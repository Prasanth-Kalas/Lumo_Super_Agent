/**
 * STUB for MOBILE-PAYMENTS-1.
 *
 * In-memory state for the payments backend, scoped per user. MERCHANT-1
 * replaces this with a Stripe-backed customer + payment methods + setup
 * intents path against a real Stripe Test (then Live) account. The
 * shapes here intentionally mirror the slice of Stripe data the iOS
 * client consumes, so the swap is mechanical.
 *
 * State is module-level and process-volatile — fine for a dev stub,
 * insufficient for production. MERCHANT-1's persistence layer is the
 * `agent_cost_log`-shaped `payments_*` tables it ships alongside the
 * Stripe API integration.
 */

export type StubCardBrand =
  | "visa"
  | "mastercard"
  | "amex"
  | "discover"
  | "unknown";

export interface StubPaymentMethod {
  id: string;
  brand: StubCardBrand;
  last4: string;
  expMonth: number;
  expYear: number;
  isDefault: boolean;
  addedAt: string;
}

export interface StubReceipt {
  id: string;
  transactionId: string;
  amountCents: number;
  currency: string;
  paymentMethodId: string;
  paymentMethodLabel: string;
  lineItems: Array<{ label: string; amountCents: number }>;
  createdAt: string;
  status: "succeeded" | "failed";
}

interface StubUserState {
  methods: StubPaymentMethod[];
  receipts: StubReceipt[];
}

const userState = new Map<string, StubUserState>();

function ensureUserState(userId: string): StubUserState {
  let state = userState.get(userId);
  if (!state) {
    state = { methods: [], receipts: [] };
    userState.set(userId, state);
  }
  return state;
}

export function listMethods(userId: string): StubPaymentMethod[] {
  return ensureUserState(userId).methods.slice();
}

export function addMethod(
  userId: string,
  input: Omit<StubPaymentMethod, "id" | "isDefault" | "addedAt">,
): StubPaymentMethod {
  const state = ensureUserState(userId);
  const id = `pm_test_${cryptoRandom(16)}`;
  const isDefault = state.methods.length === 0;
  const method: StubPaymentMethod = {
    id,
    brand: input.brand,
    last4: input.last4,
    expMonth: input.expMonth,
    expYear: input.expYear,
    isDefault,
    addedAt: new Date().toISOString(),
  };
  state.methods.push(method);
  return method;
}

export function setDefault(
  userId: string,
  methodId: string,
): StubPaymentMethod | null {
  const state = ensureUserState(userId);
  const method = state.methods.find((m) => m.id === methodId);
  if (!method) return null;
  for (const m of state.methods) m.isDefault = m.id === methodId;
  return method;
}

export function removeMethod(userId: string, methodId: string): boolean {
  const state = ensureUserState(userId);
  const before = state.methods.length;
  state.methods = state.methods.filter((m) => m.id !== methodId);
  if (state.methods.length === before) return false;
  if (!state.methods.some((m) => m.isDefault) && state.methods.length > 0) {
    const first = state.methods[0];
    if (first) first.isDefault = true;
  }
  return true;
}

export function recordReceipt(
  userId: string,
  receipt: Omit<StubReceipt, "id" | "createdAt">,
): StubReceipt {
  const state = ensureUserState(userId);
  const recorded: StubReceipt = {
    ...receipt,
    id: `rcpt_test_${cryptoRandom(16)}`,
    createdAt: new Date().toISOString(),
  };
  state.receipts.unshift(recorded);
  return recorded;
}

export function listReceipts(userId: string): StubReceipt[] {
  return ensureUserState(userId).receipts.slice();
}

/**
 * Test-only reset hook so route-handler tests don't leak state between
 * cases. Production callers should never invoke this.
 */
export function resetStubState(): void {
  userState.clear();
}

function cryptoRandom(bytes: number): string {
  const arr = new Uint8Array(bytes);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(arr);
  } else {
    for (let i = 0; i < bytes; i += 1) arr[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}
