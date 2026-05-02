/**
 * /admin layout — operator console shell.
 *
 * Persistent header with the 5 tabs. Children render under the tab
 * bar. Server component so the tab labels and active state can be
 * resolved before the page paints (avoids the empty-state flash that
 * client-side admin nav had).
 *
 * Auth: middleware already gates /admin/* behind LUMO_ADMIN_EMAILS.
 * The pages themselves redo the check for defense in depth.
 */

import type { ReactNode } from "react";
import Link from "next/link";
import { LumoWordmark } from "@/components/BrandMark";
import { ThemeToggle } from "@/components/ThemeToggle";
import { AdminTabBar } from "@/components/AdminTabBar";

export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-dvh bg-lumo-bg text-lumo-fg-high flex flex-col">
      <header className="sticky top-0 z-20 border-b border-lumo-hair bg-lumo-bg/90 backdrop-blur-md">
        <div className="flex w-full items-center justify-between px-6 py-3">
          <Link
            href="/"
            className="flex items-center gap-2.5 hover:opacity-90 transition-opacity"
          >
            <LumoWordmark height={22} />
            <span className="hidden sm:inline text-[12px] text-lumo-fg-low">/</span>
            <span className="hidden sm:inline text-[13px] text-lumo-fg">Admin</span>
          </Link>
          <ThemeToggle />
        </div>
        <AdminTabBar />
      </header>

      <div className="mx-auto w-full max-w-6xl px-5 py-8 flex-1">{children}</div>
    </main>
  );
}
