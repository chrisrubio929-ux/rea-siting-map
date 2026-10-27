-- ============================================================
-- Migration: background analysis jobs.
-- Lets large REA packages be analyzed without a function timeout:
-- the browser creates a job, a background function fills in the result,
-- and the browser polls this table until it's done.
-- Run ONCE in Supabase (SQL Editor → New query → paste → Run).
-- ============================================================

create table if not exists jobs (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null default 'analysis',
  status     text not null default 'pending',   -- pending | done | error
  result     jsonb,
  error      text,
  created_at timestamptz not null default now()
);

alter table jobs enable row level security;

-- the browser (anon key) may create a job and read its status;
-- the background function (service role key) bypasses RLS to update it.
create policy "anon insert jobs" on jobs for insert with check (true);
create policy "anon read jobs"   on jobs for select using (true);
create policy "anon update jobs" on jobs for update using (true) with check (true);
