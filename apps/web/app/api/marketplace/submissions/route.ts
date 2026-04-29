import type { NextRequest } from "next/server";
import { requireServerUser } from "@/lib/auth";
import {
  MarketplaceSubmissionError,
  submitMarketplaceAgent,
} from "@/lib/marketplace/submission";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const user = await requireServerUser();
  const form = await req.formData().catch(() => null);
  if (!form) return json({ error: "invalid_multipart" }, 400);

  const manifest = await readManifest(form);
  if (!manifest.ok) return json({ error: manifest.error }, 400);

  const bundle = form.get("bundle");
  if (!(bundle instanceof File)) {
    return json({ error: "missing_bundle" }, 400);
  }
  if (bundle.size <= 0) return json({ error: "empty_bundle" }, 400);
  if (bundle.size > 25 * 1024 * 1024) {
    return json({ error: "bundle_too_large", max_bytes: 25 * 1024 * 1024 }, 413);
  }

  const signatureValue = form.get("signature");
  const signingKeyIdValue = form.get("signing_key_id");
  const tierValue = form.get("trust_tier");

  try {
    const result = await submitMarketplaceAgent({
      manifest: manifest.value,
      bundleBytes: new Uint8Array(await bundle.arrayBuffer()),
      authorUserId: user.id,
      authorEmail: user.email ?? user.id,
      authorName: user.user_metadata?.full_name ?? user.email ?? null,
      requestedTier:
        tierValue === "official" ||
        tierValue === "verified" ||
        tierValue === "community" ||
        tierValue === "experimental"
          ? tierValue
          : undefined,
      signature: typeof signatureValue === "string" ? signatureValue : null,
      signingKeyId: typeof signingKeyIdValue === "string" ? signingKeyIdValue : null,
    });
    return json({ ok: true, submission: result });
  } catch (err) {
    if (err instanceof MarketplaceSubmissionError) {
      const status =
        err.code === "typosquat_rejected"
          ? 409
          : err.code === "db_unavailable"
            ? 503
            : 400;
      return json({ error: err.code, detail: err.detail }, status);
    }
    return json(
      {
        error: "submission_failed",
        detail: err instanceof Error ? err.message : String(err),
      },
      500,
    );
  }
}

async function readManifest(
  form: FormData,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const manifestJson = form.get("manifest");
  if (typeof manifestJson === "string") {
    try {
      return { ok: true, value: JSON.parse(manifestJson) };
    } catch {
      return { ok: false, error: "invalid_manifest_json" };
    }
  }

  const manifestFile = form.get("manifest_file");
  if (manifestFile instanceof File) {
    try {
      return { ok: true, value: JSON.parse(await manifestFile.text()) };
    } catch {
      return { ok: false, error: "invalid_manifest_file" };
    }
  }

  return { ok: false, error: "missing_manifest" };
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
