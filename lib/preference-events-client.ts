"use client";

import type { PreferenceEventInput } from "./preference-events-core";

export function logPreferenceEvent(input: PreferenceEventInput): void {
  if (typeof window === "undefined") return;
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

function hashString(value: string): string {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
