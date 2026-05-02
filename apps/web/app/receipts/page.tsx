"use client";

/**
 * /receipts — newest-first list of the user's transactions.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { LumoWordmark } from "@/components/BrandMark";
import { ThemeToggle } from "@/components/ThemeToggle";
import {
  formatCents,
  formatTransactionStatus,
  providerLabel,
  statusPillClass,
  totalDisplayCents,
} from "@/lib/web-screens-receipts";
import type { TransactionRow } from "@/lib/transactions";

export default function ReceiptsPage() {
  const [rows, setRows] = useState<TransactionRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/receipts", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { transactions: TransactionRow[] };
        if (!cancelled) setRows(body.transactions);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load receipts");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="min-h-dvh bg-lumo-bg text-lumo-fg-high">
      <header className="sticky top-0 z-20 border-b border-lumo-hair bg-lumo-bg/85 backdrop-blur-md">
        <div className="flex w-full items-center justify-between px-6 py-3">
          <div className="flex items-center gap-2.5">
            <LumoWordmark height={22} />
            <span className="hidden sm:inline text-lumo-fg-low text-[12px]">/</span>
            <span className="hidden sm:inline text-[13px] text-lumo-fg">Receipts</span>
          </div>
          <ThemeToggle />
        </div>
      </header>

      <div className="mx-auto w-full max-w-3xl px-5 py-8 space-y-6">
        <div className="space-y-2">
          <h1 className="text-[26px] sm:text-[28px] font-semibold tracking-[-0.022em] text-lumo-fg leading-[1.15]">
            Receipts
          </h1>
          <p className="text-[13.5px] text-lumo-fg-mid leading-relaxed max-w-2xl">
            Every payment Lumo has made on your behalf. Tap one to see
            line items or initiate a refund.
          </p>
        </div>

        {error ? (
          <div
            role="alert"
            className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-[12.5px] text-red-500"
          >
            {error}
          </div>
        ) : null}

        {loading ? (
          <div className="space-y-3">
            <div className="h-20 rounded-xl border border-lumo-hair bg-lumo-surface animate-pulse" />
            <div className="h-20 rounded-xl border border-lumo-hair bg-lumo-surface animate-pulse" />
          </div>
        ) : rows && rows.length > 0 ? (
          <ul className="space-y-3">
            {rows.map((r) => {
              const label = formatTransactionStatus(r);
              return (
                <li key={r.id}>
                  <Link
                    href={`/receipts/${r.id}`}
                    className="block rounded-xl border border-lumo-hair bg-lumo-surface px-4 py-3.5 hover:bg-lumo-elevated transition-colors"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-[14.5px] font-medium text-lumo-fg-high truncate">
                          {providerLabel(r.provider)}
                        </div>
                        <div className="text-[12px] text-lumo-fg-low mt-0.5">
                          {new Date(r.created_at).toLocaleString()} · {r.agent_id}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <span className="text-[13px] font-medium text-lumo-fg">
                          {formatCents(totalDisplayCents(r), r.currency)}
                        </span>
                        <span
                          className={`text-[11px] px-2 py-0.5 rounded-full border ${statusPillClass(label)}`}
                        >
                          {label}
                        </span>
                      </div>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="rounded-xl border border-dashed border-lumo-hair bg-lumo-bg/40 px-5 py-8 text-center">
            <p className="text-[13.5px] text-lumo-fg-mid">
              No receipts yet — Lumo will list payments here once
              they&apos;re made on your behalf.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
