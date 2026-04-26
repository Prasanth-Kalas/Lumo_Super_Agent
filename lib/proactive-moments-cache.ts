import type { ProactiveMomentsEnvelope } from "./proactive-moments-core.js";

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { expires_at: number; envelope: ProactiveMomentsEnvelope }>();

export function getCachedProactiveMoments(user_id: string, nowMs = Date.now()): ProactiveMomentsEnvelope | null {
  const hit = cache.get(user_id);
  if (!hit || hit.expires_at <= nowMs) {
    if (hit) cache.delete(user_id);
    return null;
  }
  return hit.envelope;
}

export function setCachedProactiveMoments(
  user_id: string,
  envelope: ProactiveMomentsEnvelope,
  nowMs = Date.now(),
): void {
  cache.set(user_id, { envelope, expires_at: nowMs + CACHE_TTL_MS });
}

export function invalidateCachedProactiveMoments(user_id: string): void {
  cache.delete(user_id);
}
