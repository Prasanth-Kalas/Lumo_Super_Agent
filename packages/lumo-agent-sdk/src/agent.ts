export type TransactionState =
  | "draft"
  | "awaiting_confirmation"
  | "authorized"
  | "executing"
  | "partially_committed"
  | "committed"
  | "rolling_back"
  | "rolled_back"
  | "refund_pending"
  | "refunded"
  | "failed"
  | "manual_review";

export interface TransactionResult {
  transaction_id: string;
  state: TransactionState;
  provider_reference?: string;
  amount_cents: number;
  currency: "USD";
  evidence?: Record<string, unknown>;
}

export interface RefundResult {
  transaction_id: string;
  state: TransactionState;
  refunded_amount_cents: number;
  provider_reference?: string;
  evidence?: Record<string, unknown>;
}

export interface MerchantAgentContext {
  transaction_id?: string;
  idempotency_key?: string;
  max_amount?: { amount: number; currency: "USD" };
  provider_token_ref?: string;
  evidence?: Record<string, unknown>;
}

export abstract class LumoAgent<TManifest = unknown> {
  readonly manifest: TManifest;

  constructor(manifest: TManifest) {
    this.manifest = manifest;
  }
}

export abstract class MerchantOfRecordAgent<TManifest = unknown> extends LumoAgent<TManifest> {
  abstract executeTransaction(
    input: unknown,
    context: MerchantAgentContext,
  ): Promise<TransactionResult>;

  abstract refund(
    transactionId: string,
    amountCents?: number,
  ): Promise<RefundResult>;

  abstract getTransactionStatus(transactionId: string): Promise<TransactionState>;
}
