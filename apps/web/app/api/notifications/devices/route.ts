// STUB for MOBILE-NOTIF-1; production server stores device tokens in a
// `device_tokens` table (or `payments_customers` extension column) per
// the Phase 5 / 4.5 sprints alongside the actual APNs push sender.
//
// GET → returns the registered devices for the signed-in user from
// the in-memory stub store.
// POST → accepts { apnsToken, bundleId, environment } and registers
// or refreshes the device. The iOS NotificationService calls this
// after `application(_:didRegisterForRemoteNotificationsWithDeviceToken:)`
// fires.
import type { NextRequest } from "next/server";
import { getServerUser } from "@/lib/auth";
import {
  listDevices,
  registerDevice,
  resolveNotificationsUserId,
  type ApnsEnvironment,
} from "@/lib/notifications-stub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const userId = await resolveNotificationsUserId(req, getServerUser);
  return json({ devices: listDevices(userId) });
}

export async function POST(req: NextRequest): Promise<Response> {
  const userId = await resolveNotificationsUserId(req, getServerUser);
  const body = (await req.json().catch(() => null)) as {
    apnsToken?: string;
    bundleId?: string;
    environment?: string;
  } | null;

  if (!body) return json({ error: "invalid_json" }, 400);

  const apnsToken =
    typeof body.apnsToken === "string" ? body.apnsToken.trim() : "";
  const bundleId =
    typeof body.bundleId === "string" ? body.bundleId.trim() : "";
  const env = normalizeEnvironment(body.environment);

  // APNs device tokens are 64 hex characters (32 bytes). We don't
  // strictly enforce that here — Apple has signaled longer tokens
  // are coming — but we do reject obviously-bogus inputs.
  if (!apnsToken.match(/^[0-9a-fA-F]{32,}$/)) {
    return json({ error: "invalid_apns_token" }, 400);
  }
  if (!bundleId.match(/^[a-zA-Z0-9.-]{3,}$/)) {
    return json({ error: "invalid_bundle_id" }, 400);
  }

  const device = registerDevice(userId, { apnsToken, bundleId, environment: env });
  return json({ device }, 201);
}

function normalizeEnvironment(raw: unknown): ApnsEnvironment {
  return raw === "production" ? "production" : "sandbox";
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
