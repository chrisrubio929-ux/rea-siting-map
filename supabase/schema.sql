-- ============================================================
-- REA EV Siting Map — Supabase schema
-- Run this in your Supabase project: SQL Editor → New query → paste → Run
-- ============================================================

-- 1. PROPERTIES: one row per shopping center / site
create table if not exists properties (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  address     text,
  analysis    jsonb,                  -- the six-section written REA analysis
  created_at  timestamptz not null default now()
);
-- if the table already existed from an earlier install, add the column:
alter table properties add column if not exists analysis jsonb;

-- 2. SITE MAPS: the uploaded site-plan image for a property
create table if not exists site_maps (
  id          uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties(id) on delete cascade,
  image_url   text not null,          -- public URL of the image in Storage
  created_at  timestamptz not null default now()
);

-- 3. ZONES: the EV-viability boxes drawn on a map
create table if not exists zones (
  id                uuid primary key default gen_random_uuid(),
  map_id            uuid not null references site_maps(id) on delete cascade,
  label             text not null default 'Zone',
  viability         text not null default 'Conditional',  -- Best | Conditional | No-go
  controlling_party text default '',
  approval          text default '',
  x                 double precision not null default 0.1, -- all 0..1, fractions of image
  y                 double precision not null default 0.1,
  w                 double precision not null default 0.3,
  h                 double precision not null default 0.2,
  created_at        timestamptz not null default now()
);

create index if not exists idx_site_maps_property on site_maps(property_id);
create index if not exists idx_zones_map on zones(map_id);

-- ============================================================
-- Row Level Security
-- This is an INTERNAL TEAM TOOL with no per-user login, so we allow
-- the public (anon) key full access. Everyone with the app can read/write.
-- If you later add Supabase Auth, tighten these policies.
-- ============================================================
alter table properties enable row level security;
alter table site_maps  enable row level security;
alter table zones      enable row level security;

create policy "anon full access - properties" on properties for all using (true) with check (true);
create policy "anon full access - site_maps"  on site_maps  for all using (true) with check (true);
create policy "anon full access - zones"      on zones      for all using (true) with check (true);

-- ============================================================
-- Storage bucket for the site-plan images (public read)
-- ============================================================
insert into storage.buckets (id, name, public)
values ('site-plans', 'site-plans', true)
on conflict (id) do nothing;

create policy "public read site-plans"
  on storage.objects for select
  using (bucket_id = 'site-plans');

create policy "anon upload site-plans"
  on storage.objects for insert
  with check (bucket_id = 'site-plans');
