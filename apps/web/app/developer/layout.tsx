import type { ReactNode } from "react";
import Link from "next/link";
import { LumoWordmark } from "@/components/BrandMark";
import { ThemeToggle } from "@/components/ThemeToggle";

const NAV = [
  { href: "/developer/dashboard", label: "Dashboard" },
  { href: "/developer/agents", label: "Agents" },
  { href: "/developer/submissions", label: "Submissions" },
  { href: "/developer/identity-verification", label: "Identity" },
  { href: "/developer/promotion-requests", label: "Promotion" },
  { href: "/developer/keys", label: "Keys" },
  { href: "/developer/webhooks", label: "Webhooks" },
];

export default function DeveloperLayout({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-dvh flex-col bg-lumo-bg text-lumo-fg-high">
      <header className="sticky top-0 z-20 border-b border-lumo-hair bg-lumo-bg/90 backdrop-blur-md">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-3">
          <Link href="/" className="flex items-center gap-2.5 transition-opacity hover:opacity-90">
            <LumoWordmark height={20} />
            <span className="hidden text-[12px] text-lumo-fg-low sm:inline">/</span>
            <span className="hidden text-[13px] text-lumo-fg sm:inline">Developer</span>
          </Link>
          <ThemeToggle />
        </div>
        <nav className="border-t border-lumo-hair/60">
          <div className="scroll-y mx-auto flex w-full max-w-6xl gap-1 overflow-x-auto px-5 py-2">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="inline-flex h-8 shrink-0 items-center rounded-md px-3 text-[12.5px] text-lumo-fg-mid transition-colors hover:bg-lumo-elevated hover:text-lumo-fg"
              >
                {item.label}
              </Link>
            ))}
          </div>
        </nav>
      </header>
      <div className="mx-auto w-full max-w-6xl flex-1 px-5 py-8">{children}</div>
    </main>
  );
}
