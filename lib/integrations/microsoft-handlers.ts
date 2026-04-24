/**
 * Microsoft Graph tool handlers — Outlook Mail + Calendar + Contacts.
 *
 * Same privacy posture as Google: nothing returned from these handlers
 * is written to our DB. Tokens (encrypted) are the only durable
 * artifact.
 *
 * Tool namespace: ms_outlook_*, ms_calendar_*, ms_contacts_* to avoid
 * collisions with Google's gmail_*, calendar_*, contacts_* when both
 * integrations are connected for the same user.
 */

import { msftFetchJson } from "./microsoft.js";

// ──────────────────────────────────────────────────────────────────────────
// Outlook Mail
// ──────────────────────────────────────────────────────────────────────────

export interface OutlookSearchResult {
  messages: Array<{
    id: string;
    from: string;
    to: string | null;
    subject: string;
    preview: string;
    received_at: string;
    has_attachments: boolean;
    is_read: boolean;
    web_link: string | null;
  }>;
}

/**
 * Search via Graph's $search (full-text) when the query looks like
 * free text; fall back to $filter for structured queries. Microsoft's
 * $search requires "Prefer: outlook.body-content-type=text" to get
 * plain-text bodies instead of HTML.
 *
 * We do a single list call (faster than Gmail's two-step list+get
 * because Graph returns headers + snippet inline).
 */
export async function outlookSearchMessages(args: {
  access_token: string;
  query: string;
  max_results?: number;
}): Promise<OutlookSearchResult> {
  const max = Math.min(25, Math.max(1, args.max_results ?? 10));
  const data = await msftFetchJson<{
    value?: Array<{
      id: string;
      subject?: string;
      bodyPreview?: string;
      receivedDateTime?: string;
      hasAttachments?: boolean;
      isRead?: boolean;
      webLink?: string;
      from?: { emailAddress?: { address?: string; name?: string } };
      toRecipients?: Array<{ emailAddress?: { address?: string; name?: string } }>;
    }>;
  }>({
    access_token: args.access_token,
    url: "https://graph.microsoft.com/v1.0/me/messages",
    query: {
      // $search implicitly scans subject/body/from/to — good default.
      $search: `"${args.query.replace(/"/g, '\\"')}"`,
      $top: max,
      $select: "id,subject,bodyPreview,receivedDateTime,hasAttachments,isRead,webLink,from,toRecipients",
    },
  });

  const fmtAddr = (
    a?: { emailAddress?: { address?: string; name?: string } },
  ): string => {
    if (!a?.emailAddress) return "";
    const { address, name } = a.emailAddress;
    if (name && address) return `${name} <${address}>`;
    return address ?? name ?? "";
  };

  return {
    messages: (data.value ?? []).map((m) => ({
      id: m.id,
      from: fmtAddr(m.from),
      to: m.toRecipients?.length
        ? m.toRecipients.map(fmtAddr).filter(Boolean).join(", ") || null
        : null,
      subject: m.subject ?? "",
      preview: m.bodyPreview ?? "",
      received_at: m.receivedDateTime ?? "",
      has_attachments: !!m.hasAttachments,
      is_read: !!m.isRead,
      web_link: m.webLink ?? null,
    })),
  };
}

export interface OutlookMessage {
  id: string;
  from: string;
  to: string | null;
  cc: string | null;
  subject: string;
  received_at: string;
  body_text: string;
  web_link: string | null;
}

export async function outlookGetMessage(args: {
  access_token: string;
  message_id: string;
}): Promise<OutlookMessage> {
  const data = await msftFetchJson<{
    id: string;
    subject?: string;
    receivedDateTime?: string;
    webLink?: string;
    body?: { contentType?: string; content?: string };
    from?: { emailAddress?: { address?: string; name?: string } };
    toRecipients?: Array<{ emailAddress?: { address?: string; name?: string } }>;
    ccRecipients?: Array<{ emailAddress?: { address?: string; name?: string } }>;
  }>({
    access_token: args.access_token,
    url: `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(args.message_id)}`,
    query: {
      $select: "id,subject,receivedDateTime,webLink,body,from,toRecipients,ccRecipients",
    },
  });

  const fmtAddr = (
    a?: { emailAddress?: { address?: string; name?: string } },
  ): string => {
    if (!a?.emailAddress) return "";
    const { address, name } = a.emailAddress;
    if (name && address) return `${name} <${address}>`;
    return address ?? name ?? "";
  };

  const body =
    data.body?.contentType === "html"
      ? htmlToPlain(data.body?.content ?? "")
      : data.body?.content ?? "";

  return {
    id: data.id,
    from: fmtAddr(data.from),
    to: data.toRecipients?.length
      ? data.toRecipients.map(fmtAddr).filter(Boolean).join(", ") || null
      : null,
    cc: data.ccRecipients?.length
      ? data.ccRecipients.map(fmtAddr).filter(Boolean).join(", ") || null
      : null,
    subject: data.subject ?? "",
    received_at: data.receivedDateTime ?? "",
    body_text: body,
    web_link: data.webLink ?? null,
  };
}

function htmlToPlain(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

// ──────────────────────────────────────────────────────────────────────────
// Outlook Calendar
// ──────────────────────────────────────────────────────────────────────────

export interface MsCalendarEvent {
  id: string;
  subject: string;
  start: string;
  end: string;
  location: string | null;
  online_meeting_url: string | null;
  attendees: string[];
  is_online: boolean;
  web_link: string | null;
}

export async function msCalendarListEvents(args: {
  access_token: string;
  time_min?: string;
  time_max?: string;
  max_results?: number;
}): Promise<{ events: MsCalendarEvent[] }> {
  const now = new Date();
  const start = args.time_min ?? now.toISOString();
  const end = args.time_max ?? new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const max = Math.min(50, Math.max(1, args.max_results ?? 10));

  // calendarView returns events expanded from recurrences — what users
  // usually mean when they say "what's on my calendar."
  const data = await msftFetchJson<{
    value?: Array<{
      id: string;
      subject?: string;
      start?: { dateTime?: string };
      end?: { dateTime?: string };
      location?: { displayName?: string };
      isOnlineMeeting?: boolean;
      onlineMeeting?: { joinUrl?: string };
      attendees?: Array<{ emailAddress?: { address?: string } }>;
      webLink?: string;
    }>;
  }>({
    access_token: args.access_token,
    url: "https://graph.microsoft.com/v1.0/me/calendarView",
    query: {
      startDateTime: start,
      endDateTime: end,
      $top: max,
      $orderby: "start/dateTime",
      $select: "id,subject,start,end,location,isOnlineMeeting,onlineMeeting,attendees,webLink",
    },
  });

  return {
    events: (data.value ?? []).map((e) => ({
      id: e.id,
      subject: e.subject ?? "(no title)",
      start: e.start?.dateTime ?? "",
      end: e.end?.dateTime ?? "",
      location: e.location?.displayName ?? null,
      online_meeting_url: e.onlineMeeting?.joinUrl ?? null,
      attendees: (e.attendees ?? [])
        .map((a) => a.emailAddress?.address ?? "")
        .filter(Boolean) as string[],
      is_online: !!e.isOnlineMeeting,
      web_link: e.webLink ?? null,
    })),
  };
}

export interface MsCreateEventInput {
  access_token: string;
  subject: string;
  body?: string;
  location?: string;
  start: string;
  end: string;
  attendees?: string[];
  is_online?: boolean;
}

export async function msCalendarCreateEvent(
  args: MsCreateEventInput,
): Promise<{ id: string; web_link: string | null; subject: string; start: string; end: string }> {
  const body: Record<string, unknown> = {
    subject: args.subject,
    start: { dateTime: args.start, timeZone: "UTC" },
    end: { dateTime: args.end, timeZone: "UTC" },
  };
  if (args.body) body.body = { contentType: "text", content: args.body };
  if (args.location) body.location = { displayName: args.location };
  if (args.attendees?.length) {
    body.attendees = args.attendees.map((email) => ({
      emailAddress: { address: email },
      type: "required",
    }));
  }
  if (args.is_online) body.isOnlineMeeting = true;

  const data = await msftFetchJson<{
    id: string;
    webLink?: string;
    subject?: string;
    start?: { dateTime?: string };
    end?: { dateTime?: string };
  }>({
    access_token: args.access_token,
    url: "https://graph.microsoft.com/v1.0/me/events",
    method: "POST",
    body,
  });

  return {
    id: data.id,
    web_link: data.webLink ?? null,
    subject: data.subject ?? args.subject,
    start: data.start?.dateTime ?? args.start,
    end: data.end?.dateTime ?? args.end,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Outlook Contacts
// ──────────────────────────────────────────────────────────────────────────

export interface MsContactResult {
  name: string;
  emails: string[];
  phones: string[];
  company: string | null;
}

export async function msContactsSearch(args: {
  access_token: string;
  query: string;
  max_results?: number;
}): Promise<{ contacts: MsContactResult[] }> {
  const max = Math.min(25, Math.max(1, args.max_results ?? 10));

  const data = await msftFetchJson<{
    value?: Array<{
      displayName?: string;
      emailAddresses?: Array<{ address?: string; name?: string }>;
      businessPhones?: string[];
      mobilePhone?: string;
      companyName?: string;
    }>;
  }>({
    access_token: args.access_token,
    url: "https://graph.microsoft.com/v1.0/me/contacts",
    query: {
      $search: `"${args.query.replace(/"/g, '\\"')}"`,
      $top: max,
      $select: "displayName,emailAddresses,businessPhones,mobilePhone,companyName",
    },
  });

  return {
    contacts: (data.value ?? []).map((c) => ({
      name: c.displayName ?? "(unknown)",
      emails: (c.emailAddresses ?? [])
        .map((e) => e.address ?? "")
        .filter(Boolean) as string[],
      phones: [
        ...(c.businessPhones ?? []),
        ...(c.mobilePhone ? [c.mobilePhone] : []),
      ],
      company: c.companyName ?? null,
    })),
  };
}
