-- Agent bundle storage bucket for MARKETPLACE-1.
--
-- Supabase's object-lock setting is applied from the dashboard/API in hosted
-- environments. This declaration keeps the bucket idempotently present for
-- local/staging databases; production operators should enable object-lock on
-- the `agent-bundles` bucket before accepting third-party submissions.

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'agent-bundles',
  'agent-bundles',
  false,
  26214400,
  array[
    'application/gzip',
    'application/x-gzip',
    'application/octet-stream'
  ]
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;
