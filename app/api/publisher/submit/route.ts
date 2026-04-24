/**
 * POST /api/publisher/submit  — invited partners submit an agent.
 *
 * Body: { manifest_url: string }
 *
 * Validation steps, in order:
 *   1. Caller is an authenticated user on LUMO_PUBLISHER_EMAILS.
 *      Anyone else gets 403 — we don't even hit the URL.
 *   2. The manifest URL is reachable over HTTPS in < 5s.
 *   3. The body parses through @lumo/agent-sdk :: parseManifest.
 *   4. The referenced /openapi.json is reachable and parses.
 *   5. Idempotent upsert into partner_agents (pending status).
 *
 * Anything that passes 1-4 lands in the review queue. Rejecting at
 * this layer is a gentler UX than letting a bad submission sit in
 * the admin queue — we tell the publisher exactly what broke.
 */

import type { NextRequest } from "next/server";
import { parseManifest, type AgentManifest } from "@lumo/agent-sdk";
import { requireServerUser } from "@/lib/auth";
import { getSupabase } from "@/lib/db";
import { isPublisher } from "@/lib/publisher/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FETCH_TIMEOUT_MS = 5_000;

interface Body {
  manifest_url?: unknown;
}

export async function POST(req: NextRequest): Promise<Response> {
  const user = await requireServerUser();
  if (!isPublisher(user.email)) {
    return json(
      { error: "not_invited", detail: "Your email isn't on the publisher allowlist." },
      403,
    );
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const manifest_url =
    typeof body.manifest_url === "string" ? body.manifest_url.trim() : "";
  if (!manifest_url || !isHttpsUrl(manifest_url)) {
    return json(
      {
        error: "invalid_url",
        detail: "Submit a full HTTPS URL that serves your AgentManifest.",
      },
      400,
    );
  }

  // --- 1) Manifest reachability + schema -----------------------
  let manifest: AgentManifest;
  try {
    const res = await fetchWithTimeout(manifest_url, FETCH_TIMEOUT_MS);
    if (!res.ok) {
      return json(
        {
          error: "manifest_unreachable",
          detail: `Manifest URL returned HTTP ${res.status}.`,
        },
        400,
      );
    }
    const rawJson = (await res.json()) as unknown;
    manifest = parseManifest(rawJson);
  } catch (err) {
    return json(
      {
        error: "manifest_invalid",
        detail: err instanceof Error ? err.message : "Could not read manifest.",
      },
      400,
    );
  }

  // --- 2) OpenAPI reachability ---------------------------------
  // Resolve openapi_url relative to the manifest URL so relative
  // paths like "/openapi.json" work without the publisher hard-
  // coding their own origin.
  try {
    const openapiUrl = manifest.openapi_url.startsWith("http")
      ? manifest.openapi_url
      : new URL(manifest.openapi_url, manifest_url).toString();
    const res = await fetchWithTimeout(openapiUrl, FETCH_TIMEOUT_MS);
    if (!res.ok) {
      return json(
        {
          error: "openapi_unreachable",
          detail: `openapi_url returned HTTP ${res.status}.`,
        },
        400,
      );
    }
    await res.json();
  } catch (err) {
    return json(
      {
        error: "openapi_invalid",
        detail: err instanceof Error ? err.message : "Could not read openapi.",
      },
      400,
    );
  }

  // --- 3) Upsert into partner_agents ---------------------------
  const sb = getSupabase();
  if (!sb) return json({ error: "db_unavailable" }, 503);

  const { data, error } = await sb
    .from("partner_agents")
    .upsert(
      {
        publisher_email: user.email!.toLowerCase(),
        manifest_url,
        parsed_manifest: manifest,
        status: "pending",
        submitted_at: new Date().toISOString(),
      },
      { onConflict: "publisher_email,manifest_url" },
    )
    .select("id, publisher_email, manifest_url, status, submitted_at")
    .single();

  if (error) return json({ error: error.message }, 500);

  return json({ submission: data });
}

function isHttpsUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:"; // http only for local dev
  } catch {
    return false;
  }
}

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
