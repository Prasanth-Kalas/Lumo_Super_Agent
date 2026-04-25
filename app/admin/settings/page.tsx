"use client";

/**
 * /admin/settings — runtime knobs, no-deploy.
 *
 * Four sections:
 *   - LLM model picker
 *   - Voice provider + model + voice ID + tuning
 *   - System prompt overrides (with version history rollback)
 *   - Feature flags
 *
 * Every change posts to /api/admin/settings; the orchestrator and
 * TTS route read these values per request via lib/admin-settings.ts.
 * Cache TTL is 30 s, so changes propagate within half a minute even
 * across serverless instances.
 */

import { useCallback, useEffect, useState } from "react";

interface SettingRow {
  key: string;
  value: unknown;
  updated_at: string;
  updated_by: string | null;
}

interface HistoryRow {
  id: string;
  key: string;
  value: unknown;
  recorded_at: string;
  recorded_by: string | null;
}

const LLM_MODELS = [
  { id: "claude-opus-4-6", label: "Claude Opus 4.6 (best quality)" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (balanced)" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5 (fastest)" },
];

const VOICE_PROVIDERS = [
  { id: "elevenlabs", label: "ElevenLabs (current)" },
  { id: "openai_realtime", label: "OpenAI Realtime (not wired yet)" },
];

const VOICE_MODELS_ELEVEN = [
  { id: "eleven_turbo_v2_5", label: "Turbo v2.5 (fast, stable)" },
  { id: "eleven_v3", label: "v3 (richest emotion, variable latency)" },
  { id: "eleven_flash_v2_5", label: "Flash v2.5 (75ms, flatter)" },
  { id: "eleven_multilingual_v2", label: "Multilingual v2" },
];

const VOICE_PRESETS = [
  { id: "21m00Tcm4TlvDq8ikWAM", label: "Rachel — warm female (default)" },
  { id: "EXAVITQu4vr4xnSDxMaL", label: "Bella — soft female" },
  { id: "ErXwobaYiN019PkySvjV", label: "Antoni — calm male" },
  { id: "VR6AewLTigWG4xSOukaG", label: "Arnold — strong male" },
  { id: "pNInz6obpgDQGcFmaJgB", label: "Adam — deep male" },
];

export default function AdminSettingsPage() {
  const [settings, setSettings] = useState<Map<string, unknown>>(new Map());
  const [loaded, setLoaded] = useState(false);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/settings", { cache: "no-store" });
      if (res.status === 403) {
        setErr("Not on admin allowlist.");
        setLoaded(true);
        return;
      }
      if (!res.ok) {
        setErr(`HTTP ${res.status}`);
        setLoaded(true);
        return;
      }
      const j = (await res.json()) as { settings?: SettingRow[] };
      const m = new Map<string, unknown>();
      for (const r of j.settings ?? []) m.set(r.key, r.value);
      setSettings(m);
      setLoaded(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function save(key: string, value: unknown) {
    setSavingKey(key);
    setErr(null);
    setInfo(null);
    try {
      const res = await fetch("/api/admin/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, value }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        throw new Error(j?.detail ?? j?.error ?? `HTTP ${res.status}`);
      }
      setSettings((prev) => {
        const next = new Map(prev);
        next.set(key, value);
        return next;
      });
      setInfo(`Saved ${key}.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingKey(null);
    }
  }

  if (!loaded) {
    return <div className="text-[13px] text-lumo-fg-mid py-10">Loading…</div>;
  }

  return (
    <div className="space-y-8">
      <div className="space-y-1">
        <h1 className="text-[24px] font-semibold tracking-[-0.02em]">Settings</h1>
        <p className="text-[13px] text-lumo-fg-mid">
          Runtime knobs for the Super Agent. Changes propagate to every
          serverless instance within ~30 seconds.
        </p>
      </div>

      {err ? (
        <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-[12.5px] text-red-400">
          {err}
        </div>
      ) : null}
      {info ? (
        <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-[12.5px] text-emerald-400">
          {info}
        </div>
      ) : null}

      {/* ── LLM ──────────────────────────────────────────── */}
      <Section
        title="LLM model"
        description="Which Anthropic model the orchestrator calls per turn. Picking a smaller model trades quality for cost and latency."
      >
        <SelectRow
          options={LLM_MODELS}
          value={String(settings.get("llm.model") ?? "claude-opus-4-6")}
          onSave={(v) => void save("llm.model", v)}
          saving={savingKey === "llm.model"}
        />
      </Section>

      {/* ── Voice ────────────────────────────────────────── */}
      <Section
        title="Voice"
        description="Provider, model, voice character, and tuning. Most users hear ElevenLabs Turbo v2.5 — change carefully and test."
      >
        <SelectRow
          label="Provider"
          options={VOICE_PROVIDERS}
          value={String(settings.get("voice.provider") ?? "elevenlabs")}
          onSave={(v) => void save("voice.provider", v)}
          saving={savingKey === "voice.provider"}
        />
        <SelectRow
          label="Model"
          options={VOICE_MODELS_ELEVEN}
          value={String(settings.get("voice.model") ?? "eleven_turbo_v2_5")}
          onSave={(v) => void save("voice.model", v)}
          saving={savingKey === "voice.model"}
        />
        <SelectRow
          label="Voice"
          options={VOICE_PRESETS}
          value={String(settings.get("voice.voice_id") ?? VOICE_PRESETS[0]!.id)}
          onSave={(v) => void save("voice.voice_id", v)}
          saving={savingKey === "voice.voice_id"}
        />
        <SliderRow
          label="Stability"
          help="0 = expressive but unstable, 1 = monotone. 0.42 is the current default."
          value={Number(settings.get("voice.stability") ?? 0.42)}
          onSave={(v) => void save("voice.stability", v)}
          saving={savingKey === "voice.stability"}
        />
        <SliderRow
          label="Similarity boost"
          help="Higher locks the voice character harder. 0.8 holds Rachel as we loosen stability."
          value={Number(settings.get("voice.similarity_boost") ?? 0.8)}
          onSave={(v) => void save("voice.similarity_boost", v)}
          saving={savingKey === "voice.similarity_boost"}
        />
        <SliderRow
          label="Style"
          help="Emotional inference from punctuation. 0.55 is the current default; above 0.7 over-acts."
          value={Number(settings.get("voice.style") ?? 0.55)}
          onSave={(v) => void save("voice.style", v)}
          saving={savingKey === "voice.style"}
        />
      </Section>

      {/* ── System prompt overrides ───────────────────── */}
      <Section
        title="System prompt overrides"
        description="Optional addenda appended to the orchestrator's voice / text branch. Use sparingly — prompt drift is the most common way Claude's behavior changes unexpectedly. History below for rollback."
      >
        <PromptOverride
          label="Voice mode addendum"
          settingKey="prompt.voice_mode_addendum"
          value={String(settings.get("prompt.voice_mode_addendum") ?? "")}
          onSave={(v) => void save("prompt.voice_mode_addendum", v)}
          saving={savingKey === "prompt.voice_mode_addendum"}
        />
        <PromptOverride
          label="Text mode addendum"
          settingKey="prompt.text_mode_addendum"
          value={String(settings.get("prompt.text_mode_addendum") ?? "")}
          onSave={(v) => void save("prompt.text_mode_addendum", v)}
          saving={savingKey === "prompt.text_mode_addendum"}
        />
      </Section>

      {/* ── Feature flags ──────────────────────────────── */}
      <Section
        title="Feature flags"
        description="Toggle entire subsystems without a deploy. Fail-closed: a flag that's anything other than `true` is treated as off."
      >
        <ToggleRow
          label="MCP servers"
          help="Allow MCP-backed tools in the orchestrator. Off → only native + partner agents."
          value={settings.get("feature.mcp_enabled") === true}
          onSave={(v) => void save("feature.mcp_enabled", v)}
          saving={savingKey === "feature.mcp_enabled"}
        />
        <ToggleRow
          label="Partner agents"
          help="Approved partner_agents rows mount in the registry. Off → only static config + MCP."
          value={settings.get("feature.partner_agents_enabled") === true}
          onSave={(v) => void save("feature.partner_agents_enabled", v)}
          saving={savingKey === "feature.partner_agents_enabled"}
        />
        <ToggleRow
          label="Voice mode"
          help="The mic button on the chat shell. Off → text-only."
          value={settings.get("feature.voice_mode_enabled") === true}
          onSave={(v) => void save("feature.voice_mode_enabled", v)}
          saving={savingKey === "feature.voice_mode_enabled"}
        />
        <ToggleRow
          label="Autonomy"
          help="Background scheduled agents (proactive intent evaluation, pattern detection). Default off."
          value={settings.get("feature.autonomy_enabled") === true}
          onSave={(v) => void save("feature.autonomy_enabled", v)}
          saving={savingKey === "feature.autonomy_enabled"}
        />
      </Section>
    </div>
  );
}

// ─────────────────────────────────────────────────────────
// Building blocks
// ─────────────────────────────────────────────────────────

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-lumo-hair bg-lumo-surface p-5 space-y-4">
      <div className="space-y-1">
        <h2 className="text-[16px] font-semibold tracking-tight">{title}</h2>
        <p className="text-[12.5px] text-lumo-fg-mid leading-relaxed">
          {description}
        </p>
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function SelectRow({
  label,
  options,
  value,
  onSave,
  saving,
}: {
  label?: string;
  options: Array<{ id: string; label: string }>;
  value: string;
  onSave: (v: string) => void;
  saving: boolean;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const dirty = draft !== value;
  return (
    <div className="flex flex-wrap items-center gap-3">
      {label ? (
        <span className="text-[11.5px] uppercase tracking-[0.12em] text-lumo-fg-low w-32 shrink-0">
          {label}
        </span>
      ) : null}
      <select
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        className="h-9 rounded-md border border-lumo-hair bg-lumo-bg px-3 text-[13px] text-lumo-fg focus:border-lumo-edge outline-none flex-1 min-w-[200px]"
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={!dirty || saving}
        onClick={() => onSave(draft)}
        className="h-9 px-3 rounded-md bg-lumo-fg text-lumo-bg text-[12.5px] font-medium hover:bg-lumo-accent hover:text-lumo-accent-ink disabled:bg-lumo-elevated disabled:text-lumo-fg-low"
      >
        {saving ? "Saving…" : "Save"}
      </button>
    </div>
  );
}

function SliderRow({
  label,
  help,
  value,
  onSave,
  saving,
}: {
  label: string;
  help: string;
  value: number;
  onSave: (v: number) => void;
  saving: boolean;
}) {
  const [draft, setDraft] = useState<number>(value);
  useEffect(() => setDraft(value), [value]);
  const dirty = Math.abs(draft - value) > 0.001;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11.5px] uppercase tracking-[0.12em] text-lumo-fg-low">
          {label}
        </span>
        <span className="text-[12.5px] text-lumo-fg num">{draft.toFixed(2)}</span>
      </div>
      <div className="flex items-center gap-3">
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={draft}
          onChange={(e) => setDraft(parseFloat(e.target.value))}
          className="flex-1"
        />
        <button
          type="button"
          disabled={!dirty || saving}
          onClick={() => onSave(draft)}
          className="h-8 px-3 rounded-md bg-lumo-fg text-lumo-bg text-[12px] font-medium hover:bg-lumo-accent hover:text-lumo-accent-ink disabled:bg-lumo-elevated disabled:text-lumo-fg-low"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      <p className="text-[11.5px] text-lumo-fg-low leading-relaxed">{help}</p>
    </div>
  );
}

function PromptOverride({
  label,
  settingKey,
  value,
  onSave,
  saving,
}: {
  label: string;
  settingKey: string;
  value: string;
  onSave: (v: string) => void;
  saving: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const [history, setHistory] = useState<HistoryRow[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  useEffect(() => setDraft(value), [value]);
  const dirty = draft !== value;

  async function loadHistory() {
    try {
      const res = await fetch(
        `/api/admin/settings?key=${encodeURIComponent(settingKey)}`,
        { cache: "no-store" },
      );
      if (!res.ok) return;
      const j = (await res.json()) as { history?: HistoryRow[] };
      setHistory(j.history ?? []);
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[11.5px] uppercase tracking-[0.12em] text-lumo-fg-low">
          {label}
        </span>
        <button
          type="button"
          onClick={() => {
            setShowHistory((s) => !s);
            if (!showHistory && !history) void loadHistory();
          }}
          className="text-[11.5px] text-lumo-fg-mid hover:text-lumo-fg"
        >
          {showHistory ? "Hide history" : "History"}
        </button>
      </div>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={6}
        placeholder="Empty = use the built-in prompt unchanged."
        className="block w-full rounded-md border border-lumo-hair bg-lumo-bg px-3 py-2 text-[12.5px] text-lumo-fg placeholder:text-lumo-fg-low focus:border-lumo-edge outline-none font-mono"
      />
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-lumo-fg-low num">
          {draft.length} / 8000 chars
        </span>
        <button
          type="button"
          disabled={!dirty || saving || draft.length > 8000}
          onClick={() => onSave(draft)}
          className="h-8 px-3 rounded-md bg-lumo-fg text-lumo-bg text-[12px] font-medium hover:bg-lumo-accent hover:text-lumo-accent-ink disabled:bg-lumo-elevated disabled:text-lumo-fg-low"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      {showHistory && history ? (
        <div className="rounded-md border border-lumo-hair bg-lumo-bg p-2 space-y-1 max-h-60 overflow-y-auto">
          {history.length === 0 ? (
            <div className="text-[11.5px] text-lumo-fg-low p-2">
              No prior versions.
            </div>
          ) : (
            history.map((h) => (
              <button
                key={h.id}
                type="button"
                onClick={() => setDraft(String(h.value ?? ""))}
                className="w-full text-left rounded p-2 hover:bg-lumo-elevated"
              >
                <div className="text-[11px] text-lumo-fg-low num">
                  {new Date(h.recorded_at).toLocaleString()} ·{" "}
                  {h.recorded_by ?? "unknown"}
                </div>
                <div className="text-[12px] text-lumo-fg-mid line-clamp-2">
                  {String(h.value ?? "")}
                </div>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

function ToggleRow({
  label,
  help,
  value,
  onSave,
  saving,
}: {
  label: string;
  help: string;
  value: boolean;
  onSave: (v: boolean) => void;
  saving: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex-1 min-w-0">
        <div className="text-[13px] text-lumo-fg">{label}</div>
        <div className="text-[11.5px] text-lumo-fg-low leading-relaxed">
          {help}
        </div>
      </div>
      <button
        type="button"
        disabled={saving}
        onClick={() => onSave(!value)}
        className={
          "h-7 w-12 rounded-full transition-colors relative shrink-0 " +
          (value ? "bg-lumo-accent" : "bg-lumo-elevated border border-lumo-hair")
        }
        aria-pressed={value}
      >
        <span
          className={
            "absolute top-0.5 h-6 w-6 rounded-full bg-lumo-bg transition-all " +
            (value ? "left-[22px]" : "left-0.5")
          }
        />
      </button>
    </div>
  );
}
