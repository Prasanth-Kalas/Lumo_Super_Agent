import { readFileSync } from "node:fs";
import {
  defineSampleAgent,
  stableHash,
  type SampleAgentContext,
  type SampleAgentResult,
} from "../../_shared/runtime.ts";

const manifest = JSON.parse(
  readFileSync(new URL("../lumo-agent.json", import.meta.url), "utf8"),
);

interface StubLegOutputs extends Record<string, unknown> {
  leg: "flight" | "hotel" | "ground";
  provider_reference: string;
  amount_cents: number;
  currency: "USD";
  idempotency_key: string;
}

interface StubCancelOutputs extends Record<string, unknown> {
  leg: "flight" | "hotel" | "ground";
  provider_reference: string;
  cancelled: true;
}

export default defineSampleAgent({
  manifest,
  capabilities: {
    book_flight_stub: (inputs, ctx) => bookLeg("flight", inputs, ctx),
    book_hotel_stub: (inputs, ctx) => bookLeg("hotel", inputs, ctx),
    book_ground_stub: (inputs, ctx) => bookLeg("ground", inputs, ctx),
    cancel_flight_stub: (inputs, ctx) => cancelLeg("flight", inputs, ctx),
    cancel_hotel_stub: (inputs, ctx) => cancelLeg("hotel", inputs, ctx),
    cancel_ground_stub: (inputs, ctx) => cancelLeg("ground", inputs, ctx),
  },
});

async function bookLeg(
  leg: StubLegOutputs["leg"],
  inputs: Record<string, unknown>,
  ctx: SampleAgentContext,
): Promise<SampleAgentResult<StubLegOutputs>> {
  const idempotencyKey = stringInput(inputs.idempotency_key) ?? `${ctx.request_id}:${leg}`;
  if (leg === "ground" || inputs.force_failure === true) {
    return {
      status: "failed",
      outputs: {
        leg,
        provider_reference: "",
        amount_cents: 100,
        currency: "USD",
        idempotency_key: idempotencyKey,
      },
      provenance_evidence: {
        sources: [{ type: "stub.failure", ref: `forced_${leg}_failure` }],
        redaction_applied: true,
      },
      cost_actuals: { usd: 0.004, calls: 1 },
    };
  }

  const providerReference = `stub_${leg}_${stableHash({ idempotencyKey, leg }).slice(0, 12)}`;
  await ctx.state.set(`stub-3-leg-trip:${providerReference}`, {
    leg,
    idempotency_key: idempotencyKey,
    committed_at: ctx.now().toISOString(),
  });

  return {
    status: "succeeded",
    outputs: {
      leg,
      provider_reference: providerReference,
      amount_cents: 100,
      currency: "USD",
      idempotency_key: idempotencyKey,
    },
    provenance_evidence: {
      sources: [{ type: "connector.mock-merchant", ref: providerReference }],
      redaction_applied: true,
    },
    cost_actuals: { usd: 0.012, calls: 1 },
  };
}

async function cancelLeg(
  leg: StubCancelOutputs["leg"],
  inputs: Record<string, unknown>,
  _ctx: SampleAgentContext,
): Promise<SampleAgentResult<StubCancelOutputs>> {
  const providerReference =
    stringInput(inputs.provider_reference) ??
    stringInput(inputs.booking_id) ??
    `stub_${leg}_unknown`;

  return {
    status: "succeeded",
    outputs: {
      leg,
      provider_reference: providerReference,
      cancelled: true,
    },
    provenance_evidence: {
      sources: [{ type: "connector.mock-merchant.cancel", ref: providerReference }],
      redaction_applied: true,
    },
    cost_actuals: { usd: 0.006, calls: 1 },
  };
}

function stringInput(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
