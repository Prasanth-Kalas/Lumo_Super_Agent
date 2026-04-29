// STUB for MOBILE-NOTIF-1; production swap is `/api/workspace/proactive-moments`
// GET, which already exists and reads from Supabase via the
// `next_proactive_moment_for_user` RPC. The reason this stub exists
// rather than the iOS client calling the workspace endpoint directly:
//
// 1. The workspace endpoint requires real Supabase auth (no
//    x-lumo-user-id header fallback). iOS dev builds without
//    Supabase auth need a path.
// 2. Background fetch (BGTaskScheduler) needs deterministic content
//    for screenshot capture + smoke testing. A stub yields the same
//    seed every call.
//
// MERCHANT-1-style swap: when iOS auth flows through Supabase
// cookies, replace this route with a redirect to
// `/api/workspace/proactive-moments` or generalize the workspace
// endpoint to accept the header fallback.
import type { NextRequest } from "next/server";
import { getServerUser } from "@/lib/auth";
import { resolveNotificationsUserId } from "@/lib/notifications-stub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const userId = await resolveNotificationsUserId(req, getServerUser);
  // Synthetic seed — covers the four notification categories so the
  // iOS client can render each card type in the in-app feed without
  // a real Phase 3 proactive scanner having run on this user.
  const now = new Date();
  const moments = [
    {
      id: `mom_stub_${userId.slice(0, 4)}_1`,
      category: "trip-update" as const,
      headline: "Flight UA 234 to LAS departs in 3 hours",
      body: "Gate B12, on time. Tap to see your full itinerary.",
      primaryAction: { label: "View trip", deeplink: "lumo://trips/upcoming" },
      createdAt: new Date(now.getTime() - 30 * 60_000).toISOString(),
      expiresAt: new Date(now.getTime() + 3 * 3_600_000).toISOString(),
    },
    {
      id: `mom_stub_${userId.slice(0, 4)}_2`,
      category: "proactive-suggestion" as const,
      headline: "You have a 3-day weekend coming up",
      body: "Memorial Day weekend is May 23–25. Want me to surface ~$800 trip ideas?",
      primaryAction: {
        label: "Plan weekend",
        chatPrefill: "Plan a 3-day weekend trip for me May 23–25, around $800 all-in.",
      },
      createdAt: new Date(now.getTime() - 2 * 3_600_000).toISOString(),
      expiresAt: new Date(now.getTime() + 24 * 3_600_000).toISOString(),
    },
    {
      id: `mom_stub_${userId.slice(0, 4)}_3`,
      category: "payment-receipt" as const,
      headline: "Receipt available — Acme Hotel",
      body: "Two-night stay confirmed. Tap to view your receipt.",
      primaryAction: { label: "View receipt", deeplink: "lumo://receipts/recent" },
      createdAt: new Date(now.getTime() - 6 * 3_600_000).toISOString(),
      expiresAt: new Date(now.getTime() + 18 * 3_600_000).toISOString(),
    },
  ];
  return json({
    generatedAt: now.toISOString(),
    moments,
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}
