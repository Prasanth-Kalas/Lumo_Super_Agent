import React, { useState } from "react";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";

interface HelpfulFeedbackProps {
  pageId?: string;
}

type VoteState = "idle" | "submitting" | "sent" | "error";

export default function HelpfulFeedback({ pageId }: HelpfulFeedbackProps): JSX.Element {
  const { siteConfig } = useDocusaurusContext();
  const [state, setState] = useState<VoteState>("idle");
  const [score, setScore] = useState<1 | -1 | null>(null);
  const [freeText, setFreeText] = useState("");
  const endpoint = String(siteConfig.customFields.feedbackEndpoint ?? "/api/docs/feedback");
  const resolvedPageId =
    pageId ??
    (typeof window === "undefined"
      ? "unknown"
      : window.location.pathname
          .replace(/^\/agents\/?/, "")
          .replace(/\/$/, "") || "README");

  async function submit(nextScore: 1 | -1): Promise<void> {
    setScore(nextScore);
    setState("submitting");
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          page_id: resolvedPageId,
          score: nextScore,
          free_text: freeText.trim() || null,
        }),
      });
      setState(res.ok ? "sent" : "error");
    } catch {
      setState("error");
    }
  }

  return (
    <section className="lumo-feedback" aria-label="Page feedback">
      <div>
        <strong>Was this page helpful?</strong>
        <p>Feedback goes to the weekly agent-platform docs digest.</p>
      </div>
      <textarea
        aria-label="Optional feedback"
        placeholder="Optional note"
        value={freeText}
        onChange={(event) => setFreeText(event.target.value)}
        maxLength={5000}
      />
      <div className="lumo-feedback__actions">
        <button
          type="button"
          className={score === 1 ? "is-selected" : ""}
          disabled={state === "submitting"}
          onClick={() => submit(1)}
        >
          Helpful
        </button>
        <button
          type="button"
          className={score === -1 ? "is-selected" : ""}
          disabled={state === "submitting"}
          onClick={() => submit(-1)}
        >
          Not helpful
        </button>
      </div>
      {state === "sent" && <p className="lumo-feedback__status">Thanks, logged.</p>}
      {state === "error" && (
        <p className="lumo-feedback__status lumo-feedback__status--error">
          Could not send feedback. Try again later.
        </p>
      )}
    </section>
  );
}
