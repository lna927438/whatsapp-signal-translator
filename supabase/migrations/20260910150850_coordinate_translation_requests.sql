-- Durable coordination across Worker instances. Only the service role can use
-- these RPCs or read stored translations. Source text is represented by a hash.
create schema if not exists translator_private;
revoke all on schema translator_private from public, anon, authenticated;
grant usage on schema translator_private to service_role;

alter table public.wallets add column reserved_characters bigint not null default 0;
alter table public.wallets add constraint wallets_reserved_characters_check
  check (reserved_characters >= 0 and reserved_characters <= balance);

create table translator_private.translation_requests (
  user_id uuid not null references auth.users(id) on delete cascade,
  request_id text not null check (request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  source_characters integer not null check (source_characters between 1 and 10000),
  claim_token uuid not null,
  state text not null default 'processing' check (state in ('processing', 'completed', 'failed')),
  metadata jsonb not null default '{}'::jsonb,
  response jsonb,
  error_code text,
  expires_at timestamptz not null default (clock_timestamp() + interval '5 minutes'),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (user_id, request_id)
);
create index translation_requests_expiry_idx on translator_private.translation_requests(user_id, expires_at)
  where state = 'processing';
alter table translator_private.translation_requests enable row level security;
revoke all on translator_private.translation_requests from public, anon, authenticated;
grant select, insert, update, delete on translator_private.translation_requests to service_role;

create function public.begin_translation(
  p_user_id uuid, p_request_id text, p_payload_hash text, p_characters integer,
  p_claim_token uuid, p_metadata jsonb default '{}'::jsonb
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_status text;
  v_wallet public.wallets%rowtype;
  v_request translator_private.translation_requests%rowtype;
  v_expired bigint;
begin
  if p_request_id is null or p_request_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
     or p_payload_hash is null or p_payload_hash !~ '^[0-9a-f]{64}$'
     or p_characters is null or p_characters not between 1 and 10000 or p_claim_token is null then
    raise exception 'invalid_request';
  end if;

  -- All request RPCs use the same lock order: profile -> wallet -> request.
  select status into v_status from public.profiles where id = p_user_id for share;
  if v_status is distinct from 'active' then raise exception 'account_disabled'; end if;
  select * into v_wallet from public.wallets where user_id = p_user_id for update;
  if not found then raise exception 'insufficient_characters'; end if;

  -- Reclaim abandoned reservations on the next request by this user. Expired IDs
  -- remain terminal: a lost Worker must not cause an automatic second AI call.
  with expired as (
    update translator_private.translation_requests
    set state = 'failed', error_code = 'translation_outcome_unknown', updated_at = clock_timestamp()
    where user_id = p_user_id and state = 'processing' and expires_at <= clock_timestamp()
    returning source_characters
  ) select coalesce(sum(source_characters), 0) into v_expired from expired;
  if v_expired > 0 then
    update public.wallets set reserved_characters = reserved_characters - v_expired where user_id = p_user_id
    returning * into v_wallet;
  end if;

  select * into v_request from translator_private.translation_requests
  where user_id = p_user_id and request_id = p_request_id;
  if found then
    if v_request.payload_hash <> p_payload_hash or v_request.source_characters <> p_characters then
      raise exception 'request_id_conflict';
    end if;
    return jsonb_build_object('state', v_request.state, 'response', v_request.response, 'error', v_request.error_code);
  end if;

  -- Old requests have a ledger/usage record but no replayable response/hash.
  -- Never let them be reused as a new, uncharged translation.
  if exists (select 1 from public.character_ledger where user_id = p_user_id and idempotency_key = p_request_id)
     or exists (select 1 from public.translation_usage where user_id = p_user_id and request_id = p_request_id) then
    raise exception 'request_id_conflict';
  end if;
  if v_wallet.balance - v_wallet.reserved_characters < p_characters then
    raise exception 'insufficient_characters';
  end if;
  insert into translator_private.translation_requests(user_id, request_id, payload_hash, source_characters, claim_token, metadata)
  values (p_user_id, p_request_id, p_payload_hash, p_characters, p_claim_token, coalesce(p_metadata, '{}'::jsonb));
  update public.wallets set reserved_characters = reserved_characters + p_characters where user_id = p_user_id;
  return jsonb_build_object('state', 'claimed');
end;
$$;

create function public.complete_translation(
  p_user_id uuid, p_request_id text, p_claim_token uuid,
  p_translation text, p_model text, p_latency_ms integer
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_status text;
  v_request translator_private.translation_requests%rowtype;
  v_balance bigint;
  v_response jsonb;
  v_error text;
begin
  select status into v_status from public.profiles where id = p_user_id for share;
  perform 1 from public.wallets where user_id = p_user_id for update;
  select * into v_request from translator_private.translation_requests
  where user_id = p_user_id and request_id = p_request_id for update;
  if not found then raise exception 'request_not_found'; end if;
  if v_request.claim_token is distinct from p_claim_token then raise exception 'request_id_conflict'; end if;
  if v_request.state <> 'processing' then
    if v_status is distinct from 'active' then raise exception 'account_disabled'; end if;
    return jsonb_build_object('state', v_request.state, 'response', v_request.response, 'error', v_request.error_code);
  end if;
  if v_status is distinct from 'active' then v_error := 'account_disabled';
  elsif v_request.expires_at <= clock_timestamp() then v_error := 'translation_outcome_unknown';
  end if;
  if v_error is not null then
    update public.wallets set reserved_characters = reserved_characters - v_request.source_characters where user_id = p_user_id;
    update translator_private.translation_requests set state = 'failed', error_code = v_error, updated_at = clock_timestamp()
    where user_id = p_user_id and request_id = p_request_id;
    return jsonb_build_object('state', 'failed', 'error', v_error);
  end if;
  if p_translation is null or length(trim(p_translation)) = 0 or length(p_translation) > 100000
     or p_model is null or p_latency_ms is null or p_latency_ms < 0 then
    raise exception 'invalid_request';
  end if;
  update public.wallets set balance = balance - v_request.source_characters,
    reserved_characters = reserved_characters - v_request.source_characters,
    lifetime_debited = lifetime_debited + v_request.source_characters
  where user_id = p_user_id returning balance into v_balance;

  insert into public.character_ledger(user_id, type, characters, balance_after, idempotency_key, source, note, metadata)
  values (p_user_id, 'translation', -v_request.source_characters, v_balance, p_request_id,
          'cloudflare-translate', '实时翻译', v_request.metadata || jsonb_build_object('model', p_model));
  insert into public.translation_usage(user_id, request_id, account_id, conversation_id, provider, model,
    source_language, target_language, source_characters, cache_hit, latency_ms)
  values (p_user_id, p_request_id, v_request.metadata->>'account_id', v_request.metadata->>'conversation_id',
    'openai', p_model, v_request.metadata->>'source_language', v_request.metadata->>'target_language',
    v_request.source_characters, false, p_latency_ms);

  v_response := jsonb_build_object('requestId', p_request_id, 'translation', p_translation,
    'sourceCharacters', v_request.source_characters, 'balanceAfter', v_balance,
    'latencyMs', p_latency_ms, 'model', p_model);
  update translator_private.translation_requests set state = 'completed', response = v_response, updated_at = clock_timestamp()
  where user_id = p_user_id and request_id = p_request_id;
  return jsonb_build_object('state', 'completed', 'response', v_response);
end;
$$;

create function public.fail_translation(p_user_id uuid, p_request_id text, p_claim_token uuid, p_error_code text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_request translator_private.translation_requests%rowtype;
begin
  perform 1 from public.profiles where id = p_user_id for share;
  perform 1 from public.wallets where user_id = p_user_id for update;
  select * into v_request from translator_private.translation_requests
  where user_id = p_user_id and request_id = p_request_id for update;
  if not found then raise exception 'request_not_found'; end if;
  if v_request.claim_token is distinct from p_claim_token then raise exception 'request_id_conflict'; end if;
  if v_request.state = 'processing' then
    update public.wallets set reserved_characters = reserved_characters - v_request.source_characters where user_id = p_user_id;
    update translator_private.translation_requests set state = 'failed', error_code = 'translation_failed', updated_at = clock_timestamp()
    where user_id = p_user_id and request_id = p_request_id;
    return jsonb_build_object('state', 'failed', 'error', 'translation_failed');
  end if;
  return jsonb_build_object('state', v_request.state, 'response', v_request.response, 'error', v_request.error_code);
end;
$$;

revoke all on function public.begin_translation(uuid,text,text,integer,uuid,jsonb) from public, anon, authenticated;
revoke all on function public.complete_translation(uuid,text,uuid,text,text,integer) from public, anon, authenticated;
revoke all on function public.fail_translation(uuid,text,uuid,text) from public, anon, authenticated;
grant execute on function public.begin_translation(uuid,text,text,integer,uuid,jsonb) to service_role;
grant execute on function public.complete_translation(uuid,text,uuid,text,text,integer) to service_role;
grant execute on function public.fail_translation(uuid,text,uuid,text) to service_role;

-- Preserve the legacy RPC during rollout, but stop it spending reserved funds
-- or charging inactive users. Serialize duplicate-ID lookup with wallet writes.
create or replace function public.consume_characters(
  p_user_id uuid, p_amount bigint, p_idempotency_key text,
  p_source text default 'translation', p_note text default null, p_metadata jsonb default '{}'::jsonb
) returns bigint language plpgsql security definer set search_path = '' as $$
declare
  v_balance bigint;
  v_status text;
  v_existing public.character_ledger%rowtype;
begin
  if p_amount is null or p_amount <= 0 or p_idempotency_key is null or length(p_idempotency_key) = 0 then
    raise exception 'invalid_request';
  end if;
  select status into v_status from public.profiles where id = p_user_id for share;
  if v_status is distinct from 'active' then raise exception 'account_disabled'; end if;
  perform 1 from public.wallets where user_id = p_user_id for update;
  select * into v_existing from public.character_ledger
  where user_id = p_user_id and idempotency_key = p_idempotency_key limit 1;
  if found then
    if v_existing.type <> 'translation' or v_existing.characters <> -p_amount then raise exception 'request_id_conflict'; end if;
    return v_existing.balance_after;
  end if;
  if exists (select 1 from translator_private.translation_requests where user_id = p_user_id and request_id = p_idempotency_key) then
    raise exception 'request_id_conflict';
  end if;
  update public.wallets set balance = balance - p_amount, lifetime_debited = lifetime_debited + p_amount
  where user_id = p_user_id and balance - reserved_characters >= p_amount returning balance into v_balance;
  if v_balance is null then raise exception 'insufficient_characters'; end if;
  insert into public.character_ledger(user_id, type, characters, balance_after, idempotency_key, source, note, metadata)
  values (p_user_id, 'translation', -p_amount, v_balance, p_idempotency_key, p_source, p_note, coalesce(p_metadata, '{}'::jsonb));
  return v_balance;
end;
$$;
