/**
 * GET /api/workspace/inbox — backing data for the Inbox tab.
 *
 * V1.0 surface: YouTube comments across the user's recent uploads,
 * scored for "business-lead-likelihood" with a heuristic + (when enabled)
 * an LLM pass. Returns:
 *   - items: comments + future DMs, unified shape
 *   - relationship_index: top 10 commenters across the window
 *   - business_leads: items where lead_score >= 0.7
 *
 * V1.x adds Instagram + Facebook + LinkedIn surfaces under the same
 * shape so the UI doesn't change as connectors light up.
 *
 * Heuristic-only V1: keyword scoring against a short corpus of
 * partnership / collaboration / sponsorship / hire / podcast asks.
 * The LLM pass is a future task once we want better recall on
 * non-English or implicit asks.
 */

import { type NextRequest, NextResponse } from "next/server";
import { getServerUser } from "@/lib/auth";
import { GOOGLE_AGENT_ID } from "@/lib/integrations/google";
import {
  listChannels,
  listRecentVideos,
  listVideoComments,
} from "@/lib/integrations/youtube";
import { getDispatchableConnection } from "@/lib/connections";

export const runtime = "nodejs";

interface InboxItem {
  id: string;
  platform: "youtube" | "instagram" | "facebook" | "linkedin";
  kind: "comment" | "dm" | "mention";
  author_handle: string;
  author_external_id: string | null;
  text: string;
  permalink_context: string; // video title / post excerpt etc.
  received_iso: string;
  like_count: number;
  lead_score: number; // 0..1 — business-lead heuristic
  lead_reasons: string[]; // why we flagged it
}

interface RelationshipRow {
  handle: string;
  count: number;
  last_iso: string;
  platforms: string[];
}

interface InboxEnvelope {
  generated_at: string;
  items: InboxItem[];
  business_leads: InboxItem[];
  relationship_index: RelationshipRow[];
  source: "live" | "cached" | "stale" | "error";
  age_ms: number;
  error?: string;
}

const LEAD_KEYWORDS: Array<{ pattern: RegExp; reason: string; weight: number }> = [
  { pattern: /\b(partner(ship)?|collab(oration)?)\b/i, reason: "partnership", weight: 0.4 },
  { pattern: /\b(sponsor(ship)?|advertis(e|ing|ement))\b/i, reason: "sponsorship", weight: 0.4 },
  { pattern: /\b(podcast|interview|on your show|on my show)\b/i, reason: "podcast/interview", weight: 0.35 },
  { pattern: /\b(hire|hiring|join (your|our) team|career|role|position)\b/i, reason: "hiring", weight: 0.4 },
  { pattern: /\b(consult(ing|ant)?|advisory|advisor)\b/i, reason: "consulting", weight: 0.3 },
  { pattern: /\b(brand( deal)?|paid promo|paid post)\b/i, reason: "brand-deal", weight: 0.4 },
  { pattern: /\b(business email|reach out|in touch|email me|dm me|message me)\b/i, reason: "contact-request", weight: 0.25 },
  { pattern: /\b(invite|invited|invitation)\b/i, reason: "invitation", weight: 0.2 },
  { pattern: /@?[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}/i, reason: "email-shared", weight: 0.35 },
];

function scoreLead(text: string): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  for (const k of LEAD_KEYWORDS) {
    if (k.pattern.test(text)) {
      score += k.weight;
      if (!reasons.includes(k.reason)) reasons.push(k.reason);
    }
  }
  // Long messages are more likely to be substantive asks.
  if (text.length > 200) score += 0.1;
  if (text.length > 500) score += 0.1;
  return { score: Math.min(score, 1), reasons };
}

export async function GET(_req: NextRequest) {
  const user = await getServerUser();
  if (!user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const startedAt = Date.now();
  let source: InboxEnvelope["source"] = "live";
  let age_ms = 0;
  let error: string | undefined;
  const items: InboxItem[] = [];

  try {
    const conn = await getDispatchableConnection({
      user_id: user.id,
      agent_id: GOOGLE_AGENT_ID,
      oauth2_config: {
        authorize_url: "",
        token_url: "",
        scopes: [],
        client_id_env: "",
        client_secret_env: "",
        client_type: "confidential",
      } as never,
    }).catch(() => null);

    if (conn) {
      const channelEnv = await listChannels({
        user_id: user.id,
        access_token: conn.access_token,
      });
      source = channelEnv.source;
      age_ms = channelEnv.age_ms;

      // For each channel (cap at 2), pull last 5 videos and last 25 comments per video.
      // Cap aggressively to stay under YouTube quota.
      for (const channel of channelEnv.channels.slice(0, 2)) {
        const videos = await listRecentVideos({
          user_id: user.id,
          channel_id: channel.id,
          access_token: conn.access_token,
          limit: 5,
        });
        for (const video of videos.videos) {
          let comments;
          try {
            comments = await listVideoComments({
              user_id: user.id,
              video_id: video.id,
              access_token: conn.access_token,
              limit: 25,
            });
          } catch {
            continue;
          }
          for (const c of comments.comments) {
            const lead = scoreLead(c.textOriginal);
            items.push({
              id: `yt:${c.id}`,
              platform: "youtube",
              kind: "comment",
              author_handle: c.authorDisplayName,
              author_external_id: c.authorChannelId ?? null,
              text: c.textOriginal,
              permalink_context: video.title,
              received_iso: c.publishedAt,
              like_count: c.likeCount ?? 0,
              lead_score: lead.score,
              lead_reasons: lead.reasons,
            });
          }
        }
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    source = "error";
  }

  // Sort recency-first.
  items.sort((a, b) => b.received_iso.localeCompare(a.received_iso));

  // Trim to last 50 to keep the dashboard lean.
  const trimmed = items.slice(0, 50);
  const business_leads = trimmed
    .filter((i) => i.lead_score >= 0.7)
    .sort((a, b) => b.lead_score - a.lead_score)
    .slice(0, 10);

  // Relationship index: count by author across the window.
  const byAuthor = new Map<string, RelationshipRow>();
  for (const item of trimmed) {
    const cur = byAuthor.get(item.author_handle) ?? {
      handle: item.author_handle,
      count: 0,
      last_iso: item.received_iso,
      platforms: [],
    };
    cur.count += 1;
    if (item.received_iso > cur.last_iso) cur.last_iso = item.received_iso;
    if (!cur.platforms.includes(item.platform)) cur.platforms.push(item.platform);
    byAuthor.set(item.author_handle, cur);
  }
  const relationship_index = Array.from(byAuthor.values())
    .sort((a, b) => b.count - a.count || b.last_iso.localeCompare(a.last_iso))
    .slice(0, 10);

  if (Date.now() - startedAt > 8000) {
    // Mark stale if we ran long; the cache layer's aggressive TTLs
    // mean this is rare in practice.
    source = source === "live" ? "stale" : source;
  }

  const envelope: InboxEnvelope = {
    generated_at: new Date().toISOString(),
    items: trimmed,
    business_leads,
    relationship_index,
    source,
    age_ms,
    ...(error ? { error } : {}),
  };
  return NextResponse.json(envelope);
}
