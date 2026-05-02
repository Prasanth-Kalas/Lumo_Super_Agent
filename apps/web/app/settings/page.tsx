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
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-5 py-3">
          <div className="flex items-center gap-2.5">
            <LumoWordmark height={22} />
            <span className="hidden sm:inline text-lumo-fg-low text-[12px]">/</span>
            <span className="hidden sm:inline text-[13px] text-lumo-fg">Settings</span>
          </div>
          <ThemeToggle />
        </div>
      </header>

      <div className="mx-auto w-full max-w-3xl px-5 py-8 space-y-6">
        <div className="space-y-2">
          <h1 className="text-[26px] sm:text-[28px] font-semibold tracking-[-0.022em] text-lumo-fg leading-[1.15]">
            Settings
          </h1>
          <p className="text-[13.5px] text-lumo-fg-mid leading-relaxed max-w-2xl">
            Configure how Lumo works for you.
          </p>
        </div>

        <ul className="space-y-2.5">
          {SETTINGS_INDEX_ITEMS.map((it) => (
            <li key={it.href}>
              <Link
                href={it.href}
                className="block rounded-xl border border-lumo-hair bg-lumo-surface px-4 py-3.5 hover:bg-lumo-elevated transition-colors"
              >
                <div className="text-[14.5px] font-medium text-lumo-fg-high">{it.label}</div>
                <p className="text-[12.5px] text-lumo-fg-mid mt-0.5">{it.description}</p>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}
