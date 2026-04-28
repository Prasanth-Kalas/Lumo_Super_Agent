/**
 * YouTube connector — channels, videos, analytics, comments.
 *
 * Reads the user's YouTube data via two Google APIs that share the same
 * OAuth grant as gmail/calendar/contacts (lib/integrations/google.ts):
 *
 *   - YouTube Data API v3       (channels, videos, comments)
 *   - YouTube Analytics API v2  (per-channel and per-video reports)
 *
 * Wraps every call in lib/connector-archive.ts so the dashboard keeps
 * rendering during quota exhaustion / token expiry / 5xx storms.
 *
 * Write actions (comment replies, video updates, etc.) DO NOT go
 * through the archive — they're committed via scheduled_posts +
 * audit_log_writes. The functions in this module return DRAFT shapes;
 * the actual platform write happens in lib/publish/youtube.ts (a
 * separate file we'll add when we wire the confirmation card).
 *
 * Scopes required (declared in lib/integrations/google.ts):
 *   - youtube.readonly
 *   - youtube.force-ssl              (for comment write — gated by card)
 *   - yt-analytics.readonly
 *   - yt-analytics-monetary.readonly (for revenue, optional)
 *
 * Note on quota: the Data API has a default 10K-units/day quota.
 * Channel-list = 1 unit, video-list = 1 unit per video, comments = 1
 * per comment-thread. We rely on the archive cache to keep us well
 * inside that envelope for the active-user cohort.
 */

import { fetchWithArchive } from "../connector-archive";
import { googleFetchJson, GoogleApiError } from "./google";

export const YOUTUBE_DATA_BASE = "https://www.googleapis.com/youtube/v3";
export const YOUTUBE_ANALYTICS_BASE =
  "https://youtubeanalytics.googleapis.com/v2";

// Logical agent_id used in agent_connections + connected_accounts.
// YouTube shares the Google OAuth grant, so for token retrieval we
// use GOOGLE_AGENT_ID; the YouTube-specific identifier here is for
// archive keys + the connected_accounts.account_type discriminator.
export const YOUTUBE_AGENT_ID = "youtube";

// ──────────────────────────────────────────────────────────────────────────
// Types — minimal surface; expand as tabs need more
// ──────────────────────────────────────────────────────────────────────────

export interface YouTubeChannel {
  id: string;
  title: string;
  description?: string;
  customUrl?: string;
  thumbnailUrl?: string;
  subscriberCount?: number;
  videoCount?: number;
  viewCount?: number;
  hiddenSubscriberCount?: boolean;
}

export interface YouTubeVideoSummary {
  id: string;
  title: string;
  publishedAt: string;
  thumbnailUrl?: string;
  duration_iso?: string;
  views?: number;
  likes?: number;
  comments?: number;
}

export interface YouTubeComment {
  id: string;
  authorDisplayName: string;
  authorChannelId?: string;
  textOriginal: string;
  publishedAt: string;
  likeCount?: number;
  parentId?: string;
  videoId?: string;
}

export interface YouTubeAnalyticsRow {
  // Each row is a record keyed by metric name. Shape depends on which
  // metrics were requested.
  [metric: string]: number | string;
}

// ──────────────────────────────────────────────────────────────────────────
// Channel list — every channel managed by this Google account
// ──────────────────────────────────────────────────────────────────────────

interface ChannelsListResponse {
  items?: Array<{
    id: string;
    snippet?: {
      title: string;
      description?: string;
      customUrl?: string;
      thumbnails?: { default?: { url?: string }; high?: { url?: string } };
    };
    statistics?: {
      subscriberCount?: string;
      videoCount?: string;
      viewCount?: string;
      hiddenSubscriberCount?: boolean;
    };
  }>;
}

/**
 * Lists every channel the user manages. We use this on first connect
 * to populate `connected_accounts` rows, and on the multi-channel
 * selector dropdown in /workspace.
 *
 * Cached aggressively (1 hour) — channels rarely change.
 */
export async function listChannels(args: {
  user_id: string;
  access_token: string;
  force_refresh?: boolean;
}): Promise<{ channels: YouTubeChannel[]; source: "live" | "cached" | "stale"; age_ms: number }> {
  const env = await fetchWithArchive<ChannelsListResponse>(
    {
      user_id: args.user_id,
      agent_id: YOUTUBE_AGENT_ID,
      endpoint: "youtube.channels.list.mine",
      params: {},
    },
    {
      ttl_seconds: 3600,
      force_refresh: args.force_refresh,
      fetcher: async () => {
        const data = await googleFetchJson<ChannelsListResponse>({
          access_token: args.access_token,
          url: `${YOUTUBE_DATA_BASE}/channels`,
          query: {
            part: "snippet,statistics",
            mine: "true",
            maxResults: 50,
          },
        });
        return { data, response_status: 200 };
      },
    },
  );

  const channels: YouTubeChannel[] = (env.data.items ?? []).map((c) => ({
    id: c.id,
    title: c.snippet?.title ?? "(unnamed channel)",
    description: c.snippet?.description,
    customUrl: c.snippet?.customUrl,
    thumbnailUrl:
      c.snippet?.thumbnails?.high?.url ?? c.snippet?.thumbnails?.default?.url,
    subscriberCount: numOrUndef(c.statistics?.subscriberCount),
    videoCount: numOrUndef(c.statistics?.videoCount),
    viewCount: numOrUndef(c.statistics?.viewCount),
    hiddenSubscriberCount: c.statistics?.hiddenSubscriberCount,
  }));
  return { channels, source: env.source, age_ms: env.age_ms };
}

// ──────────────────────────────────────────────────────────────────────────
// Recent videos for a channel
// ──────────────────────────────────────────────────────────────────────────

interface SearchListResponse {
  items?: Array<{
    id?: { videoId?: string };
    snippet?: {
      title?: string;
      publishedAt?: string;
      thumbnails?: { default?: { url?: string }; high?: { url?: string } };
    };
  }>;
}

interface VideosListResponse {
  items?: Array<{
    id: string;
    snippet?: {
      title?: string;
      publishedAt?: string;
      thumbnails?: { default?: { url?: string }; high?: { url?: string } };
    };
    contentDetails?: { duration?: string };
    statistics?: {
      viewCount?: string;
      likeCount?: string;
      commentCount?: string;
    };
  }>;
}

/**
 * Lists the channel's recent uploads with stats. Powers the Today tab
 * "Today's posts" widget and the Content tab outliers panel.
 *
 * Default cache: 5 minutes. Videos appear as new uploads land and stats
 * tick continuously; we don't want stale numbers but we also don't want
 * to spam the API on every dashboard mount.
 */
export async function listRecentVideos(args: {
  user_id: string;
  channel_id: string;
  access_token: string;
  limit?: number;
  force_refresh?: boolean;
}): Promise<{ videos: YouTubeVideoSummary[]; source: "live" | "cached" | "stale"; age_ms: number }> {
  const limit = Math.min(Math.max(args.limit ?? 10, 1), 50);
  const env = await fetchWithArchive<{ search: SearchListResponse; videos: VideosListResponse }>(
    {
      user_id: args.user_id,
      agent_id: YOUTUBE_AGENT_ID,
      external_account_id: args.channel_id,
      endpoint: "youtube.videos.recent",
      params: { limit },
    },
    {
      ttl_seconds: 300,
      force_refresh: args.force_refresh,
      fetcher: async () => {
        // Two-call path: search.list to find recent video IDs, then
        // videos.list to get full statistics. search.list alone can't
        // return stats; videos.list alone can't filter by channel.
        const search = await googleFetchJson<SearchListResponse>({
          access_token: args.access_token,
          url: `${YOUTUBE_DATA_BASE}/search`,
          query: {
            part: "snippet",
            channelId: args.channel_id,
            order: "date",
            type: "video",
            maxResults: limit,
          },
        });
        const ids = (search.items ?? [])
          .map((s) => s.id?.videoId)
          .filter((v): v is string => !!v);
        if (ids.length === 0) {
          return { data: { search, videos: { items: [] } }, response_status: 200 };
        }
        const videos = await googleFetchJson<VideosListResponse>({
          access_token: args.access_token,
          url: `${YOUTUBE_DATA_BASE}/videos`,
          query: {
            part: "snippet,contentDetails,statistics",
            id: ids.join(","),
            maxResults: limit,
          },
        });
        return { data: { search, videos }, response_status: 200 };
      },
    },
  );

  const videos: YouTubeVideoSummary[] = (env.data.videos.items ?? []).map((v) => ({
    id: v.id,
    title: v.snippet?.title ?? "(untitled)",
    publishedAt: v.snippet?.publishedAt ?? "",
    thumbnailUrl:
      v.snippet?.thumbnails?.high?.url ?? v.snippet?.thumbnails?.default?.url,
    duration_iso: v.contentDetails?.duration,
    views: numOrUndef(v.statistics?.viewCount),
    likes: numOrUndef(v.statistics?.likeCount),
    comments: numOrUndef(v.statistics?.commentCount),
  }));
  return { videos, source: env.source, age_ms: env.age_ms };
}

// ──────────────────────────────────────────────────────────────────────────
// Comment threads for a video
// ──────────────────────────────────────────────────────────────────────────

interface CommentThreadsResponse {
  items?: Array<{
    id?: string;
    snippet?: {
      videoId?: string;
      topLevelComment?: {
        id?: string;
        snippet?: {
          authorDisplayName?: string;
          authorChannelId?: { value?: string };
          textOriginal?: string;
          textDisplay?: string;
          publishedAt?: string;
          likeCount?: number;
        };
      };
      totalReplyCount?: number;
    };
  }>;
}

/**
 * Lists top-level comment threads on a video. Drives the Inbox tab
 * unified comments stream. We fetch text-original (not text-display) so
 * AI-drafted replies operate on the user's actual phrasing without
 * HTML entities.
 */
export async function listVideoComments(args: {
  user_id: string;
  video_id: string;
  access_token: string;
  limit?: number;
  force_refresh?: boolean;
}): Promise<{ comments: YouTubeComment[]; source: "live" | "cached" | "stale"; age_ms: number }> {
  const limit = Math.min(Math.max(args.limit ?? 25, 1), 100);
  const env = await fetchWithArchive<CommentThreadsResponse>(
    {
      user_id: args.user_id,
      agent_id: YOUTUBE_AGENT_ID,
      endpoint: "youtube.commentThreads.list",
      params: { video_id: args.video_id, limit },
    },
    {
      ttl_seconds: 180,
      force_refresh: args.force_refresh,
      fetcher: async () => {
        const data = await googleFetchJson<CommentThreadsResponse>({
          access_token: args.access_token,
          url: `${YOUTUBE_DATA_BASE}/commentThreads`,
          query: {
            part: "snippet",
            videoId: args.video_id,
            maxResults: limit,
            order: "time",
          },
        });
        return { data, response_status: 200 };
      },
    },
  );

  const comments: YouTubeComment[] = [];
  for (const t of env.data.items ?? []) {
    const top = t.snippet?.topLevelComment;
    const s = top?.snippet;
    if (!top?.id || !s) continue;
    const c: YouTubeComment = {
      id: top.id,
      videoId: t.snippet?.videoId ?? args.video_id,
      authorDisplayName: s.authorDisplayName ?? "(unknown)",
      textOriginal: s.textOriginal ?? s.textDisplay ?? "",
      publishedAt: s.publishedAt ?? "",
    };
    if (s.authorChannelId?.value) c.authorChannelId = s.authorChannelId.value;
    if (typeof s.likeCount === "number") c.likeCount = s.likeCount;
    comments.push(c);
  }
  return { comments, source: env.source, age_ms: env.age_ms };
}

// ──────────────────────────────────────────────────────────────────────────
// Channel-level analytics (last-30d view counts, top traffic sources)
// ──────────────────────────────────────────────────────────────────────────

interface AnalyticsReportResponse {
  columnHeaders?: Array<{ name: string; columnType?: string; dataType?: string }>;
  rows?: Array<Array<string | number>>;
}

/**
 * One report endpoint per chart on the dashboard. We park the dimension
 * + metric set as params on the archive so we can fetch many shapes
 * without colliding cache rows.
 *
 * Default window: last 30 days. Caller can override.
 */
export async function channelAnalytics(args: {
  user_id: string;
  channel_id: string;
  access_token: string;
  metrics?: string[];
  dimensions?: string[];
  start_date?: string;       // YYYY-MM-DD
  end_date?: string;         // YYYY-MM-DD
  sort?: string;
  max_results?: number;
  force_refresh?: boolean;
}): Promise<{
  rows: YouTubeAnalyticsRow[];
  columnHeaders: Array<{ name: string }>;
  source: "live" | "cached" | "stale";
  age_ms: number;
}> {
  const metrics = args.metrics ?? ["views", "estimatedMinutesWatched", "averageViewDuration"];
  const dimensions = args.dimensions ?? ["day"];
  const end = args.end_date ?? new Date().toISOString().slice(0, 10);
  const start =
    args.start_date ??
    new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);

  const env = await fetchWithArchive<AnalyticsReportResponse>(
    {
      user_id: args.user_id,
      agent_id: YOUTUBE_AGENT_ID,
      external_account_id: args.channel_id,
      endpoint: "youtube.analytics.reports",
      params: {
        metrics: metrics.slice().sort(),
        dimensions: dimensions.slice().sort(),
        start_date: start,
        end_date: end,
        sort: args.sort,
        max_results: args.max_results,
      },
    },
    {
      ttl_seconds: 900, // 15 min — analytics moves slower than comments
      force_refresh: args.force_refresh,
      keep_for_history: dimensions.includes("day"), // preserve daily snapshots
      fetcher: async () => {
        const data = await googleFetchJson<AnalyticsReportResponse>({
          access_token: args.access_token,
          url: `${YOUTUBE_ANALYTICS_BASE}/reports`,
          query: {
            ids: `channel==${args.channel_id}`,
            metrics: metrics.join(","),
            dimensions: dimensions.join(","),
            startDate: start,
            endDate: end,
            sort: args.sort,
            maxResults: args.max_results,
          },
        });
        return { data, response_status: 200 };
      },
    },
  );

  const headers = env.data.columnHeaders ?? [];
  const rows: YouTubeAnalyticsRow[] = (env.data.rows ?? []).map((row) => {
    const out: YouTubeAnalyticsRow = {};
    for (let i = 0; i < headers.length; i++) {
      const h = headers[i];
      const v = row[i];
      if (h && v !== undefined) out[h.name] = v;
    }
    return out;
  });
  return {
    rows,
    columnHeaders: headers.map((h) => ({ name: h.name })),
    source: env.source,
    age_ms: env.age_ms,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Drafting a reply — does NOT publish; returns the draft for the
// confirmation card to render.
// ──────────────────────────────────────────────────────────────────────────

export interface YouTubeReplyDraft {
  agent_id: typeof YOUTUBE_AGENT_ID;
  action_type: "comment_reply";
  parent_comment_id: string;
  video_id?: string;
  body: { text: string };
  meta: {
    parent_author?: string;
    parent_text?: string;
  };
}

/**
 * Builds a reply draft. Pure function — the LLM-generated body is
 * passed in by the orchestrator. No platform call here.
 */
export function buildReplyDraft(args: {
  parent_comment_id: string;
  reply_text: string;
  video_id?: string;
  parent_author?: string;
  parent_text?: string;
}): YouTubeReplyDraft {
  const trimmed = args.reply_text.trim();
  if (trimmed.length === 0) {
    throw new Error("reply_text is empty after trim");
  }
  if (trimmed.length > 10_000) {
    // YouTube's hard cap is 10K chars; we surface this early instead of
    // letting the platform reject it.
    throw new Error(`reply_text is ${trimmed.length} chars; YouTube max is 10000`);
  }
  return {
    agent_id: YOUTUBE_AGENT_ID,
    action_type: "comment_reply",
    parent_comment_id: args.parent_comment_id,
    video_id: args.video_id,
    body: { text: trimmed },
    meta: {
      parent_author: args.parent_author,
      parent_text: args.parent_text,
    },
  };
}

/**
 * Internal: actually post a reply to YouTube. ONLY called from the
 * publish path after the confirmation card has been approved. Not
 * exported beyond the publish layer.
 *
 * Returns YouTube's commentThread/comment ID so we can deep-link from
 * the audit log.
 */
export async function executeReplyPublish(args: {
  access_token: string;
  parent_comment_id: string;
  text: string;
}): Promise<{ comment_id: string; raw: unknown }> {
  type CommentInsertResponse = {
    id?: string;
  };
  const body = {
    snippet: {
      parentId: args.parent_comment_id,
      textOriginal: args.text,
    },
  };
  const data = await googleFetchJson<CommentInsertResponse>({
    access_token: args.access_token,
    url: `${YOUTUBE_DATA_BASE}/comments`,
    method: "POST",
    query: { part: "snippet" },
    body,
  });
  if (!data.id) {
    throw new GoogleApiError(502, "YouTube returned no comment id on insert");
  }
  return { comment_id: data.id, raw: data };
}

// ──────────────────────────────────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────────────────────────────────

function numOrUndef(s: string | number | undefined): number | undefined {
  if (s === undefined || s === null) return undefined;
  const n = typeof s === "number" ? s : parseInt(s, 10);
  return Number.isFinite(n) ? n : undefined;
}
