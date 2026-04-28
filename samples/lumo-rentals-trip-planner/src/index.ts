import { readFileSync } from "node:fs";
import {
  buildConfirmationCard,
  defineSampleAgent,
  inMinutes,
  stableHash,
  type SampleAgentContext,
  type SampleAgentResult,
} from "../../_shared/runtime.ts";

const manifest = JSON.parse(
  readFileSync(new URL("../lumo-agent.json", import.meta.url), "utf8"),
);

export interface RentalOption extends Record<string, unknown> {
  rental_id: string;
  vehicle: string;
  pickup: string;
  dropoff: string;
  start_at: string;
  end_at: string;
  total_usd: number;
  currency: string;
  refundable_until: string;
}

interface BookingOutputs {
  rental_id: string;
  reservation_id: string;
  charge_id: string;
  calendar_event_id: string;
  total_usd: number;
  idempotency_key: string;
  cached?: boolean;
}

export default defineSampleAgent({
  manifest,
  capabilities: {
    find_rental_for_trip: async (inputs, ctx) => {
      const trip = await ctx.brain.lumo_optimize_trip({
        destination: stringInput(inputs.destination) ?? "Las Vegas",
        start_at: stringInput(inputs.start_at) ?? "2026-05-15T16:00:00.000Z",
        end_at: stringInput(inputs.end_at) ?? "2026-05-18T18:00:00.000Z",
      });
      const rentals = ctx.connectors["lumo-rentals"];
      const option = rentals?.search
        ? ((await rentals.search({ trip })) as RentalOption)
        : fixtureRental();
      return rentalFound(option, "lumo-rentals.search");
    },
    book_rental: async (inputs, ctx) => {
      const option = rentalFromInputs(inputs);
      const card = buildConfirmationCard({
        title: `Book ${option.vehicle} for your trip`,
        body: `Pickup ${option.pickup} and return ${option.dropoff}. Total ${formatUsd(
          option.total_usd,
        )}.`,
        side_effect_summary:
          "Charges Stripe, creates a Lumo Rentals reservation, and adds the rental window to Google Calendar.",
        reversibility: "compensating",
        expires_at: inMinutes(ctx.now(), 15),
        amount_cents: Math.round(option.total_usd * 100),
        currency: option.currency,
        metadata: {
          rental_id: option.rental_id,
          refundable_until: option.refundable_until,
        },
      });
      return {
        status: "needs_confirmation",
        confirmation_card: card,
        outputs: {
          rental_id: option.rental_id,
          confirmation_card_id: card.id,
          total_usd: option.total_usd,
        },
        provenance_evidence: {
          sources: [
            { type: "brain.optimize", ref: "lumo_optimize_trip" },
            { type: "connector.lumo-rentals", ref: option.rental_id },
          ],
          redaction_applied: false,
        },
        cost_actuals: { usd: 0.022, calls: 2 },
      };
    },
    confirm_booking: async (inputs, ctx) => confirmBooking(inputs, ctx),
  },
});

async function confirmBooking(
  inputs: Record<string, unknown>,
  ctx: SampleAgentContext,
): Promise<SampleAgentResult<BookingOutputs>> {
  const option = rentalFromInputs(inputs);
  const idempotencyKey = stringInput(inputs.request_id) ?? ctx.request_id;
  const stateKey = `booking:${idempotencyKey}:${option.rental_id}`;
  const cached = await ctx.state.get<SampleAgentResult<BookingOutputs>>(stateKey);
  if (cached) {
    return {
      ...cached,
      outputs: {
        ...(cached.outputs as BookingOutputs),
        cached: true,
      },
    };
  }

  const stripe = ctx.connectors.stripe;
  const rentals = ctx.connectors["lumo-rentals"];
  const calendar = ctx.connectors["google-calendar"];
  const charge = stripe?.charge
    ? ((await stripe.charge({
        amount_cents: Math.round(option.total_usd * 100),
        currency: option.currency.toLowerCase(),
        idempotency_key: idempotencyKey,
      })) as { charge_id: string })
    : { charge_id: "ch_sample_lumo_rental_001" };
  const reservation = rentals?.reserve
    ? ((await rentals.reserve({
        rental_id: option.rental_id,
        charge_id: charge.charge_id,
        idempotency_key: idempotencyKey,
      })) as { reservation_id: string })
    : { reservation_id: "res_sample_lumo_rental_001" };
  const event = calendar?.createEvent
    ? ((await calendar.createEvent({
        title: `Rental car: ${option.vehicle}`,
        start_at: option.start_at,
        end_at: option.end_at,
        location: option.pickup,
        idempotency_key: idempotencyKey,
      })) as { event_id: string })
    : { event_id: "evt_lumo_rental_001" };

  const result: SampleAgentResult<BookingOutputs> = {
    status: "succeeded",
    outputs: {
      rental_id: option.rental_id,
      reservation_id: reservation.reservation_id,
      charge_id: charge.charge_id,
      calendar_event_id: event.event_id,
      total_usd: option.total_usd,
      idempotency_key: idempotencyKey,
    },
    provenance_evidence: {
      sources: [
        { type: "connector.stripe", ref: charge.charge_id },
        { type: "connector.lumo-rentals", ref: reservation.reservation_id },
        { type: "connector.google-calendar", ref: event.event_id },
        { type: "idempotency", ref: idempotencyKey, hash: stableHash(inputs) },
      ],
      redaction_applied: true,
    },
    cost_actuals: { usd: 0.118, calls: 3 },
  };
  await ctx.state.set(stateKey, result);
  return result;
}

function rentalFound(option: RentalOption, ref: string): SampleAgentResult<RentalOption> {
  return {
    status: "succeeded",
    outputs: option,
    provenance_evidence: {
      sources: [
        { type: "brain.optimize", ref: "lumo_optimize_trip" },
        { type: "connector.lumo-rentals", ref },
      ],
      redaction_applied: false,
    },
    cost_actuals: { usd: 0.041, calls: 2 },
  };
}

function rentalFromInputs(inputs: Record<string, unknown>): RentalOption {
  if (typeof inputs.rental === "object" && inputs.rental !== null) {
    return { ...fixtureRental(), ...(inputs.rental as Partial<RentalOption>) };
  }
  return fixtureRental();
}

export function fixtureRental(): RentalOption {
  return JSON.parse(
    readFileSync(new URL("../fixtures/rental-option.json", import.meta.url), "utf8"),
  ) as RentalOption;
}

function stringInput(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}
