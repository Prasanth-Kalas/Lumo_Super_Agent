import { AuthError, requireServerUser } from "@/lib/auth";
import {
  ConfirmationKeyError,
  registerDeviceKey,
} from "@/lib/merchant/confirmation-keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RegisterDeviceKeyRequest {
  deviceId?: string;
  publicKeyPem?: string;
}

export async function POST(req: Request): Promise<Response> {
  try {
    const user = await requireServerUser();
    const body = (await req.json().catch(() => null)) as RegisterDeviceKeyRequest | null;
    if (!body) return json({ error: "invalid_json" }, 400);
    if (typeof body.deviceId !== "string") {
      return json({ error: "missing_device_id" }, 400);
    }
    if (typeof body.publicKeyPem !== "string") {
      return json({ error: "missing_public_key" }, 400);
    }
    const key = await registerDeviceKey({
      userId: user.id,
      deviceId: body.deviceId,
      publicKeyPem: body.publicKeyPem,
    });
    return json({
      key: {
        id: key.id,
        deviceId: key.device_id,
        fingerprint: key.public_key_fingerprint,
        algorithm: key.algorithm,
        state: key.state,
        registeredAt: key.created_at,
      },
    }, 201);
  } catch (error) {
    if (error instanceof AuthError) {
      return json({ error: error.code }, error.code === "not_authenticated" ? 401 : 403);
    }
    if (error instanceof ConfirmationKeyError) {
      return json({ error: error.code, message: error.message }, error.status);
    }
    console.error("[payments] register-device-key failed", error);
    return json({ error: "internal_error" }, 500);
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
