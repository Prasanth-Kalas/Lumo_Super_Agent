/**
 * STUB for MOBILE-NOTIF-1.
 *
 * In-memory store for device push tokens, scoped per user. Production
 * replacement lives in a `device_tokens` table per the Phase 5 / 4.5
 * sprints — likely a column on `payments_customers` (1:1) or its own
 * table keyed by (user_id, device_id) so a user can have multiple
 * devices registered simultaneously.
 *
 * State is module-level and process-volatile — fine for a dev stub
 * but insufficient for production push delivery (a server restart
 * would invalidate every registered device). The actual push-sender
 * (Phase 4.5+) will read from Postgres, not this module.
 */

export type ApnsEnvironment = "sandbox" | "production";

export interface StubDeviceToken {
  id: string;
  apnsToken: string;
  bundleId: string;
  environment: ApnsEnvironment;
  registeredAt: string;
  /// Last server-acknowledged push attempt — for completeness; the
  /// stub never actually sends. Production sender will record it.
  lastSeenAt: string;
}

interface StubUserState {
  devices: StubDeviceToken[];
}

const userState = new Map<string, StubUserState>();

function ensureUserState(userId: string): StubUserState {
  let state = userState.get(userId);
  if (!state) {
    state = { devices: [] };
    userState.set(userId, state);
  }
  return state;
}

export function listDevices(userId: string): StubDeviceToken[] {
  return ensureUserState(userId).devices.slice();
}

/**
 * Register or refresh a device token. If the same `apnsToken` already
 * exists for the user, we update `bundleId` / `environment` /
 * `lastSeenAt` rather than producing a duplicate row — APNs tokens
 * can rotate but the same physical device may re-register on every
 * cold launch.
 */
export function registerDevice(
  userId: string,
  input: { apnsToken: string; bundleId: string; environment: ApnsEnvironment },
): StubDeviceToken {
  const state = ensureUserState(userId);
  const now = new Date().toISOString();
  const existing = state.devices.find((d) => d.apnsToken === input.apnsToken);
  if (existing) {
    existing.bundleId = input.bundleId;
    existing.environment = input.environment;
    existing.lastSeenAt = now;
    return existing;
  }
  const device: StubDeviceToken = {
    id: `dev_${cryptoRandom(12)}`,
    apnsToken: input.apnsToken,
    bundleId: input.bundleId,
    environment: input.environment,
    registeredAt: now,
    lastSeenAt: now,
  };
  state.devices.push(device);
  return device;
}

export function unregisterDevice(userId: string, deviceId: string): boolean {
  const state = ensureUserState(userId);
  const before = state.devices.length;
  state.devices = state.devices.filter((d) => d.id !== deviceId);
  return state.devices.length < before;
}

/// Test-only reset for routes-level tests.
export function resetNotificationsStub(): void {
  userState.clear();
}

/**
 * Resolve the user ID for a notifications route. Mirrors the same
 * pattern in `lib/payments-stub.ts` — try Supabase auth, fall back to
 * the `x-lumo-user-id` header for iOS dev (no browser cookies),
 * default to "anon". Production drops the header fallback and
 * requires real auth.
 */
export async function resolveNotificationsUserId(
  req: { headers: Headers },
  getServerUser: () => Promise<{ id: string } | null>,
): Promise<string> {
  const authed = await getServerUser();
  if (authed) return authed.id;
  const header = req.headers.get("x-lumo-user-id");
  if (header && header.trim().length > 0) return header.trim();
  return "anon";
}

function cryptoRandom(bytes: number): string {
  const arr = new Uint8Array(bytes);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(arr);
  } else {
    for (let i = 0; i < bytes; i += 1) arr[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}
