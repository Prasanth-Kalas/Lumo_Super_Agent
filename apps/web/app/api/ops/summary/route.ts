/**
 * GET /api/ops/summary
 *
 * Operator dashboard feed. Admin-only via LUMO_ADMIN_EMAILS allowlist.
 * Non-admin authed users get 403; logged-out users are redirected by
 * middleware before reaching here.
 *
 * Returns four sections: crons, autonomy, patterns, notifications.
 * No PII.
 */

import { requireServerUser } from "@/lib/auth";
import {
  autonomyStats,
  cronHealth,
  isAdminEmail,
  notificationStats,
  patternStats,
} from "@/lib/ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const user = await requireServerUser();
  if (!isAdminEmail(user.email ?? "")) {
    return json({ error: "forbidden" }, 403);
  }

  const [crons, autonomy, patterns, notifications] = await Promise.all([
    cronHealth(),
    autonomyStats(),
    patternStats(),
    notificationStats(),
  ]);

  return json({
    crons,
    autonomy,
    patterns,
    notifications,
    generated_at: new Date().toISOString(),
  });
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}
