-- Actual provider usage is independent of the customer character ledger.
-- Historical requests are intentionally NOT assigned fabricated token counts.
alter table public.profiles add column last_seen_at timestamptz;
create function public.touch_client_presence(p_user_id uuid) returns void language sql security invoker set search_path='' as $$
  update public.profiles set last_seen_at=clock_timestamp() where id=p_user_id and status='active'
    and (last_seen_at is null or last_seen_at<clock_timestamp()-interval '30 seconds');
$$;
revoke all on function public.touch_client_presence(uuid) from public,anon,authenticated;
grant execute on function public.touch_client_presence(uuid) to service_role;
create table translator_private.provider_usage (
  user_id uuid not null references public.profiles(id) on delete cascade,
  request_id text not null, claim_token uuid not null,
  provider text not null, model text not null,
  started_at timestamptz not null default clock_timestamp(), recorded_at timestamptz,
  provider_created_at timestamptz, provider_response_id text, provider_request_id text, http_status integer,
  input_tokens bigint, cached_tokens bigint, output_tokens bigint, total_tokens bigint, reasoning_tokens bigint,
  cost_status text not null default 'pending', cost_usd numeric(22,12),
  price_version text, price_period text, price_time_source text,
  input_rate numeric(14,6), cached_rate numeric(14,6), output_rate numeric(14,6),
  receipt jsonb, primary key(user_id,request_id),
  check(input_tokens>=0 and cached_tokens>=0 and cached_tokens<=input_tokens and output_tokens>=0),
  check(cost_usd>=0)
);
revoke all on translator_private.provider_usage from public,anon,authenticated;
grant select,insert,update on translator_private.provider_usage to service_role;
create index provider_usage_time_idx on translator_private.provider_usage(started_at,user_id);

create function translator_private.start_provider_usage() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if new.metadata->>'metering_version'='1' then
    insert into translator_private.provider_usage(user_id,request_id,claim_token,provider,model)
      values(new.user_id,new.request_id,new.claim_token,new.metadata->>'provider',new.metadata->>'requested_model');
  end if;
  return new;
end; $$;
revoke all on function translator_private.start_provider_usage() from public,anon,authenticated;
grant execute on function translator_private.start_provider_usage() to service_role;
create trigger translation_usage_started after insert on translator_private.translation_requests
  for each row execute function translator_private.start_provider_usage();

create function translator_private.deepseek_peak(p_at timestamptz) returns boolean
language sql immutable set search_path='' as $$
  select extract(isodow from p_at at time zone 'UTC') between 1 and 5
    and ( (p_at at time zone 'UTC')::time >= time '01:00' and (p_at at time zone 'UTC')::time < time '04:00'
       or (p_at at time zone 'UTC')::time >= time '06:00' and (p_at at time zone 'UTC')::time < time '10:00');
$$;
revoke all on function translator_private.deepseek_peak(timestamptz) from public,anon,authenticated;
grant execute on function translator_private.deepseek_peak(timestamptz) to service_role;

create function translator_private.record_provider_usage(p_user_id uuid,p_request_id text,p_claim_token uuid,p_receipt jsonb)
returns void language plpgsql security invoker set search_path='' as $$
declare v translator_private.provider_usage%rowtype; v_at timestamptz; v_peak boolean; v_factor integer; v_key text; v_count bigint;
begin
  select * into v from translator_private.provider_usage where user_id=p_user_id and request_id=p_request_id for update;
  if not found or v.claim_token is distinct from p_claim_token then raise exception 'request_id_conflict'; end if;
  if v.recorded_at is not null then
    if v.receipt is distinct from p_receipt then raise exception 'operation_conflict'; end if;
    return;
  end if;
  if p_receipt is null or jsonb_typeof(p_receipt)<>'object' or octet_length(p_receipt::text)>4096 then raise exception 'invalid_request';end if;
  foreach v_key in array array['inputTokens','cachedTokens','outputTokens','totalTokens','reasoningTokens'] loop
    if p_receipt->>v_key is not null then
      if (p_receipt->>v_key)!~'^\d{1,9}$' then raise exception 'invalid_request';end if;
      v_count:=(p_receipt->>v_key)::bigint;
      if v_count>100000000 then raise exception 'invalid_request';end if;
    end if;
  end loop;
  v.recorded_at:=clock_timestamp();v.receipt:=p_receipt;
  v.model:=left(coalesce(p_receipt->>'model',v.model),200);
  v.provider_response_id:=left(p_receipt->>'responseId',200);v.provider_request_id:=left(p_receipt->>'requestId',200);
  v.http_status:=(p_receipt->>'httpStatus')::integer;
  v.input_tokens:=(p_receipt->>'inputTokens')::bigint;v.cached_tokens:=(p_receipt->>'cachedTokens')::bigint;
  v.output_tokens:=(p_receipt->>'outputTokens')::bigint;v.total_tokens:=(p_receipt->>'totalTokens')::bigint;
  v.reasoning_tokens:=(p_receipt->>'reasoningTokens')::bigint;
  v.provider_created_at:=(p_receipt->>'createdAt')::timestamptz;
  if v.provider_created_at between v.started_at-interval '1 minute' and v.recorded_at+interval '1 minute' then
    v_at:=v.provider_created_at;v.price_time_source:='provider';
  elsif v.recorded_at-v.started_at<interval '10 minutes'
    and translator_private.deepseek_peak(v.started_at)=translator_private.deepseek_peak(v.recorded_at) then
    v_at:=v.started_at;v.price_time_source:='request_window';
  end if;
  v.cost_status:=case when v.http_status is null then 'unknown_response' else 'missing_usage' end;
  if v.input_tokens is not null and v.output_tokens is not null and v.total_tokens=v.input_tokens+v.output_tokens then
    if v.cached_tokens is null then v.cost_status:='missing_cache';
    elsif v.cached_tokens>v.input_tokens then raise exception 'invalid_request';
    elsif v.provider<>'deepseek' or v.model not in ('deepseek-flash','deepseek-v4-flash','deepseek-v4-flash-vision-exp','deepseek-v4-pro') then v.cost_status:='unknown_price';
    elsif v_at is null then v.cost_status:='unknown_time';
    else
      v_peak:=translator_private.deepseek_peak(v_at);v_factor:=case when v_peak then 2 else 1 end;
      v.price_period:=case when v_peak then 'peak' else 'off_peak' end;
      v.price_version:='deepseek-usd-2026-09-12';
      -- Official USD / million tokens, verified https://api-docs.deepseek.com/quick_start/pricing/
      if v.model='deepseek-v4-pro' then
        v.cached_rate:=0.022*v_factor;v.input_rate:=0.66*v_factor;v.output_rate:=1.98*v_factor;
      else
        v.cached_rate:=0.003*v_factor;v.input_rate:=0.15*v_factor;v.output_rate:=0.60*v_factor;
      end if;
      v.cost_usd:=((v.input_tokens-v.cached_tokens)*v.input_rate+v.cached_tokens*v.cached_rate+v.output_tokens*v.output_rate)/1000000;
      v.cost_status:='calculated';
    end if;
  end if;
  update translator_private.provider_usage set
    model=v.model,recorded_at=v.recorded_at,receipt=v.receipt,http_status=v.http_status,
    provider_created_at=v.provider_created_at,provider_response_id=v.provider_response_id,provider_request_id=v.provider_request_id,
    input_tokens=v.input_tokens,cached_tokens=v.cached_tokens,output_tokens=v.output_tokens,total_tokens=v.total_tokens,reasoning_tokens=v.reasoning_tokens,
    cost_status=v.cost_status,cost_usd=v.cost_usd,price_version=v.price_version,price_period=v.price_period,price_time_source=v.price_time_source,
    input_rate=v.input_rate,cached_rate=v.cached_rate,output_rate=v.output_rate
    where user_id=p_user_id and request_id=p_request_id;
end;$$;
revoke all on function translator_private.record_provider_usage(uuid,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function translator_private.record_provider_usage(uuid,text,uuid,jsonb) to service_role;

create function public.complete_translation_metered(p_user_id uuid,p_request_id text,p_claim_token uuid,p_translation text,p_model text,p_latency_ms integer,p_receipt jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
begin
  perform translator_private.record_provider_usage(p_user_id,p_request_id,p_claim_token,p_receipt);
  return public.complete_translation(p_user_id,p_request_id,p_claim_token,p_translation,p_model,p_latency_ms);
end;$$;
create function public.fail_translation_metered(p_user_id uuid,p_request_id text,p_claim_token uuid,p_error_code text,p_receipt jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
begin
  perform translator_private.record_provider_usage(p_user_id,p_request_id,p_claim_token,p_receipt);
  return public.fail_translation(p_user_id,p_request_id,p_claim_token,p_error_code);
end;$$;
revoke all on function public.complete_translation_metered(uuid,text,uuid,text,text,integer,jsonb),public.fail_translation_metered(uuid,text,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.complete_translation_metered(uuid,text,uuid,text,text,integer,jsonb),public.fail_translation_metered(uuid,text,uuid,text,jsonb) to service_role;

create table translator_private.admin_policy (
  singleton boolean primary key default true check(singleton),
  user_id uuid not null references public.profiles(id), configured_at timestamptz not null default now()
);
revoke all on translator_private.admin_policy from public,anon,authenticated;
grant select on translator_private.admin_policy to service_role;
create function translator_private.enforce_single_admin() returns trigger language plpgsql security invoker set search_path='' as $$
declare v_owner uuid;begin
  select user_id into v_owner from translator_private.admin_policy where singleton;
  if v_owner is not null then
    if tg_op='DELETE' then raise exception 'single_owner';end if;
    if new.user_id is distinct from v_owner or new.role<>'owner' then raise exception 'single_owner';end if;
  end if;
  if tg_op='DELETE' then return old;end if;
  return new;
end;$$;
revoke all on function translator_private.enforce_single_admin() from public,anon,authenticated;
grant execute on function translator_private.enforce_single_admin() to service_role;
create trigger admin_single_owner before insert or update or delete on public.admin_roles for each row execute function translator_private.enforce_single_admin();

alter function translator_private.admin_access(uuid,text) rename to admin_access_legacy;
create function translator_private.admin_access(p_actor uuid,p_scope text) returns text language plpgsql stable security invoker set search_path='' as $$
declare v_owner uuid;begin
  select user_id into v_owner from translator_private.admin_policy where singleton;
  if v_owner is null then return translator_private.admin_access_legacy(p_actor,p_scope);end if;
  if p_actor=v_owner and exists(select 1 from public.admin_roles a join public.profiles p on p.id=a.user_id where a.user_id=p_actor and a.role='owner' and p.status='active') then return 'owner';end if;
  raise exception 'admin_forbidden';
end;$$;
revoke all on function translator_private.admin_access(uuid,text) from public,anon,authenticated;
grant execute on function translator_private.admin_access(uuid,text) to service_role;

-- Preserve the reviewed v1 operations, while presenting only the requested working scope.
alter function public.admin_read(uuid,text,jsonb) rename to admin_read_legacy;
alter function public.admin_read_legacy(uuid,text,jsonb) set schema translator_private;
create view translator_private.admin_cost_rows with(security_invoker=true) as
select r.*,p.provider_response_id,p.provider_request_id,
  coalesce(p.provider,r.provider) as cost_provider,coalesce(p.model,r.model) as cost_model,
  p.input_tokens,p.cached_tokens,p.output_tokens,p.total_tokens,p.reasoning_tokens,p.cost_usd,
  coalesce(p.cost_status,'historical_unavailable') as cost_status,p.price_version,p.price_period,p.price_time_source,
  p.input_rate,p.cached_rate,p.output_rate,p.started_at as provider_started_at,p.recorded_at as usage_recorded_at,
  p.provider_created_at,p.http_status
from translator_private.admin_translation_rows r left join translator_private.provider_usage p using(user_id,request_id);
revoke all on translator_private.admin_cost_rows from public,anon,authenticated;
grant select on translator_private.admin_cost_rows to service_role;

create function translator_private.admin_cost_summary(p_filter jsonb) returns jsonb language plpgsql stable security invoker set search_path='' as $$
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
    count(*) filter(where cost_status='calculated') as priced_requests,
    count(*) filter(where cost_status<>'calculated') as unpriced_requests,
    count(*) filter(where cost_status='historical_unavailable') as historical_requests,
    count(*) filter(where total_tokens is not null) as metered_requests,
    count(*) filter(where reconciliation='mismatch') as mismatches,
    count(*) filter(where charged=0 and cost_usd>0) as provider_only_requests from filtered),
  by_user as (select user_id,email,count(*) as requests,sum(charged) as charged_characters,sum(total_tokens) as total_tokens,
    sum(cost_usd) as cost_usd,count(*) filter(where cost_status<>'calculated') as unpriced_requests,
    sum(charged) filter(where cost_status='calculated' and charged>0) as priced_characters,
    sum(cost_usd) filter(where cost_status='calculated' and charged>0) as priced_character_cost
    from filtered group by user_id,email),
  by_day as (select (created_at at time zone 'Asia/Shanghai')::date as day,count(*) as requests,sum(charged) as charged_characters,
    sum(total_tokens) as total_tokens,sum(cost_usd) as cost_usd,count(*) filter(where cost_status<>'calculated') as unpriced_requests
    from filtered group by 1)
  select jsonb_build_object('totals',(select to_jsonb(t) from totals t),'users',(select coalesce(jsonb_agg(u order by email),'[]') from by_user u),
    'days',(select coalesce(jsonb_agg(d order by day desc),'[]') from by_day d),'from',v_from,'toExclusive',v_to,'snapshotAt',clock_timestamp(),
    'pricingSource','https://api-docs.deepseek.com/quick_start/pricing/','priceVersion','deepseek-usd-2026-09-12') into v_result;
  return v_result;
end;$$;
revoke all on function translator_private.admin_cost_summary(jsonb) from public,anon,authenticated;
grant execute on function translator_private.admin_cost_summary(jsonb) to service_role;

create function public.admin_read(p_actor uuid,p_kind text,p_filter jsonb default '{}') returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare v_result jsonb;v_rows jsonb;v_scope text;begin
  v_scope:=case when p_kind='costs' then 'translations' when p_kind='user' then 'users' when p_kind='operation' then 'session' else p_kind end;
  perform translator_private.admin_access(p_actor,v_scope);
  if p_kind='costs' then return translator_private.admin_cost_summary(p_filter);end if;
  v_result:=translator_private.admin_read_legacy(p_actor,p_kind,p_filter);
  if p_kind='session' then return v_result||jsonb_build_object('singleAdmin',exists(select 1 from translator_private.admin_policy));end if;
  if p_kind='overview' then return v_result||jsonb_build_object('costs',translator_private.admin_cost_summary('{}')->'totals',
    'todayCharacters',(select coalesce(sum(-characters),0) from public.character_ledger where type='translation' and created_at>=((now() at time zone 'Asia/Shanghai')::date::timestamp at time zone 'Asia/Shanghai')),
    'recentClients',(select count(*) from public.profiles where last_seen_at>now()-interval '2 minutes'));end if;
  if p_kind='user' then return v_result||jsonb_build_object('costs',translator_private.admin_cost_summary(jsonb_build_object('userId',p_filter->>'userId'))->'totals');end if;
  if p_kind='translations' then
    select coalesce(jsonb_agg(x.row || (to_jsonb(c)-'user_id'-'request_id') order by x.ord),'[]') into v_rows
    from jsonb_array_elements(v_result->'rows') with ordinality x(row,ord)
    join translator_private.admin_cost_rows c on c.user_id=(x.row->>'user_id')::uuid and c.request_id=x.row->>'request_id';
    return jsonb_set(v_result,'{rows}',v_rows);
  end if;
  if p_kind='users' then
    select coalesce(jsonb_agg(x.row||jsonb_build_object('last_seen_at',p.last_seen_at) order by x.ord),'[]') into v_rows
      from jsonb_array_elements(v_result->'rows') with ordinality x(row,ord) join public.profiles p on p.id=(x.row->>'id')::uuid;
    return jsonb_set(v_result,'{rows}',v_rows);
  end if;
  return v_result;
end;$$;
revoke all on function public.admin_read(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.admin_read(uuid,text,jsonb) to service_role;

alter function public.admin_mutate(uuid,uuid,text,text,text,jsonb) rename to admin_mutate_legacy;
alter function public.admin_mutate_legacy(uuid,uuid,text,text,text,jsonb) set schema translator_private;
create function public.admin_mutate(p_actor uuid,p_operation uuid,p_action text,p_target text,p_reason text,p_data jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_role text;v_input jsonb;v_prior public.admin_audit%rowtype;v_amount bigint;v_balance bigint;v_result jsonb;v_totals jsonb;v_official numeric;begin
  if p_action not in ('wallet.add','cost.reconcile') then
    return translator_private.admin_mutate_legacy(p_actor,p_operation,p_action,p_target,p_reason,p_data);
  end if;
  v_role:=translator_private.admin_access(p_actor,'billing.write');
  if p_operation is null or length(trim(p_reason)) not between 3 and 500 or p_reason is null or p_data is null then raise exception 'invalid_request';end if;
  v_input:=jsonb_build_object('action',p_action,'target',p_target,'reason',p_reason,'data',p_data);
  perform pg_advisory_xact_lock(72491011);
  select * into v_prior from public.admin_audit where id=p_operation;
  if found then
    if v_prior.actor_id<>p_actor or v_prior.input<>v_input then raise exception 'operation_conflict';end if;
    return v_prior.result||jsonb_build_object('replayed',true);
  end if;
  if p_action='wallet.add' then
    if p_data->>'amount' !~ '^\d{1,10}$' then raise exception 'invalid_request';end if;
    v_amount:=(p_data->>'amount')::bigint;
    if v_amount is null or v_amount not between 1 and 1000000000 then raise exception 'invalid_request';end if;
    perform 1 from public.profiles where id=p_target::uuid for share;
    if not found then raise exception 'not_found';end if;
    update public.wallets set balance=balance+v_amount,lifetime_credited=lifetime_credited+v_amount
      where user_id=p_target::uuid returning balance into v_balance;
    if not found then raise exception 'not_found';end if;
    insert into public.character_ledger(user_id,type,characters,balance_after,idempotency_key,source,note,metadata)
      values(p_target::uuid,'adjustment',v_amount,v_balance,'admin:'||p_operation,'admin-console',p_reason,jsonb_build_object('admin_operation_id',p_operation));
    v_result:=jsonb_build_object('userId',p_target,'characters',v_amount,'balanceAfter',v_balance);
  else
    if p_target not in ('deepseek','openai') or p_data->>'officialUsd' !~ '^\d{1,9}(\.\d{1,12})?$'
      or length(trim(p_data->>'reference')) not between 3 and 200
      or p_data->>'from' is null or p_data->>'to' is null then raise exception 'invalid_request';end if;
    v_official:=(p_data->>'officialUsd')::numeric;
    v_totals:=translator_private.admin_cost_summary(jsonb_build_object('from',p_data->>'from','to',p_data->>'to','provider',p_target))->'totals';
    v_result:=jsonb_build_object('provider',p_target,'from',p_data->>'from','to',p_data->>'to','officialUsd',v_official,
      'officialTokens',(p_data->>'officialTokens')::bigint,'officialRequests',(p_data->>'officialRequests')::bigint,
      'reference',p_data->>'reference','calculated',v_totals,
      'differenceUsd',case when (v_totals->>'unpriced_requests')::bigint=0 then v_official-coalesce((v_totals->>'cost_usd')::numeric,0) end,
      'status',case when (v_totals->>'unpriced_requests')::bigint>0 then 'incomplete'
        when v_official=coalesce((v_totals->>'cost_usd')::numeric,0)
          and (p_data->>'officialTokens')::bigint=coalesce((v_totals->>'total_tokens')::bigint,0)
          and (p_data->>'officialRequests')::bigint=(v_totals->>'requests')::bigint then 'matched' else 'mismatch' end);
  end if;
  insert into public.admin_audit(id,actor_id,actor_role,action,target_id,reason,input,result)
    values(p_operation,p_actor,v_role,p_action,p_target,p_reason,v_input,v_result);
  return v_result;
end;$$;
revoke all on function public.admin_mutate(uuid,uuid,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.admin_mutate(uuid,uuid,text,text,text,jsonb) to service_role;
