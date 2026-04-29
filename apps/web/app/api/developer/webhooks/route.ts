import {
  listDeveloperWebhooks,
  registerDeveloperWebhook,
  updateDeveloperWebhook,
} from "@/lib/developer-dashboard";
import { json, readJson, requireDeveloperUser, stringField } from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const auth = await requireDeveloperUser();
  if (!auth.ok) return auth.response;
  const webhooks = await listDeveloperWebhooks(auth.user.id);
  return json({ webhooks });
}

export async function POST(req: Request): Promise<Response> {
  const auth = await requireDeveloperUser();
  if (!auth.ok) return auth.response;
  const body = await readJson(req);
  if (!body) return json({ error: "invalid_json" }, 400);
  const result = await registerDeveloperWebhook({
    userId: auth.user.id,
    label: stringField(body, "label"),
    url: stringField(body, "url"),
    eventTypes: body.event_types,
  });
  if (!result.ok) return json({ error: result.error }, result.status);
  return json({ webhook: result.webhook }, 201);
}

export async function PATCH(req: Request): Promise<Response> {
  const auth = await requireDeveloperUser();
  if (!auth.ok) return auth.response;
  const body = await readJson(req);
  if (!body) return json({ error: "invalid_json" }, 400);
  const webhookId = stringField(body, "id");
  if (!webhookId) return json({ error: "missing_id" }, 400);
  const result = await updateDeveloperWebhook({
    userId: auth.user.id,
    webhookId,
    label: body.label === undefined ? undefined : stringField(body, "label"),
    url: body.url === undefined ? undefined : stringField(body, "url"),
    eventTypes: body.event_types,
    active: typeof body.active === "boolean" ? body.active : undefined,
  });
  if (!result.ok) return json({ error: result.error }, result.status);
  return json({ webhook: result.webhook });
}
