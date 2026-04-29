import { AuthError, requireServerUser } from "@/lib/auth";

export async function requireDeveloperUser():
  Promise<{ ok: true; user: Awaited<ReturnType<typeof requireServerUser>> } | { ok: false; response: Response }> {
  try {
    const user = await requireServerUser();
    return { ok: true, user };
  } catch (err) {
    if (err instanceof AuthError) {
      return { ok: false, response: json({ error: err.code }, err.code === "forbidden" ? 403 : 401) };
    }
    return { ok: false, response: json({ error: "auth_failed" }, 401) };
  }
}

export async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = (await req.json()) as unknown;
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

export function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === "string" ? value.trim() : "";
}

export function intParam(value: string | null, fallback: number, max = 100): number {
  const parsed = value ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(parsed)));
}
