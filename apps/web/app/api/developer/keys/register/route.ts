import type { NextRequest } from "next/server";
import { registerDeveloperKey } from "@/lib/trust/keys";
import { json, readJson, requireDeveloperUser, stringField } from "../../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const auth = await requireDeveloperUser();
  if (!auth.ok) return auth.response;
  const body = await readJson(req);
  if (!body) return json({ error: "invalid_json" }, 400);

  const publicKeyPem = stringField(body, "public_key_pem");
  if (!publicKeyPem.includes("BEGIN PUBLIC KEY")) {
    return json({ error: "invalid_public_key" }, 400);
  }
  const keyId = stringField(body, "key_id") || null;
  const label = stringField(body, "label") || null;
  const jwk = typeof body.public_key_jwk === "object" && body.public_key_jwk !== null
    ? (body.public_key_jwk as Record<string, unknown>)
    : null;

  try {
    const key = await registerDeveloperKey({
      userId: auth.user.id,
      keyId,
      publicKeyPem,
      publicKeyJwk: jwk,
      label,
    });
    return json({
      ok: true,
      key: {
        key_id: key.key_id,
        fingerprint_sha256: key.fingerprint_sha256,
        algorithm: key.algorithm,
        state: key.state,
      },
    });
  } catch (err) {
    return json(
      { error: err instanceof Error ? err.message : "key_registration_failed" },
      400,
    );
  }
}
