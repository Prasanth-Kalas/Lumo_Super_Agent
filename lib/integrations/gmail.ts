/**
 * Gmail tool handlers.
 *
 * Privacy posture:
 *   - Lumo reads at query time, returns a compact projection to
 *     Claude, and does NOT persist message bodies or subjects anywhere
 *     in our DB. The only trace in events/ops_cron_runs is a metadata
 *     line (tool name, latency, ok) — see router.ts where internal
 *     integrations are marked no_persist_body.
 *   - We only request gmail.readonly scope today. Any future
 *     gmail_send / gmail_modify tool MUST bump the scope and re-prompt
 *     the user for consent; silent scope-escalation would be a breach
 *     of the connect-time disclosure.
 */

import { googleFetchJson, type GoogleApiError } from "./google.js";

// ──────────────────────────────────────────────────────────────────────────
// Types the handlers return to Claude
// ──────────────────────────────────────────────────────────────────────────

export interface GmailSearchResult {
  messages: Array<{
    id: string;
    thread_id: string;
    from: string;
    to: string | null;
    subject: string;
    snippet: string;
    date: string; // RFC2822 from Gmail — kept as-is for Claude to parse
    has_attachment: boolean;
  }>;
  total_estimated: number;
}

export interface GmailMessage {
  id: string;
  thread_id: string;
  from: string;
  to: string | null;
  cc: string | null;
  subject: string;
  date: string;
  body_text: string;
  /** True if we had to skip MIME parts we couldn't safely render as text. */
  body_truncated: boolean;
}

// ──────────────────────────────────────────────────────────────────────────
// gmail_search_messages
// ──────────────────────────────────────────────────────────────────────────

/**
 * Query uses Gmail search syntax (`from:`, `subject:`, `has:attachment`,
 * `after:`, etc. — same grammar as the web UI).
 *
 * We do TWO calls:
 *   1. messages.list with q= → returns message ids only (cheap)
 *   2. messages.get for each id with format=metadata → headers + snippet
 *
 * Bounded at max_results ≤ 25 so a pathological "from:.*" query can't
 * spiral cost or latency.
 */
export async function gmailSearchMessages(args: {
  access_token: string;
  query: string;
  max_results?: number;
}): Promise<GmailSearchResult> {
  const max = Math.min(25, Math.max(1, args.max_results ?? 10));

  const list = await googleFetchJson<{
    messages?: Array<{ id: string; threadId: string }>;
    resultSizeEstimate?: number;
  }>({
    access_token: args.access_token,
    url: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
    query: { q: args.query, maxResults: max },
  });

  const ids = (list.messages ?? []).slice(0, max);
  const results: GmailSearchResult["messages"] = [];

  for (const m of ids) {
    try {
      const msg = await googleFetchJson<{
        id: string;
        threadId: string;
        snippet?: string;
        payload?: {
          headers?: Array<{ name: string; value: string }>;
          parts?: Array<{ filename?: string }>;
        };
      }>({
        access_token: args.access_token,
        url: `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(m.id)}`,
        query: { format: "metadata", metadataHeaders: "From,To,Subject,Date" },
      });
      const h = msg.payload?.headers ?? [];
      const getHdr = (name: string) =>
        h.find((x) => x.name.toLowerCase() === name.toLowerCase())?.value ?? "";

      results.push({
        id: msg.id,
        thread_id: msg.threadId,
        from: getHdr("From"),
        to: getHdr("To") || null,
        subject: getHdr("Subject"),
        snippet: msg.snippet ?? "",
        date: getHdr("Date"),
        has_attachment: (msg.payload?.parts ?? []).some(
          (p) => (p.filename ?? "").length > 0,
        ),
      });
    } catch {
      // Individual message fetch failed (e.g., message deleted between
      // list and get). Drop it silently — the list as a whole still
      // answers the user's question usefully.
    }
  }

  return {
    messages: results,
    total_estimated: list.resultSizeEstimate ?? results.length,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// gmail_get_message
// ──────────────────────────────────────────────────────────────────────────

/**
 * Fetch a single message with its text body. We decode MIME parts and
 * return the first `text/plain` part we find; if there's only HTML we
 * strip tags crudely and return that as fallback. Attachments are
 * reported by count only — we don't return the bytes.
 */
export async function gmailGetMessage(args: {
  access_token: string;
  message_id: string;
}): Promise<GmailMessage> {
  const msg = await googleFetchJson<{
    id: string;
    threadId: string;
    payload?: MessagePart;
  }>({
    access_token: args.access_token,
    url: `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(args.message_id)}`,
    query: { format: "full" },
  });

  const headers = msg.payload?.headers ?? [];
  const getHdr = (name: string) =>
    headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

  const { text, truncated } = extractBody(msg.payload);

  return {
    id: msg.id,
    thread_id: msg.threadId,
    from: getHdr("From"),
    to: getHdr("To") || null,
    cc: getHdr("Cc") || null,
    subject: getHdr("Subject"),
    date: getHdr("Date"),
    body_text: text,
    body_truncated: truncated,
  };
}

interface MessagePart {
  mimeType?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { data?: string; size?: number };
  parts?: MessagePart[];
}

function extractBody(p: MessagePart | undefined): { text: string; truncated: boolean } {
  if (!p) return { text: "", truncated: false };

  // Prefer text/plain. If this part itself is text/plain, use it.
  if (p.mimeType === "text/plain" && p.body?.data) {
    return { text: decodeBase64Url(p.body.data), truncated: false };
  }
  // Otherwise walk parts looking for the first text/plain. Cap depth + count.
  const stack: MessagePart[] = [...(p.parts ?? [])];
  let plain = "";
  let html = "";
  let seenParts = 0;
  while (stack.length && seenParts < 50) {
    const part = stack.shift();
    if (!part) break;
    seenParts++;
    if (part.mimeType === "text/plain" && part.body?.data && !plain) {
      plain = decodeBase64Url(part.body.data);
    } else if (part.mimeType === "text/html" && part.body?.data && !html) {
      html = decodeBase64Url(part.body.data);
    }
    if (part.parts) stack.push(...part.parts);
  }
  if (plain) return { text: plain, truncated: seenParts >= 50 };
  if (html) return { text: htmlToPlain(html), truncated: seenParts >= 50 };
  return { text: "", truncated: seenParts >= 50 };
}

function decodeBase64Url(s: string): string {
  // Gmail returns url-safe base64 without padding.
  const normalized = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4 === 0 ? 0 : 4 - (normalized.length % 4);
  const padded = normalized + "=".repeat(pad);
  try {
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function htmlToPlain(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** Narrow GoogleApiError for the internal dispatcher to map onto the SDK's error taxonomy. */
export function isGoogleApiError(e: unknown): e is GoogleApiError {
  return e instanceof Error && e.name === "GoogleApiError";
}
