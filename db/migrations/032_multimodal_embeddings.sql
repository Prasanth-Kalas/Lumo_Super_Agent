-- Migration 032 — MMRAG-1 unified multi-modal embedding substrate.
--
-- Codex fills the body for MMRAG-1. This file is the scaffold: unified_embeddings
-- (vector(1024), HNSW with m=16, ef_construction=64 per ADR-011 §4),
-- projector_artifacts (versioned weight matrices for the linear projectors),
-- and the cascade-delete trigger from native source tables. Codex adds the
-- two brain tool RPCs (lumo_recall_unified, lumo_project_embedding) and the
-- backfill cron under this scaffold.
--
-- Related:
--   - docs/specs/adr-011-multimodal-rag-projection.md (sealed)
--   - docs/specs/phase-3-master.md §6 (MMRAG-1 deliverable)
--   - tests/phase3-multimodal-rag.test.mjs (recall@5 ≥ 0.7 synthetic gate)
--   - Native sources: content_embeddings (015), audio_transcripts (017),
--     pdf_documents (019), image_embeddings (020).
--
-- Open schema decisions escalated to Kalas:
--   - HNSW parameters m=16 / ef_construction=64 are sealed in ADR-011 §4. If
--     storage or recall@5 ends up off-target the parameter sweep is in
--     migration 034. Confirm before merge.
--
-- Rollback:
--   drop function if exists public.unified_embeddings_cascade_delete();
--   drop trigger  if exists content_embeddings_cascade_unified on public.content_embeddings;
--   drop trigger  if exists image_embeddings_cascade_unified on public.image_embeddings;
--   drop trigger  if exists audio_transcripts_cascade_unified on public.audio_transcripts;
--   drop trigger  if exists pdf_documents_cascade_unified on public.pdf_documents;
--   drop function if exists public.lumo_project_embedding(text, vector);
--   drop function if exists public.lumo_recall_unified(uuid, text, jsonb, integer);
--   drop index    if exists public.unified_embeddings_user_modality;
--   drop index    if exists public.unified_embeddings_hnsw;
--   drop index    if exists public.unified_embeddings_source;
--   drop table    if exists public.unified_embeddings;
--   drop table    if exists public.projector_artifacts;

create extension if not exists vector;

create table if not exists public.projector_artifacts (
  id            uuid primary key default gen_random_uuid(),
  version       text not null,                          -- e.g. 'v1.0-text', 'v1.0-clip', 'v1.0-audio'
  modality      text not null check (modality in ('text', 'image', 'audio')),
  weights       bytea not null,                         -- serialized weight matrix
  input_dim     integer not null check (input_dim > 0),
  output_dim    integer not null default 1024 check (output_dim = 1024),
  loss          real,
  recall_at_5   real,                                   -- held-out evaluation
  created_at    timestamptz not null default now(),
  unique (version, modality)
);

alter table public.projector_artifacts enable row level security;
revoke all on public.projector_artifacts from anon, authenticated;
grant all on public.projector_artifacts to service_role;

create table if not exists public.unified_embeddings (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.profiles(id) on delete cascade,
  modality           text not null check (modality in ('text', 'image', 'audio')),
  source_table       text not null,                       -- 'content_embeddings'|'image_embeddings'|'audio_transcripts'|'pdf_documents'
  source_row_id      text not null,
  source_url         text,
  text_repr          text,                                -- input to the cross-encoder re-ranker
  embedding          vector(1024) not null,
  projector_version  text not null,
  created_at         timestamptz not null default now(),
  unique (source_table, source_row_id, projector_version)
);

create index if not exists unified_embeddings_user_modality
  on public.unified_embeddings (user_id, modality);

create index if not exists unified_embeddings_source
  on public.unified_embeddings (source_table, source_row_id);

-- HNSW index (ADR-011 §4): m=16, ef_construction=64. Rebuild quarterly per
-- ADR-011 §14 risk register.
create index if not exists unified_embeddings_hnsw
  on public.unified_embeddings using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

alter table public.unified_embeddings enable row level security;
revoke all on public.unified_embeddings from anon, authenticated;
grant all on public.unified_embeddings to service_role;

-- Cascade delete from native source tables (ADR-011 §4 "deletion of a native
-- row cascades to the unified row via a trigger"). Codex wires the per-table
-- triggers below; the function body is shared.
create or replace function public.unified_embeddings_cascade_delete()
returns trigger
language plpgsql
as $$
begin
  delete from public.unified_embeddings
   where source_table = tg_argv[0]
     and source_row_id = old.id::text;
  return old;
end;
$$;

-- Codex enables these triggers once the native column 'id' shapes are
-- confirmed (some native tables use bigint, some uuid; the cast above
-- handles both, but the trigger DDL is left commented so Codex can add
-- per-table after a quick column audit).
--
--   create trigger content_embeddings_cascade_unified
--     after delete on public.content_embeddings
--     for each row execute function public.unified_embeddings_cascade_delete('content_embeddings');
--   create trigger image_embeddings_cascade_unified
--     after delete on public.image_embeddings
--     for each row execute function public.unified_embeddings_cascade_delete('image_embeddings');
--   create trigger audio_transcripts_cascade_unified
--     after delete on public.audio_transcripts
--     for each row execute function public.unified_embeddings_cascade_delete('audio_transcripts');
--   create trigger pdf_documents_cascade_unified
--     after delete on public.pdf_documents
--     for each row execute function public.unified_embeddings_cascade_delete('pdf_documents');

-- Codex fills:
--   create or replace function public.lumo_recall_unified(
--     p_user_id uuid, p_query text, p_filters jsonb, p_top_k integer
--   ) returns table (
--     source_table text, source_row_id text, source_url text,
--     text_repr text, modality text, score real, reranker_engaged boolean
--   )
--   create or replace function public.lumo_project_embedding(
--     p_modality text, p_native_embedding vector
--   ) returns vector(1024)
