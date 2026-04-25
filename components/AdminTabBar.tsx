"use client";

/**
 * Tab bar for /admin pages.
 *
 * Five tabs: Overview, Queue, Apps, Settings, Health. Active tab
 * uses the current pathname so deep-links highlight correctly.
 *
 * Kept dumb — no data fetches, no badges, no counts. The pages
 * themselves render their own queue depth / health summary so the
 * tab bar stays cheap to render and re-render.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";

interface Tab {
  href: string;
  label: string;
  prefix?: string;
}

const TABS: Tab[] = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/review-queue", label: "Queue" },
  { href: "/admin/apps", label: "Apps" },
  { href: "/admin/settings", label: "Settings" },
  { href: "/admin/health", label: "Health" },
];

export function AdminTabBar() {
  const pathname = usePathname();
  return (
    <nav className="border-t border-lumo-hair">
      <div className="mx-auto flex w-full max-w-6xl items-center gap-1 px-3 sm:px-5 overflow-x-auto">
        {TABS.map((t) => {
          const active =
            pathname === t.href ||
            (t.href !== "/admin" && pathname?.startsWith(t.href));
          return (
            <Link
              key={t.href}
              href={t.href}
              className={
                "h-9 px-3 inline-flex items-center text-[12.5px] tracking-tight border-b-2 -mb-px transition-colors " +
                (active
                  ? "border-lumo-accent text-lumo-fg"
                  : "border-transparent text-lumo-fg-mid hover:text-lumo-fg")
              }
            >
              {t.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
