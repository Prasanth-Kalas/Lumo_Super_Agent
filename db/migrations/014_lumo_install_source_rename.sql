-- Migration 014 — rename mission install provenance to Lumo.
--
-- This is intentionally tolerant of environments that already ran the
-- pre-rename migration and may have rows or permission snapshots with the
-- old source value.

alter table public.user_agent_installs
  drop constraint if exists user_agent_installs_install_source_check;

update public.user_agent_installs
set permissions = (permissions - 'jarvis') ||
  jsonb_build_object('lumo', permissions -> 'jarvis')
where permissions ? 'jarvis'
  and not permissions ? 'lumo';

update public.user_agent_installs
set install_source = 'lumo'
where install_source = 'jarvis';

alter table public.user_agent_installs
  add constraint user_agent_installs_install_source_check check (
    install_source in ('marketplace', 'oauth', 'admin', 'migration', 'lumo')
  );
