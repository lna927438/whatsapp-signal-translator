-- Realtime Translator production schema
-- Safe baseline for Supabase Auth + character wallet + billing + device/session + app admin data.

create extension if not exists pgcrypto;

-- ---------- ENUMS ----------
do $$ begin
  create type public.order_status as enum ('pending','paid','failed','refunded','cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.ledger_type as enum ('translation','recharge','adjustment','refund','bonus');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.device_status as enum ('active','revoked','blocked');
exception when duplicate_object then null; end $$;

-- ---------- CORE TABLES ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique,
  email text,
  display_name text,
  avatar_url text,
  plan_code text not null default 'free',
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists profiles_username_ci_idx on public.profiles (lower(username)) where username is not null;
create unique index if not exists profiles_email_ci_idx on public.profiles (lower(email)) where email is not null;

create table if not exists public.wallets (
  user_id uuid primary key references auth.users(id) on delete cascade,
  balance bigint not null default 0 check (balance >= 0),
  lifetime_credited bigint not null default 0 check (lifetime_credited >= 0),
  lifetime_debited bigint not null default 0 check (lifetime_debited >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.character_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type public.ledger_type not null,
  characters bigint not null,
  balance_after bigint not null check (balance_after >= 0),
  idempotency_key text,
  source text,
  note text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists character_ledger_user_idempotency_idx
  on public.character_ledger(user_id, idempotency_key)
  where idempotency_key is not null;
create index if not exists character_ledger_user_created_idx on public.character_ledger(user_id, created_at desc);

create table if not exists public.translation_usage (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id text not null,
  account_id text,
  conversation_id text,
  provider text not null,
  model text,
  source_language text,
  target_language text,
  source_characters integer not null default 0 check (source_characters >= 0),
  cache_hit boolean not null default false,
  latency_ms integer,
  created_at timestamptz not null default now()
);

create unique index if not exists translation_usage_user_request_idx on public.translation_usage(user_id, request_id);
create index if not exists translation_usage_user_created_idx on public.translation_usage(user_id, created_at desc);

create table if not exists public.plans (
  code text primary key,
  name text not null,
  included_characters bigint not null default 0 check (included_characters >= 0),
  price_cents integer not null default 0 check (price_cents >= 0),
  currency text not null default 'USD',
  active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null default 'stripe',
  provider_order_id text unique,
  status public.order_status not null default 'pending',
  plan_code text references public.plans(code),
  amount_cents integer not null default 0 check (amount_cents >= 0),
  currency text not null default 'USD',
  characters bigint not null default 0 check (characters >= 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists orders_user_created_idx on public.orders(user_id, created_at desc);

create table if not exists public.devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_fingerprint text not null,
  device_name text,
  platform text,
  app_version text,
  status public.device_status not null default 'active',
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create unique index if not exists devices_user_fingerprint_idx on public.devices(user_id, device_fingerprint);

create table if not exists public.app_versions (
  version text primary key,
  platform text not null default 'windows',
  download_url text,
  minimum_supported boolean not null default false,
  force_update boolean not null default false,
  release_notes text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  level text not null default 'info',
  active boolean not null default true,
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.admin_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'admin',
  created_at timestamptz not null default now()
);

-- ---------- UPDATED_AT ----------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at before update on public.profiles
for each row execute function public.set_updated_at();
create trigger wallets_set_updated_at before update on public.wallets
for each row execute function public.set_updated_at();
create trigger plans_set_updated_at before update on public.plans
for each row execute function public.set_updated_at();
create trigger orders_set_updated_at before update on public.orders
for each row execute function public.set_updated_at();

-- ---------- SIGNUP BOOTSTRAP ----------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, username, email)
  values (
    new.id,
    nullif(trim(new.raw_user_meta_data ->> 'username'), ''),
    new.email
  )
  on conflict (id) do nothing;

  insert into public.wallets (user_id, balance, lifetime_credited, lifetime_debited)
  values (new.id, 0, 0, 0)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

create or replace trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- ---------- ATOMIC WALLET RPCS (SERVER ONLY) ----------
create or replace function public.consume_characters(
  p_user_id uuid,
  p_amount bigint,
  p_idempotency_key text,
  p_source text default 'translation',
  p_note text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance bigint;
  v_existing bigint;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'amount must be greater than zero';
  end if;

  select balance_after into v_existing
  from public.character_ledger
  where user_id = p_user_id and idempotency_key = p_idempotency_key
  limit 1;

  if found then
    return v_existing;
  end if;

  update public.wallets
  set balance = balance - p_amount,
      lifetime_debited = lifetime_debited + p_amount,
      updated_at = now()
  where user_id = p_user_id and balance >= p_amount
  returning balance into v_balance;

  if v_balance is null then
    raise exception 'insufficient_characters';
  end if;

  insert into public.character_ledger(user_id, type, characters, balance_after, idempotency_key, source, note, metadata)
  values (p_user_id, 'translation', -p_amount, v_balance, p_idempotency_key, p_source, p_note, coalesce(p_metadata, '{}'::jsonb));

  return v_balance;
end;
$$;

create or replace function public.credit_characters(
  p_user_id uuid,
  p_amount bigint,
  p_idempotency_key text,
  p_source text default 'recharge',
  p_note text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_balance bigint;
  v_existing bigint;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'amount must be greater than zero';
  end if;

  select balance_after into v_existing
  from public.character_ledger
  where user_id = p_user_id and idempotency_key = p_idempotency_key
  limit 1;

  if found then
    return v_existing;
  end if;

  update public.wallets
  set balance = balance + p_amount,
      lifetime_credited = lifetime_credited + p_amount,
      updated_at = now()
  where user_id = p_user_id
  returning balance into v_balance;

  if v_balance is null then
    insert into public.wallets(user_id, balance, lifetime_credited, lifetime_debited)
    values (p_user_id, p_amount, p_amount, 0)
    returning balance into v_balance;
  end if;

  insert into public.character_ledger(user_id, type, characters, balance_after, idempotency_key, source, note, metadata)
  values (p_user_id, 'recharge', p_amount, v_balance, p_idempotency_key, p_source, p_note, coalesce(p_metadata, '{}'::jsonb));

  return v_balance;
end;
$$;

revoke all on function public.consume_characters(uuid,bigint,text,text,text,jsonb) from public, anon, authenticated;
revoke all on function public.credit_characters(uuid,bigint,text,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.consume_characters(uuid,bigint,text,text,text,jsonb) to service_role;
grant execute on function public.credit_characters(uuid,bigint,text,text,text,jsonb) to service_role;

-- ---------- RLS ----------
alter table public.profiles enable row level security;
alter table public.wallets enable row level security;
alter table public.character_ledger enable row level security;
alter table public.translation_usage enable row level security;
alter table public.plans enable row level security;
alter table public.orders enable row level security;
alter table public.devices enable row level security;
alter table public.app_versions enable row level security;
alter table public.announcements enable row level security;
alter table public.admin_roles enable row level security;

create policy "profiles_select_own" on public.profiles for select to authenticated using (auth.uid() = id);
create policy "profiles_update_own" on public.profiles for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);
create policy "wallets_select_own" on public.wallets for select to authenticated using (auth.uid() = user_id);
create policy "ledger_select_own" on public.character_ledger for select to authenticated using (auth.uid() = user_id);
create policy "usage_select_own" on public.translation_usage for select to authenticated using (auth.uid() = user_id);
create policy "orders_select_own" on public.orders for select to authenticated using (auth.uid() = user_id);
create policy "devices_select_own" on public.devices for select to authenticated using (auth.uid() = user_id);
create policy "devices_insert_own" on public.devices for insert to authenticated with check (auth.uid() = user_id);
create policy "devices_update_own" on public.devices for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "plans_read_active" on public.plans for select to authenticated using (active = true);
create policy "versions_read_active" on public.app_versions for select to authenticated using (active = true);
create policy "announcements_read_active" on public.announcements for select to authenticated using (active = true and starts_at <= now() and (ends_at is null or ends_at > now()));
create policy "admin_roles_select_own" on public.admin_roles for select to authenticated using (auth.uid() = user_id);

-- Prevent ordinary clients from directly modifying protected financial tables.
revoke insert, update, delete on public.wallets from anon, authenticated;
revoke insert, update, delete on public.character_ledger from anon, authenticated;
revoke insert, update, delete on public.translation_usage from anon, authenticated;
revoke insert, update, delete on public.orders from anon, authenticated;
revoke insert, update, delete on public.plans from anon, authenticated;
revoke insert, update, delete on public.app_versions from anon, authenticated;
revoke insert, update, delete on public.announcements from anon, authenticated;
revoke insert, update, delete on public.admin_roles from anon, authenticated;

-- ---------- SEED ----------
insert into public.plans(code, name, included_characters, price_cents, currency, active)
values
  ('free', '免费版', 0, 0, 'USD', true),
  ('starter', '入门版', 100000, 0, 'USD', true),
  ('pro', '高级套餐', 1000000, 0, 'USD', true)
on conflict (code) do update set
  name = excluded.name,
  included_characters = excluded.included_characters,
  active = excluded.active,
  updated_at = now();
