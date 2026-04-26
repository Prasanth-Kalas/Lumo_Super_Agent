import type { ConnectionMeta } from "./connections.js";

const DUPLICATE_CALLBACK_GRACE_MS = 60_000;

export function hasRecentActiveOAuthConnection(
  connections: ConnectionMeta[],
  nowMs = Date.now(),
): boolean {
  const cutoff = nowMs - DUPLICATE_CALLBACK_GRACE_MS;
  return connections.some((connection) => {
    if (connection.status !== "active") return false;
    const connectedAt = new Date(connection.connected_at).getTime();
    return Number.isFinite(connectedAt) && connectedAt >= cutoff;
  });
}
