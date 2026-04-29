import { getSubmissionDetail } from "@/lib/developer-dashboard";
import { json, requireDeveloperUser } from "../../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  const auth = await requireDeveloperUser();
  if (!auth.ok) return auth.response;
  const submission = await getSubmissionDetail({
    userId: auth.user.id,
    submissionId: params.id,
  });
  if (!submission) return json({ error: "submission_not_found" }, 404);
  return json({ submission });
}
