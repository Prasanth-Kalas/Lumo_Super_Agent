"use client";

import type { PreferenceEventInput } from "./preference-events-core";

const DEDUPE_WINDOW_MS = 5_000;
const MAX_DEDUPE_KEYS = 500;
const recentPreferenceEvents = new Map<string, number>();

export function logPreferenceEvent(input: PreferenceEventInput): void {
  if (typeof window === "undefined") return;

  const now = Date.now();
  const dedupeKey = preferenceEventDedupeKey(input);
  const lastSeen = recentPreferenceEvents.get(dedupeKey);
  if (lastSeen !== undefined && now - lastSeen < DEDUPE_WINDOW_MS) {
    return;
  }
  recentPreferenceEvents.set(dedupeKey, now);
  prunePreferenceEventDedupe(now);

  const payload = JSON.stringify({ events: [input] });

  try {
    if (navigator.sendBeacon) {
      const blob = new Blob([payload], { type: "application/json" });
      if (navigator.sendBeacon("/api/preferences/events", blob)) return;
    }
  } catch {
    // Fall through to fetch. Preference logging must never break UX.
  }

  void fetch("/api/preferences/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload,
    credentials: "include",
    keepalive: true,
  }).catch(() => {});
}

export function preferenceTargetId(prefix: string, value: string): string {
  return `${prefix}:${hashString(value)}`;
}

export function compactPreferenceText(value: string, max = 120): string {
  const s = value.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function __resetPreferenceEventDedupeForTests(): void {
  recentPreferenceEvents.clear();
}

function preferenceEventDedupeKey(input: PreferenceEventInput): string {
  return [
    input.surface,
    input.target_type,
    input.target_id,
    input.event_type,
    input.session_id ?? "",
    contextKey(input.context),
  ].join("\u001f");
}

function contextKey(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const record = value as Record<string, unknown>;
  return [
    stringish(record.source),
    stringish(record.action),
    stringish(record.view),
    stringish(record.label),
    stringish(record.mission_id),
  ].join("|");
}

function stringish(value: unknown): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : "";
}

function prunePreferenceEventDedupe(now: number): void {
  if (recentPreferenceEvents.size <= MAX_DEDUPE_KEYS) return;
  for (const [key, seenAt] of recentPreferenceEvents) {
    if (now - seenAt >= DEDUPE_WINDOW_MS) {
      recentPreferenceEvents.delete(key);
    }
  }
  while (recentPreferenceEvents.size > MAX_DEDUPE_KEYS) {
    const oldest = recentPreferenceEvents.keys().next().value;
    if (typeof oldest !== "string") break;
    recentPreferenceEvents.delete(oldest);
  }
}

function hashString(value: string): string {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
