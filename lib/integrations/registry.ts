/**
 * Internal-integration registry.
 *
 * "External" agents live on their own servers and serve /.well-known/
 * agent.json over HTTPS. "Internal" integrations are Lumo-owned bundles
 * of tools that run in-process and call upstream APIs (Gmail, Calendar,
 * Contacts, and in the future Slack, Notion, iCloud, etc.).
 *
 * The rest of the stack treats internals identically to externals —
 * same agent_connections table for OAuth, same confirmation gate for
 * writes, same per-user scoping. The ONLY differences:
 *
 *   1. Their manifest is synthesized in-code here, not fetched via HTTP.
 *   2. Router dispatch is a function call, not a POST to base_url.
 *
 * Exported surfaces:
 *
 *   getInternalAgentEntries()   → RegistryEntry[] for loadRegistry() to
 *                                 fold into its bridge alongside HTTP
 *                                 agents.
 *
 *   isInternalAgent(agent_id)   → boolean the router uses to branch.
 *
 *   dispatchInternalTool(...)   → invoke the handler for a tool_name
 *                                 with the decrypted access token.
 *
 * To add a new integration (e.g. Slack):
 *   - Add a lib/integrations/slack.ts with pure tool handlers.
 *   - Add a manifest block + routing entries to INTERNAL_AGENTS below.
 *   - Optional: document scopes/env in docs/integrations-*.md.
 *
 * No schema changes needed per-integration — everything threads through
 * the existing registry + bridge + agent_connections primitives.
 */

import type {
  AgentManifest,
  BridgeResult,
  ClaudeTool,
  ToolRoutingEntry,
} from "@lumo/agent-sdk";
import type { RegistryEntry } from "../agent-registry.js";
import {
  GOOGLE_AGENT_ID,
  GOOGLE_AUTHORIZE_URL,
  GOOGLE_REVOCATION_URL,
  GOOGLE_SCOPE_DESCRIPTIONS,
  GOOGLE_SCOPES,
  GOOGLE_TOKEN_URL,
  isGoogleConfigured,
} from "./google.js";
import { gmailGetMessage, gmailSearchMessages, isGoogleApiError } from "./gmail.js";
import { calendarCreateEvent, calendarListEvents } from "./calendar.js";
import { contactsSearch } from "./contacts.js";
import {
  MICROSOFT_AGENT_ID,
  MICROSOFT_AUTHORIZE_URL,
  MICROSOFT_SCOPES,
  MICROSOFT_SCOPE_DESCRIPTIONS,
  MICROSOFT_TOKEN_URL,
  isMicrosoftApiError,
  isMicrosoftConfigured,
} from "./microsoft.js";
import {
  msCalendarCreateEvent,
  msCalendarListEvents,
  msContactsSearch,
  outlookGetMessage,
  outlookSearchMessages,
} from "./microsoft-handlers.js";
import {
  SPOTIFY_AGENT_ID,
  SPOTIFY_AUTHORIZE_URL,
  SPOTIFY_SCOPES,
  SPOTIFY_SCOPE_DESCRIPTIONS,
  SPOTIFY_TOKEN_URL,
  isSpotifyApiError,
  isSpotifyConfigured,
  spotifyAddToQueue,
  spotifyCurrentPlayback,
  spotifyPause,
  spotifyPlay,
  spotifyRecentlyPlayed,
  spotifySearch,
  spotifySkipNext,
} from "./spotify.js";

// ──────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────

export function isInternalAgent(agent_id: string): boolean {
  return INTERNAL_AGENT_IDS.has(agent_id);
}

/**
 * Manifest + tools + routing for every enabled internal integration.
 * The registry loader folds these into its aggregate bridge so Claude
 * sees them alongside external agents' tools with zero special-casing.
 *
 * Disabled (missing env) integrations are omitted — the marketplace
 * simply won't show a Connect button until the operator wires
 * credentials.
 */
export function getInternalAgentEntries(): RegistryEntry[] {
  const entries: RegistryEntry[] = [];
  if (isGoogleConfigured()) entries.push(buildGoogleEntry());
  if (isMicrosoftConfigured()) entries.push(buildMicrosoftEntry());
  if (isSpotifyConfigured()) entries.push(buildSpotifyEntry());
  // Future: Slack, Notion, GitHub, etc.
  return entries;
}

/**
 * Dispatch a tool call into the in-process integration handler.
 * Returns the raw result payload that the router would have received
 * over HTTP. Exceptions propagate so the router's error-mapping
 * (GoogleApiError → upstream_error / confirmation_mismatch / etc.)
 * fires the same way for internal and external.
 */
export async function dispatchInternalTool(args: {
  tool_name: string;
  access_token: string;
  args: Record<string, unknown>;
}): Promise<unknown> {
  const handler = INTERNAL_TOOL_HANDLERS[args.tool_name];
  if (!handler) {
    throw new Error(`[integrations] no handler for ${args.tool_name}`);
  }
  try {
    return await handler({ access_token: args.access_token, args: args.args });
  } catch (err) {
    // Known API error shapes propagate as-is so router.ts can map
    // HTTP status → AgentErrorCode uniformly.
    if (isGoogleApiError(err)) throw err;
    if (isMicrosoftApiError(err)) throw err;
    if (isSpotifyApiError(err)) throw err;
    throw err;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Handler map
// ──────────────────────────────────────────────────────────────────────────

type InternalHandler = (args: {
  access_token: string;
  args: Record<string, unknown>;
}) => Promise<unknown>;

const INTERNAL_TOOL_HANDLERS: Record<string, InternalHandler> = {
  gmail_search_messages: async ({ access_token, args }) =>
    gmailSearchMessages({
      access_token,
      query: String(args.query ?? ""),
      max_results: typeof args.max_results === "number" ? args.max_results : undefined,
    }),
  gmail_get_message: async ({ access_token, args }) =>
    gmailGetMessage({
      access_token,
      message_id: String(args.message_id ?? ""),
    }),
  calendar_list_events: async ({ access_token, args }) =>
    calendarListEvents({
      access_token,
      time_min: typeof args.time_min === "string" ? args.time_min : undefined,
      time_max: typeof args.time_max === "string" ? args.time_max : undefined,
      max_results: typeof args.max_results === "number" ? args.max_results : undefined,
      calendar_id: typeof args.calendar_id === "string" ? args.calendar_id : undefined,
    }),
  calendar_create_event: async ({ access_token, args }) =>
    calendarCreateEvent({
      access_token,
      calendar_id: typeof args.calendar_id === "string" ? args.calendar_id : undefined,
      summary: String(args.summary ?? ""),
      description: typeof args.description === "string" ? args.description : undefined,
      location: typeof args.location === "string" ? args.location : undefined,
      start: String(args.start ?? ""),
      end: String(args.end ?? ""),
      attendees: Array.isArray(args.attendees)
        ? (args.attendees as string[]).filter((x) => typeof x === "string")
        : undefined,
      all_day: typeof args.all_day === "boolean" ? args.all_day : false,
    }),
  contacts_search: async ({ access_token, args }) =>
    contactsSearch({
      access_token,
      query: String(args.query ?? ""),
      max_results: typeof args.max_results === "number" ? args.max_results : undefined,
    }),

  // ── Microsoft ────────────────────────────────────────────────
  outlook_search_messages: async ({ access_token, args }) =>
    outlookSearchMessages({
      access_token,
      query: String(args.query ?? ""),
      max_results: typeof args.max_results === "number" ? args.max_results : undefined,
    }),
  outlook_get_message: async ({ access_token, args }) =>
    outlookGetMessage({
      access_token,
      message_id: String(args.message_id ?? ""),
    }),
  ms_calendar_list_events: async ({ access_token, args }) =>
    msCalendarListEvents({
      access_token,
      time_min: typeof args.time_min === "string" ? args.time_min : undefined,
      time_max: typeof args.time_max === "string" ? args.time_max : undefined,
      max_results: typeof args.max_results === "number" ? args.max_results : undefined,
    }),
  ms_calendar_create_event: async ({ access_token, args }) =>
    msCalendarCreateEvent({
      access_token,
      subject: String(args.subject ?? ""),
      body: typeof args.body === "string" ? args.body : undefined,
      location: typeof args.location === "string" ? args.location : undefined,
      start: String(args.start ?? ""),
      end: String(args.end ?? ""),
      attendees: Array.isArray(args.attendees)
        ? (args.attendees as string[]).filter((x) => typeof x === "string")
        : undefined,
      is_online: typeof args.is_online === "boolean" ? args.is_online : false,
    }),
  ms_contacts_search: async ({ access_token, args }) =>
    msContactsSearch({
      access_token,
      query: String(args.query ?? ""),
      max_results: typeof args.max_results === "number" ? args.max_results : undefined,
    }),

  // ── Spotify ─────────────────────────────────────────────────
  spotify_current_playback: async ({ access_token }) =>
    spotifyCurrentPlayback({ access_token }),
  spotify_search: async ({ access_token, args }) =>
    spotifySearch({
      access_token,
      query: String(args.query ?? ""),
      max_results: typeof args.max_results === "number" ? args.max_results : undefined,
    }),
  spotify_play: async ({ access_token, args }) =>
    spotifyPlay({
      access_token,
      uri: typeof args.uri === "string" ? args.uri : undefined,
    }),
  spotify_pause: async ({ access_token }) => spotifyPause({ access_token }),
  spotify_skip_next: async ({ access_token }) => spotifySkipNext({ access_token }),
  spotify_add_to_queue: async ({ access_token, args }) =>
    spotifyAddToQueue({ access_token, uri: String(args.uri ?? "") }),
  spotify_recently_played: async ({ access_token, args }) =>
    spotifyRecentlyPlayed({
      access_token,
      max_results: typeof args.max_results === "number" ? args.max_results : undefined,
    }),
};

const INTERNAL_AGENT_IDS = new Set<string>([
  GOOGLE_AGENT_ID,
  MICROSOFT_AGENT_ID,
  SPOTIFY_AGENT_ID,
]);

// ──────────────────────────────────────────────────────────────────────────
// Synthesized manifests
// ──────────────────────────────────────────────────────────────────────────

function buildGoogleEntry(): RegistryEntry {
  const manifest: AgentManifest & {
    connect: {
      model: "oauth2";
      authorize_url: string;
      token_url: string;
      revocation_url?: string;
      scopes: Array<{ name: string; description: string; required: boolean }>;
      client_id_env: string;
      client_secret_env: string;
      client_type: "confidential";
    };
    listing?: {
      category?: string;
      pricing_note?: string;
      about_paragraphs?: string[];
      privacy_note?: string;
    };
  } = {
    agent_id: GOOGLE_AGENT_ID,
    version: "0.1.0",
    domain: "personal",
    display_name: "Google (Gmail · Calendar · Contacts)",
    one_liner:
      "Let Lumo read your email, see your calendar, and look up your contacts — data stays on Google, never saved in Lumo.",
    intents: [
      "search_email",
      "read_email",
      "list_calendar",
      "create_calendar_event",
      "search_contacts",
    ],
    example_utterances: [
      "find the latest email from my bank",
      "what's on my calendar tomorrow afternoon",
      "send a calendar invite to alex@example.com for dinner Friday 7pm",
      "what's the phone number for Sam",
    ],
    // openapi_url is required by the SDK schema; we set a self-
    // referential sentinel since there's no real OpenAPI doc. The
    // bridge builder uses the routing entries we synthesize below,
    // not the OpenAPI fetch path. Schema validation still accepts
    // any https URL; use the shell's public URL if available.
    openapi_url: `${process.env.LUMO_SHELL_PUBLIC_URL ?? "https://lumo-super-agent.vercel.app"}/.well-known/internal/google`,
    ui: { components: [] },
    health_url: `${process.env.LUMO_SHELL_PUBLIC_URL ?? "https://lumo-super-agent.vercel.app"}/api/health`,
    sla: {
      p50_latency_ms: 800,
      p95_latency_ms: 3500,
      availability_target: 0.99,
    },
    pii_scope: ["name", "email"],
    requires_payment: false,
    supported_regions: [],
    capabilities: {
      sdk_version: "0.4.0",
      supports_compound_bookings: false,
      implements_cancellation: false,
    },
    connect: {
      model: "oauth2",
      authorize_url: GOOGLE_AUTHORIZE_URL,
      token_url: GOOGLE_TOKEN_URL,
      revocation_url: GOOGLE_REVOCATION_URL,
      scopes: GOOGLE_SCOPES.map((s) => ({
        name: s,
        description: GOOGLE_SCOPE_DESCRIPTIONS[s] ?? s,
        required: true,
      })),
      client_id_env: "LUMO_GOOGLE_CLIENT_ID",
      client_secret_env: "LUMO_GOOGLE_CLIENT_SECRET",
      client_type: "confidential",
    },
    listing: {
      category: "Personal",
      pricing_note: "Free · read-only by default",
      about_paragraphs: [
        "Lumo reads from your Google account at the moment you ask — and only what you ask for. Nothing is saved in Lumo's database.",
        "You can disconnect at any time from /connections or revoke access at myaccount.google.com/permissions.",
      ],
      privacy_note:
        "Your Gmail messages and Contacts are never stored in Lumo. They pass through a single request to Google on your behalf and are forgotten at turn end. Calendar events you ask Lumo to create are created directly on your calendar.",
    },
  };

  const tools: ClaudeTool[] = buildGoogleClaudeTools();
  const routing: Record<string, ToolRoutingEntry> = buildGoogleRouting();

  return {
    key: "google",
    base_url: `internal://${GOOGLE_AGENT_ID}`,
    manifest,
    openapi: {} as never, // placeholder — internal agents don't use this
    last_health: { status: "ok", agent_id: GOOGLE_AGENT_ID, version: "0.1.0", checked_at: Date.now() },
    health_score: 1.0,
    manifest_loaded_at: Date.now(),
  };
}

function buildGoogleClaudeTools(): ClaudeTool[] {
  return [
    {
      name: "gmail_search_messages",
      description:
        "Search the user's Gmail using Gmail query syntax (from:, subject:, has:attachment, after:, etc.). Returns up to 25 matches with sender, subject, snippet, and date. Does NOT return bodies — call gmail_get_message with a specific id if you need the full text. Lumo never stores the results.",
      input_schema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Gmail search query. Example: 'from:bank@chase.com after:2024/01/01'. Keep narrow — users care about signal, not volume.",
          },
          max_results: {
            type: "number",
            description: "1..25. Default 10.",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "gmail_get_message",
      description:
        "Fetch the full text body of one Gmail message by id. Use after gmail_search_messages surfaced a match the user wants to read. Returns plain-text body + headers.",
      input_schema: {
        type: "object",
        properties: {
          message_id: { type: "string" },
        },
        required: ["message_id"],
      },
    },
    {
      name: "calendar_list_events",
      description:
        "List events on the user's primary Google Calendar within a time window. Default window is now..now+7d. Returns summary, start/end, location, attendees, description.",
      input_schema: {
        type: "object",
        properties: {
          time_min: { type: "string", description: "ISO 8601 datetime. Default: now." },
          time_max: { type: "string", description: "ISO 8601 datetime. Default: now+7d." },
          max_results: { type: "number", description: "1..50. Default 10." },
        },
        required: [],
      },
    },
    {
      name: "calendar_create_event",
      description:
        "Create a new event on the user's primary Google Calendar. WRITE action — show the user a reservation-style summary first (the shell will render a confirmation card) and only call this after they confirm. Invites are sent to attendees automatically.",
      input_schema: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Event title." },
          description: { type: "string" },
          location: { type: "string" },
          start: { type: "string", description: "ISO 8601 datetime, or YYYY-MM-DD if all_day." },
          end: { type: "string", description: "ISO 8601 datetime, or YYYY-MM-DD if all_day." },
          attendees: {
            type: "array",
            items: { type: "string" },
            description: "Array of email addresses. Optional.",
          },
          all_day: { type: "boolean", description: "Default false." },
        },
        required: ["summary", "start", "end"],
      },
    },
    {
      name: "contacts_search",
      description:
        "Look up a person in the user's Google Contacts by name, email, phone, or org. Returns up to 25 matches with emails, phones, and organization. Use this when the user refers to someone by first name ('text Sam') and you need an email or phone.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string" },
          max_results: { type: "number", description: "1..25. Default 10." },
        },
        required: ["query"],
      },
    },
  ];
}

function buildGoogleRouting(): Record<string, ToolRoutingEntry> {
  const common = {
    agent_id: GOOGLE_AGENT_ID,
    // These are placeholders — internal dispatch doesn't use path /
    // http_method. Keeping the fields set keeps the ToolRoutingEntry
    // shape uniform with external agents.
    http_method: "POST" as const,
    cost_tier: "free" as const,
    pii_required: [] as string[],
    operation_id: "",
    intent_tags: [] as string[],
  };
  return {
    gmail_search_messages: {
      ...common,
      path: "/internal/gmail_search_messages",
      requires_confirmation: false,
    },
    gmail_get_message: {
      ...common,
      path: "/internal/gmail_get_message",
      requires_confirmation: false,
    },
    calendar_list_events: {
      ...common,
      path: "/internal/calendar_list_events",
      requires_confirmation: false,
    },
    calendar_create_event: {
      ...common,
      path: "/internal/calendar_create_event",
      // Writing to a calendar is a commitment to the user's future —
      // confirm before doing it. The orchestrator's existing pricing
      // → confirmation flow handles it with a structured-reservation
      // summary, same as a hotel reservation.
      requires_confirmation: "structured-reservation",
      cost_tier: "metered",
    },
    contacts_search: {
      ...common,
      path: "/internal/contacts_search",
      requires_confirmation: false,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Microsoft — synthesized manifest + tools + routing
// ──────────────────────────────────────────────────────────────────────────

function buildMicrosoftEntry(): RegistryEntry {
  const manifest: AgentManifest & {
    connect: {
      model: "oauth2";
      authorize_url: string;
      token_url: string;
      scopes: Array<{ name: string; description: string; required: boolean }>;
      client_id_env: string;
      client_secret_env: string;
      client_type: "confidential";
    };
    listing?: {
      category?: string;
      pricing_note?: string;
      about_paragraphs?: string[];
      privacy_note?: string;
    };
  } = {
    agent_id: MICROSOFT_AGENT_ID,
    version: "0.1.0",
    domain: "personal",
    display_name: "Microsoft 365 (Outlook · Calendar · Contacts)",
    one_liner:
      "Let Lumo read your Outlook mail, see your calendar, and look up your contacts — data stays on Microsoft, never saved in Lumo.",
    intents: [
      "search_email",
      "read_email",
      "list_calendar",
      "create_calendar_event",
      "search_contacts",
    ],
    example_utterances: [
      "did my boss reply to the proposal",
      "block 2-3pm on Thursday for a call with alex",
      "who's on my calendar this afternoon",
    ],
    openapi_url: `${process.env.LUMO_SHELL_PUBLIC_URL ?? "https://lumo-super-agent.vercel.app"}/.well-known/internal/microsoft`,
    ui: { components: [] },
    health_url: `${process.env.LUMO_SHELL_PUBLIC_URL ?? "https://lumo-super-agent.vercel.app"}/api/health`,
    sla: { p50_latency_ms: 900, p95_latency_ms: 3500, availability_target: 0.99 },
    pii_scope: ["name", "email"],
    requires_payment: false,
    supported_regions: [],
    capabilities: {
      sdk_version: "0.4.0",
      supports_compound_bookings: false,
      implements_cancellation: false,
    },
    connect: {
      model: "oauth2",
      authorize_url: MICROSOFT_AUTHORIZE_URL,
      token_url: MICROSOFT_TOKEN_URL,
      scopes: MICROSOFT_SCOPES.map((s) => ({
        name: s,
        description: MICROSOFT_SCOPE_DESCRIPTIONS[s] ?? s,
        required: true,
      })),
      client_id_env: "LUMO_MICROSOFT_CLIENT_ID",
      client_secret_env: "LUMO_MICROSOFT_CLIENT_SECRET",
      client_type: "confidential",
    },
    listing: {
      category: "Personal",
      pricing_note: "Free · read-heavy by default",
      about_paragraphs: [
        "Lumo reads from your Microsoft 365 account at the moment you ask — Outlook mail, your calendar, and your contacts. Nothing is saved in Lumo's database.",
        "Works for both personal Microsoft accounts and work/school Microsoft 365 (your admin may need to approve the app).",
      ],
      privacy_note:
        "Outlook messages and contacts are never stored in Lumo. Calendar events you ask Lumo to create are created directly on your Outlook calendar.",
    },
  };

  return {
    key: "microsoft",
    base_url: `internal://${MICROSOFT_AGENT_ID}`,
    manifest,
    openapi: {} as never,
    last_health: { status: "ok", agent_id: MICROSOFT_AGENT_ID, version: "0.1.0", checked_at: Date.now() },
    health_score: 1.0,
    manifest_loaded_at: Date.now(),
  };
}

function buildMicrosoftClaudeTools(): ClaudeTool[] {
  return [
    {
      name: "outlook_search_messages",
      description:
        "Search the user's Outlook mailbox. Uses Microsoft Graph $search (full-text over from/to/subject/body). Returns up to 25 matches with sender, subject, preview, received time, read state. Does NOT return the body — call outlook_get_message for that.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Free-text query. Example: 'quarterly review from Alex'." },
          max_results: { type: "number", description: "1..25. Default 10." },
        },
        required: ["query"],
      },
    },
    {
      name: "outlook_get_message",
      description:
        "Fetch the full text body of one Outlook message by id. HTML bodies are stripped to plain text.",
      input_schema: {
        type: "object",
        properties: { message_id: { type: "string" } },
        required: ["message_id"],
      },
    },
    {
      name: "ms_calendar_list_events",
      description:
        "List events on the user's primary Outlook calendar within a time window. Default window is now..now+7d. Recurrences expanded (calendarView). Returns subject, start/end, location, attendees, online-meeting join URL.",
      input_schema: {
        type: "object",
        properties: {
          time_min: { type: "string" },
          time_max: { type: "string" },
          max_results: { type: "number", description: "1..50. Default 10." },
        },
        required: [],
      },
    },
    {
      name: "ms_calendar_create_event",
      description:
        "Create a new event on the user's primary Outlook calendar. WRITE action — show a reservation-style confirmation card first. Supports Teams online-meeting creation via is_online=true.",
      input_schema: {
        type: "object",
        properties: {
          subject: { type: "string" },
          body: { type: "string" },
          location: { type: "string" },
          start: { type: "string", description: "ISO 8601 datetime." },
          end: { type: "string", description: "ISO 8601 datetime." },
          attendees: { type: "array", items: { type: "string" } },
          is_online: { type: "boolean", description: "Create a Teams meeting. Default false." },
        },
        required: ["subject", "start", "end"],
      },
    },
    {
      name: "ms_contacts_search",
      description:
        "Look up a person in the user's Outlook Contacts by name, email, phone, or company. Returns up to 25 matches.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string" },
          max_results: { type: "number", description: "1..25. Default 10." },
        },
        required: ["query"],
      },
    },
  ];
}

function buildMicrosoftRouting(): Record<string, ToolRoutingEntry> {
  const common = {
    agent_id: MICROSOFT_AGENT_ID,
    http_method: "POST" as const,
    cost_tier: "free" as const,
    pii_required: [] as string[],
    operation_id: "",
    intent_tags: [] as string[],
  };
  return {
    outlook_search_messages: {
      ...common,
      path: "/internal/outlook_search_messages",
      requires_confirmation: false,
    },
    outlook_get_message: {
      ...common,
      path: "/internal/outlook_get_message",
      requires_confirmation: false,
    },
    ms_calendar_list_events: {
      ...common,
      path: "/internal/ms_calendar_list_events",
      requires_confirmation: false,
    },
    ms_calendar_create_event: {
      ...common,
      path: "/internal/ms_calendar_create_event",
      requires_confirmation: "structured-reservation",
      cost_tier: "metered",
    },
    ms_contacts_search: {
      ...common,
      path: "/internal/ms_contacts_search",
      requires_confirmation: false,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Spotify — synthesized manifest + tools + routing
// ──────────────────────────────────────────────────────────────────────────

function buildSpotifyEntry(): RegistryEntry {
  const manifest: AgentManifest & {
    connect: {
      model: "oauth2";
      authorize_url: string;
      token_url: string;
      scopes: Array<{ name: string; description: string; required: boolean }>;
      client_id_env: string;
      client_secret_env: string;
      client_type: "confidential";
    };
    listing?: {
      category?: string;
      pricing_note?: string;
      about_paragraphs?: string[];
      privacy_note?: string;
    };
  } = {
    agent_id: SPOTIFY_AGENT_ID,
    version: "0.1.0",
    domain: "personal",
    display_name: "Spotify",
    one_liner:
      "Ask Lumo what's playing, search for tracks, and control playback — Premium required for play / pause / queue.",
    intents: [
      "current_playback",
      "search_tracks",
      "play_track",
      "pause_playback",
      "queue_track",
      "recently_played",
    ],
    example_utterances: [
      "what's playing",
      "play something mellow",
      "queue that Kendrick album",
      "pause",
      "what was that song from yesterday",
    ],
    openapi_url: `${process.env.LUMO_SHELL_PUBLIC_URL ?? "https://lumo-super-agent.vercel.app"}/.well-known/internal/spotify`,
    ui: { components: [] },
    health_url: `${process.env.LUMO_SHELL_PUBLIC_URL ?? "https://lumo-super-agent.vercel.app"}/api/health`,
    sla: { p50_latency_ms: 400, p95_latency_ms: 2000, availability_target: 0.99 },
    pii_scope: ["name", "email"],
    requires_payment: false,
    supported_regions: [],
    capabilities: {
      sdk_version: "0.4.0",
      supports_compound_bookings: false,
      implements_cancellation: false,
    },
    connect: {
      model: "oauth2",
      authorize_url: SPOTIFY_AUTHORIZE_URL,
      token_url: SPOTIFY_TOKEN_URL,
      scopes: SPOTIFY_SCOPES.map((s) => ({
        name: s,
        description: SPOTIFY_SCOPE_DESCRIPTIONS[s] ?? s,
        required: true,
      })),
      client_id_env: "LUMO_SPOTIFY_CLIENT_ID",
      client_secret_env: "LUMO_SPOTIFY_CLIENT_SECRET",
      client_type: "confidential",
    },
    listing: {
      category: "Personal",
      pricing_note: "Free to connect · Premium needed for playback",
      about_paragraphs: [
        "Lumo can tell you what's playing, search for tracks, and — with Spotify Premium — control playback and queue music on whichever device is currently active.",
        "Free Spotify accounts can search and see history; play/pause/queue require Premium.",
      ],
      privacy_note:
        "Your listening history and playlists are fetched on demand and never stored in Lumo.",
    },
  };

  return {
    key: "spotify",
    base_url: `internal://${SPOTIFY_AGENT_ID}`,
    manifest,
    openapi: {} as never,
    last_health: { status: "ok", agent_id: SPOTIFY_AGENT_ID, version: "0.1.0", checked_at: Date.now() },
    health_score: 1.0,
    manifest_loaded_at: Date.now(),
  };
}

function buildSpotifyClaudeTools(): ClaudeTool[] {
  return [
    {
      name: "spotify_current_playback",
      description:
        "Return what's currently playing on Spotify (track, artist, album, device, progress) or nothing-playing if there's no active session.",
      input_schema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "spotify_search",
      description:
        "Search Spotify's catalog for tracks. Returns up to 20 matches with name, artist, album, URI, duration.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural query, e.g. 'taylor swift anti hero' or 'chill jazz'." },
          max_results: { type: "number", description: "1..20. Default 10." },
        },
        required: ["query"],
      },
    },
    {
      name: "spotify_play",
      description:
        "Resume playback, or start a specific track / album / playlist by URI. Requires Premium. If no active device, user gets an error telling them to open Spotify first.",
      input_schema: {
        type: "object",
        properties: {
          uri: {
            type: "string",
            description: "Spotify URI. spotify:track:… for a single track, spotify:album:… or spotify:playlist:… for context. Omit to resume the current queue.",
          },
        },
        required: [],
      },
    },
    {
      name: "spotify_pause",
      description: "Pause playback. Requires Premium.",
      input_schema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "spotify_skip_next",
      description: "Skip to the next track in the queue. Requires Premium.",
      input_schema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "spotify_add_to_queue",
      description: "Append a track URI to the current playback queue. Requires Premium.",
      input_schema: {
        type: "object",
        properties: {
          uri: { type: "string", description: "spotify:track:… URI from spotify_search." },
        },
        required: ["uri"],
      },
    },
    {
      name: "spotify_recently_played",
      description: "List what the user listened to recently (most recent first). Up to 50 items.",
      input_schema: {
        type: "object",
        properties: { max_results: { type: "number", description: "1..50. Default 20." } },
        required: [],
      },
    },
  ];
}

function buildSpotifyRouting(): Record<string, ToolRoutingEntry> {
  const common = {
    agent_id: SPOTIFY_AGENT_ID,
    http_method: "POST" as const,
    cost_tier: "free" as const,
    pii_required: [] as string[],
    operation_id: "",
    intent_tags: [] as string[],
    requires_confirmation: false as const,
  };
  return {
    spotify_current_playback: { ...common, path: "/internal/spotify_current_playback" },
    spotify_search: { ...common, path: "/internal/spotify_search" },
    // Playback writes are low-stakes (reversible, no $) so they skip
    // the confirmation gate — same as a discovery tool. If users
    // complain about accidental plays, we'll add a gate later.
    spotify_play: { ...common, path: "/internal/spotify_play" },
    spotify_pause: { ...common, path: "/internal/spotify_pause" },
    spotify_skip_next: { ...common, path: "/internal/spotify_skip_next" },
    spotify_add_to_queue: { ...common, path: "/internal/spotify_add_to_queue" },
    spotify_recently_played: { ...common, path: "/internal/spotify_recently_played" },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Merging helpers — loadRegistry() calls this after its HTTP fetch loop.
// ──────────────────────────────────────────────────────────────────────────

export function mergeInternalIntoBridge(
  bridge: BridgeResult,
  internals: RegistryEntry[],
): BridgeResult {
  const tools = [...bridge.tools];
  const routing = { ...bridge.routing };
  for (const e of internals) {
    if (e.manifest.agent_id === GOOGLE_AGENT_ID) {
      tools.push(...buildGoogleClaudeTools());
      for (const [k, v] of Object.entries(buildGoogleRouting())) routing[k] = v;
    } else if (e.manifest.agent_id === MICROSOFT_AGENT_ID) {
      tools.push(...buildMicrosoftClaudeTools());
      for (const [k, v] of Object.entries(buildMicrosoftRouting())) routing[k] = v;
    } else if (e.manifest.agent_id === SPOTIFY_AGENT_ID) {
      tools.push(...buildSpotifyClaudeTools());
      for (const [k, v] of Object.entries(buildSpotifyRouting())) routing[k] = v;
    }
  }
  return { tools, routing };
}
