/**
 * Manifest to PERM-1 scope descriptors.
 *
 * ADR-014's final manifest schema is still ahead of the installed SDK. This
 * helper accepts both the future `requires.scopes` shape and today's registry
 * fields so the consent UI, API, and router all agree on the same scope list.
 */

import { createHash } from "node:crypto";
import type { AgentManifest, ToolRoutingEntry } from "@lumo/agent-sdk";
import type { PermissionConstraints } from "./permissions.js";

export interface PermissionScopeDescriptor {
  scope: string;
  label: string;
  description: string;
  category: "read" | "write" | "financial" | "other";
  defaultConstraints: PermissionConstraints;
  requiresConfirmation: boolean;
}

export function permissionScopesForManifest(
  manifest: AgentManifest,
  routing?: ToolRoutingEntry,
): PermissionScopeDescriptor[] {
  const manifestRecord = manifest as AgentManifest & Record<string, unknown>;
  const declared = [
    ...stringArrayAt(manifestRecord, ["requires", "scopes"]),
    ...stringArrayAt(manifestRecord, ["x_lumo", "requires", "scopes"]),
    ...stringArrayAt(manifestRecord, ["x_lumo_sample", "requires", "scopes"]),
  ];
  const scopes = declared.length > 0 ? declared : oauthRequiredScopes(manifest);

  if (scopes.length === 0 && routing?.cost_tier === "money") {
    scopes.push("write.financial.transfer");
  }

  return [...new Set(scopes)].map(describePermissionScope);
}

export function consentTextForAgent(
  manifest: AgentManifest,
  scopes: PermissionScopeDescriptor[],
): string {
  const lines = [
    `Lumo agent install consent for ${manifest.display_name} ${manifest.version}.`,
    `Agent id: ${manifest.agent_id}.`,
    `The user grants the following scopes:`,
    ...scopes.map((scope) => {
      const constraints = Object.keys(scope.defaultConstraints).length
        ? ` Constraints: ${stableStringify(scope.defaultConstraints)}.`
        : "";
      return `- ${scope.scope}: ${scope.description}.${constraints}`;
    }),
    `Money-moving or side-effect actions remain subject to Lumo confirmation cards.`,
  ];
  return lines.join("\n");
}

export function consentTextHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function describePermissionScope(scope: string): PermissionScopeDescriptor {
  const constraints = parseScopeConstraints(scope);
  const baseScope = basePermissionScope(scope);
  const category = permissionCategory(baseScope);
  return {
    scope,
    label: humanizeScope(baseScope),
    description: scopeDescription(baseScope),
    category,
    defaultConstraints: constraints,
    requiresConfirmation:
      category === "financial" ||
      baseScope.startsWith("write.") ||
      baseScope.includes(".send") ||
      baseScope.includes(".book"),
  };
}

function oauthRequiredScopes(manifest: AgentManifest): string[] {
  if (manifest.connect.model !== "oauth2") return [];
  return manifest.connect.scopes
    .filter((scope) => scope.required)
    .map((scope) => scope.name)
    .filter((scope) => scope.length > 0);
}

function stringArrayAt(record: Record<string, unknown>, path: string[]): string[] {
  let cursor: unknown = record;
  for (const key of path) {
    if (!isRecord(cursor)) return [];
    cursor = cursor[key];
  }
  if (!Array.isArray(cursor)) return [];
  return cursor.filter((value): value is string => typeof value === "string" && value.length > 0);
}

function parseScopeConstraints(scope: string): PermissionConstraints {
  const constraints: PermissionConstraints = {};
  for (const part of scope.split(".")) {
    const [key, value] = part.split(":");
    if (!key || !value) continue;
    if (key === "up_to_per_invocation") {
      const amount = parseUsd(value);
      if (amount !== null) constraints.up_to_per_invocation_usd = amount;
    } else if (key === "per_day") {
      const amount = parseUsd(value);
      if (amount !== null) constraints.per_day_usd = amount;
    } else if (key === "specific_to") {
      constraints.specific_to = value;
    }
  }
  return constraints;
}

function basePermissionScope(scope: string): string {
  return scope
    .split(".")
    .filter((part) =>
      !part.startsWith("up_to_per_invocation:") &&
      !part.startsWith("per_day:") &&
      !part.startsWith("specific_to:"),
    )
    .join(".");
}

function parseUsd(value: string): number | null {
  const normalized = value.toLowerCase().replace(/_?usd$/, "");
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function permissionCategory(scope: string): PermissionScopeDescriptor["category"] {
  if (scope.includes("financial") || scope.includes("payment")) return "financial";
  if (scope.startsWith("read.")) return "read";
  if (scope.startsWith("write.")) return "write";
  return "other";
}

function humanizeScope(scope: string): string {
  return scope
    .split(".")
    .map((part) => part.replace(/_/g, " "))
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" / ");
}

function scopeDescription(scope: string): string {
  if (scope === "read.recall") return "Read relevant memory and recall context";
  if (scope === "read.location.current") return "Use your current or inferred location";
  if (scope === "read.email.headers") return "Read email sender, subject, and date metadata";
  if (scope === "read.email.bodies") return "Read email body content when needed";
  if (scope === "read.contacts") return "Read contact names and addresses";
  if (scope === "read.calendar.events") return "Read calendar event details";
  if (scope === "write.calendar.events") return "Create and update calendar events";
  if (scope === "write.email.send") return "Send email after a confirmation card";
  if (scope === "write.financial.transfer") return "Complete a money-moving transaction after confirmation";
  if (scope.startsWith("https://")) return `Use provider OAuth scope ${scope}`;
  if (scope.startsWith("read.")) return `Read ${humanizeScope(scope.slice("read.".length)).toLowerCase()} data`;
  if (scope.startsWith("write.")) return `Modify ${humanizeScope(scope.slice("write.".length)).toLowerCase()} data`;
  return `Use ${humanizeScope(scope).toLowerCase()}`;
}

function stableStringify(value: unknown): string {
  if (!isRecord(value)) return JSON.stringify(value);
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) sorted[key] = value[key];
  return JSON.stringify(sorted);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
