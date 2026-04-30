"use client";

/**
 * /receipts/[id] — single receipt with line items + refund modal.
 *
 * The "Initiate refund" button POSTs to the STUB
 * /api/receipts/[id]/refund. v1 surfaces a toast and closes; the real
 * flow lands in PAYMENTS-REFUND-1 and will mutate refunded_amount_cents.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { LumoWordmark } from "@/components/BrandMark";
import { ThemeToggle } from "@/components/ThemeToggle";
import {
  formatCents,
  formatTransactionStatus,
  isRefundable,
  providerLabel,
  statusPillClass,
  totalDisplayCents,
} from "@/lib/web-screens-receipts";
import type { TransactionLegRow, TransactionRow } from "@/lib/transactions";

interface DetailResponse {
  transaction: TransactionRow;
  legs: TransactionLegRow[];
}

export default function ReceiptDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const [data, setData] = useState<DetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refundOpen, setRefundOpen] = useState(false);
  const [refundBusy, setRefundBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/receipts/${id}`, { cache: "no-store" });
      if (res.status === 404) {
        setError("Receipt not found.");
        setData(null);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as DetailResponse;
      setData(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load receipt");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (id) void refresh();
  }, [id, refresh]);

  const handleRefund = async () => {
    setRefundBusy(true);
    try {
      const res = await fetch(`/api/receipts/${id}/refund`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "user_initiated" }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setRefundOpen(false);
      setToast("We've received your refund request. A teammate will follow up shortly.");
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Refund request failed");
    } finally {
      setRefundBusy(false);
    }
  };

  const tx = data?.transaction ?? null;
  const legs = data?.legs ?? [];
  const label = tx ? formatTransactionStatus(tx) : "Pending";
  const refundable = tx ? isRefundable(tx) : false;

  return (
    <main className="min-h-dvh bg-lumo-bg text-lumo-fg-high">
      <header className="sticky top-0 z-20 border-b border-lumo-hair bg-lumo-bg/85 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-5 py-3">
          <div className="flex items-center gap-2.5">
            <LumoWordmark height={20} />
            <span className="hidden sm:inline text-lumo-fg-low text-[12px]">/</span>
            <Link href="/receipts" className="hidden sm:inline text-[13px] text-lumo-fg-mid hover:text-lumo-fg">
              Receipts
            </Link>
            <span className="hidden sm:inline text-lumo-fg-low text-[12px]">/</span>
            <span className="hidden sm:inline text-[13px] text-lumo-fg-low font-mono">
              {id.slice(0, 8)}
            </span>
          </div>
          <ThemeToggle />
        </div>
      </header>

      <div className="mx-auto w-full max-w-3xl px-5 py-8 space-y-6">
        {toast ? (
          <div
            role="status"
            className="rounded-md border border-lumo-ok/30 bg-lumo-ok/5 px-3 py-2 text-[12.5px] text-lumo-ok"
          >
            {toast}
          </div>
        ) : null}

        {error ? (
          <div
            role="alert"
            className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-[12.5px] text-red-500"
          >
            {error}
          </div>
        ) : null}

        {loading ? (
          <div className="h-32 rounded-xl border border-lumo-hair bg-lumo-surface animate-pulse" />
        ) : tx ? (
          <>
            <section className="rounded-xl border border-lumo-hair bg-lumo-surface p-5 sm:p-6 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-lumo-fg leading-tight">
                    {providerLabel(tx.provider)}
                  </h1>
                  <div className="text-[12px] text-lumo-fg-low mt-1">
                    {new Date(tx.created_at).toLocaleString()} · agent {tx.agent_id}@{tx.agent_version}
                  </div>
                </div>
                <span
                  className={`text-[11px] px-2 py-0.5 rounded-full border flex-shrink-0 ${statusPillClass(label)}`}
                >
                  {label}
                </span>
              </div>
              <div className="text-[18px] font-semibold text-lumo-fg">
                {formatCents(totalDisplayCents(tx), tx.currency)}
              </div>
              {tx.payment_method_label ? (
                <div className="text-[12.5px] text-lumo-fg-mid">
                  Charged to {tx.payment_method_label}
                </div>
              ) : null}
              {tx.refunded_amount_cents > 0 ? (
                <div className="text-[12.5px] text-lumo-fg-mid">
                  Refunded {formatCents(tx.refunded_amount_cents, tx.currency)}
                </div>
              ) : null}
              {refundable ? (
                <button
                  type="button"
                  onClick={() => setRefundOpen(true)}
                  className="h-9 px-3.5 rounded-md border border-lumo-hair bg-lumo-bg/40 text-[12.5px] text-lumo-fg-high hover:bg-lumo-elevated transition-colors"
                >
                  Initiate refund
                </button>
              ) : null}
            </section>

            <section className="rounded-xl border border-lumo-hair bg-lumo-surface p-5 sm:p-6 space-y-3">
              <h2 className="text-[16px] font-semibold tracking-[-0.02em] text-lumo-fg">
                Line items
              </h2>
              {tx.line_items.length === 0 ? (
                <p className="text-[12.5px] text-lumo-fg-mid">No itemized line items recorded.</p>
              ) : (
                <ul className="divide-y divide-lumo-hair">
                  {tx.line_items.map((li, i) => (
                    <li key={i} className="flex items-baseline justify-between py-2 text-[13px]">
                      <span className="text-lumo-fg-high">
                        {li.description ?? `Item ${i + 1}`}
                        {li.quantity && li.quantity > 1 ? ` × ${li.quantity}` : ""}
                      </span>
                      <span className="text-lumo-fg-mid font-mono">
                        {typeof li.amount_cents === "number"
                          ? formatCents(li.amount_cents, tx.currency)
                          : "—"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {legs.length > 0 ? (
              <section className="rounded-xl border border-lumo-hair bg-lumo-surface p-5 sm:p-6 space-y-3">
                <h2 className="text-[16px] font-semibold tracking-[-0.02em] text-lumo-fg">
                  Legs
                </h2>
                <ol className="space-y-2">
                  {legs.map((leg) => (
                    <li
                      key={leg.id}
                      className="rounded-md border border-lumo-hair bg-lumo-bg/40 p-3 flex items-baseline justify-between gap-2 text-[12.5px]"
                    >
                      <div>
                        <span className="text-lumo-fg-high font-medium">
                          {leg.step_order + 1}. {leg.capability_id}
                        </span>
                        <span className="ml-2 text-lumo-fg-low">{leg.provider}</span>
                      </div>
                      <span className="text-lumo-fg-mid font-mono">
                        {formatCents(leg.amount_cents, leg.currency)} · {leg.status}
                      </span>
                    </li>
                  ))}
                </ol>
              </section>
            ) : null}
          </>
        ) : !error ? (
          <div className="rounded-xl border border-dashed border-lumo-hair bg-lumo-bg/40 px-5 py-8 text-center">
            <p className="text-[13.5px] text-lumo-fg-mid">Receipt not found.</p>
          </div>
        ) : null}
      </div>

      {refundOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="refund-title"
          className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 px-4"
        >
          <div className="w-full max-w-md rounded-xl border border-lumo-hair bg-lumo-bg p-5 space-y-4">
            <h3 id="refund-title" className="text-[16px] font-semibold text-lumo-fg">
              Initiate refund
            </h3>
            <p className="text-[13px] text-lumo-fg-mid leading-relaxed">
              We&apos;ll review your refund request and follow up by email.
              Refunds for completed bookings can take 5–10 business days
              once approved.
            </p>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setRefundOpen(false)}
                disabled={refundBusy}
                className="h-9 px-3.5 rounded-md text-[12.5px] text-lumo-fg-mid hover:bg-lumo-elevated transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleRefund}
                disabled={refundBusy}
                className="h-9 px-4 rounded-md bg-lumo-fg text-lumo-bg text-[12.5px] font-medium hover:bg-lumo-accent hover:text-lumo-accent-ink transition-colors disabled:opacity-50"
              >
                {refundBusy ? "Submitting…" : "Submit request"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
