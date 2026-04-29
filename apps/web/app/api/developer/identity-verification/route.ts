import {
  getIdentityVerification,
  submitIdentityEvidence,
} from "@/lib/developer-dashboard";
import { json, readJson, requireDeveloperUser, stringField } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const auth = await requireDeveloperUser();
  if (!auth.ok) return auth.response;
  const identity = await getIdentityVerification(auth.user.id);
  return json({ identity });
}

export async function POST(req: Request): Promise<Response> {
  const auth = await requireDeveloperUser();
  if (!auth.ok) return auth.response;
  const body = await readJson(req);
  if (!body) return json({ error: "invalid_json" }, 400);
  const result = await submitIdentityEvidence({
    userId: auth.user.id,
    legalEntityName: stringField(body, "legal_entity_name"),
    registrationNumber: stringField(body, "registration_number") || null,
    registrationCountry: stringField(body, "registration_country") || null,
    documentPath: stringField(body, "document_path"),
    evidence: isRecord(body.evidence) ? body.evidence : {},
  });
  if (!result.ok) return json({ error: result.error }, result.status);
  return json({ identity: result.identity }, 201);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
