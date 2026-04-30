/**
 * In-memory refund-request log — STUB until PAYMENTS-REFUND-1 lands the
 * real saga-driven flow. The /receipts/[id] page hits this through
 * /api/receipts/[id]/refund so the consumer surface and copy can be
 * built today; only the implementation swaps.
 *
 * Server restart loses the log. Acceptable for v1 since the user-visible
 * confirmation toast is the only artifact we promise.
 */

const requests: RefundRequest[] = [];

export interface RefundRequest {
  request_id: string;
  user_id: string;
  transaction_id: string;
  reason: string | null;
  requested_at: string;
}

export function recordRefundRequest(
  partial: Omit<RefundRequest, "request_id">,
): string {
  const request_id = `rrq_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  requests.push({ request_id, ...partial });
  return request_id;
}

export function listRefundRequestsForUser(user_id: string): RefundRequest[] {
  return requests.filter((r) => r.user_id === user_id);
}

export function __resetForTesting(): void {
  requests.length = 0;
}
