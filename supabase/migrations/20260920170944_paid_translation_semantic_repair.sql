-- One bounded, provider-metered repair of an already paid translation. The
-- original customer ledger, usage row, provider receipts and result stay intact.
-- Only trusted Worker code may attest that the retained result is semantically
-- invalid, after recomputing the original payload hash. Clients have no RPC grant.
set local lock_timeout='1s';
set local statement_timeout='15s';

alter table translator_private.translation_requests add column billable_characters integer;
update translator_private.translation_requests set billable_characters=source_characters;
alter table translator_private.translation_requests alter column billable_characters set not null;
alter table translator_private.translation_requests add constraint translation_billable_characters
  check(billable_characters in (0,source_characters));

create table translator_private.translation_repairs (
  user_id uuid not null,
  original_request_id text not null,
  repair_request_id text not null,
  payload_hash text not null check(payload_hash ~ '^[0-9a-f]{64}$'),
  source_characters integer not null check(source_characters between 1 and 10000),
  created_at timestamptz not null default clock_timestamp(),
  primary key(user_id,original_request_id),
  unique(user_id,repair_request_id),
  check(original_request_id<>repair_request_id),
  foreign key(user_id,original_request_id) references translator_private.translation_requests(user_id,request_id) on delete cascade,
  foreign key(user_id,repair_request_id) references translator_private.translation_requests(user_id,request_id) on delete cascade deferrable initially deferred
);
alter table translator_private.translation_repairs enable row level security;
revoke all on translator_private.translation_repairs from public,anon,authenticated,service_role;
grant select,insert on translator_private.translation_repairs to service_role;

create function translator_private.repair_character_contract() returns trigger
language plpgsql security invoker set search_path='' as $$
declare v_repair translator_private.translation_repairs%rowtype;v_original translator_private.translation_requests%rowtype;
begin
  if tg_op='UPDATE' and (old.user_id is distinct from new.user_id or old.request_id is distinct from new.request_id
    or old.payload_hash is distinct from new.payload_hash or old.source_characters is distinct from new.source_characters
    or old.billable_characters is distinct from new.billable_characters) then
    raise exception 'request_id_conflict';
  end if;
  select * into v_repair from translator_private.translation_repairs where user_id=new.user_id and repair_request_id=new.request_id;
  if found then
    select * into strict v_original from translator_private.translation_requests
      where user_id=new.user_id and request_id=v_repair.original_request_id;
    if v_original.state<>'completed' or v_original.billable_characters<>v_original.source_characters
      or v_original.payload_hash<>v_repair.payload_hash or new.payload_hash<>v_repair.payload_hash
      or new.source_characters<>v_repair.source_characters or new.source_characters<>v_original.source_characters
      or (new.billable_characters is not null and new.billable_characters<>0) then raise exception 'request_id_conflict';end if;
    new.billable_characters:=0;
  else
    if new.billable_characters is not null and new.billable_characters<>new.source_characters then raise exception 'invalid_request';end if;
    new.billable_characters:=new.source_characters;
  end if;
  return new;
end;$$;
revoke all on function translator_private.repair_character_contract() from public,anon,authenticated;
grant execute on function translator_private.repair_character_contract() to service_role;
create trigger a_repair_character_contract before insert or update of user_id,request_id,payload_hash,source_characters,billable_characters
  on translator_private.translation_requests for each row execute function translator_private.repair_character_contract();

create function public.begin_translation_repair(p_user_id uuid,p_original_request_id text,p_payload_hash text,
  p_characters integer,p_request_id text,p_claim_token uuid,p_metadata jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_status text;v_original translator_private.translation_requests%rowtype;
  v_repair translator_private.translation_repairs%rowtype;v_request translator_private.translation_requests%rowtype;
  v_key text;
begin
  if p_request_id is null or p_request_id!~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
    or p_original_request_id is null or p_original_request_id!~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
    or p_original_request_id=p_request_id or p_payload_hash is null or p_payload_hash!~'^[0-9a-f]{64}$'
    or p_characters is null or p_characters not between 1 and 10000 or p_claim_token is null
    or jsonb_typeof(p_metadata) is distinct from 'object' or p_metadata->>'metering_version' is distinct from '2' then
    raise exception 'invalid_request';
  end if;
  -- Match the global lock order. Even a zero character balance can repair a
  -- paid result, but account status, concurrency and provider cost limits apply.
  select status into v_status from public.profiles where id=p_user_id for share;
  if v_status is distinct from 'active' then raise exception 'account_disabled';end if;
  perform 1 from public.wallets where user_id=p_user_id for update;
  if not found then raise exception 'request_not_found';end if;
  select * into v_original from translator_private.translation_requests
    where user_id=p_user_id and request_id=p_original_request_id for update;
  if not found then raise exception 'request_not_found';end if;
  if v_original.state<>'completed' or v_original.payload_hash<>p_payload_hash
    or v_original.source_characters<>p_characters or v_original.billable_characters<>p_characters
    or exists(select 1 from translator_private.translation_repairs where user_id=p_user_id and repair_request_id=p_original_request_id)
    or not exists(select 1 from public.character_ledger where user_id=p_user_id and idempotency_key=p_original_request_id
      and type='translation' and characters=-p_characters)
    or not exists(select 1 from public.translation_usage where user_id=p_user_id and request_id=p_original_request_id
      and source_characters=p_characters and not cache_hit) then raise exception 'request_id_conflict';end if;
  foreach v_key in array array['account_id','conversation_id','source_language','target_language'] loop
    if p_metadata->v_key is distinct from v_original.metadata->v_key then raise exception 'request_id_conflict';end if;
  end loop;
  select * into v_repair from translator_private.translation_repairs where user_id=p_user_id and original_request_id=p_original_request_id;
  if found then
    if v_repair.repair_request_id<>p_request_id or v_repair.payload_hash<>p_payload_hash
      or v_repair.source_characters<>p_characters then raise exception 'request_id_conflict';end if;
    -- Never reclaim/re-call an expired repair. It remains a permanent one-shot
    -- tombstone; receipt recording may still arrive later for provider accounting.
    return public.translation_status(p_user_id,p_request_id);
  end if;
  if length(coalesce(v_original.response->>'translation',''))=0 then raise exception 'translation_content_unavailable';end if;
  if exists(select 1 from translator_private.translation_requests where user_id=p_user_id and request_id=p_request_id)
    or exists(select 1 from public.character_ledger where user_id=p_user_id and idempotency_key=p_request_id)
    or exists(select 1 from public.translation_usage where user_id=p_user_id and request_id=p_request_id) then raise exception 'request_id_conflict';end if;
  insert into translator_private.translation_repairs(user_id,original_request_id,repair_request_id,payload_hash,source_characters)
    values(p_user_id,p_original_request_id,p_request_id,p_payload_hash,p_characters);
  -- Insertion executes the SAME provider budget and concurrency trigger as a
  -- normal translation; source_characters is never replaced with zero for cost.
  insert into translator_private.translation_requests(user_id,request_id,payload_hash,source_characters,claim_token,metadata)
    values(p_user_id,p_request_id,p_payload_hash,p_characters,p_claim_token,p_metadata);
  return jsonb_build_object('state','claimed');
end;$$;

create function public.translation_repair_status(p_user_id uuid,p_original_request_id text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_status text;v_id text;v_result jsonb;
begin
  select status into v_status from public.profiles where id=p_user_id for share;
  if v_status is distinct from 'active' then raise exception 'account_disabled';end if;
  select repair_request_id into v_id from translator_private.translation_repairs
    where user_id=p_user_id and original_request_id=p_original_request_id;
  if not found then return jsonb_build_object('state','none');end if;
  v_result:=public.translation_status(p_user_id,v_id);
  return v_result||jsonb_build_object('repairRequestId',v_id,'repairOf',p_original_request_id);
end;$$;
revoke all on function public.begin_translation_repair(uuid,text,text,integer,text,uuid,jsonb),
  public.translation_repair_status(uuid,text) from public,anon,authenticated;
grant execute on function public.begin_translation_repair(uuid,text,text,integer,text,uuid,jsonb),
  public.translation_repair_status(uuid,text) to service_role;

-- Unlike begin_translation/status, this admission read never creates a claim,
-- expires another request, or changes reservations. The trusted Worker must
-- match an original fingerprint even before returning an already faithful
-- paid receipt. A later begin_translation_repair still verifies under locks.
create function public.verify_original_translation(p_user_id uuid,p_request_id text,p_payload_hashes jsonb,p_characters integer)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare v_status text;v_request translator_private.translation_requests%rowtype;
begin
  if p_request_id is null or p_request_id!~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
    or p_characters is null or p_characters not between 1 and 10000
    or jsonb_typeof(p_payload_hashes) is distinct from 'array' then raise exception 'invalid_request';end if;
  if jsonb_array_length(p_payload_hashes) not between 1 and 8
    or exists(select 1 from jsonb_array_elements(p_payload_hashes) as h(value)
      where jsonb_typeof(h.value)<>'string' or (h.value#>>'{}')!~'^[0-9a-f]{64}$') then raise exception 'invalid_request';end if;
  select status into v_status from public.profiles where id=p_user_id;
  if v_status is distinct from 'active' then raise exception 'account_disabled';end if;
  select * into v_request from translator_private.translation_requests where user_id=p_user_id and request_id=p_request_id;
  if not found then raise exception 'request_not_found';end if;
  if v_request.source_characters<>p_characters or not(p_payload_hashes ? v_request.payload_hash) then raise exception 'request_id_conflict';end if;
  return jsonb_build_object('state',v_request.state,'response',v_request.response,'error',v_request.error_code);
end;$$;
revoke all on function public.verify_original_translation(uuid,text,jsonb,integer) from public,anon,authenticated;
grant execute on function public.verify_original_translation(uuid,text,jsonb,integer) to service_role;

-- Every reservation-release path uses customer billable characters, including
-- normal-request expiry sweeps that can encounter a pending zero-debit repair.
create or replace function public.begin_translation(
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
    returning billable_characters
  ) select coalesce(sum(billable_characters), 0) into v_expired from expired;
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

create or replace function public.translation_status(p_user_id uuid, p_request_id text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_request translator_private.translation_requests%rowtype; v_status text;
begin
  select status into v_status from public.profiles where id = p_user_id for share;
  if v_status is distinct from 'active' then raise exception 'account_disabled'; end if;
  perform 1 from public.wallets where user_id = p_user_id for update;
  select * into v_request from translator_private.translation_requests
    where user_id = p_user_id and request_id = p_request_id for update;
  if not found then return jsonb_build_object('state', 'not_found'); end if;
  if v_request.state = 'processing' and v_request.expires_at <= clock_timestamp() then
    update public.wallets set reserved_characters = reserved_characters - v_request.billable_characters where user_id = p_user_id;
    update translator_private.translation_requests set state = 'failed', error_code = 'translation_outcome_unknown', updated_at = clock_timestamp()
      where user_id = p_user_id and request_id = p_request_id returning * into v_request;
  end if;
  return jsonb_build_object('state', v_request.state, 'response', v_request.response,
    'requestId', v_request.request_id, 'sourceCharacters', v_request.source_characters, 'error', v_request.error_code);
end;
$$;

create or replace function public.fail_translation(p_user_id uuid, p_request_id text, p_claim_token uuid, p_error_code text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_request translator_private.translation_requests%rowtype;
  v_code text := case when p_error_code = any(array['provider_auth','provider_quota','provider_model','provider_permission','provider_request','provider_rate_limit','provider_timeout','provider_unavailable','provider_empty','provider_wrong_language','protected_literal_mismatch','provider_not_translation']) then p_error_code else 'translation_failed' end;
begin
  perform 1 from public.profiles where id = p_user_id for share;
  perform 1 from public.wallets where user_id = p_user_id for update;
  select * into v_request from translator_private.translation_requests
  where user_id = p_user_id and request_id = p_request_id for update;
  if not found then raise exception 'request_not_found'; end if;
  if v_request.claim_token is distinct from p_claim_token then raise exception 'request_id_conflict'; end if;
  if v_request.state = 'processing' then
    update public.wallets set reserved_characters = reserved_characters - v_request.billable_characters where user_id = p_user_id;
    update translator_private.translation_requests set state = 'failed', error_code = v_code, updated_at = clock_timestamp()
    where user_id = p_user_id and request_id = p_request_id;
    return jsonb_build_object('state', 'failed', 'error', v_code);
  end if;
  return jsonb_build_object('state', v_request.state, 'response', v_request.response, 'error', v_request.error_code);
end;
$$;

create or replace function public.complete_translation(
  p_user_id uuid, p_request_id text, p_claim_token uuid,
  p_translation text, p_model text, p_latency_ms integer
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_status text;
  v_request translator_private.translation_requests%rowtype;
  v_balance bigint;
  v_response jsonb;
  v_error text;
  v_original_id text;
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
    update public.wallets set reserved_characters = reserved_characters - v_request.billable_characters where user_id = p_user_id;
    update translator_private.translation_requests set state = 'failed', error_code = v_error, updated_at = clock_timestamp()
    where user_id = p_user_id and request_id = p_request_id;
    return jsonb_build_object('state', 'failed', 'error', v_error);
  end if;
  if p_translation is null or length(trim(p_translation)) = 0 or length(p_translation) > 100000
     or p_model is null or p_latency_ms is null or p_latency_ms < 0 then
    raise exception 'invalid_request';
  end if;
  if v_request.metadata->>'metering_version'='2' and coalesce(v_request.metadata->>'selected_provider','') not in ('openai','deepseek') then raise exception 'invalid_request';end if;
  if v_request.billable_characters=0 then
    select original_request_id into strict v_original_id from translator_private.translation_repairs
      where user_id=p_user_id and repair_request_id=p_request_id;
    select balance into v_balance from public.wallets where user_id=p_user_id;
    v_response:=jsonb_build_object('requestId',v_original_id,'translation',p_translation,
      'sourceCharacters',v_request.source_characters,'chargedCharacters',0,'balanceAfter',v_balance,
      'latencyMs',p_latency_ms,'model',p_model,'repairRequestId',p_request_id,'repairOf',v_original_id);
    update translator_private.translation_requests set state='completed',response=v_response,updated_at=clock_timestamp()
      where user_id=p_user_id and request_id=p_request_id;
    return jsonb_build_object('state','completed','response',v_response);
  end if;
  update public.wallets set balance = balance - v_request.source_characters,
    reserved_characters = reserved_characters - v_request.billable_characters,
    lifetime_debited = lifetime_debited + v_request.source_characters
  where user_id = p_user_id returning balance into v_balance;

  insert into public.character_ledger(user_id, type, characters, balance_after, idempotency_key, source, note, metadata)
  values (p_user_id, 'translation', -v_request.source_characters, v_balance, p_request_id,
          'cloudflare-translate', '实时翻译', v_request.metadata || jsonb_build_object('model', p_model));
  insert into public.translation_usage(user_id, request_id, account_id, conversation_id, provider, model,
    source_language, target_language, source_characters, cache_hit, latency_ms)
  values (p_user_id, p_request_id, v_request.metadata->>'account_id', v_request.metadata->>'conversation_id',
    case when v_request.metadata->>'metering_version'='2' then v_request.metadata->>'selected_provider' when v_request.metadata->>'provider' = 'deepseek' then 'deepseek' else 'openai' end, p_model, v_request.metadata->>'source_language', v_request.metadata->>'target_language',
    v_request.source_characters, false, p_latency_ms);

  v_response := jsonb_build_object('requestId', p_request_id, 'translation', p_translation,
    'sourceCharacters', v_request.source_characters, 'balanceAfter', v_balance,
    'latencyMs', p_latency_ms, 'model', p_model);
  update translator_private.translation_requests set state = 'completed', response = v_response, updated_at = clock_timestamp()
  where user_id = p_user_id and request_id = p_request_id;
  return jsonb_build_object('state', 'completed', 'response', v_response);
end;
$$;

create or replace view translator_private.admin_translation_rows with (security_invoker=true) as
with debits as (
  select user_id, idempotency_key as request_id, count(*) as debit_count,
    -sum(characters) as charged, min(id::text) as ledger_id, max(created_at) as created_at
  from public.character_ledger where type='translation' group by user_id,idempotency_key
), rows as (
  select coalesce(r.user_id,u.user_id,d.user_id) as user_id,
    coalesce(r.request_id,u.request_id,d.request_id) as request_id,
    coalesce(r.source_characters,u.source_characters) as source_characters,
    u.source_characters as usage_characters, coalesce(u.cache_hit,false) as cache_hit,
    coalesce(r.state,case when u.id is not null then 'completed' else 'unknown' end) as state,
    case when r.error_code ~ '^[a-z_]{1,64}$' then r.error_code else null end as error_code,
    u.provider,u.model,u.source_language,u.target_language,u.latency_ms,
    coalesce(d.charged,0) as charged, coalesce(d.debit_count,0) as debit_count, d.ledger_id,
    r.expires_at, coalesce(r.created_at,u.created_at,d.created_at) as created_at,
    case when r.state in ('processing','failed') and coalesce(d.charged,0)<>0 then 'mismatch'
      when r.state='processing' then 'pending'
      when r.state='failed' and coalesce(d.charged,0)=0 then 'not_charged'
      when r.state='completed' and r.billable_characters=0 and coalesce(d.charged,0)=0
        and exists(select 1 from translator_private.translation_repairs x where x.user_id=r.user_id and x.repair_request_id=r.request_id) then 'free'
      when u.cache_hit and coalesce(d.charged,0)=0 then 'cache'
      when u.source_characters=0 and coalesce(d.charged,0)=0 then 'free'
      when coalesce(d.debit_count,0)=1 and u.source_characters=d.charged
        and coalesce(r.source_characters,u.source_characters)=d.charged
        and coalesce(r.state,'completed')='completed' then 'matched'
      else 'mismatch' end as reconciliation
  from translator_private.translation_requests r
  full join public.translation_usage u on u.user_id=r.user_id and u.request_id=r.request_id
  full join debits d on d.user_id=coalesce(r.user_id,u.user_id) and d.request_id=coalesce(r.request_id,u.request_id)
)
select rows.*,p.email,p.username,
  coalesce((select sum(l.characters) from public.character_ledger l where l.user_id=rows.user_id
    and l.type='refund' and l.metadata->>'original_ledger_id'=rows.ledger_id),0) as refunded
from rows join public.profiles p on p.id=rows.user_id;
