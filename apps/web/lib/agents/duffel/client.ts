export type DuffelEnvironment = "test" | "live";

export type DuffelErrorCode =
  | "duffel_not_configured"
  | "duffel_request_failed"
  | "duffel_bad_response"
  | "duffel_offer_not_holdable"
  | "duffel_booking_failed";

export class DuffelError extends Error {
  readonly code: DuffelErrorCode;
  readonly status: number;

  constructor(code: DuffelErrorCode, message: string, status = 500) {
    super(message);
    this.name = "DuffelError";
    this.code = code;
    this.status = status;
  }
}

export interface DuffelClientOptions {
  apiKey?: string;
  environment?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface DuffelApiEnvelope<T> {
  data: T;
  meta?: Record<string, unknown>;
}

export interface DuffelOffer {
  id: string;
  total_amount: string;
  total_currency: string;
  expires_at?: string;
  payment_requirements?: {
    requires_instant_payment?: boolean;
    price_guarantee_expires_at?: string | null;
    payment_required_by?: string | null;
  };
  slices?: Array<{
    duration?: string;
    origin?: { iata_code?: string; name?: string; city_name?: string };
    destination?: { iata_code?: string; name?: string; city_name?: string };
    segments?: Array<{
      departing_at?: string;
      arriving_at?: string;
      marketing_carrier?: { name?: string; iata_code?: string };
      operating_carrier?: { name?: string; iata_code?: string };
      marketing_carrier_flight_number?: string;
    }>;
  }>;
}

export interface DuffelOfferRequest {
  id: string;
  offers?: DuffelOffer[];
  passengers?: Array<{ id?: string; type?: string }>;
}

export interface DuffelOrder {
  id: string;
  booking_reference?: string;
  total_amount: string;
  total_currency: string;
  awaiting_payment?: boolean;
  created_at?: string;
  payment_status?: {
    awaiting_payment?: boolean;
    payment_required_by?: string | null;
    price_guarantee_expires_at?: string | null;
  };
  documents?: Array<{ type?: string; unique_identifier?: string }>;
}

export class DuffelClient {
  private readonly apiKey?: string;
  private readonly environment: DuffelEnvironment;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: DuffelClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.LUMO_DUFFEL_API_KEY;
    this.environment =
      (options.environment ?? process.env.LUMO_DUFFEL_ENVIRONMENT ?? "test") === "live"
        ? "live"
        : "test";
    this.baseUrl = options.baseUrl ?? "https://api.duffel.com";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get configured(): boolean {
    return Boolean(this.apiKey) && this.environment === "test";
  }

  async createOfferRequest(input: {
    origin: string;
    destination: string;
    departDate: string;
    returnDate?: string | null;
    passengers: Array<{ type: "adult" | "child" | "infant_without_seat" }>;
    cabinClass?: "economy" | "premium_economy" | "business" | "first";
    supplierTimeoutMs?: number;
  }): Promise<DuffelOfferRequest> {
    const slices = [
      {
        origin: input.origin,
        destination: input.destination,
        departure_date: input.departDate,
      },
    ];
    if (input.returnDate) {
      slices.push({
        origin: input.destination,
        destination: input.origin,
        departure_date: input.returnDate,
      });
    }
    return this.post<DuffelOfferRequest>(
      `/air/offer_requests?return_offers=true&supplier_timeout=${input.supplierTimeoutMs ?? 10000}`,
      {
        data: {
          slices,
          passengers: input.passengers,
          cabin_class: input.cabinClass ?? "economy",
        },
      },
    );
  }

  async getOffer(offerId: string): Promise<DuffelOffer> {
    return this.get<DuffelOffer>(`/air/offers/${encodeURIComponent(offerId)}`);
  }

  async createOrder(input: {
    offerId: string;
    passengers: Array<Record<string, unknown>>;
    payment?: { amount: string; currency: string };
    hold?: boolean;
  }): Promise<DuffelOrder> {
    return this.post<DuffelOrder>("/air/orders", {
      data: {
        selected_offers: [input.offerId],
        passengers: input.passengers,
        ...(input.hold
          ? { type: "hold" }
          : {
              payments: input.payment
                ? [
                    {
                      type: "balance",
                      amount: input.payment.amount,
                      currency: input.payment.currency,
                    },
                  ]
                : undefined,
            }),
      },
    });
  }

  async cancelOrder(orderId: string): Promise<DuffelOrder> {
    return this.post<DuffelOrder>(`/air/orders/${encodeURIComponent(orderId)}/actions/cancel`, {
      data: {},
    });
  }

  private async get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    if (!this.configured || !this.apiKey) {
      throw new DuffelError(
        "duffel_not_configured",
        "Duffel is not configured. Set LUMO_DUFFEL_API_KEY and LUMO_DUFFEL_ENVIRONMENT=test.",
        503,
      );
    }
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "duffel-version": "v2",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      throw new DuffelError(
        "duffel_request_failed",
        `Duffel ${method} ${path} failed with ${response.status}`,
        response.status,
      );
    }
    const json = (await response.json()) as DuffelApiEnvelope<T>;
    if (!json || typeof json !== "object" || !("data" in json)) {
      throw new DuffelError("duffel_bad_response", "Duffel response missing data envelope", 502);
    }
    return json.data;
  }
}

export function createDuffelClient(options: DuffelClientOptions = {}): DuffelClient {
  return new DuffelClient(options);
}
