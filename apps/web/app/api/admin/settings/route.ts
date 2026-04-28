/**
 * /api/admin/settings — operator console knobs.
 *
 *   GET             list all settings
 *   GET ?key=KEY    read one setting + its recent history
 *   POST            { key, value } upsert one setting
 *
 * Admin-gated via LUMO_ADMIN_EMAILS. Middleware also gates this
 * prefix; the route checks again as defense in depth.
 *
 * Validation: known keys are typed. Unknown keys are rejected so a
 * typo doesn't accidentally create dead settings rows.
 */

import type { NextRequest } from "next/server";
import { requireServerUser } from "@/lib/auth";
import { isAdmin } from "@/lib/publisher/access";
import {
  getSetting,
  listSettings,
  listSettingHistory,
  setSetting,
  type AdminSettingKey,
} from "@/lib/admin-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KNOWN_KEYS: ReadonlySet<AdminSettingKey> = new Set<AdminSettingKey>([
  "llm.model",
  "voice.provider",
  "voice.model",
  "voice.voice_id",
  "voice.stability",
  "voice.similarity_boost",
  "voice.style",
  "feature.mcp_enabled",
  "feature.partner_agents_enabled",
  "feature.voice_mode_enabled",
  "feature.autonomy_enabled",
  "prompt.voice_mode_addendum",
  "prompt.text_mode_addendum",
]);

export async function GET(req: NextRequest): Promise<Response> {
  const user = await requireServerUser();
  if (!isAdmin(user.email)) return json({ error: "forbidden" }, 403);

  const { searchParams } = new URL(req.url);
  const key = searchParams.get("key") as AdminSettingKey | null;

  if (key) {
    if (!KNOWN_KEYS.has(key)) {
      return json({ error: "unknown_key", detail: `Unknown setting: ${key}` }, 400);
    }
    // Bypass the cache for the dashboard — admin should see truth.
    const value = await getSetting<unknown>(key, null);
    const history = await listSettingHistory(key, 20);
    return json({ key, value, history });
  }

  const settings = await listSettings();
  return json({ settings });
}

interface PostBody {
  key?: unknown;
  value?: unknown;
}

export async function POST(req: NextRequest): Promise<Response> {
  const user = await requireServerUser();
  if (!isAdmin(user.email)) return json({ error: "forbidden" }, 403);

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const key = typeof body.key === "string" ? (body.key as AdminSettingKey) : null;
  if (!key || !KNOWN_KEYS.has(key)) {
    return json({ error: "unknown_key", detail: `Unknown setting key.` }, 400);
  }
  if (body.value === undefined) {
    return json({ error: "missing_value" }, 400);
  }

  // Type-check obvious shapes so a fat-fingered admin can't store a
  // string where a number is expected (e.g. voice.stability).
  const validation = validateValue(key, body.value);
  if (validation) return json({ error: "invalid_value", detail: validation }, 400);

  try {
    const row = await setSetting(key, body.value, user.email ?? "admin");
    return json({ setting: row });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
}

/**
 * Lightweight type guard per known key. Returns null when valid,
 * otherwise a human-readable explanation.
 */
function validateValue(key: AdminSettingKey, value: unknown): string | null {
  if (key.startsWith("feature.")) {
    return typeof value === "boolean" ? null : "feature flags must be boolean";
  }
  if (key === "voice.stability" || key === "voice.similarity_boost" || key === "voice.style") {
    if (typeof value !== "number") return `${key} must be a number`;
    if (value < 0 || value > 1) return `${key} must be 0..1`;
    return null;
  }
  if (key.startsWith("voice.") || key === "llm.model") {
    return typeof value === "string" ? null : `${key} must be a string`;
  }
  if (key.startsWith("prompt.")) {
    if (typeof value !== "string") return `${key} must be a string`;
    if (value.length > 8_000) return `${key} too long (max 8000 chars)`;
    return null;
  }
  return null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
