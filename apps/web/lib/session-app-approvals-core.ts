import { createHash } from "node:crypto";

export function sessionApprovalIdempotencyKey(
  session_id: string,
  agent_id: string,
): string {
  return createHash("sha256")
    .update(session_id.trim())
    .update(":")
    .update(agent_id.trim())
    .digest("hex")
    .slice(0, 32);
}
