/**
 * GET /api/workspace/inbox — backing data for the Inbox tab.
 *
 * V1.0 surface: YouTube comments across the user's recent uploads,
 * scored for "business-lead-likelihood" through Lumo_ML_Service's
 * classifier with a strict heuristic fallback. Returns:
 *   - items: comments + future DMs, unified shape
 *   - relationship_index: top 10 commenters across the window
 *   - business_leads: items at or above the configured lead threshold
 *
 * V1.x adds Instagram + Facebook + LinkedIn surfaces under the same
 * shape so the UI doesn't change as connectors light up.
 *
 * Hot-path SLO: classifier gets a 300ms budget. If it is missing, slow,
 * or unhealthy, the existing heuristic scoring is used and the Inbox still
 * renders.
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
import { LEAD_SCORE_THRESHOLD, scoreLeadHeuristic } from "@/lib/lead-scoring";
import { classifyLeadItems } from "@/lib/workspace-lead-classifier";

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
  lead_source: "heuristic" | "ml";
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
  lead_scoring_source: "heuristic" | "ml";
  lead_scoring_latency_ms: number;
  error?: string;
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
            const lead = scoreLeadHeuristic(c.textOriginal);
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
              lead_source: lead.source,
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
  const classified = await classifyLeadItems(
    user.id,
    trimmed.map((item) => ({ text: item.text })),
  );
  trimmed.forEach((item, index) => {
    const score = classified.scores[index];
    if (!score) return;
    item.lead_score = score.score;
    item.lead_reasons = score.reasons;
    item.lead_source = score.source;
  });

  const business_leads = trimmed
    .filter((i) => i.lead_score >= LEAD_SCORE_THRESHOLD)
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
    lead_scoring_source: classified.source,
    lead_scoring_latency_ms: classified.latency_ms,
    ...(error ? { error } : {}),
  };
  return NextResponse.json(envelope);
}
