from __future__ import annotations

import re
from dataclasses import dataclass

from lumo_ml.schemas import ClassifyRequest
from lumo_ml.tools import classify


@dataclass(frozen=True)
class Example:
    text: str
    lead: bool


# Hand-curated seed set for Day 4. It is intentionally stratified across:
# sponsorship, consulting, speaker/podcast invites, hiring, licensing, and
# common non-lead viewer chatter/spam. These are not user records.
POSITIVE_LEADS = [
    "Our brand wants to sponsor your next video. Can you send rates to partnerships@example.com?",
    "Could you keynote our founder summit next month? We have a speaker budget and can book a call.",
    "I run a B2B podcast and would love to interview you. What is the best business email?",
    "Our agency has a paid campaign for a creator in your niche. Can we discuss scope of work?",
    "We are hiring an advisor for our product launch and think your consulting style fits.",
    "Would you be open to a paid webinar with our marketing team? Please email your pricing.",
    "Our company wants to license this framework for enterprise training. Who handles contracts?",
    "Can we collaborate on a joint campaign? We have budget and a calendar link ready.",
    "I represent a client looking for a brand deal. Your audience is the exact fit.",
    "Our partnerships team wants to invite you to speak on a panel. Can we get your media kit?",
    "We would like to hire you for a workshop with our sales team. What are your rates?",
    "Could you join our podcast as a guest and share your consulting packages?",
    "We want to white-label your checklist for our customers. Can you send a proposal?",
    "Our founder wants an intro call about a sponsorship package for the channel.",
    "Paid integration opportunity here. Please DM me your pricing and availability.",
    "Can our startup retain you as a fractional advisor? We can discuss contract terms.",
    "We have an affiliate partnership idea and a budget for Q3. Who should we contact?",
    "Would you create a sponsored tutorial for our SaaS? Email the partnerships team.",
    "Our conference needs a speaker on AI workflows. Do you have a keynote fee sheet?",
    "I work at a venture studio and want to book a call about advisory work.",
    "Can you consult with our creator team? We need training and can pay your rate.",
    "We are putting together an interview series and want you as a paid guest.",
    "My agency wants to place a paid promo on this channel. Can you send a media kit?",
    "Our enterprise client wants a workshop based on this video. Can we get a quote?",
    "We want to sponsor a Vegas travel episode. Please reach out with package options.",
    "Could you advise our leadership team for two sessions? We can work through procurement.",
    "Our brand ambassador program would be a fit for you. Can I send details by email?",
    "We are recruiting for a creator strategy role and want to discuss joining our team.",
    "Can you speak at our webinar and share your rates? The audience is founders.",
    "Our licensing team wants permission to use this method in our course. Who signs contracts?",
    "Would you be interested in a paid collaboration with our travel app?",
    "I manage partnerships at a hotel group. Can we talk about sponsored content?",
    "Our team wants a consulting call about the workflow you showed. Budget is approved.",
    "Could we hire you to build this process for our company? Please send a proposal.",
    "We have a client campaign and need a creator for a sponsored post. Are you available?",
    "Our podcast producer wants to schedule you for an interview. What email should we use?",
    "Can we book you for a keynote at our annual customer event? We have speaker budget.",
    "I run business development for an AI tool and want to explore a partnership.",
    "Would you review our product in a paid integration? Please send your rates.",
    "Our training department wants a workshop license for your playbook.",
    "We want to invite you to our panel and cover your speaking fee.",
    "Can our marketing team schedule a call about a paid campaign?",
    "I have a sponsorship inquiry from a fintech client. What is your business email?",
    "Our company wants to hire you as an advisor for creator operations.",
    "Would you join our show for an interview and discuss a brand partnership?",
    "We need a quote for three consulting sessions with our content team.",
    "Can you send your media kit? We are planning a sponsored launch.",
    "Our agency wants to resell this workflow to clients under license.",
    "I lead partnerships at a travel startup and want to collaborate on a campaign.",
    "Could we set up an intro call about enterprise training based on this video?",
]

NEGATIVE_NOT_LEADS = [
    "Great video, I learned a lot from this.",
    "Where did you buy that microphone?",
    "This feels like it should be sponsored but I know it is not sponsored.",
    "Can you make a tutorial about the spreadsheet formula?",
    "First comment!",
    "I love this channel so much.",
    "What camera are you using in the intro?",
    "This is not a brand deal, right?",
    "Free followers waiting for you on my profile.",
    "Crypto airdrop link in my bio.",
    "I need a job, can you hire me please?",
    "The interview question at 2:15 was interesting.",
    "My partner in crime also watches this channel.",
    "Thanks for sharing your process.",
    "Can you explain the last step again?",
    "This sponsor segment was actually funny.",
    "Sub4sub anyone?",
    "I wish I could afford your course someday.",
    "Do you have a playlist for beginners?",
    "This helped me finish my homework.",
    "What laptop stand is on your desk?",
    "I disagree with your take but appreciate the video.",
    "Please upload more often.",
    "The audio is too quiet.",
    "I used this tip for my school project.",
    "Can you review my resume in a future video?",
    "The podcast you mentioned is my favorite.",
    "That conference story was hilarious.",
    "No sponsorship needed, this tool is already good.",
    "I sent this to my team because it was useful.",
    "Can you do a video about Notion templates?",
    "This is the best explanation on YouTube.",
    "What font is in your thumbnail?",
    "I got an error following the tutorial.",
    "Your cat appearing in the background made my day.",
    "I am not advertising, just saying this app helped me.",
    "The hiring market is rough right now.",
    "Your advisor example was clear.",
    "This brand deal joke aged well.",
    "Can you compare this with the free version?",
    "The partner API docs are confusing.",
    "Do you have a discount code?",
    "This webinar replay was useful.",
    "I like the way you interview guests.",
    "The agency example was too broad.",
    "Can you pin the spreadsheet link?",
    "The pricing section in your video confused me.",
    "Is there a phone app for this?",
    "Thanks, this saved me an hour.",
    "I shared this with a friend who loves automation.",
]

EXAMPLES = [*(Example(text, True) for text in POSITIVE_LEADS), *(Example(text, False) for text in NEGATIVE_NOT_LEADS)]


BASELINE_PATTERNS: list[tuple[re.Pattern[str], float]] = [
    (re.compile(r"\b(partner(ship)?|collab(oration)?)\b", re.I), 0.4),
    (re.compile(r"\b(sponsor(ship)?|advertis(e|ing|ement))\b", re.I), 0.4),
    (re.compile(r"\b(podcast|interview|on your show|on my show)\b", re.I), 0.35),
    (re.compile(r"\b(hire|hiring|join (your|our) team|career|role|position)\b", re.I), 0.4),
    (re.compile(r"\b(consult(ing|ant)?|advisory|advisor)\b", re.I), 0.3),
    (re.compile(r"\b(brand( deal)?|paid promo|paid post)\b", re.I), 0.4),
    (re.compile(r"\b(business email|reach out|in touch|email me|dm me|message me)\b", re.I), 0.25),
    (re.compile(r"\b(invite|invited|invitation)\b", re.I), 0.2),
    (re.compile(r"@?[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}", re.I), 0.35),
]


def test_day4_seed_set_has_100_hand_labels() -> None:
    assert len(EXAMPLES) == 100
    assert sum(e.lead for e in EXAMPLES) == 50
    assert sum(not e.lead for e in EXAMPLES) == 50


def test_lead_classifier_beats_previous_regex_baseline() -> None:
    labels = [e.lead for e in EXAMPLES]
    response = classify(ClassifyRequest(classifier="lead", items=[e.text for e in EXAMPLES], threshold=0.7))
    classifier_predictions = [item.above_threshold for item in response.items]
    baseline_predictions = [_baseline_score(e.text) >= 0.7 for e in EXAMPLES]

    classifier = _confusion(labels, classifier_predictions)
    baseline = _confusion(labels, baseline_predictions)

    assert classifier["precision"] >= 0.85
    assert classifier["recall"] >= 0.85
    assert classifier["f1"] > baseline["f1"]


def test_classifier_route_identifies_non_regex_lead_shapes() -> None:
    response = classify(
        ClassifyRequest(
            classifier="lead",
            items=[
                "Could you keynote our founder summit? We have a speaker budget and can book a call.",
                "Great video, where did you buy that microphone?",
            ],
            threshold=0.7,
        )
    )
    assert response.items[0].label == "business_lead"
    assert "speaker-invite" in response.items[0].reasons
    assert response.items[1].label == "not_lead"


def _baseline_score(text: str) -> float:
    score = sum(weight for pattern, weight in BASELINE_PATTERNS if pattern.search(text))
    if len(text) > 200:
        score += 0.1
    if len(text) > 500:
        score += 0.1
    return min(score, 1.0)


def _confusion(labels: list[bool], predictions: list[bool]) -> dict[str, float]:
    tp = sum(label and pred for label, pred in zip(labels, predictions))
    fp = sum((not label) and pred for label, pred in zip(labels, predictions))
    fn = sum(label and (not pred) for label, pred in zip(labels, predictions))
    tn = sum((not label) and (not pred) for label, pred in zip(labels, predictions))
    precision = tp / max(tp + fp, 1)
    recall = tp / max(tp + fn, 1)
    f1 = 2 * precision * recall / max(precision + recall, 1e-9)
    return {
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "tn": tn,
        "precision": precision,
        "recall": recall,
        "f1": f1,
    }
