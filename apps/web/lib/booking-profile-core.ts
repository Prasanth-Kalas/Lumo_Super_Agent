/**
 * Pure booking profile autofill helpers.
 *
 * The Supabase-backed lookup lives in booking-profile.ts. This module stays
 * dependency-free so prompt generation and unit tests can use the same snapshot
 * shaping without pulling in runtime-only database clients.
 */

export type BookingProfileFieldName =
  | "name"
  | "email"
  | "phone"
  | "payment_method_id"
  | "traveler_profile"
  | "passport"
  | "passport_optional"
  | "dob";

export type BookingProfileFieldStatus = "present" | "missing" | "not_in_scope";

export interface BookingProfileField<T> {
  status: BookingProfileFieldStatus;
  value: T | null;
  label?: string | null;
  source?: string | null;
}

export interface BookingPaymentMethod {
  id: string;
  brand: string;
  last4: string;
  exp_month: number | null;
  exp_year: number | null;
  label: string;
}

export interface BookingTravelerProfile {
  type: "adult" | "child" | "infant_without_seat";
  given_name?: string;
  family_name?: string;
  email?: string;
  phone_number?: string;
  born_on?: string;
  title?: string;
  gender?: string;
  source: "traveler_profiles" | "profile";
}

export interface BookingPassport {
  number?: string;
  issuing_country_code?: string;
  expires_on?: string;
  source: "passports" | "traveler_profile";
}

export interface BookingProfileSnapshot {
  user_id: string;
  granted_scopes: string[];
  fields: {
    name: BookingProfileField<string>;
    email: BookingProfileField<string>;
    phone: BookingProfileField<string>;
    payment_method_id: BookingProfileField<BookingPaymentMethod>;
    traveler_profile: BookingProfileField<BookingTravelerProfile[]>;
    passport: BookingProfileField<BookingPassport>;
    passport_optional: BookingProfileField<BookingPassport>;
    dob: BookingProfileField<string>;
  };
  required_missing_fields: BookingProfileFieldName[];
  prefill_summary: string | null;
}

export interface BookingProfileSnapshotRows {
  userId: string;
  grantedScopes: string[];
  profile?: Record<string, unknown> | null;
  userProfile?: Record<string, unknown> | null;
  paymentMethod?: Record<string, unknown> | null;
  travelerProfile?: Record<string, unknown> | null;
  passport?: Record<string, unknown> | null;
}

const FIELD_ORDER: BookingProfileFieldName[] = [
  "name",
  "email",
  "phone",
  "payment_method_id",
  "traveler_profile",
  "passport",
  "passport_optional",
  "dob",
];

const OPTIONAL_FIELDS = new Set<BookingProfileFieldName>(["passport_optional"]);

export function buildBookingProfileSnapshotFromRows(
  rows: BookingProfileSnapshotRows,
): BookingProfileSnapshot {
  const scopeSet = normalizeBookingScopes(rows.grantedScopes);
  const profile = rows.profile ?? {};
  const userProfile = rows.userProfile ?? {};
  const extra = isRecord(userProfile.extra) ? userProfile.extra : {};

  const name =
    stringAt(profile, "full_name") ??
    stringAt(userProfile, "display_name") ??
    stringAt(extra, "full_name") ??
    stringAt(extra, "name");
  const email = stringAt(profile, "email") ?? stringAt(extra, "email");
  const phone =
    stringAt(profile, "phone") ??
    stringAt(extra, "phone") ??
    stringAt(extra, "phone_number") ??
    stringAt(extra, "mobile_phone");
  const dob =
    stringAt(extra, "dob") ??
    stringAt(extra, "date_of_birth") ??
    stringAt(rows.travelerProfile ?? {}, "born_on");
  const paymentMethod = normalizePaymentMethod(rows.paymentMethod);
  const travelerProfile = normalizeTravelerProfile(rows.travelerProfile, {
    name,
    email,
    phone,
    dob,
  });
  const passport = normalizePassport(rows.passport, rows.travelerProfile);

  const fields: BookingProfileSnapshot["fields"] = {
    name: field(scopeSet, "name", name, name ? "profiles.full_name" : null),
    email: field(scopeSet, "email", email, email ? "profiles.email" : null),
    phone: field(scopeSet, "phone", phone, phone ? "profile.extra.phone" : null),
    payment_method_id: field(
      scopeSet,
      "payment_method_id",
      paymentMethod,
      paymentMethod?.label ?? null,
      paymentMethod ? "payment_methods.default" : null,
    ),
    traveler_profile: field(
      scopeSet,
      "traveler_profile",
      travelerProfile.length ? travelerProfile : null,
      travelerProfile.length ? travelerLabel(travelerProfile[0]) : null,
      travelerProfile.length ? travelerProfile[0]?.source ?? null : null,
    ),
    passport: field(
      scopeSet,
      "passport",
      passport,
      passport ? "Passport on file" : null,
      passport?.source ?? null,
    ),
    passport_optional: field(
      scopeSet,
      "passport_optional",
      passport,
      passport ? "Passport on file" : null,
      passport?.source ?? null,
    ),
    dob: field(scopeSet, "dob", dob, dob ? "profile.extra.dob" : null),
  };

  const required_missing_fields = FIELD_ORDER.filter(
    (key) => fields[key].status === "missing" && !OPTIONAL_FIELDS.has(key),
  );

  return {
    user_id: rows.userId,
    granted_scopes: Array.from(new Set(rows.grantedScopes)).sort(),
    fields,
    required_missing_fields,
    prefill_summary: buildPrefillSummary(fields),
  };
}

export function bookingProfileSnapshotToPii(
  snapshot: BookingProfileSnapshot | null,
): Record<string, unknown> {
  if (!snapshot) return {};
  const out: Record<string, unknown> = {};
  if (snapshot.fields.name.status === "present") out.name = snapshot.fields.name.value;
  if (snapshot.fields.email.status === "present") out.email = snapshot.fields.email.value;
  if (snapshot.fields.phone.status === "present") out.phone = snapshot.fields.phone.value;
  if (snapshot.fields.dob.status === "present") out.dob = snapshot.fields.dob.value;
  if (snapshot.fields.payment_method_id.status === "present") {
    out.payment_method_id = snapshot.fields.payment_method_id.value?.id;
    out.payment_method_label = snapshot.fields.payment_method_id.value?.label;
  }
  if (snapshot.fields.traveler_profile.status === "present") {
    out.traveler_profile = snapshot.fields.traveler_profile.value;
  }
  if (snapshot.fields.passport.status === "present") {
    out.passport = snapshot.fields.passport.value;
  }
  return out;
}

export function bookingProfileSnapshotToPrompt(
  snapshot: BookingProfileSnapshot | null,
): string {
  if (!snapshot) return "";
  const lines = FIELD_ORDER.map((key) => {
    const fieldValue = snapshot.fields[key];
    const status = fieldValue.status;
    const label =
      fieldValue.label ??
      (fieldValue.value === null ? null : String(fieldValue.value));
    return `- ${key}: ${status}${label ? ` (${label})` : ""}`;
  });
  const missing = snapshot.required_missing_fields;
  return [
    "",
    "BOOKING PROFILE PREFILL:",
    ...lines,
    missing.length
      ? `Missing required booking fields: ${missing.join(", ")}. Ask only for these fields.`
      : `All required booking fields that are in scope are present. Do not ask for name, email, phone, traveler, or payment details; proceed to the confirmation card and summarize the prefilled values.`,
    snapshot.prefill_summary ? `Prefill summary: ${snapshot.prefill_summary}` : "",
    "Offer overrides when appropriate: Use my profile / Different traveler / Different payment.",
    "",
  ].filter(Boolean).join("\n");
}

export function missingBookingProfileFields(
  snapshot: BookingProfileSnapshot | null,
): BookingProfileFieldName[] {
  return snapshot?.required_missing_fields ?? [];
}

export function applyBookingProfileDefaults(
  args: Record<string, unknown>,
  pii: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...args };
  const paymentMethodId =
    stringAt(next, "paymentMethodId") ?? stringAt(next, "payment_method_id");
  if (!paymentMethodId && typeof pii.payment_method_id === "string") {
    next.paymentMethodId = pii.payment_method_id;
  }

  if (!Array.isArray(next.passengers)) {
    const travelerProfile = Array.isArray(pii.traveler_profile)
      ? pii.traveler_profile.filter(isRecord)
      : [];
    if (travelerProfile.length > 0) {
      next.passengers = travelerProfile;
    } else if (typeof pii.name === "string" || typeof pii.email === "string") {
      next.passengers = [
        passengerFromProfile({
          name: typeof pii.name === "string" ? pii.name : null,
          email: typeof pii.email === "string" ? pii.email : null,
          phone: typeof pii.phone === "string" ? pii.phone : null,
          dob: typeof pii.dob === "string" ? pii.dob : null,
        }),
      ];
    }
  }
  return next;
}

function normalizeBookingScopes(grantedScopes: string[]): Set<BookingProfileFieldName> {
  const out = new Set<BookingProfileFieldName>();
  for (const raw of grantedScopes) {
    const normalized = raw.trim().toLowerCase().replace(/^profile:/, "");
    if (
      normalized === "name" ||
      normalized === "full_name" ||
      normalized === "display_name"
    ) {
      out.add("name");
    } else if (normalized === "email") {
      out.add("email");
    } else if (normalized === "phone" || normalized === "phone_number") {
      out.add("phone");
    } else if (
      normalized === "payment_method_id" ||
      normalized === "payment method" ||
      normalized === "payment_method"
    ) {
      out.add("payment_method_id");
    } else if (normalized === "traveler_profile" || normalized === "traveler profile") {
      out.add("traveler_profile");
    } else if (normalized === "passport") {
      out.add("passport");
    } else if (normalized === "passport_optional") {
      out.add("passport_optional");
    } else if (normalized === "dob" || normalized === "date_of_birth") {
      out.add("dob");
    }
  }
  return out;
}

function field<T>(
  scopeSet: Set<BookingProfileFieldName>,
  key: BookingProfileFieldName,
  value: T | null | undefined,
  label?: string | null,
  source?: string | null,
): BookingProfileField<T> {
  if (!scopeSet.has(key)) {
    return { status: "not_in_scope", value: null, label: null, source: null };
  }
  if (value === null || value === undefined || value === "") {
    return { status: "missing", value: null, label: null, source: null };
  }
  return { status: "present", value, label: label ?? null, source: source ?? null };
}

function normalizePaymentMethod(row: Record<string, unknown> | null | undefined): BookingPaymentMethod | null {
  if (!row) return null;
  const id = stringAt(row, "id");
  const brand = stringAt(row, "brand") ?? "card";
  const last4 = stringAt(row, "last4");
  if (!id || !last4) return null;
  const exp_month = numberAt(row, "exp_month");
  const exp_year = numberAt(row, "exp_year");
  return {
    id,
    brand,
    last4,
    exp_month,
    exp_year,
    label: `${titleCase(brand)} ••${last4}`,
  };
}

function normalizeTravelerProfile(
  row: Record<string, unknown> | null | undefined,
  fallback: {
    name: string | null;
    email: string | null;
    phone: string | null;
    dob: string | null;
  },
): BookingTravelerProfile[] {
  if (row) {
    const name =
      stringAt(row, "full_name") ??
      stringAt(row, "name") ??
      [stringAt(row, "given_name"), stringAt(row, "family_name")]
        .filter(Boolean)
        .join(" ");
    const passenger = passengerFromProfile({
      name: name || fallback.name,
      email: stringAt(row, "email") ?? fallback.email,
      phone: stringAt(row, "phone") ?? stringAt(row, "phone_number") ?? fallback.phone,
      dob: stringAt(row, "born_on") ?? stringAt(row, "dob") ?? fallback.dob,
    });
    passenger.source = "traveler_profiles";
    return [passenger];
  }
  if (fallback.name || fallback.email) {
    return [passengerFromProfile(fallback)];
  }
  return [];
}

function passengerFromProfile(input: {
  name: string | null;
  email: string | null;
  phone: string | null;
  dob: string | null;
}): BookingTravelerProfile {
  const { given, family } = splitName(input.name);
  return {
    type: "adult",
    ...(given ? { given_name: given } : {}),
    ...(family ? { family_name: family } : {}),
    ...(input.email ? { email: input.email } : {}),
    ...(input.phone ? { phone_number: input.phone } : {}),
    ...(input.dob ? { born_on: input.dob } : {}),
    source: "profile",
  };
}

function normalizePassport(
  passportRow: Record<string, unknown> | null | undefined,
  travelerRow: Record<string, unknown> | null | undefined,
): BookingPassport | null {
  const row = passportRow ?? travelerRow ?? null;
  if (!row) return null;
  const number =
    stringAt(row, "number") ??
    stringAt(row, "passport_number") ??
    stringAt(row, "unique_identifier");
  const issuingCountry =
    stringAt(row, "issuing_country_code") ??
    stringAt(row, "country_code") ??
    stringAt(row, "issuing_country");
  const expiresOn =
    stringAt(row, "expires_on") ??
    stringAt(row, "expiry_date") ??
    stringAt(row, "expires_at");
  if (!number && !issuingCountry && !expiresOn) return null;
  return {
    ...(number ? { number } : {}),
    ...(issuingCountry ? { issuing_country_code: issuingCountry } : {}),
    ...(expiresOn ? { expires_on: expiresOn } : {}),
    source: passportRow ? "passports" : "traveler_profile",
  };
}

function buildPrefillSummary(fields: BookingProfileSnapshot["fields"]): string | null {
  const parts: string[] = [];
  if (fields.name.status === "present" && fields.name.value) parts.push(String(fields.name.value));
  if (fields.email.status === "present" && fields.email.value) parts.push(String(fields.email.value));
  if (
    fields.payment_method_id.status === "present" &&
    fields.payment_method_id.value?.label
  ) {
    parts.push(fields.payment_method_id.value.label);
  }
  return parts.length ? `Booking for ${parts.join(" · ")}` : null;
}

function stringAt(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function numberAt(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function splitName(name: string | null): { given: string | null; family: string | null } {
  if (!name) return { given: null, family: null };
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { given: null, family: null };
  if (parts.length === 1) return { given: parts[0] ?? null, family: null };
  return { given: parts[0] ?? null, family: parts.slice(1).join(" ") };
}

function travelerLabel(traveler: BookingTravelerProfile | undefined): string | null {
  if (!traveler) return null;
  const name = [traveler.given_name, traveler.family_name].filter(Boolean).join(" ");
  return name || traveler.email || "Traveler on file";
}

function titleCase(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
