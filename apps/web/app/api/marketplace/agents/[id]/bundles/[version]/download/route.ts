import type { NextRequest } from "next/server";
import { getSupabase } from "@/lib/db";
import { downloadVerifiedBundle } from "@/lib/marketplace/bundle-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string; version: string } },
): Promise<Response> {
  const db = getSupabase();
  if (!db) return json({ error: "db_unavailable" }, 503);

  const { data, error } = await db
    .from("marketplace_agent_versions")
    .select("bundle_path, bundle_sha256, yanked, published_at, signature, signing_key_id, signer_user_id")
    .eq("agent_id", params.id)
    .eq("version", params.version)
    .maybeSingle();
  if (error) return json({ error: error.message }, 500);
  if (!data) return json({ error: "bundle_not_found" }, 404);

  const row = data as {
    bundle_path: string;
    bundle_sha256: string;
    yanked: boolean;
    published_at: string | null;
    signature: string | null;
    signing_key_id: string | null;
    signer_user_id: string | null;
  };
  if (row.yanked || !row.published_at) return json({ error: "version_unavailable" }, 410);

  try {
    const bundle = await downloadVerifiedBundle({
      path: row.bundle_path,
      expectedSha256: row.bundle_sha256,
      agentId: params.id,
      version: params.version,
      signature: row.signature,
      signingKeyId: row.signing_key_id,
      signerUserId: row.signer_user_id,
    });
    const body = bundle.bytes.buffer.slice(
      bundle.bytes.byteOffset,
      bundle.bytes.byteOffset + bundle.bytes.byteLength,
    ) as BodyInit;
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/gzip",
        "content-disposition": `attachment; filename="${params.id}-${params.version}.tar.gz"`,
        "x-lumo-bundle-sha256": bundle.sha256,
        "cache-control": "private, max-age=300",
      },
    });
  } catch (err) {
    return json(
      {
        error: "bundle_download_failed",
        detail: err instanceof Error ? err.message : String(err),
      },
      500,
    );
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}
