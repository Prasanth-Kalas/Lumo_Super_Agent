import { createHash } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9/_-]*$/;

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const parsed = parseFeedbackBody(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const db = getSupabase();
  if (!db) {
    return NextResponse.json({ ok: true, persisted: false }, { status: 202 });
  }

  const userAgent = req.headers.get("user-agent")?.slice(0, 1024) ?? null;
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    req.headers.get("x-real-ip") ??
    "unknown";
  const anonymousId = `anon:${createHash("sha256")
    .update(`${ip}:${userAgent ?? ""}:${parsed.value.page_id}`)
    .digest("hex")
    .slice(0, 48)}`;

  const { error } = await db.from("docs_page_feedback").insert({
    page_id: parsed.value.page_id,
    user_id: null,
    anonymous_id: anonymousId,
    score: parsed.value.score,
    free_text: parsed.value.free_text,
    url_referrer: req.headers.get("referer")?.slice(0, 2048) ?? null,
    user_agent: userAgent,
  });

  if (error) {
    console.error("[docs] feedback insert failed:", error.message);
    return NextResponse.json({ error: "feedback_unavailable" }, { status: 503 });
  }

  return NextResponse.json({ ok: true, persisted: true });
}

function parseFeedbackBody(input: unknown):
  | { ok: true; value: { page_id: string; score: 1 | -1; free_text: string | null } }
  | { ok: false; error: string } {
  if (!input || typeof input !== "object") return { ok: false, error: "body_required" };
  const record = input as Record<string, unknown>;
  const pageId = String(record.page_id ?? "").trim();
  if (!PAGE_ID_RE.test(pageId) || pageId.includes("..")) {
    return { ok: false, error: "invalid_page_id" };
  }
  const score = Number(record.score);
  if (score !== 1 && score !== -1) return { ok: false, error: "invalid_score" };
  const rawText = typeof record.free_text === "string" ? record.free_text.trim() : "";
  if (rawText.length > 5000) return { ok: false, error: "free_text_too_long" };
  return {
    ok: true,
    value: {
      page_id: pageId,
      score,
      free_text: rawText || null,
    },
  };
}
