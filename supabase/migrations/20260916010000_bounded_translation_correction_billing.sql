-- One bounded DeepSeek correction after a complete but invalid result.
-- Old claims without provider_correction keep their two-attempt contract.
-- Immutable old receipts and customer balances are not rewritten.
create function translator_private.has_provider_correction(p_metadata jsonb) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
begin
 if not(p_metadata ? 'provider_correction') then return false;end if;
 if p_metadata->>'metering_version' is distinct from '2'
  or p_metadata->'provider_correction' is distinct from
    '{"provider":"deepseek","model":"deepseek-v4-pro","maxAttempts":1}'::jsonb
  or (p_metadata->'provider_plan' is distinct from
    '[{"provider":"openai","model":"gpt-5.6-luna"},{"provider":"deepseek","model":"deepseek-v4-pro"}]'::jsonb
    and p_metadata->'provider_plan' is distinct from '[{"provider":"deepseek","model":"deepseek-v4-pro"}]'::jsonb)
  then raise exception 'invalid_request';end if;
 return true;
end;$$;
revoke all on function translator_private.has_provider_correction(jsonb) from public,anon,authenticated;
grant execute on function translator_private.has_provider_correction(jsonb) to service_role;

alter function translator_private.translation_cost_bound(jsonb,integer,numeric,numeric,timestamptz)
 rename to translation_cost_bound_v2;
create function translator_private.translation_cost_bound(p_metadata jsonb,p_characters integer,
 p_input_upper numeric,p_output_upper numeric,p_at timestamptz)
returns numeric language plpgsql immutable security invoker set search_path='' as $$
declare v_correction boolean;v_bound numeric;
begin
 v_correction:=translator_private.has_provider_correction(p_metadata);
 v_bound:=translator_private.translation_cost_bound_v2(p_metadata,p_characters,p_input_upper,p_output_upper,p_at);
 if v_correction then
  v_bound:=v_bound+translator_private.provider_attempt_cost_bound(p_metadata,p_characters,p_input_upper,p_output_upper,p_at,'deepseek','deepseek-v4-pro');
 end if;
 return v_bound;
end;$$;
revoke all on function translator_private.translation_cost_bound(jsonb,integer,numeric,numeric,timestamptz) from public,anon,authenticated;
grant execute on function translator_private.translation_cost_bound(jsonb,integer,numeric,numeric,timestamptz) to service_role;

alter table translator_private.provider_attempt_usage
 drop constraint provider_attempt_usage_attempt_index_check,
 drop constraint provider_attempt_usage_user_id_request_id_provider_key,
 add column correction boolean not null default false,
 add constraint provider_attempt_usage_attempt_index_check check(attempt_index between 1 and 3),
 add constraint provider_attempt_usage_correction_check check(not correction or(provider='deepseek' and attempt_index>=2)),
 add constraint provider_attempt_usage_provider_kind_key unique(user_id,request_id,provider,correction);

create or replace function translator_private.record_provider_usage(p_user_id uuid,p_request_id text,p_claim_token uuid,p_receipt jsonb)
returns void language plpgsql security invoker set search_path='' as $$
declare v_request translator_private.translation_requests%rowtype; v_parent translator_private.provider_usage%rowtype;
  v_policy translator_private.security_policy%rowtype; v translator_private.provider_attempt_usage%rowtype;
  v_item jsonb; v_raw jsonb; v_plan jsonb; v_key text; v_count bigint; v_position integer; v_previous integer:=0;
  v_index integer:=0; v_selected text; v_at timestamptz; v_factor integer; v_all_exact boolean:=true;
  v_total numeric:=0; v_upper numeric:=0; v_input bigint:=0; v_cached bigint:=0; v_output bigint:=0; v_tokens bigint:=0; v_reasoning bigint:=0;
  v_n integer; v_last_end timestamptz; v_prior translator_private.provider_attempt_usage%rowtype;
  v_correction_allowed boolean;v_correction_used boolean:=false;v_first_provider text;v_mixed boolean:=false;
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
  v_correction_allowed:=translator_private.has_provider_correction(v_request.metadata);
  if jsonb_typeof(p_receipt) is distinct from 'object' or p_receipt->>'version' is distinct from '2'
    or octet_length(p_receipt::text)>(case when v_correction_allowed then 16384 else 12288 end) or jsonb_typeof(p_receipt->'attempts') is distinct from 'array'
    or not(p_receipt ? 'selectedProvider') then raise exception 'invalid_request';end if;
  v_n:=jsonb_array_length(p_receipt->'attempts');v_selected:=p_receipt->>'selectedProvider';
  if v_n>(case when v_correction_allowed then 3 else 2 end) or (v_selected is not null and v_selected not in ('openai','deepseek')) then raise exception 'invalid_request';end if;
  v_plan:=v_request.metadata->'provider_plan';
  select * into strict v_policy from translator_private.security_policy where singleton;
  for v_item in select value from jsonb_array_elements(p_receipt->'attempts') loop
    v_index:=v_index+1;v_prior:=v;v:=null;v_at:=null;
    if jsonb_typeof(v_item) is distinct from 'object' or coalesce(v_item->>'model','')!~'^[A-Za-z0-9_.:/-]{1,200}$'
      or not(v_item ? 'errorCode') or (v_item->>'errorCode' is not null and v_item->>'errorCode'!~'^[a-z][a-z0-9_]{0,79}$') then raise exception 'invalid_request';end if;
    select ordinal::integer into v_position from jsonb_array_elements(v_plan) with ordinality p(item,ordinal)
      where item->>'provider'=v_item->>'provider' and item->>'model'=v_item->>'model';
    if v_position is null then raise exception 'invalid_request';end if;
    v.correction:=coalesce(v_item->'correction'='true'::jsonb,false);
    if v_item ? 'correction' and not v.correction then raise exception 'invalid_request';end if;
    if v.correction then
      -- Only a complete, explicitly invalid response authorizes the one final
      -- correction. Network/HTTP/auth/empty/unknown failures never do.
      if not v_correction_allowed or v_correction_used or v_index<>v_n or v_index<2
        or v_prior.provider is distinct from 'deepseek' or v_item->>'provider' is distinct from 'deepseek'
        or v_position<>v_previous or v_prior.http_status is distinct from 200
        or v_prior.error_code is null or v_prior.error_code not in('provider_wrong_language','protected_literal_mismatch')
        then raise exception 'invalid_request';end if;
      v_correction_used:=true;
    elsif v_position<=v_previous then raise exception 'invalid_request';end if;
    v_previous:=v_position;
    v.user_id:=p_user_id;v.request_id:=p_request_id;v.attempt_index:=v_index;
    v.provider:=v_item->>'provider';v.model:=v_item->>'model';v.error_code:=v_item->>'errorCode';
    v.started_at:=(v_item->>'startedAt')::timestamptz;v.finished_at:=(v_item->>'finishedAt')::timestamptz;
    if v.started_at is null or v.finished_at is null or v.started_at<v_request.created_at-interval '1 minute'
      or v.finished_at<v.started_at or v.finished_at>clock_timestamp()+interval '1 minute'
      or (v_last_end is not null and v.started_at<v_last_end) then raise exception 'invalid_request';end if;
    v_last_end:=v.finished_at;
    -- A failed normal DS result may precede its successful correction. Only
    -- the final selected attempt has no error; every other attempt must fail.
    if v.error_code is null and (v_selected is null or v_selected<>v.provider or v_index<>v_n)
      or v.error_code is not null and v_selected=v.provider and v_index=v_n then raise exception 'invalid_request';end if;
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
    if v_first_provider is null then v_first_provider:=v.provider;
    elsif v_first_provider<>v.provider then v_mixed:=true;end if;
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
    provider=case when v_mixed then 'mixed' when v_n>0 then v.provider else provider end,
    model=case when v_mixed then 'multiple' when v_n>0 then v.model else model end,
    input_tokens=v_input,cached_tokens=v_cached,output_tokens=v_output,total_tokens=v_tokens,reasoning_tokens=v_reasoning,
    http_status=case when v_n=1 then v.http_status else null end,
    cost_status=case when v_n=0 then 'not_attempted' when v_all_exact then 'calculated' else 'unknown_attempt_cost' end,
    cost_usd=case when v_all_exact then v_total else null end,budget_cost_usd=v_upper
    where user_id=p_user_id and request_id=p_request_id;
  update translator_private.translation_requests set metadata=metadata||jsonb_build_object('selected_provider',v_selected)
    where user_id=p_user_id and request_id=p_request_id;
end;$$;

-- User-center usage and balance remain in one statement snapshot.
CREATE OR REPLACE FUNCTION public.account_snapshot(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'wallet', (select to_jsonb(w) - 'user_id' from public.wallets w where w.user_id = p_user_id),
    'usage', coalesce((select jsonb_agg(u order by u.created_at desc) from (
      select request_id, source_language, target_language, source_characters, provider, model, latency_ms, created_at
      from public.translation_usage where user_id = p_user_id order by created_at desc limit 100
    ) u), '[]'::jsonb),
    'ledger', coalesce((select jsonb_agg(l order by l.created_at desc) from (
      select idempotency_key as request_id, type, characters, balance_after, created_at
      from public.character_ledger where user_id = p_user_id order by created_at desc limit 100
    ) l), '[]'::jsonb),
    'reconciliation', jsonb_build_object(
      'translationDebit', (select coalesce(-sum(characters), 0) from public.character_ledger where user_id = p_user_id and type = 'translation'),
      'usageCharacters', (select coalesce(sum(source_characters), 0) from public.translation_usage where user_id = p_user_id),
      'duplicateDebits', (select count(*) from (select idempotency_key from public.character_ledger where user_id = p_user_id and type = 'translation' group by idempotency_key having count(*) <> 1) d),
      'mismatchedRequests', (select count(*) from public.translation_usage u full join (
        select user_id, idempotency_key, -sum(characters) as charged
        from public.character_ledger where type = 'translation' group by user_id, idempotency_key
      ) l on l.user_id = u.user_id and l.idempotency_key = u.request_id
      where coalesce(u.user_id, l.user_id) = p_user_id
        and (u.request_id is null or l.idempotency_key is null or u.source_characters <> l.charged))
    ),
    'snapshotAt', statement_timestamp()
  ) where exists (select 1 from public.profiles where id = p_user_id and status = 'active');
$function$
