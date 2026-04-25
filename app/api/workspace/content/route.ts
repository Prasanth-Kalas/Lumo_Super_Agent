/**
 * GET /api/workspace/content — backing data for the Content tab.
 *
 * V1.0 surface: YouTube outliers + a content schedule view of the
 * user's scheduled_posts queue. Future versions add IG/FB outliers
 * and the LLM-driven repurpose queue.
 *
 * Outliers ranking:
 *   For each channel, compute the median view count across the last
 *   30 uploads, then surface videos beating median by ≥1.5×, sorted
 *   by multiplier descending. Cap at 10 per channel.
 *
 * Schedule:
 *   scheduled_posts where status in ('queued', 'pending') AND
 *   scheduled_for in [now-7d, now+30d] for at-a-glance roadmap.
 */

import { type NextRequest, NextResponse } from "next/server";
import { getServerUser } from "@/lib/auth";
import { GOOGLE_AGENT_ID } from "@/lib/integrations/google";
import { listChannels, listRecentVideos } from "@/lib/integrations/youtube";
import { getDispatchableConnection } from "@/lib/connections";
import { getSupabase } from "@/lib/db";

export const runtime = "nodejs";

interface OutlierVideo {
  id: string;
  title: string;
  channel_title: string;
  views: number;
  median_views: number;
  multiplier: number;
  published_at: string;
  thumbnail_url?: string;
}

interface ScheduledItem {
  id: string;
  agent_id: string;
  action_type: string;
  status: string;
  scheduled_for: string;
  body_excerpt: string;
  external_account_id: string | null;
  origin: string;
}

interface RepurposeCue {
  source_id: string;
  source_label: string;
  multiplier: number;
  suggestion: string;
  target_platforms: string[];
}

interface ContentEnvelope {
  generated_at: string;
  outliers: OutlierVideo[];
  schedule: ScheduledItem[];
  repurpose_cues: RepurposeCue[];
  source: "live" | "cached" | "stale" | "error";
  age_ms: number;
  error?: string;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = nums.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    const a = sorted[mid - 1] ?? 0;
    const b = sorted[mid] ?? 0;
    return (a + b) / 2;
  }
  return sorted[mid] ?? 0;
}

export async function GET(_req: NextRequest) {
  const user = await getServerUser();
  if (!user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let source: ContentEnvelope["source"] = "live";
  let age_ms = 0;
  let error: string | undefined;
  const outliers: OutlierVideo[] = [];

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

      for (const channel of channelEnv.channels.slice(0, 2)) {
        const videos = await listRecentVideos({
          user_id: user.id,
          channel_id: channel.id,
          access_token: conn.access_token,
          limit: 30,
        });
        const viewCounts = videos.videos
          .map((v) => v.views ?? 0)
          .filter((n) => n > 0);
        if (viewCounts.length === 0) continue;
        const med = median(viewCounts);
        if (med <= 0) continue;
        for (const v of videos.videos) {
          const views = v.views ?? 0;
          if (views <= 0) continue;
          const mult = views / med;
          if (mult >= 1.5) {
            outliers.push({
              id: v.id,
              title: v.title,
              channel_title: channel.title,
              views,
              median_views: med,
              multiplier: mult,
              published_at: v.publishedAt,
              ...(v.thumbnailUrl ? { thumbnail_url: v.thumbnailUrl } : {}),
            });
          }
        }
      }
      outliers.sort((a, b) => b.multiplier - a.multiplier);
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    source = "error";
  }

  // Schedule: query scheduled_posts for the user.
  const schedule: ScheduledItem[] = [];
  const sb = getSupabase();
  if (sb) {
    try {
      const cutoff = new Date(Date.now() - 7 * 86400_000).toISOString();
      const horizon = new Date(Date.now() + 30 * 86400_000).toISOString();
      const { data: rows } = await sb
        .from("scheduled_posts")
        .select(
          "id, agent_id, action_type, status, scheduled_for, draft_body, external_account_id, origin",
        )
        .eq("user_id", user.id)
        .in("status", ["queued", "pending", "draft"])
        .gte("scheduled_for", cutoff)
        .lte("scheduled_for", horizon)
        .order("scheduled_for", { ascending: true })
        .limit(50);

      for (const r of (rows ?? []) as Array<{
        id: string;
        agent_id: string;
        action_type: string;
        status: string;
        scheduled_for: string;
        draft_body: { text?: string };
        external_account_id: string | null;
        origin: string;
      }>) {
        schedule.push({
          id: r.id,
          agent_id: r.agent_id,
          action_type: r.action_type,
          status: r.status,
          scheduled_for: r.scheduled_for,
          body_excerpt: (r.draft_body?.text ?? "").slice(0, 140),
          external_account_id: r.external_account_id,
          origin: r.origin,
        });
      }
    } catch (err) {
      console.warn("[workspace/content] schedule read soft-failed", err);
    }
  }

  // Repurpose cues: top 3 outliers each get a suggestion to mirror the
  // hook on a different platform. V1 generates simple template
  // suggestions; V1.x can swap in an LLM call.
  const repurpose_cues: RepurposeCue[] = outliers.slice(0, 3).map((o) => ({
    source_id: o.id,
    source_label: o.title,
    multiplier: o.multiplier,
    suggestion: `Spin off a ${pickShortFormat(o.multiplier)} clip from the opening hook of "${o.title.slice(0, 60)}" — your audience clearly wants more of this angle.`,
    target_platforms: pickRepurposeTargets(o.multiplier),
  }));

  const envelope: ContentEnvelope = {
    generated_at: new Date().toISOString(),
    outliers: outliers.slice(0, 12),
    schedule,
    repurpose_cues,
    source,
    age_ms,
    ...(error ? { error } : {}),
  };
  return NextResponse.json(envelope);
}

function pickShortFormat(multiplier: number): string {
  if (multiplier >= 5) return "60-second cut + Instagram reel";
  if (multiplier >= 3) return "60-second short";
  return "vertical clip";
}

function pickRepurposeTargets(multiplier: number): string[] {
  if (multiplier >= 5) return ["instagram", "x", "linkedin"];
  if (multiplier >= 3) return ["instagram", "x"];
  return ["instagram"];
}
