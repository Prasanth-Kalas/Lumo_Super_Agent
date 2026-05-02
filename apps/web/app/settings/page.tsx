/**
 * /settings — flat index of every settings sub-route.
 *
 * Server component (no client hooks needed). Just a list of links.
 * Middleware gates /settings, so unauthenticated visitors land on
 * /login?next=/settings before this renders.
 */

import Link from "next/link";
import { LumoWordmark } from "@/components/BrandMark";
import { ThemeToggle } from "@/components/ThemeToggle";
import { SETTINGS_INDEX_ITEMS } from "@/lib/web-screens-settings-index";

export default function SettingsIndexPage() {
  return (
    <main className="min-h-dvh bg-lumo-bg text-lumo-fg-high">
      <header className="sticky top-0 z-20 border-b border-lumo-hair bg-lumo-bg/85 backdrop-blur-md">
        <div className="flex w-full items-center justify-between px-6 py-3">
          <div className="flex items-center gap-2.5">
            <LumoWordmark height={22} />
            <span className="hidden sm:inline text-lumo-fg-low text-[12px]">/</span>
            <span className="hidden sm:inline text-[13px] text-lumo-fg">Settings</span>
          </div>
          <ThemeToggle />
        </div>
      </header>

      <div className="mx-auto w-full max-w-4xl px-6 py-12 space-y-10">
        <div className="space-y-3">
          <h1 className="font-display text-[44px] md:text-[64px] leading-[1.0] tracking-[-0.02em] text-lumo-fg">
            <span className="italic text-lumo-accent">Settings.</span>
          </h1>
          <p className="text-[15px] text-lumo-fg-mid leading-[1.65] max-w-xl">
            Configure how Lumo works for you.
          </p>
        </div>

        <ul className="space-y-3">
          {SETTINGS_INDEX_ITEMS.map((it) => (
            <li key={it.href}>
              <Link
                href={it.href}
                className="block rounded-2xl border border-lumo-hair bg-lumo-surface px-5 py-4 hover:border-lumo-edge hover:shadow-card-lift transition-all"
              >
                <div className="text-[15px] font-medium text-lumo-fg">{it.label}</div>
                <p className="text-[13px] text-lumo-fg-mid mt-1 leading-relaxed">{it.description}</p>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}
