-- ============================================================
-- Migration: storage bucket for REA/OEA source documents.
--
-- Why: Netlify function requests are capped at ~6 MB, and a PDF converted
-- to base64 grows ~33%, so sending the raw PDF to the analysis function
-- fails with HTTP 413 (Payload Too Large). Instead, the browser uploads
-- each PDF to this bucket and passes the function a short URL; the function
-- downloads the file server-side. This works for any file size.
--
-- Run ONCE in Supabase (SQL Editor -> New query -> paste -> Run).
-- Safe to run again.
-- ============================================================

insert into storage.buckets (id, name, public)
values ('rea-docs', 'rea-docs', true)
on conflict (id) do nothing;

-- the browser (anon) may upload documents and read them back
drop policy if exists "public read rea-docs" on storage.objects;
create policy "public read rea-docs"
  on storage.objects for select
  using (bucket_id = 'rea-docs');

drop policy if exists "anon upload rea-docs" on storage.objects;
create policy "anon upload rea-docs"
  on storage.objects for insert
  with check (bucket_id = 'rea-docs');
