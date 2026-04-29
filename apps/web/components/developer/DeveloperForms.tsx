"use client";

import { useMemo, useState } from "react";

export function PromotionRequestForm({
  agents,
}: {
  agents: Array<{ agent_id: string; name: string; trust_tier: string }>;
}) {
  const [agentId, setAgentId] = useState(agents[0]?.agent_id ?? "");
  const [targetTier, setTargetTier] = useState("community");
  const [reason, setReason] = useState("");
  const [status, setStatus] = useFormStatus();
  const currentAgent = useMemo(
    () => agents.find((agent) => agent.agent_id === agentId),
    [agentId, agents],
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setStatus({ busy: true, message: null, error: null });
    try {
      const res = await fetch("/api/developer/promotion-requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent_id: agentId,
          target_tier: targetTier,
          reason,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setReason("");
      setStatus({ busy: false, message: "Promotion request submitted.", error: null });
      window.location.reload();
    } catch (err) {
      setStatus({
        busy: false,
        message: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (agents.length === 0) {
    return <InlineNotice text="Submit an agent before requesting promotion." />;
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Agent">
          <select
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            className={inputClass}
          >
            {agents.map((agent) => (
              <option key={agent.agent_id} value={agent.agent_id}>
                {agent.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Target tier">
          <select
            value={targetTier}
            onChange={(e) => setTargetTier(e.target.value)}
            className={inputClass}
          >
            <option value="community">community</option>
            <option value="verified">verified</option>
            <option value="official">official</option>
          </select>
        </Field>
      </div>
      <Field label="Reason">
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className={`${inputClass} min-h-24 resize-y py-2`}
          placeholder="What's changed since the current tier?"
        />
      </Field>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-[11.5px] text-lumo-fg-low">
          Current tier: {currentAgent?.trust_tier ?? "unknown"}
        </p>
        <SubmitButton busy={status.busy} label="Request promotion" />
      </div>
      <FormMessage status={status} />
    </form>
  );
}

export function IdentityEvidenceForm({
  approved,
}: {
  approved: boolean;
}) {
  const [status, setStatus] = useFormStatus();
  const [entity, setEntity] = useState("");
  const [registration, setRegistration] = useState("");
  const [country, setCountry] = useState("");
  const [documentPath, setDocumentPath] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setStatus({ busy: true, message: null, error: null });
    try {
      const res = await fetch("/api/developer/identity-verification", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          legal_entity_name: entity,
          registration_number: registration,
          registration_country: country,
          document_path: documentPath,
          evidence: { source: "developer_dashboard" },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setStatus({ busy: false, message: "Evidence submitted for review.", error: null });
      window.location.reload();
    } catch (err) {
      setStatus({
        busy: false,
        message: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (approved) {
    return <InlineNotice text="Legal entity verification is approved and locked." />;
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <Field label="Legal entity name">
        <input
          value={entity}
          onChange={(e) => setEntity(e.target.value)}
          className={inputClass}
          placeholder="Lumo Labs Inc."
        />
      </Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_120px]">
        <Field label="Registration number">
          <input
            value={registration}
            onChange={(e) => setRegistration(e.target.value)}
            className={inputClass}
            placeholder="Optional"
          />
        </Field>
        <Field label="Country">
          <input
            value={country}
            onChange={(e) => setCountry(e.target.value.toUpperCase().slice(0, 2))}
            className={inputClass}
            placeholder="US"
          />
        </Field>
      </div>
      <Field label="Document storage path">
        <input
          value={documentPath}
          onChange={(e) => setDocumentPath(e.target.value)}
          className={inputClass}
          placeholder="developer-verification/user-id/document.pdf"
        />
      </Field>
      <div className="flex justify-end">
        <SubmitButton busy={status.busy} label="Submit evidence" />
      </div>
      <FormMessage status={status} />
    </form>
  );
}

export function WebhookRegistrationForm() {
  const [status, setStatus] = useFormStatus();
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState(["install_completed", "uninstall_completed"]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setStatus({ busy: true, message: null, error: null });
    try {
      const res = await fetch("/api/developer/webhooks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label, url, event_types: events }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setLabel("");
      setUrl("");
      setStatus({ busy: false, message: "Webhook registered.", error: null });
      window.location.reload();
    } catch (err) {
      setStatus({
        busy: false,
        message: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[0.72fr_1.28fr]">
        <Field label="Label">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className={inputClass}
            placeholder="Production webhook"
          />
        </Field>
        <Field label="HTTPS URL">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className={inputClass}
            placeholder="https://example.com/lumo/webhook"
          />
        </Field>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {WEBHOOK_EVENTS.map((event) => (
          <label key={event} className="flex items-center gap-2 text-[12.5px] text-lumo-fg-mid">
            <input
              type="checkbox"
              checked={events.includes(event)}
              onChange={(e) => {
                setEvents((prev) =>
                  e.target.checked
                    ? [...new Set([...prev, event])]
                    : prev.filter((value) => value !== event),
                );
              }}
            />
            {event}
          </label>
        ))}
      </div>
      <div className="flex justify-end">
        <SubmitButton busy={status.busy} label="Register webhook" />
      </div>
      <FormMessage status={status} />
    </form>
  );
}

export function WebhookEditForm({
  webhook,
}: {
  webhook: {
    id: string;
    label: string;
    url: string;
    event_types: string[];
    active: boolean;
  };
}) {
  const [status, setStatus] = useFormStatus();
  const [label, setLabel] = useState(webhook.label);
  const [url, setUrl] = useState(webhook.url);
  const [active, setActive] = useState(webhook.active);
  const [events, setEvents] = useState(webhook.event_types);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setStatus({ busy: true, message: null, error: null });
    try {
      const res = await fetch("/api/developer/webhooks", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: webhook.id,
          label,
          url,
          active,
          event_types: events,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setStatus({ busy: false, message: "Webhook updated.", error: null });
      window.location.reload();
    } catch (err) {
      setStatus({
        busy: false,
        message: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-md border border-lumo-hair bg-lumo-bg p-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[0.72fr_1.28fr]">
        <Field label="Label">
          <input value={label} onChange={(e) => setLabel(e.target.value)} className={inputClass} />
        </Field>
        <Field label="HTTPS URL">
          <input value={url} onChange={(e) => setUrl(e.target.value)} className={inputClass} />
        </Field>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <label className="flex items-center gap-2 text-[12.5px] text-lumo-fg-mid">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Active
        </label>
        <div className="flex flex-wrap gap-2">
          {WEBHOOK_EVENTS.slice(0, 4).map((event) => (
            <label key={event} className="flex items-center gap-1.5 text-[11.5px] text-lumo-fg-mid">
              <input
                type="checkbox"
                checked={events.includes(event)}
                onChange={(e) => {
                  setEvents((prev) =>
                    e.target.checked
                      ? [...new Set([...prev, event])]
                      : prev.filter((value) => value !== event),
                  );
                }}
              />
              {event}
            </label>
          ))}
        </div>
        <SubmitButton busy={status.busy} label="Save" />
      </div>
      <FormMessage status={status} />
    </form>
  );
}

const WEBHOOK_EVENTS = [
  "view",
  "install_started",
  "install_completed",
  "uninstall_completed",
  "version_published",
  "version_yanked",
  "promotion_decided",
  "transaction_completed",
];

const inputClass =
  "h-9 w-full rounded-md border border-lumo-hair bg-lumo-bg px-3 text-[12.5px] text-lumo-fg outline-none transition-colors placeholder:text-lumo-fg-low focus:border-lumo-accent";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-[10.5px] uppercase tracking-[0.14em] text-lumo-fg-low">
        {label}
      </span>
      {children}
    </label>
  );
}

function SubmitButton({ busy, label }: { busy: boolean; label: string }) {
  return (
    <button
      type="submit"
      disabled={busy}
      className="inline-flex h-9 items-center justify-center rounded-md bg-lumo-accent px-3 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
    >
      {busy ? "Working…" : label}
    </button>
  );
}

function InlineNotice({ text }: { text: string }) {
  return (
    <div className="rounded-md border border-lumo-hair bg-lumo-elevated px-3 py-2 text-[12.5px] text-lumo-fg-mid">
      {text}
    </div>
  );
}

function FormMessage({
  status,
}: {
  status: { busy: boolean; message: string | null; error: string | null };
}) {
  if (!status.message && !status.error) return null;
  return (
    <div
      className={
        "rounded-md border px-3 py-2 text-[12.5px] " +
        (status.error
          ? "border-red-500/30 bg-red-500/5 text-red-400"
          : "border-emerald-500/30 bg-emerald-500/5 text-emerald-400")
      }
    >
      {status.error ?? status.message}
    </div>
  );
}

function useFormStatus() {
  return useState<{ busy: boolean; message: string | null; error: string | null }>({
    busy: false,
    message: null,
    error: null,
  });
}
