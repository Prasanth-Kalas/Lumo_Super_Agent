import { createHmac, randomUUID } from "node:crypto";

interface SignServiceJwtInput {
  audience: string;
  user_id: string;
  scope: string;
  request_id?: string;
  ttl_seconds?: number;
}

export function signLumoServiceJwt(input: SignServiceJwtInput): string {
  const secret = process.env.LUMO_ML_SERVICE_JWT_SECRET;
  if (!secret) {
    throw new Error("LUMO_ML_SERVICE_JWT_SECRET is required for system-agent dispatch");
  }
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    iss: "lumo-core",
    aud: input.audience,
    sub: input.user_id,
    jti: input.request_id ?? randomUUID(),
    scope: input.scope,
    iat: now,
    exp: now + (input.ttl_seconds ?? 60),
  };
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signature = createHmac("sha256", secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest("base64url");
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

function base64url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}
