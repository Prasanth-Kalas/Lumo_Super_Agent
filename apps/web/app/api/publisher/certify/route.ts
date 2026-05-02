/**
 * POST /api/publisher/certify — run app-store certification without
 * creating/updating a submission row.
 *
 * Publishers use this as a preflight check before clicking Submit.
 */

import type { NextRequest } from "next/server";
import { requireServerUser } from "@/lib/auth";
import { certifyAgentManifestUrl } from "@/lib/agent-certification";
import { isApprovedDeveloper } from "@/lib/publisher/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  manifest_url?: unknown;
}

export async function POST(req: NextRequest): Promise<Response> {
  const user = await requireServerUser();
  if (!(await isApprovedDeveloper(user.email))) {
    return json(
      {
        error: "not_invited",
        detail:
          "Your developer application isn't approved yet. Visit /publisher to check status or apply.",
      },
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
  if (!manifest_url) return json({ error: "missing_manifest_url" }, 400);

  const { report } = await certifyAgentManifestUrl(manifest_url);
  return json({ certification: report });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
