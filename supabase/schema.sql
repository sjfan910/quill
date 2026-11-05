-- Quill: run this once in Supabase → SQL Editor → New query → Run.
-- Everything is private per user (row-level security). The usage ledger can only be
-- written by the server (service role), so spending limits can't be tampered with.

create table if not exists public.profiles (
  user_id    uuid primary key references auth.users on delete cascade,
  settings   jsonb not null default '{}'::jsonb,
  synced_at  timestamptz not null default now()
);

create table if not exists public.courses (
  id         uuid primary key,
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  data       jsonb not null,
  deleted    boolean not null default false,
  synced_at  timestamptz not null default now()
);

create table if not exists public.lectures (
  id         uuid primary key,
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  data       jsonb not null,
  deleted    boolean not null default false,
  synced_at  timestamptz not null default now()
);

create table if not exists public.usage_log (
  id              bigint generated always as identity primary key,
  user_id         uuid not null references auth.users on delete cascade,
  at              timestamptz not null default now(),
  lecture_id      text,
  kind            text,
  model           text,
  prompt_tokens   integer not null default 0,
  audio_tokens    integer not null default 0,
  cached_tokens   integer not null default 0,
  output_tokens   integer not null default 0,
  thoughts_tokens integer not null default 0,
  cost_usd        numeric(12, 6) not null default 0
);

create index if not exists courses_sync   on public.courses   (user_id, synced_at);
create index if not exists lectures_sync  on public.lectures  (user_id, synced_at);
create index if not exists usage_by_month on public.usage_log (user_id, at);

-- synced_at is set by the server clock on every write, so "what changed since" is reliable.
create or replace function public.touch_synced_at() returns trigger language plpgsql as $$
begin new.synced_at := now(); return new; end $$;

drop trigger if exists touch on public.profiles;
create trigger touch before insert or update on public.profiles for each row execute function public.touch_synced_at();
drop trigger if exists touch on public.courses;
create trigger touch before insert or update on public.courses for each row execute function public.touch_synced_at();
drop trigger if exists touch on public.lectures;
create trigger touch before insert or update on public.lectures for each row execute function public.touch_synced_at();

alter table public.profiles  enable row level security;
alter table public.courses   enable row level security;
alter table public.lectures  enable row level security;
alter table public.usage_log enable row level security;

drop policy if exists own on public.profiles;
create policy own on public.profiles for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists own on public.courses;
create policy own on public.courses for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists own on public.lectures;
create policy own on public.lectures for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
-- Ledger: you can read your own rows; only the server (service role, bypasses RLS) can write.
drop policy if exists read_own on public.usage_log;
create policy read_own on public.usage_log for select to authenticated using (user_id = auth.uid());
