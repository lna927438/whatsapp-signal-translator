-- A translation keeps one character debit while every provider attempt keeps
-- its own receipt. Unknown provider charges retain their conservative budget.
-- Existing v1 receipts, APIs and grants remain available during rolling deploys.
alter function translator_private.translation_cost_bound(jsonb,integer,numeric,numeric,timestamptz)
  rename to translation_cost_bound_v1;
create function translator_private.provider_attempt_cost_bound(p_metadata jsonb,p_characters integer,
  p_input_upper numeric,p_output_upper numeric,p_at timestamptz,p_provider text,p_model text)
returns numeric language plpgsql immutable security invoker set search_path='' as $$
declare v_input integer; v_output integer;
begin
  v_input:=coalesce((p_metadata->>'security_input_token_bound')::integer,p_characters*4+16000);
  v_output:=coalesce((p_metadata->>'security_output_token_bound')::integer,16384);
  if v_input not between 1 and 262144 or v_output not between 1 and 16384 then raise exception 'invalid_request';end if;
  -- Default-tier Luna: cache writes cost more than uncached input. Reserve that
  -- larger rate for ALL input, plus the full output cap, never cached discounts.
  if p_provider='openai' and p_model='gpt-5.6-luna' then
    return (v_input*0.25+v_output*1.20)/1000000;
  end if;
  return translator_private.translation_cost_bound_v1(p_metadata||jsonb_build_object(
    'metering_version','1','provider',p_provider,'requested_model',p_model),p_characters,p_input_upper,p_output_upper,p_at);
end;$$;

create function translator_private.translation_cost_bound(p_metadata jsonb,p_characters integer,
  p_input_upper numeric,p_output_upper numeric,p_at timestamptz)
returns numeric language plpgsql immutable security invoker set search_path='' as $$
declare v_plan jsonb; v_item jsonb; v_seen text[]:='{}'; v_sum numeric:=0;
begin
  if p_metadata->>'metering_version' is distinct from '2' then
    return translator_private.translation_cost_bound_v1(p_metadata,p_characters,p_input_upper,p_output_upper,p_at);
  end if;
  v_plan:=p_metadata->'provider_plan';
  if jsonb_typeof(v_plan) is distinct from 'array' or jsonb_array_length(v_plan) not between 1 and 2 then raise exception 'invalid_request';end if;
  if p_metadata->>'provider' is distinct from v_plan->0->>'provider'
    or p_metadata->>'requested_model' is distinct from v_plan->0->>'model' then raise exception 'invalid_request';end if;
  for v_item in select value from jsonb_array_elements(v_plan) loop
    if jsonb_typeof(v_item) is distinct from 'object' or v_item->>'provider' is null
      or v_item->>'provider' not in ('openai','deepseek') or (v_item->>'provider')=any(v_seen)
      or coalesce(v_item->>'model','')!~'^[A-Za-z0-9_.:/-]{1,200}$' then raise exception 'invalid_request';end if;
    v_seen:=array_append(v_seen,v_item->>'provider');
    v_sum:=v_sum+translator_private.provider_attempt_cost_bound(p_metadata,p_characters,p_input_upper,p_output_upper,p_at,v_item->>'provider',v_item->>'model');
  end loop;
  return v_sum;
end;$$;
revoke all on function translator_private.provider_attempt_cost_bound(jsonb,integer,numeric,numeric,timestamptz,text,text),
  translator_private.translation_cost_bound(jsonb,integer,numeric,numeric,timestamptz) from public,anon,authenticated;
grant execute on function translator_private.provider_attempt_cost_bound(jsonb,integer,numeric,numeric,timestamptz,text,text),
  translator_private.translation_cost_bound(jsonb,integer,numeric,numeric,timestamptz) to service_role;

alter table translator_private.provider_usage add column budget_cost_usd numeric(22,12) check(budget_cost_usd>=0);
create table translator_private.provider_attempt_usage (
  user_id uuid not null, request_id text not null, attempt_index smallint not null check(attempt_index between 1 and 2),
  provider text not null check(provider in ('openai','deepseek')), model text not null,
  started_at timestamptz not null, finished_at timestamptz not null, error_code text,
  receipt jsonb not null, http_status integer,
  input_tokens bigint, cached_tokens bigint, cache_write_tokens bigint, output_tokens bigint, total_tokens bigint, reasoning_tokens bigint,
  cost_status text not null, cost_usd numeric(22,12), maximum_usd numeric(22,12) not null,
  price_version text, price_period text, price_time_source text,
  input_rate numeric(14,6), cached_rate numeric(14,6), cache_write_rate numeric(14,6), output_rate numeric(14,6),
  primary key(user_id,request_id,attempt_index), unique(user_id,request_id,provider),
  foreign key(user_id,request_id) references translator_private.provider_usage(user_id,request_id) on delete cascade,
  check(finished_at>=started_at), check(cost_usd>=0 and maximum_usd>=0),
  check(input_tokens>=0 and cached_tokens>=0 and cache_write_tokens>=0 and output_tokens>=0),
  check(cached_tokens<=input_tokens and coalesce(cached_tokens,0)+coalesce(cache_write_tokens,0)<=input_tokens),
  check(reasoning_tokens>=0 and reasoning_tokens<=output_tokens)
);
create index provider_attempt_usage_time_idx on translator_private.provider_attempt_usage(provider,started_at);
alter table translator_private.provider_attempt_usage enable row level security;
revoke all on translator_private.provider_attempt_usage from public,anon,authenticated;
grant select,insert on translator_private.provider_attempt_usage to service_role;

create or replace function translator_private.start_provider_usage() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if new.metadata->>'metering_version' in ('1','2') then
    insert into translator_private.provider_usage(user_id,request_id,claim_token,provider,model)
      values(new.user_id,new.request_id,new.claim_token,new.metadata->>'provider',new.metadata->>'requested_model');
  end if;
  return new;
end;$$;

alter function translator_private.record_provider_usage(uuid,text,uuid,jsonb) rename to record_provider_usage_v1;
create function translator_private.record_provider_usage(p_user_id uuid,p_request_id text,p_claim_token uuid,p_receipt jsonb)
returns void language plpgsql security invoker set search_path='' as $$
declare v_request translator_private.translation_requests%rowtype; v_parent translator_private.provider_usage%rowtype;
  v_policy translator_private.security_policy%rowtype; v translator_private.provider_attempt_usage%rowtype;
  v_item jsonb; v_raw jsonb; v_plan jsonb; v_key text; v_count bigint; v_position integer; v_previous integer:=0;
  v_index integer:=0; v_selected text; v_at timestamptz; v_factor integer; v_all_exact boolean:=true;
  v_total numeric:=0; v_upper numeric:=0; v_input bigint:=0; v_cached bigint:=0; v_output bigint:=0; v_tokens bigint:=0; v_reasoning bigint:=0;
  v_n integer; v_last_end timestamptz;
begin
  select * into v_request from translator_private.translation_requests where user_id=p_user_id and request_id=p_request_id;
  if v_request.metadata->>'metering_version' is distinct from '2' then
    perform translator_private.record_provider_usage_v1(p_user_id,p_request_id,p_claim_token,p_receipt);return;
  end if;
  -- Match translation RPC lock order before taking the provider ledger lock.
  perform 1 from public.profiles where id=p_user_id for share;
  perform 1 from public.wallets where user_id=p_user_id for update;
  select * into v_request from translator_private.translation_requests where user_id=p_user_id and request_id=p_request_id for update;
  select * into v_parent from translator_private.provider_usage where user_id=p_user_id and request_id=p_request_id for update;
  if not found or v_parent.claim_token is distinct from p_claim_token or v_request.claim_token is distinct from p_claim_token then raise exception 'request_id_conflict';end if;
  if v_parent.recorded_at is not null then
    if v_parent.receipt is distinct from p_receipt then raise exception 'operation_conflict';end if;return;
  end if;
  if jsonb_typeof(p_receipt) is distinct from 'object' or p_receipt->>'version' is distinct from '2'
    or octet_length(p_receipt::text)>12288 or jsonb_typeof(p_receipt->'attempts') is distinct from 'array'
    or not(p_receipt ? 'selectedProvider') then raise exception 'invalid_request';end if;
  v_n:=jsonb_array_length(p_receipt->'attempts');v_selected:=p_receipt->>'selectedProvider';
  if v_n>2 or (v_selected is not null and v_selected not in ('openai','deepseek')) then raise exception 'invalid_request';end if;
  v_plan:=v_request.metadata->'provider_plan';
  select * into strict v_policy from translator_private.security_policy where singleton;
  for v_item in select value from jsonb_array_elements(p_receipt->'attempts') loop
    v_index:=v_index+1;v:=null;v_at:=null;
    if jsonb_typeof(v_item) is distinct from 'object' or coalesce(v_item->>'model','')!~'^[A-Za-z0-9_.:/-]{1,200}$'
      or not(v_item ? 'errorCode') or (v_item->>'errorCode' is not null and v_item->>'errorCode'!~'^[a-z][a-z0-9_]{0,79}$') then raise exception 'invalid_request';end if;
    select ordinal::integer into v_position from jsonb_array_elements(v_plan) with ordinality p(item,ordinal)
      where item->>'provider'=v_item->>'provider' and item->>'model'=v_item->>'model';
    if v_position is null or v_position<=v_previous then raise exception 'invalid_request';end if;v_previous:=v_position;
    v.user_id:=p_user_id;v.request_id:=p_request_id;v.attempt_index:=v_index;
    v.provider:=v_item->>'provider';v.model:=v_item->>'model';v.error_code:=v_item->>'errorCode';
    v.started_at:=(v_item->>'startedAt')::timestamptz;v.finished_at:=(v_item->>'finishedAt')::timestamptz;
    if v.started_at is null or v.finished_at is null or v.started_at<v_request.created_at-interval '1 minute'
      or v.finished_at<v.started_at or v.finished_at>clock_timestamp()+interval '1 minute'
      or (v_last_end is not null and v.started_at<v_last_end) then raise exception 'invalid_request';end if;
    v_last_end:=v.finished_at;
    if (v.error_code is null) is distinct from (v_selected=v.provider and v_index=v_n) then
      -- Every attempt except the selected final one must have a failure code.
      if v.error_code is null or v_selected=v.provider then raise exception 'invalid_request';end if;
    end if;
    v_raw:=v_item->'receipt';
    if jsonb_typeof(v_raw) is distinct from 'object' or octet_length(v_raw::text)>4096 then raise exception 'invalid_request';end if;
    v.receipt:=v_raw;
    foreach v_key in array array['inputTokens','cachedTokens','cacheWriteTokens','outputTokens','totalTokens','reasoningTokens'] loop
      if v_raw->>v_key is not null then
        if jsonb_typeof(v_raw->v_key)<>'number' or (v_raw->>v_key)!~'^\d{1,9}$' then raise exception 'invalid_request';end if;
        v_count:=(v_raw->>v_key)::bigint;if v_count>100000000 then raise exception 'invalid_request';end if;
      end if;
    end loop;
    v.model:=coalesce(v_raw->>'model',v.model);
    if v.model!~'^[A-Za-z0-9_.:/-]{1,200}$' then raise exception 'invalid_request';end if;
    v.http_status:=(v_raw->>'httpStatus')::integer;
    if v.http_status is not null and v.http_status not between 100 and 599 then raise exception 'invalid_request';end if;
    if v.error_code is null and (v.http_status is null or v.http_status not between 200 and 299) then raise exception 'invalid_request';end if;
    v.input_tokens:=(v_raw->>'inputTokens')::bigint;v.cached_tokens:=(v_raw->>'cachedTokens')::bigint;
    v.cache_write_tokens:=(v_raw->>'cacheWriteTokens')::bigint;v.output_tokens:=(v_raw->>'outputTokens')::bigint;
    v.total_tokens:=(v_raw->>'totalTokens')::bigint;v.reasoning_tokens:=(v_raw->>'reasoningTokens')::bigint;
    if v.cached_tokens>v.input_tokens or coalesce(v.cached_tokens,0)+coalesce(v.cache_write_tokens,0)>v.input_tokens
      or v.reasoning_tokens>v.output_tokens then raise exception 'invalid_request';end if;
    v.maximum_usd:=translator_private.provider_attempt_cost_bound(v_request.metadata,v_request.source_characters,
      v_policy.input_upper_usd_per_million,v_policy.output_upper_usd_per_million,v_request.created_at,v.provider,v_item->>'model');
    v.cost_status:=case when v.http_status is null then 'unknown_response' else 'missing_usage' end;
    if v.input_tokens is not null and v.output_tokens is not null and v.total_tokens=v.input_tokens+v.output_tokens then
      if v.cached_tokens is null then v.cost_status:='missing_cache';
      elsif v.provider='openai' and v.model='gpt-5.6-luna' then
        if v.cache_write_tokens is null then v.cost_status:='missing_cache_write';
        elsif v_raw->>'serviceTier' is distinct from 'default' then v.cost_status:='unknown_service_tier';
        elsif v.input_tokens>262144 then v.cost_status:='unknown_price';
        else
          v.price_version:='openai-luna-usd-2026-09-15';v.price_period:='default';v.price_time_source:='fixed';
          v.input_rate:=0.20;v.cached_rate:=0.02;v.cache_write_rate:=0.25;v.output_rate:=1.20;
          v.cost_usd:=((v.input_tokens-v.cached_tokens-v.cache_write_tokens)*v.input_rate+
            v.cached_tokens*v.cached_rate+v.cache_write_tokens*v.cache_write_rate+v.output_tokens*v.output_rate)/1000000;
          v.cost_status:='calculated';
        end if;
      elsif v.provider='deepseek' and v.model in ('deepseek-flash','deepseek-v4-flash','deepseek-v4-flash-vision-exp','deepseek-v4-pro') then
        v_at:=(v_raw->>'createdAt')::timestamptz;
        if v_at between v.started_at-interval '1 minute' and v.finished_at+interval '1 minute' then v.price_time_source:='provider';
        elsif v.finished_at-v.started_at<interval '10 minutes' and translator_private.deepseek_peak(v.started_at)=translator_private.deepseek_peak(v.finished_at) then
          v_at:=v.started_at;v.price_time_source:='request_window';
        else v_at:=null;end if;
        if v_at is null then v.cost_status:='unknown_time';
        else
          v_factor:=case when translator_private.deepseek_peak(v_at) then 2 else 1 end;
          v.price_period:=case when v_factor=2 then 'peak' else 'off_peak' end;v.price_version:='deepseek-usd-2026-09-12';
          if v.model='deepseek-v4-pro' then v.cached_rate:=0.022*v_factor;v.input_rate:=0.66*v_factor;v.output_rate:=1.98*v_factor;
          else v.cached_rate:=0.003*v_factor;v.input_rate:=0.15*v_factor;v.output_rate:=0.60*v_factor;end if;
          v.cost_usd:=((v.input_tokens-v.cached_tokens)*v.input_rate+v.cached_tokens*v.cached_rate+v.output_tokens*v.output_rate)/1000000;
          v.cost_status:='calculated';
        end if;
      else v.cost_status:='unknown_price';end if;
    end if;
    insert into translator_private.provider_attempt_usage select v.*;
    if v.cost_usd is null then v_all_exact:=false;end if;
    v_total:=v_total+coalesce(v.cost_usd,0);v_upper:=v_upper+coalesce(v.cost_usd,v.maximum_usd);
    v_input:=v_input+v.input_tokens;v_cached:=v_cached+v.cached_tokens;v_output:=v_output+v.output_tokens;
    v_tokens:=v_tokens+v.total_tokens;v_reasoning:=v_reasoning+v.reasoning_tokens;
  end loop;
  if v_selected is not null and (v_n=0 or v.provider is distinct from v_selected or v.error_code is not null) then raise exception 'invalid_request';end if;
  if v_n=0 then
    -- The immutable envelope confirms that no inference was attempted. All
    -- provider token totals and cost are known zero, so release its budget.
    v_all_exact:=true;v_total:=0;v_upper:=0;
    v_input:=0;v_cached:=0;v_output:=0;v_tokens:=0;v_reasoning:=0;
  else
    select greatest(v_upper,maximum_usd) into v_upper from translator_private.cost_reservations where user_id=p_user_id and request_id=p_request_id;
  end if;
  update translator_private.provider_usage set recorded_at=clock_timestamp(),receipt=p_receipt,
    provider=case when v_n>1 then 'mixed' when v_n=1 then v.provider else provider end,
    model=case when v_n>1 then 'multiple' when v_n=1 then v.model else model end,
    input_tokens=v_input,cached_tokens=v_cached,output_tokens=v_output,total_tokens=v_tokens,reasoning_tokens=v_reasoning,
    http_status=case when v_n=1 then v.http_status else null end,
    cost_status=case when v_n=0 then 'not_attempted' when v_all_exact then 'calculated' else 'unknown_attempt_cost' end,
    cost_usd=case when v_all_exact then v_total else null end,budget_cost_usd=v_upper
    where user_id=p_user_id and request_id=p_request_id;
  update translator_private.translation_requests set metadata=metadata||jsonb_build_object('selected_provider',v_selected)
    where user_id=p_user_id and request_id=p_request_id;
end;$$;
revoke all on function translator_private.record_provider_usage(uuid,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function translator_private.record_provider_usage(uuid,text,uuid,jsonb) to service_role;

create or replace function public.complete_translation_metered(p_user_id uuid,p_request_id text,p_claim_token uuid,p_translation text,p_model text,p_latency_ms integer,p_receipt jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
begin
  if p_receipt->>'version'='2' and (p_receipt->>'selectedProvider' is null
    or p_model is distinct from coalesce(p_receipt->'attempts'->-1->'receipt'->>'model',p_receipt->'attempts'->-1->>'model')) then raise exception 'invalid_request';end if;
  perform translator_private.record_provider_usage(p_user_id,p_request_id,p_claim_token,p_receipt);
  return public.complete_translation(p_user_id,p_request_id,p_claim_token,p_translation,p_model,p_latency_ms);
end;$$;
create or replace function public.fail_translation_metered(p_user_id uuid,p_request_id text,p_claim_token uuid,p_error_code text,p_receipt jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
begin
  if p_receipt->>'version'='2' and p_receipt->>'selectedProvider' is not null then raise exception 'invalid_request';end if;
  perform translator_private.record_provider_usage(p_user_id,p_request_id,p_claim_token,p_receipt);
  return public.fail_translation(p_user_id,p_request_id,p_claim_token,p_error_code);
end;$$;
-- Attribute new usage to the server-selected provider. Preserve legacy OpenAI claims.
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
  if v_request.metadata->>'metering_version'='2' and coalesce(v_request.metadata->>'selected_provider','') not in ('openai','deepseek') then raise exception 'invalid_request';end if;
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

revoke all on function public.complete_translation(uuid,text,uuid,text,text,integer) from public, anon, authenticated;
grant execute on function public.complete_translation(uuid,text,uuid,text,text,integer) to service_role;

create or replace function translator_private.guard_translation_cost() returns trigger
language plpgsql security invoker set search_path='' as $$
declare v_policy translator_private.security_policy%rowtype; v_user numeric; v_global numeric; v_reserve numeric;
  v_day timestamptz=date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC';
begin
  select * into strict v_policy from translator_private.security_policy where singleton for update;
  if not v_policy.enabled then raise exception 'security_paused'; end if;
  if (select count(*) from translator_private.translation_requests where user_id=new.user_id and created_at>clock_timestamp()-interval '1 minute')>=v_policy.user_requests_per_minute
    or (select count(*) from translator_private.translation_requests where user_id=new.user_id and state='processing' and expires_at>clock_timestamp())>=v_policy.user_concurrency then raise exception 'rate_limited'; end if;
  v_reserve:=translator_private.translation_cost_bound(new.metadata,new.source_characters,
    v_policy.input_upper_usd_per_million,v_policy.output_upper_usd_per_million,new.created_at);
  select coalesce(sum(coalesce(u.cost_usd,u.budget_cost_usd,r.maximum_usd)) filter(where r.user_id=new.user_id),0),coalesce(sum(coalesce(u.cost_usd,u.budget_cost_usd,r.maximum_usd)),0)
  into v_user,v_global from translator_private.cost_reservations r left join translator_private.provider_usage u using(user_id,request_id) where r.created_at>=v_day;
  select v_user+coalesce(sum(coalesce(u.cost_usd,u.budget_cost_usd,1)) filter(where u.user_id=new.user_id),0),v_global+coalesce(sum(coalesce(u.cost_usd,u.budget_cost_usd,1)),0)
  into v_user,v_global from translator_private.provider_usage u where u.started_at>=v_day
    and not exists(select 1 from translator_private.cost_reservations r where r.user_id=u.user_id and r.request_id=u.request_id);
  if v_user+v_reserve>v_policy.user_daily_usd or v_global+v_reserve>v_policy.global_daily_usd then raise exception 'cost_limit'; end if;
  insert into translator_private.cost_reservations(user_id,request_id,maximum_usd) values(new.user_id,new.request_id,v_reserve);
  return new;
end; $$;

-- Keep the existing admin response shape, and name each actual rate source.
-- The legacy scalar remains a URL for clients that only render one link.
alter function translator_private.admin_cost_summary(jsonb) rename to admin_cost_summary_v1;
create function translator_private.admin_cost_summary(p_filter jsonb) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare v_result jsonb;
begin
  v_result:=translator_private.admin_cost_summary_v1(p_filter);
  return v_result||jsonb_build_object(
    'pricingSource',case when p_filter->>'provider'='deepseek' then 'https://api-docs.deepseek.com/quick_start/pricing/' else 'https://developers.openai.com/api/docs/pricing' end,
    'priceVersion','provider-attempts-usd-2026-09-15',
    'pricingSources',jsonb_build_array(
      jsonb_build_object('provider','openai','url','https://developers.openai.com/api/docs/pricing','priceVersion','openai-luna-usd-2026-09-15'),
      jsonb_build_object('provider','deepseek','url','https://api-docs.deepseek.com/quick_start/pricing/','priceVersion','deepseek-usd-2026-09-12')));
end;$$;
revoke all on function translator_private.admin_cost_summary(jsonb) from public,anon,authenticated;
grant execute on function translator_private.admin_cost_summary(jsonb) to service_role;



-- A known zero-call outcome is priced, but is not a metered inference.
create or replace function translator_private.admin_cost_summary_v1(p_filter jsonb) returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare v_from timestamptz;v_to timestamptz;v_user uuid;v_provider text;v_result jsonb;
begin
  v_from:=coalesce(nullif(p_filter->>'from','')::date,date '2026-01-01')::timestamp at time zone 'Asia/Shanghai';
  v_to:=(coalesce(nullif(p_filter->>'to','')::date,(now() at time zone 'Asia/Shanghai')::date)+1)::timestamp at time zone 'Asia/Shanghai';
  if v_to<=v_from or v_to-v_from>interval '3660 days' then raise exception 'invalid_request';end if;
  v_user:=nullif(p_filter->>'userId','')::uuid;v_provider:=nullif(p_filter->>'provider','');
  with filtered as (select c.* from translator_private.admin_cost_rows c
    where c.created_at>=v_from and c.created_at<v_to and (v_user is null or c.user_id=v_user)
      and (v_provider is null or c.cost_provider=v_provider)),
  totals as (select count(*) as requests,coalesce(sum(charged),0) as charged_characters,coalesce(sum(refunded),0) as refunded_characters,
    sum(source_characters) as source_characters,sum(total_tokens) as total_tokens,sum(input_tokens) as input_tokens,
    sum(cached_tokens) as cached_tokens,sum(output_tokens) as output_tokens,sum(cost_usd) as cost_usd,
    count(*) filter(where cost_status in ('calculated','not_attempted')) as priced_requests,
    count(*) filter(where cost_status not in ('calculated','not_attempted')) as unpriced_requests,
    count(*) filter(where cost_status='historical_unavailable') as historical_requests,
    count(*) filter(where total_tokens is not null and cost_status<>'not_attempted') as metered_requests,
    count(*) filter(where reconciliation='mismatch') as mismatches,
    count(*) filter(where charged=0 and cost_usd>0) as provider_only_requests from filtered),
  by_user as (select user_id,email,count(*) as requests,sum(charged) as charged_characters,sum(total_tokens) as total_tokens,
    sum(cost_usd) as cost_usd,count(*) filter(where cost_status not in ('calculated','not_attempted')) as unpriced_requests,
    sum(charged) filter(where cost_status in ('calculated','not_attempted') and charged>0) as priced_characters,
    sum(cost_usd) filter(where cost_status in ('calculated','not_attempted') and charged>0) as priced_character_cost
    from filtered group by user_id,email),
  by_day as (select (created_at at time zone 'Asia/Shanghai')::date as day,count(*) as requests,sum(charged) as charged_characters,
    sum(total_tokens) as total_tokens,sum(cost_usd) as cost_usd,count(*) filter(where cost_status not in ('calculated','not_attempted')) as unpriced_requests
    from filtered group by 1)
  select jsonb_build_object('totals',(select to_jsonb(t) from totals t),'users',(select coalesce(jsonb_agg(u order by email),'[]') from by_user u),
    'days',(select coalesce(jsonb_agg(d order by day desc),'[]') from by_day d),'from',v_from,'toExclusive',v_to,'snapshotAt',clock_timestamp(),
    'pricingSource','https://api-docs.deepseek.com/quick_start/pricing/','priceVersion','deepseek-usd-2026-09-12') into v_result;
  return v_result;
end;$$;
revoke all on function translator_private.admin_cost_summary_v1(jsonb) from public,anon,authenticated;
grant execute on function translator_private.admin_cost_summary_v1(jsonb) to service_role;
