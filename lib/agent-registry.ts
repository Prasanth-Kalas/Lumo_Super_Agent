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

export interface RegistryEntry {
  /** Key used in config/agents.registry.json. */
  key: string;
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
    base_url: string;
    /** Optional version pin (semver range). */
    version?: string;
  }>;
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

  const raw = await readFile(path, "utf8");
  const config = JSON.parse(raw) as RegistryConfigFile;

  const entries: RegistryEntry[] = [];
  for (const a of config.agents) {
    if (!a.enabled) continue;
    try {
      const entry = await loadAgent(a.key, a.base_url);
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
  const healthyEntries: RegistryEntry[] = [];
  const bridgeResults = [];
  for (const e of entries) {
    try {
      bridgeResults.push(openApiToClaudeTools(e.manifest.agent_id, e.openapi));
      healthyEntries.push(e);
    } catch (err) {
      console.error(
        `[registry] agent "${e.key}" (${e.manifest.agent_id}) failed bridge validation — dropping from this boot:`,
        err,
      );
    }
  }
  const bridge = mergeBridges(bridgeResults);
  // Replace the accumulator we were about to use for the registry map.
  entries.length = 0;
  entries.push(...healthyEntries);

  const registry: Registry = {
    agents: Object.fromEntries(entries.map((e) => [e.key, e])),
    bridge,
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

async function loadAgent(key: string, base_url: string): Promise<RegistryEntry> {
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
    base_url,
    manifest,
    openapi,
    last_health: null,
    health_score: 1.0, // optimistic — first probe corrects
    manifest_loaded_at: Date.now(),
  };
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
