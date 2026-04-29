import { parseManifest } from "@lumo/agent-sdk";
import type { TrustCheckContext, TrustCheckResult } from "./types.js";
import { result } from "./types.js";

export async function runManifestCheck(ctx: TrustCheckContext):
  Promise<{ check: TrustCheckResult; manifest?: ReturnType<typeof parseManifest> }> {
  const startedAt = new Date().toISOString();
  try {
    const manifest = parseManifest(ctx.manifestRaw);
    return {
      manifest,
      check: result({
        id: "manifest",
        label: "Manifest validator",
        outcome: "pass",
        startedAt,
        details: {
          agent_id: manifest.agent_id,
          version: manifest.version,
          sdk_version: manifest.capabilities.sdk_version,
        },
      }),
    };
  } catch (err) {
    return {
      check: result({
        id: "manifest",
        label: "Manifest validator",
        outcome: "fail",
        startedAt,
        reason_codes: ["manifest_invalid"],
        details: { error: err instanceof Error ? err.message : String(err) },
      }),
    };
  }
}
