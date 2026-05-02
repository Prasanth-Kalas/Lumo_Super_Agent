/**
 * Fast-turn LLM helper.
 *
 * Streams a single chat completion from Groq (with Cerebras as
 * failover). Used for `fast_path` orchestrator turns where:
 *   - The intent classifier returned high-confidence "fast_path".
 *   - No tools are needed for this turn.
 *
 * Both Groq and Cerebras expose an OpenAI-compatible
 * /v1/chat/completions endpoint, which is what we use. The wire
 * format is intentionally narrow — we don't pull in the full
 * `openai` SDK for two reasons: (a) avoid a bundle dependency
 * for what is essentially a single fetch, (b) the existing
 * `intent-classifier.ts` already proves out the raw-fetch
 * pattern against both providers.
 *
 * Failure mode: if both providers are unreachable / unset / time
 * out, we throw. The orchestrator catches and falls through to
 * its Anthropic Haiku fallback so the user always gets a reply.
 */

const DEFAULT_TIMEOUT_MS = 12_000;

export interface FastTurnMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface FastTurnInput {
  /** Plain chat history, NEWEST LAST. System message goes in `system`. */
  messages: FastTurnMessage[];
  /** System prompt. Forwarded as the first message with role=system. */
  system: string;
  /** Streaming callback — invoked with each text delta from the SSE stream. */
  onText?: (delta: string) => void;
  /** Optional abort signal. */
  signal?: AbortSignal;
  /** Test seam. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Override the provider list (mostly for tests). */
  providers?: FastTurnProvider[];
}

export interface FastTurnResult {
  text: string;
  /** The provider that actually served the response. */
  provider: "groq" | "cerebras";
  /** The model name reported by the provider. */
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export interface FastTurnProvider {
  provider: "groq" | "cerebras";
  baseUrl: string;
  apiKey: string | undefined;
  model: string;
}

export function defaultFastTurnProviders(): FastTurnProvider[] {
  return [
    {
      provider: "groq",
      baseUrl: "https://api.groq.com/openai/v1/chat/completions",
      apiKey: process.env.LUMO_GROQ_API_KEY,
      // 70B versatile model — fast (sub-1s for short replies) and
      // capable enough for the chitchat / quick-acknowledgement
      // turns the classifier routes here. Keep this larger than
      // the 8B intent-classifier model since the user actually
      // sees this output.
      model: process.env.LUMO_GROQ_FAST_TURN_MODEL ?? "llama-3.3-70b-versatile",
    },
    {
      provider: "cerebras",
      baseUrl: "https://api.cerebras.ai/v1/chat/completions",
      apiKey: process.env.LUMO_CEREBRAS_API_KEY,
      model:
        process.env.LUMO_CEREBRAS_FAST_TURN_MODEL ?? "llama-3.3-70b",
    },
  ];
}

export async function streamFastTurn(
  input: FastTurnInput,
): Promise<FastTurnResult> {
  const providers = input.providers ?? defaultFastTurnProviders();
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let lastError: Error | null = null;

  for (const provider of providers) {
    if (!provider.apiKey || !provider.model) continue;
    try {
      return await callFastTurnProvider({
        provider,
        input,
        fetchImpl,
        timeoutMs,
      });
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // Fall through to next provider.
    }
  }

  throw (
    lastError ??
    new Error(
      "fast_turn: no provider configured (set LUMO_GROQ_API_KEY or LUMO_CEREBRAS_API_KEY)",
    )
  );
}

interface FastTurnUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

async function callFastTurnProvider({
  provider,
  input,
  fetchImpl,
  timeoutMs,
}: {
  provider: FastTurnProvider;
  input: FastTurnInput;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}): Promise<FastTurnResult> {
  const started = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
  // Plumb the caller's signal through too, so an upstream cancel
  // (request aborted, page navigation) propagates here.
  if (input.signal) {
    input.signal.addEventListener("abort", () => controller.abort("upstream"));
  }

  const body = {
    model: provider.model,
    stream: true,
    // Top-level system prompt is most reliably honored by both
    // providers when included as the first chat message rather
    // than the OpenAI top-level `system` (which neither honors).
    messages: [
      { role: "system" as const, content: input.system },
      ...input.messages,
    ],
    // Hard cap to keep "fast" actually fast. A fast_path turn that
    // wants to ramble suggests the classifier mis-routed it; the
    // orchestrator's fallback to Haiku will catch genuine misroutes.
    max_tokens: 512,
    // Modest temperature so responses feel personable but not
    // wandering.
    temperature: 0.6,
  };

  let response: Response;
  try {
    response = await fetchImpl(provider.baseUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok || !response.body) {
    const detail = await safeReadText(response);
    throw new Error(
      `fast_turn ${provider.provider} ${response.status}: ${detail.slice(0, 240)}`,
    );
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";
  let text = "";
  let usage: FastTurnUsage | null = null;
  let modelReported = provider.model;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIdx = buffer.indexOf("\n");
    while (newlineIdx >= 0) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      newlineIdx = buffer.indexOf("\n");
      if (!line) continue;
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const parsed = JSON.parse(payload) as {
          choices?: Array<{
            delta?: { content?: string };
            finish_reason?: string | null;
          }>;
          model?: string;
          usage?: FastTurnUsage | null;
        };
        if (parsed.model) modelReported = parsed.model;
        if (parsed.usage) usage = parsed.usage;
        const delta = parsed.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta.length > 0) {
          text += delta;
          input.onText?.(delta);
        }
      } catch {
        // Tolerate occasional non-JSON keep-alive frames; both
        // providers send them rarely.
      }
    }
  }

  return {
    text,
    provider: provider.provider,
    model: modelReported,
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    latencyMs: Date.now() - started,
  };
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
