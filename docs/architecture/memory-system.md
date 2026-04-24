# Memory system

How Lumo remembers what matters and surfaces it when it's useful.

## The three layers

1. **Profile** (`user_profile` table) — structured preferences. Always in scope for every turn.
2. **Facts** (`user_facts` table, pgvector-embedded) — free-form statements, retrieved by similarity.
3. **Patterns** (`user_behavior_patterns` table) — derived from activity by a nightly cron.

Each has a distinct lifetime, write path, and retrieval style.

## Profile

Structured columns — timezone, preferred_seat, budget_tier, etc. See [data-model.md](data-model.md#user_profile-migration-005).

Profile is loaded once per turn (fast — single-row SELECT by user_id) and composed into the system prompt as plain key-value lines. No embedding, no similarity search.

Write paths:
- **`/memory` page** — direct edit, PUT to `/api/memory/profile`.
- **`profile_update(field, value)` meta-tool** — Claude calls it when the user says "I prefer aisle seats" in a conversation.
- **Onboarding flow** — seeds the first set of values from `/signup` → `/onboarding`.

## Facts

The semantic-memory layer. Every fact has:

- Plain text content ("prefers vegetarian restaurants").
- A 1536-dimensional embedding from OpenAI's `text-embedding-3-small`.
- An importance score (0–1).
- A created-at timestamp.

### Writing a fact

```ts
// lib/memory.ts
export async function saveFact(
  userId: string,
  content: string,
  importance = 0.5,
): Promise<Fact> {
  const embedding = await embedText(content);
  // Upsert by (user_id, content) to avoid duplicates
  const row = await db.query(
    `insert into user_facts (user_id, content, embedding, importance)
     values ($1, $2, $3, $4)
     on conflict (user_id, content) do update
       set embedding = excluded.embedding,
           importance = greatest(user_facts.importance, excluded.importance),
           updated_at = now()
     returning *`,
    [userId, content, toVectorLiteral(embedding), importance],
  );
  return row;
}
```

Embedding is generated **before** insert. If the OpenAI call fails, `lib/embeddings.ts` returns a null-vector fallback and logs a warning — the fact is still stored, just won't match similarity queries until re-embedded. This keeps fact-writing reliable under upstream outages.

### Retrieving relevant facts

```ts
// lib/memory.ts — simplified
export async function retrieveRelevantFacts(
  userId: string,
  query: string,
  topK = 5,
): Promise<Fact[]> {
  const q = await embedText(query);
  // Scoring: cosine distance (smaller = more similar) blended with
  // recency and importance boosts.
  return db.query(
    `select *,
       (embedding <=> $2) as cos_dist,
       exp(-extract(epoch from (now() - updated_at)) / 2592000) as recency,
       importance
     from user_facts
     where user_id = $1
       and embedding <=> $2 < 0.35      -- distance threshold
     order by
       (embedding <=> $2) * 0.6
       + (1 - recency) * 0.2
       + (1 - importance) * 0.2
     limit $3`,
    [userId, toVectorLiteral(q), topK],
  );
}
```

The scoring:
- **60%** weight on cosine distance (the meaning match).
- **20%** weight on recency (exponential decay over 30 days).
- **20%** weight on importance.

A fact is considered a match only if its cosine distance is below 0.35 (tuned empirically — below 0.35, humans also judge the facts as "relevant" to the query). This prevents junk retrievals on queries that don't match anything.

### Where facts get into the prompt

The orchestrator calls `retrieveRelevantFacts(userId, thread[-1].content, 5)` before building the system prompt. The top matches land in the "Things the user has told you that matter right now:" section.

### The importance score

Starts at 0.5 for user-stated facts and 0.3 for inferred ones. It gets bumped when:
- The user restates the same fact ("I really do prefer aisle seats") — +0.2.
- A tool call surfaces the fact as a deciding factor ("booked aisle seat per your preference") — +0.1.
- The user explicitly marks a fact as important (feature not yet shipped; importance column is future-ready).

Importance caps at 1.0. Facts never get a score reduction; the decay happens in the recency term instead.

## Behavior patterns

The `detect-patterns` cron (`/api/cron/detect-patterns`, daily at 03:00) runs a Claude-backed analyzer over each active user's recent activity:

1. Pulls the last 30 days of `trip_events`, `chat` messages (metadata only, not content), and `autonomous_actions`.
2. Hands Claude a summarized activity log with a prompt: "What routines or preferences are apparent from this? Return a JSON list of at most 10 pattern strings."
3. Upserts the returned patterns into `user_behavior_patterns`, deduplicating by fuzzy string match against existing rows (if `<85% similar` to any existing, insert new; otherwise update `last_seen_at` and bump `evidence_count`).

Examples:
- "Books work trips Tuesday evenings or early Wednesday"
- "Orders dinner around 7pm on weeknights"
- "Prefers direct flights; tolerates one connection if >$100 cheaper"

Patterns are read-only from the user's perspective — they can't edit them, but "Forget everything" wipes them and they re-emerge naturally.

## Retrieval is per-query, not per-turn

Two queries in the same turn (say, user asks for a flight, then asks about a hotel) each embed independently and pull potentially different top-5 facts. This matters because a hotel query ("near the convention center") and a flight query ("preferring aisle") pull distinct preference sets.

## Cache policy

The embeddings client (`lib/embeddings.ts`) maintains an LRU cache of the last 200 query embeddings. Same query asked twice in a session hits the cache. We do **not** cache user fact embeddings — they're stored in the DB, which is a single query away anyway.

## Deletion paths

- **Single fact** → `/memory` → trashcan → `DELETE /api/memory/facts/{id}` → hard delete.
- **All memory** → `/memory` → Forget everything → `forget_everything(user_id)` RPC → atomic wipe of facts + patterns + non-identity profile fields.
- **Account deletion** → propagates through FK cascades: `auth.users` → `profiles` → `user_profile`, `user_facts`, `user_behavior_patterns`.

No soft-delete on memory. Deletions are gone by the next retrieval.

## Backup considerations

On managed deployments, Supabase takes daily encrypted backups. Backups DO include user memory. When a user hits "Forget everything", deletions land in the next backup after the deletion runs — worst case 24 hours before a backup rolls over. For hard compliance requirements (e.g. "no data retained after deletion request"), configure Supabase to either:

- Disable PITR + backups on the memory tables (loses DR capability for those tables).
- Run a per-user delete sweep against backups within the customer's mandated window.

Most deployments don't need either; the default 7-day backup retention is acceptable for GDPR "reasonable time to delete" under most interpretations.

## Failure modes

- **OpenAI embeddings API down.** `embedText` returns a null-vector and logs. Writes still succeed (fact is stored, unembedded). Reads skip unembedded facts in similarity but still include them by recency. Once the API comes back, a re-embed background job (future work) catches them up.
- **pgvector not installed.** Migration 005 fails at apply-time with a clear error — the operator sees it and installs `pgvector` in Supabase's extensions panel before re-running.
- **Similarity threshold too tight / loose.** Symptom: Lumo either never finds facts that are relevant or surfaces too many irrelevant ones. The threshold (0.35) is configurable via `LUMO_MEMORY_SIMILARITY_THRESHOLD` env var — raise it to match more loosely, lower it to be stricter.

## Extension points

- **Different embedding model.** Swap `text-embedding-3-small` in `lib/embeddings.ts` for another model; the 1536-dim column accepts anything of that shape. Re-embedding existing facts requires a one-time batch job.
- **Per-user embedding weights.** The scoring formula is a static blend today. Making the `recency` and `importance` weights user-tunable via a profile setting is straightforward.
- **Cross-user pattern mining.** Explicitly NOT done today (privacy posture). If ever needed, would require a separate table and opt-in flow; do not bolt it onto the existing patterns table.

## Related

- [users/memory.md](../users/memory.md) — user-facing view of memory.
- [orchestration.md](orchestration.md) — where retrieved facts get stitched into the system prompt.
- [data-model.md](data-model.md#user_facts-migration-005) — column-level reference.
