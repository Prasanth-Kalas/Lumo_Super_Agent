-- WEB-COMPOUND-VIEW-1 event-log frame type.
--
-- Rollback:
--   alter table public.events drop constraint if exists events_frame_type_check;
--   alter table public.events
--     add constraint events_frame_type_check check (
--       frame_type in (
--         'text',
--         'mission',
--         'tool',
--         'selection',
--         'summary',
--         'assistant_suggestions',
--         'leg_status',
--         'error',
--         'done',
--         'request',
--         'internal'
--       )
--     );

alter table public.events
  drop constraint if exists events_frame_type_check;

alter table public.events
  add constraint events_frame_type_check check (
    frame_type in (
      'text',
      'mission',
      'tool',
      'selection',
      'summary',
      'assistant_suggestions',
      'assistant_compound_dispatch',
      'leg_status',
      'error',
      'done',
      'request',
      'internal'
    )
  );
