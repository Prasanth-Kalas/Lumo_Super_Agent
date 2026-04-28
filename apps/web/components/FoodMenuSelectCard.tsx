"use client";

/**
 * FoodMenuSelectCard
 *
 * Multi-select menu card rendered inline in the Super Agent chat when
 * the orchestrator calls `food_get_restaurant_menu`. Mirrors the same
 * pattern used by the Food Agent's standalone web app but restyled
 * with the Super Agent's Linear/Vercel dark-first tokens.
 *
 * Interaction model
 * ─────────────────
 * - Each row has a square checkbox on the left. Tapping the row (or
 *   the checkbox) flips it to `qty = 1`. Tapping again on an already-
 *   selected row morphs the checkbox into a compact `[− N +]` stepper
 *   so multiple units of the same item are trivial to add.
 * - A footer CTA shows running selection count + total and, on tap,
 *   emits a single natural-language turn back into the chat stream.
 *   The orchestrator already has the menu in context from the
 *   preceding `food_get_restaurant_menu` call, so name → item_id
 *   resolution is reliable.
 * - After emit, local qty resets.
 */

import { useState } from "react";

export interface FoodMenuSelection {
  restaurant_id: string;
  restaurant_name: string;
  is_open?: boolean;
  /**
   * Canonical field from `food_get_restaurant_menu`. The wire shape
   * uses `menu`; we alias to `items` internally for ergonomics.
   */
  menu: Array<{
    item_id: string;
    name: string;
    description?: string;
    unit_price_cents: number;
    category?: string;
  }>;
}

function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function FoodMenuSelectCard({
  payload,
  onSubmit,
  disabled,
  decidedLabel,
}: {
  payload: FoodMenuSelection;
  onSubmit: (text: string) => void;
  disabled?: boolean;
  decidedLabel?: "confirmed" | "cancelled" | null;
}) {
  const [qty, setQty] = useState<Record<string, number>>({});

  const items = payload.menu ?? [];
  const selected = items.filter((it) => (qty[it.item_id] ?? 0) > 0);
  const count = selected.reduce((s, it) => s + (qty[it.item_id] ?? 0), 0);
  const total = selected.reduce(
    (s, it) => s + (qty[it.item_id] ?? 0) * it.unit_price_cents,
    0,
  );

  const inc = (id: string) =>
    setQty((prev) => ({ ...prev, [id]: (prev[id] ?? 0) + 1 }));
  const dec = (id: string) =>
    setQty((prev) => {
      const next = (prev[id] ?? 0) - 1;
      if (next <= 0) {
        const { [id]: _drop, ...rest } = prev;
        return rest;
      }
      return { ...prev, [id]: next };
    });

  const submit = () => {
    if (count === 0 || disabled) return;
    const parts = selected.map((it) => {
      const n = qty[it.item_id]!;
      return n === 1 ? it.name : `${n}× ${it.name}`;
    });
    onSubmit(
      `Add to cart from ${payload.restaurant_name}: ${parts.join(", ")}.`,
    );
    setQty({});
  };

  const frozen = !!decidedLabel || !!disabled;

  return (
    <div className="w-full max-w-[600px] animate-fade-up rounded-xl bg-lumo-surface border border-lumo-hair overflow-hidden">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 px-4 pt-3.5 pb-3 border-b border-lumo-hair">
        <div className="min-w-0">
          <div className="text-[10.5px] uppercase tracking-[0.12em] text-lumo-fg-mid font-medium">
            Menu
          </div>
          <div className="mt-1 truncate text-[14px] font-medium text-lumo-fg">
            {payload.restaurant_name}
          </div>
        </div>
        {payload.is_open === false ? (
          <span className="shrink-0 inline-flex items-center gap-1.5 text-[10.5px] font-medium px-2 py-1 rounded-md bg-lumo-elevated text-lumo-err border border-lumo-hair">
            <span className="h-1.5 w-1.5 rounded-full bg-lumo-err" aria-hidden />
            Closed
          </span>
        ) : (
          <span className="shrink-0 inline-flex items-center gap-1.5 text-[10.5px] font-medium px-2 py-1 rounded-md bg-lumo-elevated text-lumo-ok border border-lumo-hair">
            <span className="h-1.5 w-1.5 rounded-full bg-lumo-ok" aria-hidden />
            Open
          </span>
        )}
      </div>

      {/* Rows */}
      <ul className="divide-y divide-lumo-hair max-h-[420px] overflow-y-auto">
        {items.map((it) => {
          const n = qty[it.item_id] ?? 0;
          const checked = n > 0;
          return (
            <li
              key={it.item_id}
              className={`flex items-center gap-3 px-4 py-3 transition-colors relative ${
                checked ? "bg-lumo-elevated" : "hover:bg-lumo-elevated/60"
              }`}
            >
              {/* Accent left-bar when selected */}
              <span
                aria-hidden
                className={`absolute left-0 top-0 bottom-0 w-[2px] transition-colors ${
                  checked ? "bg-lumo-accent" : "bg-transparent"
                }`}
              />

              {/* Left control: checkbox or stepper */}
              {checked ? (
                <div className="inline-flex h-[24px] shrink-0 items-center rounded-md border border-lumo-edge bg-lumo-inset">
                  <button
                    type="button"
                    onClick={() => dec(it.item_id)}
                    aria-label={`Remove one ${it.name}`}
                    disabled={frozen}
                    className="flex h-[22px] w-[22px] items-center justify-center rounded-md text-lumo-fg-mid hover:text-lumo-fg hover:bg-lumo-elevated transition disabled:opacity-50"
                  >
                    <svg
                      viewBox="0 0 14 14"
                      width="10"
                      height="10"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                    >
                      <path d="M3 7h8" />
                    </svg>
                  </button>
                  <span className="min-w-[18px] px-1 text-center text-[11.5px] font-medium text-lumo-fg num">
                    {n}
                  </span>
                  <button
                    type="button"
                    onClick={() => inc(it.item_id)}
                    aria-label={`Add another ${it.name}`}
                    disabled={frozen}
                    className="flex h-[22px] w-[22px] items-center justify-center rounded-md text-lumo-fg-mid hover:text-lumo-fg hover:bg-lumo-elevated transition disabled:opacity-50"
                  >
                    <svg
                      viewBox="0 0 14 14"
                      width="10"
                      height="10"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                    >
                      <path d="M7 3v8M3 7h8" />
                    </svg>
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={false}
                  aria-label={`Add ${it.name}`}
                  onClick={() => inc(it.item_id)}
                  disabled={frozen}
                  className="h-[18px] w-[18px] shrink-0 rounded-[4px] border border-lumo-edge bg-lumo-inset transition hover:border-lumo-fg-mid focus:border-lumo-accent focus:outline-none disabled:opacity-50"
                />
              )}

              {/* Body — clicking when unchecked adds qty=1 */}
              <button
                type="button"
                onClick={() => {
                  if (!checked && !frozen) inc(it.item_id);
                }}
                disabled={frozen}
                className="min-w-0 flex-1 text-left disabled:opacity-70"
              >
                <div className="truncate text-[13.5px] font-medium text-lumo-fg">
                  {it.name}
                </div>
                {it.description ? (
                  <div className="mt-0.5 line-clamp-2 text-[12px] text-lumo-fg-mid">
                    {it.description}
                  </div>
                ) : null}
              </button>

              <div className="shrink-0 text-[13.5px] font-medium text-lumo-fg num">
                {formatPrice(it.unit_price_cents)}
              </div>
            </li>
          );
        })}
      </ul>

      {/* Footer */}
      <div className="border-t border-lumo-hair px-3 py-2.5">
        {decidedLabel === "confirmed" ? (
          <div className="text-[12px] text-lumo-ok text-center font-medium py-1">
            Selection submitted · building your cart
          </div>
        ) : decidedLabel === "cancelled" ? (
          <div className="text-[12px] text-lumo-fg-mid text-center py-1">
            Cancelled
          </div>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={count === 0 || frozen}
            className="w-full h-9 rounded-lg text-[13px] font-medium transition-colors bg-lumo-fg text-lumo-bg hover:bg-lumo-accent hover:text-lumo-accent-ink disabled:bg-lumo-elevated disabled:text-lumo-fg-low disabled:cursor-not-allowed"
          >
            {count === 0 ? (
              "Tap items to add"
            ) : (
              <>
                Add {count} item{count === 1 ? "" : "s"}{" "}
                <span className="text-lumo-fg-mid mx-1">·</span>{" "}
                <span className="num">{formatPrice(total)}</span>
              </>
            )}
          </button>
        )}
      </div>
    </div>
  );
}
