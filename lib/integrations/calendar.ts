/**
 * Google Calendar tool handlers.
 *
 * Two tools:
 *   calendar_list_events   — read, cheap, no confirmation
 *   calendar_create_event  — WRITE, requires a structured-reservation
 *                            summary first (same gate as a hotel
 *                            reservation). We're touching the user's
 *                            actual calendar; it deserves a confirm.
 */

import { googleFetchJson } from "./google.js";

export interface CalendarEvent {
  id: string;
  summary: string;
  start: string;   // ISO datetime or all-day date
  end: string;
  location: string | null;
  description: string | null;
  attendees: string[];
  status: string | null;
  html_link: string | null;
}

export async function calendarListEvents(args: {
  access_token: string;
  time_min?: string;   // ISO; defaults to now
  time_max?: string;   // ISO; defaults to now + 7d
  max_results?: number;
  calendar_id?: string; // defaults to "primary"
}): Promise<{ events: CalendarEvent[] }> {
  const calendar_id = args.calendar_id ?? "primary";
  const now = new Date();
  const time_min = args.time_min ?? now.toISOString();
  const time_max = args.time_max ?? new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const max_results = Math.min(50, Math.max(1, args.max_results ?? 10));

  const data = await googleFetchJson<{
    items?: Array<{
      id: string;
      summary?: string;
      start?: { dateTime?: string; date?: string };
      end?: { dateTime?: string; date?: string };
      location?: string;
      description?: string;
      attendees?: Array<{ email?: string }>;
      status?: string;
      htmlLink?: string;
    }>;
  }>({
    access_token: args.access_token,
    url: `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendar_id)}/events`,
    query: {
      timeMin: time_min,
      timeMax: time_max,
      maxResults: max_results,
      singleEvents: "true",
      orderBy: "startTime",
    },
  });

  const events: CalendarEvent[] = (data.items ?? []).map((e) => ({
    id: e.id,
    summary: e.summary ?? "(no title)",
    start: e.start?.dateTime ?? e.start?.date ?? "",
    end: e.end?.dateTime ?? e.end?.date ?? "",
    location: e.location ?? null,
    description: e.description ?? null,
    attendees: (e.attendees ?? [])
      .map((a) => a.email ?? "")
      .filter(Boolean) as string[],
    status: e.status ?? null,
    html_link: e.htmlLink ?? null,
  }));

  return { events };
}

export interface CreateEventInput {
  access_token: string;
  calendar_id?: string;
  summary: string;
  description?: string;
  location?: string;
  start: string;   // ISO datetime (or date for all-day)
  end: string;
  attendees?: string[];
  all_day?: boolean;
}

export interface CreateEventResult {
  id: string;
  html_link: string | null;
  summary: string;
  start: string;
  end: string;
}

/**
 * Create an event. This is a WRITE to the user's world, so the
 * orchestrator's confirmation gate must be satisfied before the router
 * calls us — the internal dispatcher declares the routing entry with
 * cost_tier="money" / requires_confirmation="structured-reservation"
 * so the existing hash-check logic applies as-is.
 */
export async function calendarCreateEvent(
  args: CreateEventInput,
): Promise<CreateEventResult> {
  const calendar_id = args.calendar_id ?? "primary";
  const body: Record<string, unknown> = {
    summary: args.summary,
  };
  if (args.description) body.description = args.description;
  if (args.location) body.location = args.location;
  if (args.all_day) {
    body.start = { date: args.start.slice(0, 10) };
    body.end = { date: args.end.slice(0, 10) };
  } else {
    body.start = { dateTime: args.start };
    body.end = { dateTime: args.end };
  }
  if (args.attendees?.length) {
    body.attendees = args.attendees.map((email) => ({ email }));
  }

  const data = await googleFetchJson<{
    id: string;
    htmlLink?: string;
    summary?: string;
    start?: { dateTime?: string; date?: string };
    end?: { dateTime?: string; date?: string };
  }>({
    access_token: args.access_token,
    url: `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendar_id)}/events`,
    method: "POST",
    body,
    query: { sendUpdates: args.attendees?.length ? "all" : "none" },
  });

  return {
    id: data.id,
    html_link: data.htmlLink ?? null,
    summary: data.summary ?? args.summary,
    start: data.start?.dateTime ?? data.start?.date ?? args.start,
    end: data.end?.dateTime ?? data.end?.date ?? args.end,
  };
}
