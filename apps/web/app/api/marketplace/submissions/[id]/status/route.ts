import type { NextRequest } from "next/server";
import { requireServerUser } from "@/lib/auth";
import { marketplaceSubmissionStatus } from "@/lib/marketplace/submission";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } },
): Promise<Response> {
  await requireServerUser();
  const version = req.nextUrl.searchParams.get("version");
  const status = await marketplaceSubmissionStatus(params.id, version);
  if (!status) return json({ error: "submission_not_found" }, 404);
  return json({ submission: status });
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
