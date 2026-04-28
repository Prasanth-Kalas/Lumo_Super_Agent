"use client";

/**
 * McpConnectModal — the token-paste dialog for connecting to an MCP
 * server.
 *
 * Phase 1's connect model for third-party MCP servers is "paste a
 * long-lived bearer token you generated yourself." It's a developer-
 * preview pattern: fine for partners and power users, not fine for
 * consumers at scale. Phase 1c will add the OAuth 2.1 Dynamic Client
 * Registration flow for servers that support it, and this modal
 * becomes a fallback for servers that don't.
 *
 * The modal is intentionally blunt about the preview status. We link
 * to the server's docs when available so the user isn't left
 * guessing where the token lives.
 */

import { useEffect, useRef, useState } from "react";

export interface McpConnectModalProps {
  open: boolean;
  /** Server metadata, pulled from /api/marketplace. */
  server: {
    server_id: string;
    display_name: string;
    one_liner: string;
    scopes?: Array<{ name: string; description: string }>;
  } | null;
  onClose: () => void;
  /** Called after a successful POST /api/mcp/connections. */
  onConnected: () => void;
}

export default function McpConnectModal({
  open,
  server,
  onClose,
  onConnected,
}: McpConnectModalProps) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset state every time the modal opens for a different server.
  useEffect(() => {
    if (!open) return;
    setToken("");
    setError(null);
    setBusy(false);
    const t = setTimeout(() => inputRef.current?.focus(), 60);
    return () => clearTimeout(t);
  }, [open, server?.server_id]);

  if (!open || !server) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!server) return;
    const trimmed = token.trim();
    if (!trimmed) {
      setError("Paste the token first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/mcp/connections", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          server_id: server.server_id,
          access_token: trimmed,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        throw new Error(
          (j?.detail as string | undefined) ??
            (j?.error as string | undefined) ??
            `HTTP ${res.status}`,
        );
      }
      onConnected();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Connect ${server.display_name}`}
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      {/* Scrim */}
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
      />

      <div className="relative w-full max-w-md rounded-2xl border border-lumo-hair bg-lumo-surface p-5 shadow-2xl animate-fade-up">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <div className="text-[10.5px] uppercase tracking-[0.12em] text-lumo-fg-low">
              Connect · via MCP
            </div>
            <div className="text-[16px] font-semibold text-lumo-fg mt-0.5">
              {server.display_name}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="h-7 w-7 rounded-md text-lumo-fg-low hover:text-lumo-fg hover:bg-lumo-elevated inline-flex items-center justify-center"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
              <path
                d="M3 3l8 8M11 3l-8 8"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        <p className="text-[13px] text-lumo-fg-mid leading-relaxed">
          {server.one_liner}
        </p>

        {server.scopes && server.scopes.length > 0 ? (
          <div className="mt-3 rounded-md border border-lumo-hair bg-lumo-bg p-2.5">
            <div className="text-[10.5px] uppercase tracking-[0.12em] text-lumo-fg-low mb-1.5">
              What this will access
            </div>
            <ul className="space-y-1">
              {server.scopes.map((s) => (
                <li key={s.name} className="text-[12.5px] text-lumo-fg">
                  <span className="font-medium">{s.name}</span>
                  <span className="text-lumo-fg-mid"> — {s.description}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <form onSubmit={submit} className="mt-4 space-y-3">
          <label className="block">
            <span className="text-[11px] uppercase tracking-[0.12em] text-lumo-fg-low">
              Access token
            </span>
            <input
              ref={inputRef}
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Paste your token"
              className="mt-1 block w-full rounded-md border border-lumo-hair bg-lumo-bg px-3 py-2 text-[13.5px] text-lumo-fg placeholder:text-lumo-fg-low focus:border-lumo-edge outline-none"
              disabled={busy}
            />
          </label>

          {error ? (
            <div className="text-[12px] text-red-400 border border-red-500/30 bg-red-500/5 rounded-md px-2 py-1.5">
              {error}
            </div>
          ) : null}

          <div className="text-[11.5px] text-lumo-fg-low leading-relaxed">
            Developer preview. Tokens are stored on Lumo&apos;s
            servers and attached to every call to{" "}
            <span className="text-lumo-fg">{server.display_name}</span>
            . You can revoke it anytime from Memory.
          </div>

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="h-8 px-3 rounded-md text-[12.5px] text-lumo-fg-low hover:text-lumo-fg hover:bg-lumo-elevated"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || !token.trim()}
              className="h-8 px-3 rounded-md bg-lumo-fg text-lumo-bg text-[12.5px] font-medium hover:bg-lumo-accent hover:text-lumo-accent-ink disabled:bg-lumo-elevated disabled:text-lumo-fg-low transition-colors"
            >
              {busy ? "Connecting…" : "Connect"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
