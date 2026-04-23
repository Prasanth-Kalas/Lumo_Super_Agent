"use client";

/**
 * FoodMenuSelectCard
 *
 * Multi-select menu card rendered inline in the Super Agent chat when
 * the orchestrator calls `food_get_restaurant_menu`. Mirrors the same
 * pattern used by the Food Agent's standalone web app
 * (`Lumo_Food_Agent_Web/components/ToolResultRenderer.tsx :: MenuCard`)
 * but restyled with the Super Agent's design tokens (lumo-accent /
 * lumo-ink / lumo-surface / lumo-hairline).
 *
 * Interaction model
 * ─────────────────
 * - Each row has a square checkbox on the left. Tapping the row (or
 *   the checkbox) flips it to `qty = 1`. Tapping again on an already-
 *   selected row morphs the checkbox into a compact `[− N +]` stepper
 *   so multiple units of the same item are trivial to add.
 * - A sticky footer CTA shows running selection count + total and,
 *   on tap, emits a single natural-language turn back into the chat
 *   stream: `"Add to cart: 2× Large Pepperoni, 1× Garlic Knots."`.
 *   The orchestrator already has the menu in context from the
 *   preceding `food_get_restaurant_menu` call, so name → item_id
 *   resolution is reliable.
 * - After emit, local qty resets. The cart summary card that follows
 *   supersedes this one anyway, so the selection state doesn't need
 *   to persist in the thread.
 */

import { useState } from "react";

export interface FoodMenuSelection {
  restaurant_id: string;
  restaurant_name: string;
  is_open?: boolean;
  /**
   * Canonical field from `food_get_restaurant_menu`. We alias to
   * `items` internally for local-variable ergonomics, but the wire
   * shape uses `menu`.
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
    <div className="mr-auto max-w-[92%] ml-[34px] animate-fade-up rounded-2xl bg-lumo-surface border border-lumo-hairline shadow-card overflow-hidden">
      {/* Header strip */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-lumo-hairline bg-gradient-to-r from-lumo-accent/8 to-transparent">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-wider text-lumo-muted font-semibold">
            Menu — pick what you'd like
          </div>
          <div className="truncate text-[15px] font-semibold text-lumo-ink">
            {payload.restaurant_name}
          </div>
        </div>
        {payload.is_open === false ? (
          <span className="shrink-0 text-[11px] font-medium px-2 py-0.5 rounded-full bg-red-50 text-red-700 border border-red-200">
            Closed
          </span>
        ) : (
          <span className="shrink-0 text-[11px] font-medium px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
            Open
          </span>
        )}
      </div>

      {/* Rows */}
      <ul className="divide-y divide-lumo-hairline max-h-[420px] overflow-y-auto">
        {items.map((it) => {
          const n = qty[it.item_id] ?? 0;
          const checked = n > 0;
          return (
            <li
              key={it.item_id}
              className={`flex items-center gap-3 px-4 py-3 transition-colors ${
                checked ? "bg-lumo-accent/5" : "hover:bg-black/2.5"
              }`}
            >
              {/* Left control: checkbox or stepper */}
              {checked ? (
                <div className="inline-flex h-[26px] shrink-0 items-center rounded-full border border-lumo-accent/40 bg-white px-0.5 shadow-[0_1px_3px_rgba(255,107,44,0.15)]">
                  <button
                    type="button"
                    onClick={() => dec(it.item_id)}
                    aria-label={`Remove one ${it.name}`}
                    disabled={frozen}
                    className="flex h-[24px] w-[24px] items-center justify-center rounded-full text-lumo-ink transition hover:bg-lumo-accent/10 disabled:opacity-50"
                  >
                    <svg
                      viewBox="0 0 14 14"
                      width="12"
                      height="12"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                    >
                      <path d="M3 7h8" />
                    </svg>
                  </button>
                  <span className="min-w-[16px] px-0.5 text-center text-[12px] font-bold text-lumo-accentDeep tabular-nums">
                    {n}
                  </span>
                  <button
                    type="button"
                    onClick={() => inc(it.item_id)}
                    aria-label={`Add another ${it.name}`}
                    disabled={frozen}
                    className="flex h-[24px] w-[24px] items-center justify-center rounded-full text-lumo-ink transition hover:bg-lumo-accent/10 disabled:opacity-50"
                  >
                    <svg
                      viewBox="0 0 14 14"
                      width="12"
                      height="12"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
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
                  className="h-[24px] w-[24px] shrink-0 rounded-md border-[1.5px] border-lumo-hairline bg-white transition hover:border-lumo-accent/60 focus:border-lumo-accent focus:outline-none disabled:opacity-50"
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
                <div className="truncate text-[14px] font-medium text-lumo-ink">
                  {it.name}
                </div>
                {it.description ? (
                  <div className="mt-0.5 line-clamp-2 text-[12px] text-lumo-muted">
                    {it.description}
                  </div>
                ) : null}
              </button>

              <div className="shrink-0 text-[14px] font-semibold text-lumo-ink tabular-nums">
                {formatPrice(it.unit_price_cents)}
              </div>
            </li>
          );
        })}
      </ul>

      {/* Sticky footer */}
      <div className="border-t border-lumo-hairline bg-white/60 px-4 py-3 backdrop-blur-sm">
        {decidedLabel === "confirmed" ? (
          <div className="text-[12.5px] text-emerald-700 text-center font-medium">
            Selection submitted · building your cart
          </div>
        ) : decidedLabel === "cancelled" ? (
          <div className="text-[12.5px] text-lumo-muted text-center">
            Cancelled
          </div>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={count === 0 || frozen}
            className="w-full rounded-full bg-lumo-accent px-5 py-2.5 text-[14px] font-semibold text-white shadow-[0_6px_14px_-6px_rgba(255,107,44,0.7)] hover:bg-lumo-accentDeep disabled:bg-black/10 disabled:text-lumo-muted disabled:shadow-none transition-all"
          >
            {count === 0
              ? "Tap items to add"
              : `Add ${count} item${count === 1 ? "" : "s"} · ${formatPrice(total)}`}
          </button>
        )}
      </div>
    </div>
  );
}
