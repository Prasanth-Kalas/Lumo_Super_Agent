import type { NextRequest } from "next/server";
import { AuthError, requireServerUser } from "@/lib/auth";
import {
  DEEPGRAM_TOKEN_TTL_SECONDS,
  createDeepgramTemporaryToken,
} from "@/lib/deepgram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const WINDOW_MS = 60_000;
const MAX_TOKENS_PER_WINDOW = 30;
const buckets = new Map<string, { count: number; resetAt: number }>();

export async function POST(req: NextRequest): Promise<Response> {
  let user;
  try {
    user = await requireServerUser();
  } catch (error) {
    if (error instanceof AuthError) {
      return json({ error: error.code }, error.code === "not_authenticated" ? 401 : 403);
    }
    throw error;
  }

  const rate = checkRateLimit(`${user.id}:${clientIp(req)}`);
  if (!rate.ok) {
    return json(
      { error: "rate_limited", retry_after_seconds: rate.retryAfterSeconds },
      429,
      { "retry-after": String(rate.retryAfterSeconds) },
    );
  }

  const result = await createDeepgramTemporaryToken({
    ttlSeconds: DEEPGRAM_TOKEN_TTL_SECONDS,
  });
  if (!result.ok) {
    return json({ error: result.error }, result.status);
  }
  return json(
    {
      token: result.result.token,
      expires_at: result.result.expires_at,
    },
    200,
  );
}

function checkRateLimit(key: string): { ok: true } | { ok: false; retryAfterSeconds: number } {
  const now = Date.now();
  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { ok: true };
  }
  if (existing.count >= MAX_TOKENS_PER_WINDOW) {
    return {
      ok: false,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }
  existing.count += 1;
  return { ok: true };
}

function clientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

function json(body: unknown, status: number, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}
