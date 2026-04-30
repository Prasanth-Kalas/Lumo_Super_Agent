interface CompoundCreateResponse {
  compound_transaction_id: string;
  status: string;
  graph_hash: string;
  error?: string;
  message?: string;
}

interface LegStatusFrame {
  status?: string;
}

const API_BASE = (process.env.LUMO_API_BASE ?? "http://localhost:3000").replace(/\/$/, "");
const SESSION_COOKIE = process.env.LUMO_SESSION_COOKIE ?? "";
const MAX_STREAM_MS = Number(process.env.LUMO_SAMPLE_MAX_MS ?? 30_000);

const terminalStatuses = new Set(["committed", "rolled_back", "failed", "cancelled"]);

async function main(): Promise<void> {
  const idempotencyKey = `stub-3-leg-trip:${new Date().toISOString().slice(0, 10)}:demo`;
  const create = await postCompoundTransaction(idempotencyKey);
  if (create.error) {
    throw new Error(`${create.error}${create.message ? `: ${create.message}` : ""}`);
  }

  console.log(
    `compound_transaction_id=${create.compound_transaction_id} status=${create.status} graph_hash=${create.graph_hash}`,
  );
  await streamLegStatus(create.compound_transaction_id);
}

async function postCompoundTransaction(idempotencyKey: string): Promise<CompoundCreateResponse> {
  const response = await fetch(`${API_BASE}/api/compound/transactions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify({
      idempotency_key: idempotencyKey,
      currency: "USD",
      confirmation_digest:
        "0000000000000000000000000000000000000000000000000000000000000000",
      line_items: [
        { label: "Synthetic flight", amountCents: 100 },
        { label: "Synthetic hotel", amountCents: 100 },
        { label: "Synthetic ground", amountCents: 100 },
      ],
      legs: [
        {
          client_leg_id: "flight",
          agent_id: "stub-3-leg-trip",
          agent_version: "1.0.0",
          provider: "mock_merchant",
          capability_id: "book_flight_stub",
          compensation_capability_id: "cancel_flight_stub",
          amount_cents: 100,
          currency: "USD",
          compensation_kind: "perfect",
        },
        {
          client_leg_id: "hotel",
          agent_id: "stub-3-leg-trip",
          agent_version: "1.0.0",
          provider: "mock_merchant",
          capability_id: "book_hotel_stub",
          compensation_capability_id: "cancel_hotel_stub",
          amount_cents: 100,
          currency: "USD",
          compensation_kind: "perfect",
        },
        {
          client_leg_id: "ground",
          agent_id: "stub-3-leg-trip",
          agent_version: "1.0.0",
          provider: "mock_merchant",
          capability_id: "book_ground_stub",
          compensation_capability_id: "cancel_ground_stub",
          amount_cents: 100,
          currency: "USD",
          compensation_kind: "best-effort",
        },
      ],
      dependencies: [
        {
          dependency_client_leg_id: "flight",
          dependent_client_leg_id: "hotel",
          edge_type: "requires_destination",
        },
        {
          dependency_client_leg_id: "hotel",
          dependent_client_leg_id: "ground",
          edge_type: "requires_arrival_time",
        },
      ],
    }),
  });
  return (await response.json()) as CompoundCreateResponse;
}

async function streamLegStatus(compoundId: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MAX_STREAM_MS);
  try {
    const response = await fetch(`${API_BASE}/api/compound/transactions/${compoundId}/stream`, {
      headers: authHeaders(),
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`stream_failed:${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const raw of frames) {
        const data = parseSseData(raw);
        if (!data) continue;
        console.log(JSON.stringify(data));
        if (terminalStatuses.has(String((data as LegStatusFrame).status))) return;
      }
    }
  } catch (error) {
    if ((error as { name?: string }).name === "AbortError") {
      console.log(`stream_timeout_after_ms=${MAX_STREAM_MS}`);
      return;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function parseSseData(raw: string): unknown | null {
  const line = raw.split("\n").find((candidate) => candidate.startsWith("data: "));
  if (!line) return null;
  return JSON.parse(line.slice("data: ".length));
}

function authHeaders(): Record<string, string> {
  return SESSION_COOKIE ? { cookie: SESSION_COOKIE } : {};
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
