/**
 * Agent registry.
 *
 * The shell keeps an in-memory map of known agents. At boot we load
 * config/agents.registry.json, fetch each agent's manifest and OpenAPI,
 * and compute the tool list. We re-poll health every HEALTH_POLL_MS.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  parseManifest,
  openApiToClaudeTools,
  mergeBridges,
  HealthReportSchema,
  type AgentManifest,
  type BridgeResult,
  type HealthReport,
  type OpenApiDocument,
} from "@lumo/agent-sdk";
import {
  getInternalAgentEntries,
  mergeInternalIntoBridge,
} from "./integrations/registry.js";
import { filterBridgeForUser } from "./agent-bridge-scope.js";
import { validateRegistryConfig } from "./registry-config-validation.js";

// Static JSON imports so Next.js' file tracer pulls these into the
// serverless bundle. We had been reading the registry via
// `readFile(process.cwd() + "/config/...")`, but Next's tracer only
// follows static imports — on Vercel the function shipped without the
// JSON and every chat request 500'd with
//   ENOENT: no such file or directory, open 'config/agents.registry.vercel.json'
//
// `resolveJsonModule` is on in tsconfig; these are compile-time
// constants with no runtime cost.
import devRegistry from "../config/agents.registry.json";
import prodRegistry from "../config/agents.registry.prod.json";
import vercelRegistry from "../config/agents.registry.vercel.json";

/**
 * Map the `LUMO_REGISTRY_PATH` env var (kept for legacy compatibility)
 * or an explicit path argument onto one of the three JSON blobs we
 * bundled statically above. Unknown values fall through to a disk
 * read, which preserves the old behaviour for anyone running the
 * shell locally with a hand-crafted registry file.
 */
function bundledRegistryFor(path: string): RegistryConfigFile | null {
  if (path.endsWith("agents.registry.vercel.json")) return vercelRegistry as RegistryConfigFile;
  if (path.endsWith("agents.registry.prod.json")) return prodRegistry as RegistryConfigFile;
  if (path.endsWith("agents.registry.json")) return devRegistry as RegistryConfigFile;
  return null;
}

export interface RegistryEntry {
  /** Key used in config/agents.registry.json. */
  key: string;
  /**
   * Lumo-owned registry policy: system agents are auto-eligible for
   * authenticated users. Never trust this bit from a partner manifest.
   */
  system?: boolean;
  /** Environment-specific base URL for this agent. */
  base_url: string;
  /** Full manifest, parsed and validated. */
  manifest: AgentManifest;
  /** Loaded OpenAPI document. */
  openapi: OpenApiDocument;
  /** Rolling health. */
  last_health: HealthReport | null;
  /** 0..1 rolling health score from circuit breaker. */
  health_score: number;
  /** When did we last successfully fetch the manifest? */
  manifest_loaded_at: number;
}

export interface Registry {
  agents: Record<string, RegistryEntry>;
  bridge: BridgeResult;
  loaded_at: number;
}

interface RegistryConfigFile {
  agents: Array<{
    key: string;
    enabled: boolean;
    /** Lumo-owned policy bit. Partner manifests cannot set this. */
    system?: boolean;
    base_url: string;
    /** Optional version pin (semver range). */
    version?: string;
  }>;
}

interface AgentBridgeCandidate {
  entry: RegistryEntry;
  bridge: BridgeResult;
}

const HEALTH_POLL_MS = 10_000;

let _registry: Registry | null = null;

/**
 * Load the registry config from disk, fetch every enabled agent's manifest +
 * OpenAPI, and build the merged tool bridge. Called on cold start; the
 * shell's server runtime also re-calls this on SIGHUP in production.
 */
export async function loadRegistry(configPath?: string): Promise<Registry> {
  const path =
    configPath ??
    process.env.LUMO_REGISTRY_PATH ??
    join(process.cwd(), "config", "agents.registry.json");

  // Prefer the statically-imported JSON so Vercel's file tracer keeps
  // it in the function bundle. Only fall back to disk if the caller
  // pointed at something bespoke.
  const bundled = bundledRegistryFor(path);
  const config: RegistryConfigFile = bundled ?? (JSON.parse(await readFile(path, "utf8")) as RegistryConfigFile);
  validateRegistryConfig(config, path);

  const entries: RegistryEntry[] = [];
  for (const a of config.agents) {
    if (!a.enabled) continue;
    const base_url = expandEnvRefs(a.base_url);
    if (!base_url) {
      // The config pointed at a `${VAR}` that isn't set. In prod this is
      // almost always a mis-wired Vercel env var — fail loud rather than
      // silently fall back to an empty URL and break every tool call.
      console.error(
        `[registry] agent "${a.key}" base_url resolved to empty after env expansion ("${a.base_url}"); skipping.`,
      );
      continue;
    }
    try {
      const entry = await loadAgent(a.key, base_url, { system: a.system === true });
      entries.push(entry);
    } catch (err) {
      console.error(`[registry] failed to load agent "${a.key}":`, err);
      // Keep going — one broken agent must not take the whole shell down.
    }
  }

  // Per-agent bridge construction may throw if the agent's OpenAPI violates
  // the cancellation protocol (money tool without cancel counterpart, cancel
  // that re-prompts, etc.). Isolate the failure the same way we isolate a
  // failed manifest fetch — log loudly, drop that agent, keep the shell up.
  const bridgeCandidates: AgentBridgeCandidate[] = [];
  for (const e of entries) {
    try {
      bridgeCandidates.push({
        entry: e,
        bridge: openApiToClaudeTools(e.manifest.agent_id, e.openapi),
      });
    } catch (err) {
      console.error(
        `[registry] agent "${e.key}" (${e.manifest.agent_id}) failed bridge validation — dropping from this boot:`,
        err,
      );
    }
  }
  const { entries: healthyEntries, bridge } =
    mergeAgentBridgeCandidates(bridgeCandidates);
  // Replace the accumulator we were about to use for the registry map.
  entries.length = 0;
  entries.push(...healthyEntries);

  // Fold internal integrations (Google, etc.) into the registry + bridge.
  // Zero impact on external agents — if none are configured, this is a
  // no-op. See lib/integrations/registry.ts.
  const internals = getInternalAgentEntries();
  for (const e of internals) entries.push(e);
  let withInternals = mergeInternalIntoBridge(bridge, internals);

  // Partner agents — rows in partner_agents with status = 'approved'.
  // Loaded the same way static agents are (manifest + openapi fetch,
  // bridge validation) but the manifest URL comes from the DB instead
  // of config/agents.registry.json. One flaky partner can't break the
  // shell: each loadPartnerAgent is try/caught.
  const partners = await loadApprovedPartnerAgents();
  if (partners.length > 0) {
    const partnerBridgeCandidates: AgentBridgeCandidate[] = [];
    for (const p of partners) {
      try {
        partnerBridgeCandidates.push({
          entry: p,
          bridge: openApiToClaudeTools(p.manifest.agent_id, p.openapi),
        });
      } catch (err) {
        console.error(
          `[registry] partner agent "${p.manifest.agent_id}" failed bridge validation — dropping:`,
          err,
        );
      }
    }
    const mergedPartners = mergeAgentBridgeCandidates(
      partnerBridgeCandidates,
      withInternals,
    );
    withInternals = mergedPartners.bridge;
    entries.push(...mergedPartners.entries);
  }

  const registry: Registry = {
    agents: Object.fromEntries(entries.map((e) => [e.key, e])),
    bridge: withInternals,
    loaded_at: Date.now(),
  };

  _registry = registry;
  scheduleHealthPolling(registry);
  return registry;
}

export function getRegistry(): Registry | null {
  return _registry;
}

export async function ensureRegistry(): Promise<Registry> {
  if (_registry) return _registry;
  return loadRegistry();
}

/**
 * Filter the bridge to agents the user has actually installed/connected.
 * Intersects with healthyBridge.
 *
 * Called by the orchestrator per-turn so Claude never sees tools the
 * user can't execute. If we skip this filter, Claude will happily call
 * `food_place_order` for a user who hasn't connected Food, the router
 * will reject with `connection_required`, and the user's chat turn is
 * wasted on a tool round-trip that was always going to fail.
 *
 * `connectedAgentIds` is the set of agent_ids for which the user has an
 * active OAuth connection. `installedAgentIds` is the explicit app install
 * state for connectionless apps. Anonymous sessions can opt into public
 * connect.model === "none" tools for local/demo use.
 */
export function userScopedBridge(
  registry: Registry,
  connectedAgentIds: ReadonlySet<string>,
  installedAgentIds: ReadonlySet<string> = new Set(),
  minScore = 0.6,
  allowPublicWithoutInstall = false,
): BridgeResult {
  const base = healthyBridge(registry, minScore);
  return filterBridgeForUser(
    base,
    Object.values(registry.agents),
    connectedAgentIds,
    installedAgentIds,
    minScore,
    allowPublicWithoutInstall,
  );
}

/**
 * Returns the tool list filtered to agents that are currently healthy. This
 * is what the orchestrator passes to Claude for each turn.
 */
export function healthyBridge(registry: Registry, minScore = 0.6): BridgeResult {
  const healthyAgentIds = new Set(
    Object.values(registry.agents)
      .filter((a) => a.health_score >= minScore)
      .map((a) => a.manifest.agent_id),
  );
  const filteredTools = registry.bridge.tools.filter((t) => {
    const routing = registry.bridge.routing[t.name];
    return routing ? healthyAgentIds.has(routing.agent_id) : false;
  });
  const filteredRouting = Object.fromEntries(
    Object.entries(registry.bridge.routing).filter(([, v]) =>
      healthyAgentIds.has(v.agent_id),
    ),
  );
  return { tools: filteredTools, routing: filteredRouting };
}

// ──────────────────────────────────────────────────────────────────────────
// Internals
// ──────────────────────────────────────────────────────────────────────────

async function loadAgent(
  key: string,
  base_url: string,
  opts: { system?: boolean } = {},
): Promise<RegistryEntry> {
  const manifestUrl = new URL("/.well-known/agent.json", base_url).toString();
  const manifestRes = await fetchWithTimeout(manifestUrl, 5_000);
  const manifest = parseManifest(await manifestRes.json());

  const openapiUrl = manifest.openapi_url.startsWith("http")
    ? manifest.openapi_url
    : new URL(manifest.openapi_url, base_url).toString();
  const openapiRes = await fetchWithTimeout(openapiUrl, 5_000);
  const openapi = (await openapiRes.json()) as OpenApiDocument;

  return {
    key,
    system: opts.system === true,
    base_url,
    manifest,
    openapi,
    last_health: null,
    health_score: 1.0, // optimistic — first probe corrects
    manifest_loaded_at: Date.now(),
  };
}

/**
 * Load every row in partner_agents that has status = 'approved'.
 *
 * The manifest is already stored (approved rows had their manifest
 * parsed during /api/publisher/submit) so we skip the manifest fetch.
 * The openapi is not stored — fetching it keeps the wire-free and
 * ensures a partner who pushed a bad openapi after approval drops out
 * on the next boot instead of breaking the bridge.
 *
 * The Supabase read is done through a lazy import so this module
 * stays usable in contexts that don't have a DB configured (tests,
 * build-time analysis). A missing client just returns an empty list
 * — the shell then boots with only static + internal agents, which
 * is the correct "no partners configured yet" behaviour.
 */
async function loadApprovedPartnerAgents(): Promise<RegistryEntry[]> {
  let sb: ReturnType<typeof import("./db.js").getSupabase>;
  try {
    const mod = await import("./db.js");
    sb = mod.getSupabase();
  } catch {
    return [];
  }
  if (!sb) return [];

  let rows: Array<{
    id: string;
    manifest_url: string;
    parsed_manifest: unknown;
  }> = [];
  try {
    const { data, error } = await sb
      .from("partner_agents")
      .select("id, manifest_url, parsed_manifest")
      .eq("status", "approved");
    if (error) {
      console.warn("[registry] partner_agents read failed:", error.message);
      return [];
    }
    rows = data ?? [];
  } catch (err) {
    console.warn("[registry] partner_agents read threw:", err);
    return [];
  }

  const out: RegistryEntry[] = [];
  for (const row of rows) {
    try {
      const manifest = parseManifest(row.parsed_manifest);
      // Derive the agent's base URL from the manifest URL. A well-
      // formed partner serves the manifest at <base>/.well-known/
      // agent.json, so the origin is the base.
      const origin = new URL(row.manifest_url).origin;
      const openapiUrl = manifest.openapi_url.startsWith("http")
        ? manifest.openapi_url
        : new URL(manifest.openapi_url, origin).toString();
      const openapiRes = await fetchWithTimeout(openapiUrl, 5_000);
      const openapi = (await openapiRes.json()) as OpenApiDocument;
      out.push({
        // Namespace partner keys so they don't collide with static
        // config keys if a partner picks a name we use internally.
        key: `partner:${row.id}`,
        base_url: origin,
        manifest,
        openapi,
        last_health: null,
        health_score: 1.0,
        manifest_loaded_at: Date.now(),
      });
    } catch (err) {
      console.error(
        `[registry] partner agent "${row.manifest_url}" failed to load — dropping:`,
        err,
      );
    }
  }
  return out;
}

/**
 * Resolve `${VAR_NAME}` placeholders in a string against `process.env`.
 *
 * Used so the committed registry config can point at environment-
 * dependent URLs (Vercel preview vs. prod, local dev vs. CI) without
 * per-environment JSON files. Missing vars resolve to the empty string
 * — the loader's caller turns that into a skip + loud log, so a typo
 * in a Vercel env var surfaces as "agent X skipped" rather than as
 * mysterious downstream 500s.
 *
 * Intentionally narrow: only `${IDENTIFIER}` is substituted, no shell
 * fallbacks (`${FOO:-bar}`), no nested refs, no command substitution.
 * If you want fallbacks, precompute the value in CI.
 */
function expandEnvRefs(input: string): string {
  if (typeof input !== "string" || input.length === 0) return input;
  return input.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (match, name: string) => {
    const v = process.env[name];
    if (v === undefined || v === "") {
      console.warn(
        `[registry] env var ${name} referenced by registry config is unset; ${match} → "".`,
      );
      return "";
    }
    return v;
  });
}

function mergeAgentBridgeCandidates(
  candidates: AgentBridgeCandidate[],
  initial: BridgeResult = { tools: [], routing: {} },
): { entries: RegistryEntry[]; bridge: BridgeResult } {
  const accepted: RegistryEntry[] = [];
  let bridge = initial;

  for (const candidate of candidates) {
    try {
      bridge = mergeBridges([bridge, candidate.bridge]);
      accepted.push(candidate.entry);
    } catch (err) {
      console.error(
        `[registry] agent "${candidate.entry.key}" (${candidate.entry.manifest.agent_id}) failed bridge merge — dropping from catalog:`,
        err,
      );
    }
  }

  return { entries: accepted, bridge };
}

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const res = await fetch(url, { signal: c.signal });
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    return res;
  } finally {
    clearTimeout(t);
  }
}

function scheduleHealthPolling(registry: Registry): void {
  // Keep a single interval per process. Node's global.
  const g = globalThis as typeof globalThis & {
    __lumo_health_timer?: NodeJS.Timeout;
  };
  if (g.__lumo_health_timer) clearInterval(g.__lumo_health_timer);

  g.__lumo_health_timer = setInterval(async () => {
    for (const entry of Object.values(registry.agents)) {
      try {
        const res = await fetchWithTimeout(entry.manifest.health_url, 3_000);
        const parsed = HealthReportSchema.parse(await res.json());
        entry.last_health = parsed;
        // Simple score for now — circuit-breaker.ts refines this.
        entry.health_score =
          parsed.status === "ok" ? 1.0 : parsed.status === "degraded" ? 0.4 : 0.0;
      } catch (err) {
        entry.last_health = null;
        entry.health_score = Math.max(0, entry.health_score - 0.25);
        console.warn(`[registry] health probe failed for ${entry.key}:`, err);
      }
    }
  }, HEALTH_POLL_MS);
}
