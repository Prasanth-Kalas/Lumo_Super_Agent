"use client";

/**
 * PostConfirmationCard
 *
 * The mandatory gate every social write goes through — posts, replies,
 * comments, DMs, scheduled publishes — across YouTube, Instagram,
 * Facebook Pages, LinkedIn, Threads, Newsletter (when added). Per the
 * locked decision in docs/specs/workspace-and-creator-connectors.md
 * §8, this card is shown for EVERY write regardless of the user's
 * autonomy tier. There is no bypass.
 *
 * Visual system mirrors ReservationConfirmationCard / TripConfirmationCard:
 * 10px radius, single hairline border, restrained accent on the primary
 * CTA hover, `tabular-nums` on numeric readouts, dark-first.
 *
 * Lifecycle:
 *   - Parent renders the card with `payload` + handlers.
 *   - User clicks Approve → onApprove(); parent records audit_log_writes,
 *     calls platform API, marks `decidedLabel` to lock the buttons.
 *   - User clicks Edit → onEdit(); parent reopens an editor and re-shows
 *     the card with updated payload.
 *   - User clicks Cancel → onCancel(); parent marks scheduled_post
 *     status='cancelled', records audit, locks the buttons.
 *
 * Per Q3 (PRD): the scheduled time is shown in the user's local time
 * (already pre-formatted by the parent in `userLocalTime`) plus the
 * platform-side offset (`platformTime`) so the user never has to do
 * timezone math.
 */

import { useMemo } from "react";

export type PostPlatform =
  | "youtube"
  | "instagram"
  | "facebook"
  | "linkedin"
  | "threads"
  | "newsletter";

export type PostActionType =
  | "post"
  | "reply"
  | "comment_reply"
  | "dm"
  | "story"
  | "short";

export interface PostConfirmationPayload {
  kind: "post-confirmation";
  scheduled_post_id: string;
  platform: PostPlatform;
  action_type: PostActionType;
  /** External account display label, e.g. "@lumo_official", "Lumo Technologies — FB Page". */
  target_account_label: string;
  /** Optional context — for replies, the parent author + parent text snippet. */
  parent_author?: string;
  parent_excerpt?: string;
  /** The exact text we'll submit. */
  body_text: string;
  /** Optional media (count + first thumbnail URL for preview). */
  media_count?: number;
  media_first_thumbnail_url?: string;
  /** ISO with local offset; pre-formatted for display. */
  scheduled_for_iso: string;
  /** "Tue, May 12 — 9:30 AM IST" */
  user_local_time: string;
  /** "May 12, 4:00 AM UTC" — what the platform will see */
  platform_time: string;
  /** Whether this is a "post now" (scheduled_for == now within 60s). */
  immediate: boolean;
  /** Origin tag for audit. */
  origin: "user" | "agent_suggestion" | "standing_intent" | "cron";
}

export interface PostConfirmationCardProps {
  payload: PostConfirmationPayload;
  onApprove: () => void;
  onEdit?: () => void;
  onCancel: () => void;
  disabled?: boolean;
  decidedLabel?: "approved" | "cancelled" | null;
}

const PLATFORM_LABELS: Record<PostPlatform, string> = {
  youtube: "YouTube",
  instagram: "Instagram",
  facebook: "Facebook",
  linkedin: "LinkedIn",
  threads: "Threads",
  newsletter: "Newsletter",
};

const PLATFORM_ACCENT: Record<PostPlatform, string> = {
  youtube: "#ff0033",
  instagram: "#e1306c",
  facebook: "#1877f2",
  linkedin: "#0a66c2",
  threads: "#101010",
  newsletter: "#fb923c",
};

const ACTION_LABELS: Record<PostActionType, string> = {
  post: "Publishing a new post",
  reply: "Replying to a post",
  comment_reply: "Replying to a comment",
  dm: "Sending a direct message",
  story: "Publishing a story",
  short: "Publishing a short",
};

const ORIGIN_LABELS: Record<PostConfirmationPayload["origin"], string> = {
  user: "You requested this",
  agent_suggestion: "Lumo suggested this",
  standing_intent: "Triggered by a standing intent",
  cron: "Scheduled by you earlier",
};

export default function PostConfirmationCard({
  payload,
  onApprove,
  onEdit,
  onCancel,
  disabled,
  decidedLabel,
}: PostConfirmationCardProps) {
  const accent = PLATFORM_ACCENT[payload.platform];
  const platformLabel = PLATFORM_LABELS[payload.platform];
  const actionLabel = ACTION_LABELS[payload.action_type];

  const charCount = useMemo(() => payload.body_text.length, [payload.body_text]);

  const decided = !!decidedLabel;
  const buttonsDisabled = disabled || decided;
  const primaryCtaLabel = payload.immediate
    ? `Post now to ${platformLabel}`
    : `Schedule on ${platformLabel}`;

  return (
    <div
      className="post-card"
      role="dialog"
      aria-labelledby={`post-card-${payload.scheduled_post_id}-title`}
    >
      <header className="post-card__head">
        <span
          className="post-card__platform"
          style={{ background: accent + "1a", borderColor: accent + "55", color: accent }}
        >
          {platformLabel}
        </span>
        <span className="post-card__action">{actionLabel}</span>
      </header>

      <div className="post-card__target">
        <span className="post-card__target-label">Posting from</span>
        <span className="post-card__target-value">{payload.target_account_label}</span>
      </div>

      {payload.parent_author && (
        <div className="post-card__parent">
          <div className="post-card__parent-label">In reply to {payload.parent_author}</div>
          {payload.parent_excerpt && (
            <div className="post-card__parent-text">&ldquo;{payload.parent_excerpt}&rdquo;</div>
          )}
        </div>
      )}

      <div
        className="post-card__body"
        id={`post-card-${payload.scheduled_post_id}-title`}
      >
        {payload.body_text}
      </div>

      {payload.media_count && payload.media_count > 0 ? (
        <div className="post-card__media">
          {payload.media_first_thumbnail_url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={payload.media_first_thumbnail_url}
              alt=""
              className="post-card__media-thumb"
            />
          )}
          <span className="post-card__media-count">
            {payload.media_count} attachment{payload.media_count === 1 ? "" : "s"}
          </span>
        </div>
      ) : null}

      <dl className="post-card__meta">
        <div>
          <dt>{payload.immediate ? "Posting" : "Scheduled for"}</dt>
          <dd className="post-card__meta-value tabular-nums">{payload.user_local_time}</dd>
          {!payload.immediate && (
            <dd className="post-card__meta-sub tabular-nums">{payload.platform_time}</dd>
          )}
        </div>
        <div>
          <dt>Length</dt>
          <dd className="tabular-nums">{charCount.toLocaleString()} chars</dd>
        </div>
        <div>
          <dt>Origin</dt>
          <dd>{ORIGIN_LABELS[payload.origin]}</dd>
        </div>
      </dl>

      {decided ? (
        <div
          className={
            "post-card__decided post-card__decided--" + decidedLabel
          }
        >
          {decidedLabel === "approved"
            ? "Approved — sent to the platform."
            : "Cancelled — nothing was posted."}
        </div>
      ) : (
        <div className="post-card__actions">
          <button
            type="button"
            className="post-card__btn post-card__btn--ghost"
            onClick={onCancel}
            disabled={buttonsDisabled}
          >
            Cancel
          </button>
          {onEdit && (
            <button
              type="button"
              className="post-card__btn post-card__btn--ghost"
              onClick={onEdit}
              disabled={buttonsDisabled}
            >
              Edit
            </button>
          )}
          <button
            type="button"
            className="post-card__btn post-card__btn--primary"
            onClick={onApprove}
            disabled={buttonsDisabled}
            style={{ borderColor: accent, background: accent }}
          >
            {primaryCtaLabel}
          </button>
        </div>
      )}

      <style jsx>{`
        .post-card {
          border: 1px solid var(--lumo-border);
          border-radius: 10px;
          padding: 16px 18px;
          background: var(--lumo-surface);
          color: var(--lumo-fg);
          max-width: 560px;
          margin: 8px 0;
          font-size: 14px;
        }
        .post-card__head {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-bottom: 12px;
        }
        .post-card__platform {
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          padding: 3px 8px;
          border: 1px solid;
          border-radius: 999px;
        }
        .post-card__action {
          color: var(--lumo-muted);
          font-size: 13px;
        }
        .post-card__target {
          display: flex;
          align-items: baseline;
          gap: 8px;
          padding-bottom: 12px;
          border-bottom: 1px solid var(--lumo-border);
          margin-bottom: 12px;
        }
        .post-card__target-label {
          color: var(--lumo-muted);
          font-size: 12px;
        }
        .post-card__target-value {
          font-weight: 500;
        }
        .post-card__parent {
          padding: 10px 12px;
          background: color-mix(in srgb, var(--lumo-bg), transparent 0%);
          border-left: 2px solid var(--lumo-border);
          margin-bottom: 12px;
          border-radius: 4px;
        }
        .post-card__parent-label {
          font-size: 12px;
          color: var(--lumo-muted);
          margin-bottom: 4px;
        }
        .post-card__parent-text {
          font-size: 13px;
          color: var(--lumo-fg);
          line-height: 1.4;
        }
        .post-card__body {
          font-size: 15px;
          line-height: 1.55;
          white-space: pre-wrap;
          word-break: break-word;
          margin-bottom: 12px;
          padding: 12px;
          border: 1px solid var(--lumo-border);
          border-radius: 6px;
          background: var(--lumo-bg);
        }
        .post-card__media {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-bottom: 12px;
          font-size: 12px;
          color: var(--lumo-muted);
        }
        .post-card__media-thumb {
          width: 40px;
          height: 40px;
          border-radius: 4px;
          object-fit: cover;
          border: 1px solid var(--lumo-border);
        }
        .post-card__meta {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 12px;
          padding: 10px 0;
          border-top: 1px solid var(--lumo-border);
          margin: 0 0 16px 0;
        }
        .post-card__meta dt {
          font-size: 11px;
          color: var(--lumo-muted);
          text-transform: uppercase;
          letter-spacing: 0.06em;
          margin-bottom: 4px;
        }
        .post-card__meta dd {
          margin: 0;
          font-size: 13px;
        }
        .post-card__meta-value {
          font-weight: 500;
        }
        .post-card__meta-sub {
          color: var(--lumo-muted);
          font-size: 12px;
          margin-top: 2px;
        }
        .post-card__actions {
          display: flex;
          justify-content: flex-end;
          gap: 8px;
        }
        .post-card__btn {
          padding: 8px 14px;
          border-radius: 8px;
          font-size: 13px;
          font-weight: 500;
          cursor: pointer;
          border: 1px solid var(--lumo-border);
          transition: opacity 0.15s, transform 0.05s;
        }
        .post-card__btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .post-card__btn--ghost {
          background: transparent;
          color: var(--lumo-fg);
        }
        .post-card__btn--ghost:hover:not(:disabled) {
          background: var(--lumo-bg);
        }
        .post-card__btn--primary {
          color: #ffffff;
        }
        .post-card__btn--primary:hover:not(:disabled) {
          opacity: 0.9;
        }
        .post-card__btn--primary:active:not(:disabled) {
          transform: translateY(1px);
        }
        .post-card__decided {
          padding: 10px 12px;
          border-radius: 6px;
          font-size: 13px;
          margin-top: 4px;
        }
        .post-card__decided--approved {
          background: color-mix(in srgb, #2ea84a 15%, transparent);
          color: #2ea84a;
          border: 1px solid color-mix(in srgb, #2ea84a 30%, transparent);
        }
        .post-card__decided--cancelled {
          background: color-mix(in srgb, #e0613f 15%, transparent);
          color: #e0613f;
          border: 1px solid color-mix(in srgb, #e0613f 30%, transparent);
        }
        @media (max-width: 640px) {
          .post-card {
            padding: 14px;
          }
          .post-card__meta {
            grid-template-columns: 1fr;
            gap: 8px;
          }
          .post-card__actions {
            flex-direction: column-reverse;
          }
          .post-card__btn {
            width: 100%;
          }
        }
      `}</style>
    </div>
  );
}
