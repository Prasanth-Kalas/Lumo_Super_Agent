-- Migration 013 — Lumo mission permission gate.
--
-- The mission gate is an SSE-visible app-store checkpoint. It records which
-- marketplace apps Lumo asked the user to install/connect before continuing
-- a multi-agent task. Installs approved from that card use install_source =
-- 'lumo' so audit/reporting can distinguish proactive app discovery from a
-- manual marketplace click.

alter table public.user_agent_installs
  drop constraint if exists user_agent_installs_install_source_check;

alter table public.user_agent_installs
  add constraint user_agent_installs_install_source_check check (
    install_source in ('marketplace', 'oauth', 'admin', 'migration', 'lumo')
  );

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
      'leg_status',
      'error',
      'done',
      'request',
      'internal'
    )
  );
