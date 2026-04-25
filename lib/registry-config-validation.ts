import Ajv, { type ErrorObject } from "ajv";
import registrySchema from "../config/agents.registry.schema.json";

const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(registrySchema);

export function validateRegistryConfig(config: unknown, source = "registry config"): void {
  if (validate(config)) return;
  const details = formatAjvErrors(validate.errors ?? []);
  throw new Error(`[registry] invalid ${source}:\n${details}`);
}

function formatAjvErrors(errors: ErrorObject[]): string {
  if (errors.length === 0) return "  - unknown validation error";
  return errors
    .map((err) => {
      const path = err.instancePath || "<root>";
      if (err.keyword === "additionalProperties") {
        const key = String(
          (err.params as { additionalProperty?: unknown }).additionalProperty ?? "unknown",
        );
        return `  - ${path}: unknown key "${key}"`;
      }
      return `  - ${path}: ${err.message ?? err.keyword}`;
    })
    .join("\n");
}
