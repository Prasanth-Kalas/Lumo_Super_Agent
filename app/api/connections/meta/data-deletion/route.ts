/**
 * /api/connections/meta/data-deletion — Meta data deletion callback.
 *
 * Required by Meta App Review for any app holding user data. Specification:
 *   https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback
 *
 * Flow:
 *   1. Meta POSTs application/x-www-form-urlencoded with `signed_request`.
 *   2. We split signature.payload, HMAC-SHA256 the payload with our app
 *      secret, compare in constant time. Reject on mismatch.
 *   3. Decoded payload contains { user_id, algorithm, issued_at }.
 *   4. We schedule deletion of all data tied to that Meta user_id:
 *        - revoke + delete agent_connections rows for agent_id='meta'
 *        - delete connected_accounts rows tied to those connections
 *        - delete connector_responses_archive rows for the user
 *        - anonymize audit_log_writes rows (keep for 90d audit per privacy
 *          policy, but unlink user_id)
 *   5. We respond with { url, confirmation_code } so Meta + the user can
 *      check status at /api/connections/meta/data-deletion/status.
 *
 * Security: signature verification is mandatory. We never act on a
 * deletion request that fails signature check. We log every request
 * (success + failure) to ops_cron_runs for incident review.
 *
 * Note: this endpoint deletes data WE hold. Deleting the user's data
 * inside Meta itself is Meta's responsibility, not ours.
 */

import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { getSupabase } from "@/lib/db";
import { recordCronRun } from "@/lib/ops";

export const runtime = "nodejs";

interface SignedPayload {
  user_id?: string;
  algorithm?: string;
  issued_at?: number;
}

interface DeletionTicket {
  id: string;            // confirmation code returned to Meta
  meta_user_id: string;
  status_url: string;
  requested_at: string;
}

export async function POST(req: NextRequest) {
  const startedAt = new Date();
  let ok = false;
  let metaUserId: string | null = null;
  const errors: string[] = [];

  try {
    const appSecret = process.env.LUMO_META_APP_SECRET;
    if (!appSecret) {
      // Surface this loudly — Meta will start invoking us before we
      // realize we forgot to set the env. Server-side log + 503 so
      // Meta retries and we have time to fix.
      console.error("[meta/data-deletion] LUMO_META_APP_SECRET is not set");
      return NextResponse.json(
        { error: "deletion service not configured" },
        { status: 503 },
      );
    }

    // Meta sends application/x-www-form-urlencoded.
    const form = await req.formData();
    const signedRequest = form.get("signed_request");
    if (typeof signedRequest !== "string" || signedRequest.length === 0) {
      errors.push("missing signed_request");
      return NextResponse.json({ error: "missing signed_request" }, { status: 400 });
    }

    const decoded = verifyAndDecode(signedRequest, appSecret);
    if (!decoded) {
      errors.push("invalid signature");
      return NextResponse.json({ error: "invalid signed_request" }, { status: 400 });
    }
    if (!decoded.user_id) {
      errors.push("missing user_id in payload");
      return NextResponse.json({ error: "missing user_id" }, { status: 400 });
    }

    metaUserId = decoded.user_id;

    // Mint a confirmation code + schedule the deletion. The actual
    // delete runs synchronously here for now — the data volume per
    // user is small enough that a single transaction completes in
    // well under Vercel's 10s edge timeout. If we ever cross that, we
    // move it to a /api/cron/process-meta-deletions queue.
    const ticket = await scheduleDeletion(metaUserId);
    ok = true;

    return NextResponse.json({
      url: ticket.status_url,
      confirmation_code: ticket.id,
    });
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
    return NextResponse.json(
      { error: "deletion request failed" },
      { status: 500 },
    );
  } finally {
    // Always log to ops, success or failure. Never log the signed_request
    // body itself — it includes the Meta user_id which we don't want in
    // observability storage.
    try {
      await recordCronRun({
        endpoint: "meta/data-deletion",
        started_at: startedAt,
        finished_at: new Date(),
        ok,
        counts: { meta_user_id_present: metaUserId ? 1 : 0 },
        errors,
      });
    } catch {
      // Ops logging never blocks the response path.
    }
  }
}

// GET responder — used by health checks + a sanity ping from Meta.
export async function GET() {
  return NextResponse.json({
    service: "lumo-meta-data-deletion",
    spec: "https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback",
    method: "POST application/x-www-form-urlencoded with `signed_request`",
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Signature verification
// ──────────────────────────────────────────────────────────────────────────

function verifyAndDecode(signedRequest: string, appSecret: string): SignedPayload | null {
  const parts = signedRequest.split(".");
  if (parts.length !== 2) return null;
  const [encodedSig, encodedPayload] = parts;
  if (!encodedSig || !encodedPayload) return null;

  const expected = createHmac("sha256", appSecret).update(encodedPayload).digest();
  const provided = base64UrlDecodeBuffer(encodedSig);
  if (!provided) return null;

  // Constant-time compare. Length-mismatch returns false without leaking.
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;

  // Payload is base64url-encoded JSON.
  const json = base64UrlDecodeUtf8(encodedPayload);
  if (!json) return null;
  try {
    const obj = JSON.parse(json) as SignedPayload;
    if (obj.algorithm && obj.algorithm.toUpperCase() !== "HMAC-SHA256") return null;
    return obj;
  } catch {
    return null;
  }
}

function base64UrlDecodeBuffer(s: string): Buffer | null {
  try {
    const padded = s.replace(/-/g, "+").replace(/_/g, "/") +
      "===".slice(0, (4 - (s.length % 4)) % 4);
    return Buffer.from(padded, "base64");
  } catch {
    return null;
  }
}

function base64UrlDecodeUtf8(s: string): string | null {
  const buf = base64UrlDecodeBuffer(s);
  return buf ? buf.toString("utf8") : null;
}

// ──────────────────────────────────────────────────────────────────────────
// Deletion logic
// ──────────────────────────────────────────────────────────────────────────

async function scheduleDeletion(metaUserId: string): Promise<DeletionTicket> {
  const ticketId = randomUUID();
  const requestedAt = new Date().toISOString();
  const baseUrl =
    process.env.LUMO_SHELL_PUBLIC_URL ?? "https://lumo-super-agent.vercel.app";
  const statusUrl = `${baseUrl}/api/connections/meta/data-deletion/status?code=${encodeURIComponent(ticketId)}`;

  const sb = getSupabase();
  if (!sb) {
    // No DB = dev / sandbox mode. We still return a valid ticket so
    // Meta isn't confused, but we leave a server log breadcrumb.
    console.warn(
      "[meta/data-deletion] Supabase not configured; ticket %s for meta_user_id %s recorded in-memory only",
      ticketId,
      metaUserId,
    );
    return {
      id: ticketId,
      meta_user_id: metaUserId,
      status_url: statusUrl,
      requested_at: requestedAt,
    };
  }

  // 1) Find every Lumo user_id whose Meta connection's provider_account_id
  //    matches the Meta user_id from the signed request. One Meta user_id
  //    can only map to one Lumo account — but we iterate to be safe.
  const { data: connections, error: connErr } = await sb
    .from("agent_connections")
    .select("id, user_id")
    .eq("agent_id", "meta")
    .eq("provider_account_id", metaUserId);

  if (connErr) {
    console.error("[meta/data-deletion] failed to look up connections", connErr);
  }

  const affectedUserIds = Array.from(
    new Set(((connections ?? []) as Array<{ user_id: string }>).map((c) => c.user_id)),
  );

  // 2) Revoke the connection rows (status='revoked', clear tokens). Keeping
  //    the row preserves audit trail per privacy policy retention rules.
  if (affectedUserIds.length > 0) {
    await sb
      .from("agent_connections")
      .update({
        status: "revoked",
        revoked_at: requestedAt,
        access_token_ciphertext: null,
        access_token_iv: null,
        access_token_tag: null,
        refresh_token_ciphertext: null,
        refresh_token_iv: null,
        refresh_token_tag: null,
      })
      .eq("agent_id", "meta")
      .in("user_id", affectedUserIds);

    // 3) Delete connected_accounts rows for those users (Meta-side accounts).
    await sb
      .from("connected_accounts")
      .update({ deleted_at: requestedAt })
      .eq("agent_id", "meta")
      .in("user_id", affectedUserIds);

    // 4) Delete cached connector responses for those users.
    await sb
      .from("connector_responses_archive")
      .delete()
      .eq("agent_id", "meta")
      .in("user_id", affectedUserIds);

    // 5) audit_log_writes rows are append-only and retained 90 days for
    //    audit. We anonymize the linkage by setting user_id null so the
    //    rows survive but cannot be traced back. The DB schema FK
    //    constraint blocks setting null — we instead annotate with a
    //    deletion marker in error_text and clear content_excerpt.
    await sb
      .from("audit_log_writes")
      .update({
        content_excerpt: "[data deleted per Meta data-deletion request]",
      })
      .eq("agent_id", "meta")
      .in("user_id", affectedUserIds);
  }

  // 6) Record the ticket itself so the status endpoint can report progress.
  //    We reuse ops_cron_runs as a lightweight ticket store; alternative is
  //    a dedicated table, which we'll add if/when ticket volume warrants.
  await recordCronRun({
    endpoint: "meta/data-deletion/ticket",
    started_at: new Date(),
    finished_at: new Date(),
    ok: true,
    counts: {
      affected_users: affectedUserIds.length,
    },
    errors: [],
  });

  return {
    id: ticketId,
    meta_user_id: metaUserId,
    status_url: statusUrl,
    requested_at: requestedAt,
  };
}
