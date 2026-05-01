"""Held-out evaluation for the lead classifier.

Replaces the misleading F1=1.00 on-seed claim with an honest stratified
80/20 split and a ML baseline trained on the 80% only.

This harness evaluates TWO models on the same held-out 20% test set:

1. The shipped *rule-based* classifier (`app.tools.classify`). Note that this
   classifier has zero learnable parameters, so "training" it on 80% is
   meaningless -- but its in-the-wild performance on the 20% is still a fair
   measure of how well its hand-tuned regex rules generalise to held-out
   examples drawn from the same distribution.

2. A real ML baseline (TF-IDF + Logistic Regression) fit on the 80% only,
   to give a realistic ML-baseline comparison and stress-test whether the
   F1=1.00 claim was a measurement artefact.

It also runs leakage / sanity diagnostics:
  * duplicate text across splits
  * near-duplicates via character n-gram cosine similarity
  * label correlation with trivial features (length, has-email, etc.)
  * train/test class balance check

Outputs:
  - JSON artefact: lumo_ml/eval/results/lead_classifier_v1.json

Run:
  python -m lumo_ml.eval.lead_classifier_eval

Constraints:
  - Does NOT modify production classifier code (app/tools.py).
  - Does NOT create new datasets or labels -- uses the existing seed in
    tests/test_classify.py as the single source of truth.
"""
from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    accuracy_score,
    confusion_matrix,
    f1_score,
    precision_score,
    recall_score,
    roc_auc_score,
)
from sklearn.model_selection import StratifiedKFold, train_test_split

REPO_ROOT = Path(__file__).resolve().parents[2]
RESULTS_PATH = REPO_ROOT / "lumo_ml" / "eval" / "results" / "lead_classifier_v1.json"
SEED = 42

# Make the repo importable so we can call the production rule classifier.
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from lumo_ml.schemas import ClassifyRequest  # noqa: E402
from lumo_ml.tools import classify as rule_classify  # noqa: E402


@dataclass(frozen=True)
class Example:
    text: str
    label: int  # 1 = lead, 0 = not_lead


def load_seed_dataset() -> list[Example]:
    """Load the 100-example seed set defined in tests/test_classify.py."""
    sys.path.insert(0, str(REPO_ROOT))
    from tests import test_classify as seed  # type: ignore

    examples: list[Example] = []
    for text in seed.POSITIVE_LEADS:
        examples.append(Example(text=text, label=1))
    for text in seed.NEGATIVE_NOT_LEADS:
        examples.append(Example(text=text, label=0))
    return examples


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text.strip().lower())


def find_exact_duplicates(texts: list[str]) -> list[tuple[int, int]]:
    seen: dict[str, int] = {}
    dupes: list[tuple[int, int]] = []
    for i, t in enumerate(texts):
        key = _normalize(t)
        if key in seen:
            dupes.append((seen[key], i))
        else:
            seen[key] = i
    return dupes


def find_near_duplicates(
    texts_a: list[str], texts_b: list[str], threshold: float = 0.85
) -> list[tuple[int, int, float]]:
    """Char n-gram cosine similarity between two lists.

    Returns (idx_a, idx_b, cosine) for any pair >= threshold.
    """
    if not texts_a or not texts_b:
        return []
    vec = TfidfVectorizer(analyzer="char_wb", ngram_range=(3, 5))
    matrix = vec.fit_transform(texts_a + texts_b)
    a = matrix[: len(texts_a)]
    b = matrix[len(texts_a) :]
    sim = (a @ b.T).toarray()
    hits: list[tuple[int, int, float]] = []
    for i in range(sim.shape[0]):
        for j in range(sim.shape[1]):
            if sim[i, j] >= threshold:
                hits.append((i, j, float(sim[i, j])))
    return hits


def trivial_feature_correlation(examples: list[Example]) -> dict[str, float]:
    df = pd.DataFrame(
        {
            "label": [e.label for e in examples],
            "length": [len(e.text) for e in examples],
            "word_count": [len(e.text.split()) for e in examples],
            "has_email": [int(bool(re.search(r"[\w.+-]+@[\w-]+\.[\w.-]+", e.text))) for e in examples],
            "has_question_mark": [int("?" in e.text) for e in examples],
            "has_we_or_our": [int(bool(re.search(r"\b(we|our)\b", e.text, re.I))) for e in examples],
        }
    )
    corr = df.corr(numeric_only=True)["label"].drop("label")
    return {k: float(round(v, 4)) for k, v in corr.items()}


def compute_metrics(
    y_true: np.ndarray, y_pred: np.ndarray, y_score: np.ndarray | None
) -> dict[str, Any]:
    cm = confusion_matrix(y_true, y_pred, labels=[0, 1])
    tn, fp, fn, tp = int(cm[0, 0]), int(cm[0, 1]), int(cm[1, 0]), int(cm[1, 1])
    out: dict[str, Any] = {
        "accuracy": float(round(accuracy_score(y_true, y_pred), 4)),
        "precision_lead": float(round(precision_score(y_true, y_pred, pos_label=1, zero_division=0), 4)),
        "recall_lead": float(round(recall_score(y_true, y_pred, pos_label=1, zero_division=0), 4)),
        "f1_lead": float(round(f1_score(y_true, y_pred, pos_label=1, zero_division=0), 4)),
        "precision_not_lead": float(round(precision_score(y_true, y_pred, pos_label=0, zero_division=0), 4)),
        "recall_not_lead": float(round(recall_score(y_true, y_pred, pos_label=0, zero_division=0), 4)),
        "f1_not_lead": float(round(f1_score(y_true, y_pred, pos_label=0, zero_division=0), 4)),
        "f1_macro": float(round(f1_score(y_true, y_pred, average="macro", zero_division=0), 4)),
        "confusion_matrix": {
            "tn": tn, "fp": fp, "fn": fn, "tp": tp,
            "labels_order": ["not_lead", "business_lead"],
        },
        "support": {
            "total": int(len(y_true)),
            "lead": int(int(y_true.sum())),
            "not_lead": int(len(y_true) - int(y_true.sum())),
        },
    }
    if y_score is not None and len(np.unique(y_true)) > 1:
        try:
            out["roc_auc"] = float(round(roc_auc_score(y_true, y_score), 4))
        except ValueError:
            out["roc_auc"] = None
    else:
        out["roc_auc"] = None
    return out


def predict_with_rule_classifier(
    texts: list[str], threshold: float = 0.7
) -> tuple[np.ndarray, np.ndarray]:
    response = rule_classify(ClassifyRequest(classifier="lead", items=texts, threshold=threshold))
    scores = np.array([item.score for item in response.items], dtype=float)
    preds = (scores >= threshold).astype(int)
    return preds, scores


def train_and_predict_tfidf_lr(
    train_texts: list[str], train_labels: np.ndarray, test_texts: list[str]
) -> tuple[np.ndarray, np.ndarray, dict[str, Any]]:
    vec = TfidfVectorizer(
        ngram_range=(1, 2),
        min_df=1,
        max_df=0.95,
        sublinear_tf=True,
        lowercase=True,
        strip_accents="unicode",
    )
    X_train = vec.fit_transform(train_texts)
    X_test = vec.transform(test_texts)
    clf = LogisticRegression(
        C=1.0, class_weight="balanced", max_iter=1000, random_state=SEED, solver="liblinear"
    )
    clf.fit(X_train, train_labels)
    proba = clf.predict_proba(X_test)[:, 1]
    pred = (proba >= 0.5).astype(int)

    cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=SEED)
    cv_f1: list[float] = []
    for fold_train, fold_val in cv.split(X_train, train_labels):
        sub_clf = LogisticRegression(
            C=1.0, class_weight="balanced", max_iter=1000, random_state=SEED, solver="liblinear"
        )
        sub_clf.fit(X_train[fold_train], train_labels[fold_train])
        fold_pred = sub_clf.predict(X_train[fold_val])
        cv_f1.append(f1_score(train_labels[fold_val], fold_pred, pos_label=1, zero_division=0))

    aux = {
        "cv_f1_lead_mean": float(round(np.mean(cv_f1), 4)),
        "cv_f1_lead_std": float(round(np.std(cv_f1), 4)),
        "cv_folds": 5,
        "vocab_size": int(len(vec.vocabulary_)),
        "model": "TfidfVectorizer(1,2)+LogisticRegression(C=1.0, class_weight=balanced)",
    }
    return pred, proba, aux


def main() -> dict[str, Any]:
    examples = load_seed_dataset()
    texts = [e.text for e in examples]
    labels = np.array([e.label for e in examples], dtype=int)

    label_dist = {
        "lead": int(labels.sum()),
        "not_lead": int(len(labels) - labels.sum()),
        "total": int(len(labels)),
    }
    text_lengths = [len(t) for t in texts]
    length_stats_by_label = {
        "lead_mean_chars": float(round(float(np.mean([len(t) for t, lbl in zip(texts, labels) if lbl == 1])), 2)),
        "not_lead_mean_chars": float(round(float(np.mean([len(t) for t, lbl in zip(texts, labels) if lbl == 0])), 2)),
        "lead_mean_words": float(round(float(np.mean([len(t.split()) for t, lbl in zip(texts, labels) if lbl == 1])), 2)),
        "not_lead_mean_words": float(round(float(np.mean([len(t.split()) for t, lbl in zip(texts, labels) if lbl == 0])), 2)),
    }

    duplicates = find_exact_duplicates(texts)
    feature_corr = trivial_feature_correlation(examples)

    train_idx, test_idx = train_test_split(
        np.arange(len(texts)), test_size=0.20, stratify=labels, random_state=SEED
    )
    train_texts = [texts[i] for i in train_idx]
    test_texts = [texts[i] for i in test_idx]
    y_train = labels[train_idx]
    y_test = labels[test_idx]

    cross_split_near_dupes = find_near_duplicates(train_texts, test_texts, threshold=0.85)

    split_info = {
        "seed": SEED,
        "train_size": int(len(train_idx)),
        "test_size": int(len(test_idx)),
        "train_label_dist": {
            "lead": int(y_train.sum()),
            "not_lead": int(len(y_train) - y_train.sum()),
        },
        "test_label_dist": {
            "lead": int(y_test.sum()),
            "not_lead": int(len(y_test) - y_test.sum()),
        },
    }

    rule_pred_full, rule_score_full = predict_with_rule_classifier(texts, threshold=0.7)
    rule_metrics_full = compute_metrics(labels, rule_pred_full, rule_score_full)

    rule_pred_test, rule_score_test = predict_with_rule_classifier(test_texts, threshold=0.7)
    rule_metrics_test = compute_metrics(y_test, rule_pred_test, rule_score_test)

    lr_pred, lr_proba, lr_aux = train_and_predict_tfidf_lr(train_texts, y_train, test_texts)
    lr_metrics_test = compute_metrics(y_test, lr_pred, lr_proba)

    artefact = {
        "schema_version": 1,
        "generated_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "task": "lead_classifier_v1",
        "dataset": {
            "source": "tests/test_classify.py (POSITIVE_LEADS + NEGATIVE_NOT_LEADS)",
            "size": int(len(examples)),
            "label_distribution": label_dist,
            "length_stats_chars": {
                "min": int(np.min(text_lengths)),
                "max": int(np.max(text_lengths)),
                "mean": float(round(float(np.mean(text_lengths)), 2)),
                "median": float(round(float(np.median(text_lengths)), 2)),
            },
            "length_stats_by_label": length_stats_by_label,
        },
        "leakage_diagnostics": {
            "exact_duplicate_pairs_in_full_set": [
                {"i": i, "j": j, "text": texts[i]} for i, j in duplicates
            ],
            "near_duplicate_pairs_train_vs_test_threshold_0_85": [
                {
                    "train_idx": int(i),
                    "test_idx": int(j),
                    "cosine": round(s, 4),
                    "train_text": train_texts[i],
                    "test_text": test_texts[j],
                }
                for i, j, s in cross_split_near_dupes
            ],
            "trivial_feature_pearson_r_with_label": feature_corr,
            "interpretation": (
                "If |pearson r| > 0.5 for length/has_we_or_our, a trivial baseline could "
                "achieve high F1 without learning anything generalizable."
            ),
        },
        "split": split_info,
        "models": {
            "rule_based_full_set": {
                "name": "app.tools.classify (regex+weights, threshold=0.7)",
                "evaluated_on": "ALL 100 seed examples (NOT held-out -- for parity with the F1=1.00 claim only)",
                "metrics": rule_metrics_full,
                "warning": (
                    "The rule weights and regex patterns were tuned against this exact 100-example "
                    "seed set, so this number is by construction an upper bound and should not be "
                    "reported as a generalisation estimate."
                ),
            },
            "rule_based_holdout": {
                "name": "app.tools.classify (regex+weights, threshold=0.7)",
                "evaluated_on": "20% held-out test split (seed=42, stratified)",
                "metrics": rule_metrics_test,
            },
            "tfidf_logreg_holdout": {
                "name": lr_aux["model"],
                "evaluated_on": "20% held-out test split (seed=42, stratified)",
                "metrics": lr_metrics_test,
                "cross_validation_on_train_split": {
                    "f1_lead_mean": lr_aux["cv_f1_lead_mean"],
                    "f1_lead_std": lr_aux["cv_f1_lead_std"],
                    "folds": lr_aux["cv_folds"],
                },
                "vocab_size": lr_aux["vocab_size"],
            },
        },
        "honesty_notes": [
            "The shipped lead classifier is rule-based (regex + hand-tuned weights), not a "
            "trainable ML model. 'Training' is therefore not meaningful for the rule classifier; "
            "we report its metrics on both the full set (matching the prior F1 claim) and the "
            "held-out 20% to show how much the prior number depended on test-set tuning.",
            "The TF-IDF + LogisticRegression baseline IS trained only on the 80% train split and "
            "evaluated only on the held-out 20% split. It is the apples-to-apples generalisation "
            "estimate.",
            "100 examples is too few to draw confident conclusions. ROC-AUC and per-class metrics "
            "on a 20-row test set have wide confidence intervals (~+/-0.10 at 95%).",
        ],
    }

    RESULTS_PATH.parent.mkdir(parents=True, exist_ok=True)
    RESULTS_PATH.write_text(json.dumps(artefact, indent=2))
    return artefact


if __name__ == "__main__":
    artefact = main()
    summary = {
        "rule_full_set_f1_lead": artefact["models"]["rule_based_full_set"]["metrics"]["f1_lead"],
        "rule_holdout_f1_lead": artefact["models"]["rule_based_holdout"]["metrics"]["f1_lead"],
        "tfidf_lr_holdout_f1_lead": artefact["models"]["tfidf_logreg_holdout"]["metrics"]["f1_lead"],
        "tfidf_lr_holdout_roc_auc": artefact["models"]["tfidf_logreg_holdout"]["metrics"]["roc_auc"],
        "tfidf_lr_cv_f1_mean": artefact["models"]["tfidf_logreg_holdout"][
            "cross_validation_on_train_split"
        ]["f1_lead_mean"],
        "exact_dupes": len(artefact["leakage_diagnostics"]["exact_duplicate_pairs_in_full_set"]),
        "near_dupes_across_split": len(
            artefact["leakage_diagnostics"]["near_duplicate_pairs_train_vs_test_threshold_0_85"]
        ),
        "results_path": str(RESULTS_PATH),
    }
    print(json.dumps(summary, indent=2))
