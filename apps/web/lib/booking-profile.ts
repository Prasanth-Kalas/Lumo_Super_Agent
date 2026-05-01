/**
 * Booking profile autofill.
 *
 * Consent/approval tells us which profile fields the user allowed an app to
 * use. This module turns those approved scopes into a typed snapshot for
 * booking flows so the assistant asks only for genuinely missing data.
 */

import { getSupabase } from "./db.js";
import {
  buildBookingProfileSnapshotFromRows,
  type BookingProfileSnapshot,
} from "./booking-profile-core.js";
import { listSessionAppApprovals } from "./session-app-approvals.js";

export * from "./booking-profile-core.js";

export async function bookingProfileSnapshotForSession(
  userId: string,
  sessionId: string,
): Promise<BookingProfileSnapshot | null> {
  if (!userId || userId === "anon") return null;
  const approvals = await listSessionAppApprovals(userId, sessionId);
  const grantedScopes = approvals
    .filter((approval) => approval.connected_at !== null)
    .flatMap((approval) => approval.granted_scopes);
  if (grantedScopes.length === 0) return null;
  return bookingProfileSnapshot(userId, grantedScopes);
}

export async function bookingProfileSnapshot(
  userId: string,
  grantedScopes: string[],
): Promise<BookingProfileSnapshot | null> {
  const db = getSupabase();
  if (!db || !userId || userId === "anon") return null;

  const [profile, userProfile, paymentMethod, travelerProfile, passport] =
    await Promise.all([
      optionalSingle(
        db
          .from("profiles")
          .select("id, email, full_name")
          .eq("id", userId)
          .maybeSingle(),
      ),
      optionalSingle(
        db
          .from("user_profile")
          .select("display_name, extra")
          .eq("id", userId)
          .maybeSingle(),
      ),
      optionalSingle(
        db
          .from("payment_methods")
          .select("id, brand, last4, exp_month, exp_year, is_default, attached_at")
          .eq("user_id", userId)
          .is("detached_at", null)
          .order("is_default", { ascending: false })
          .order("attached_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ),
      optionalSingle(
        db
          .from("traveler_profiles")
          .select("*")
          .eq("user_id", userId)
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ),
      optionalSingle(
        db
          .from("passports")
          .select("*")
          .eq("user_id", userId)
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ),
    ]);

  return buildBookingProfileSnapshotFromRows({
    userId,
    grantedScopes,
    profile,
    userProfile,
    paymentMethod,
    travelerProfile,
    passport,
  });
}

async function optionalSingle<T>(
  query: PromiseLike<{ data: T | null; error: { message?: string; code?: string } | null }>,
): Promise<T | null> {
  const { data, error } = await query;
  if (!error) return data ?? null;
  const message = error.message ?? "";
  if (
    message.includes("does not exist") ||
    message.includes("schema cache") ||
    error.code === "42P01" ||
    error.code === "PGRST205"
  ) {
    return null;
  }
  console.warn("[booking-profile] optional lookup failed:", message);
  return null;
}
