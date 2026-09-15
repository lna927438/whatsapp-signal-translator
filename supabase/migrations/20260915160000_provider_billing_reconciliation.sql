-- Provider attempts and customer character debits are different ledgers.
-- A backup call must never hide its provider cost or duplicate its characters.
create view translator_private.provider_cost_items with(security_invoker=true) as
select a.user_id,a.request_id,a.attempt_index,a.provider,a.model,r.created_at,a.started_at as occurred_at,
  a.input_tokens,a.cached_tokens,a.cache_write_tokens,a.output_tokens,a.total_tokens,a.cost_status,a.cost_usd,
  a.maximum_usd,a.finished_at as recorded_at
from translator_private.provider_attempt_usage a join translator_private.translation_requests r using(user_id,request_id)
union all
select c.user_id,c.request_id,0::smallint,c.cost_provider,c.cost_model,c.created_at,coalesce(c.provider_started_at,c.created_at),
  c.input_tokens,c.cached_tokens,null::bigint,c.output_tokens,c.total_tokens,c.cost_status,c.cost_usd,
  coalesce(p.budget_cost_usd,z.maximum_usd),c.usage_recorded_at
from translator_private.admin_cost_rows c left join translator_private.provider_usage p using(user_id,request_id)
left join translator_private.cost_reservations z using(user_id,request_id)
where not exists(select 1 from translator_private.provider_attempt_usage a where a.user_id=c.user_id and a.request_id=c.request_id);
revoke all on translator_private.provider_cost_items from public,anon,authenticated;
grant select on translator_private.provider_cost_items to service_role;

create table translator_private.provider_bill_snapshots (
  id uuid primary key, provider text not null check(provider in ('openai','deepseek')),
  period_from timestamptz not null,period_to timestamptz not null,timezone text not null check(timezone in ('UTC','Asia/Shanghai')),
  source text not null check(source in ('openai_costs_api','manual_statement')),scope jsonb not null,
  official_usd numeric(22,12) not null check(abs(official_usd)<1000000000),official_tokens bigint,official_requests bigint,
  reference text not null check(length(reference) between 3 and 200),fetched_at timestamptz not null default clock_timestamp(),
  provisional boolean not null default true,actor_id uuid references public.profiles(id) on delete set null,
  check(period_to>period_from and period_to-period_from<=interval '93 days'),check(official_tokens>=0 and official_requests>=0)
);
create index provider_bill_snapshots_range on translator_private.provider_bill_snapshots(provider,period_from,period_to,fetched_at desc);
alter table translator_private.provider_bill_snapshots enable row level security;
revoke all on translator_private.provider_bill_snapshots from public,anon,authenticated;
grant select,insert on translator_private.provider_bill_snapshots to service_role;

create table translator_private.provider_balance_snapshots (
  id uuid primary key,provider text not null check(provider='deepseek'),available boolean not null,
  balances jsonb not null,fetched_at timestamptz not null default clock_timestamp()
);
create index provider_balance_snapshots_latest on translator_private.provider_balance_snapshots(fetched_at desc);
alter table translator_private.provider_balance_snapshots enable row level security;
revoke all on translator_private.provider_balance_snapshots from public,anon,authenticated;
grant select,insert on translator_private.provider_balance_snapshots to service_role;
create function public.record_provider_balance(p_id uuid,p_balances jsonb,p_available boolean,p_fetched_at timestamptz)
returns void language plpgsql security invoker set search_path='' as $$
declare v jsonb;v_old translator_private.provider_balance_snapshots%rowtype;v_seen text[]:='{}';
begin
  if p_id is null or p_available is null or jsonb_typeof(p_balances) is distinct from 'array' or jsonb_array_length(p_balances) not between 1 and 2
    or p_fetched_at is null or p_fetched_at>clock_timestamp()+interval '1 minute' then raise exception 'invalid_request';end if;
  for v in select value from jsonb_array_elements(p_balances) loop
    if coalesce(v->>'currency','') not in ('USD','CNY') or v->>'currency'=any(v_seen)
      or coalesce(v->>'total','')!~'^-?\d{1,12}(\.\d{1,12})?$' or coalesce(v->>'granted','')!~'^-?\d{1,12}(\.\d{1,12})?$'
      or coalesce(v->>'paid','')!~'^-?\d{1,12}(\.\d{1,12})?$' then raise exception 'invalid_request';end if;
    v_seen:=array_append(v_seen,v->>'currency');
  end loop;
  perform pg_advisory_xact_lock(hashtextextended(p_id::text,732));select * into v_old from translator_private.provider_balance_snapshots where id=p_id;
  if found then if v_old.balances is distinct from p_balances or v_old.available is distinct from p_available or v_old.fetched_at is distinct from p_fetched_at then raise exception 'operation_conflict';end if;return;end if;
  insert into translator_private.provider_balance_snapshots(id,provider,available,balances,fetched_at) values(p_id,'deepseek',p_available,p_balances,p_fetched_at);
end;$$;
revoke all on function public.record_provider_balance(uuid,jsonb,boolean,timestamptz) from public,anon,authenticated;
grant execute on function public.record_provider_balance(uuid,jsonb,boolean,timestamptz) to service_role;

create function public.record_official_bill(p_id uuid,p_from timestamptz,p_to timestamptz,p_scope jsonb,p_usd text,p_fetched_at timestamptz)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v translator_private.provider_bill_snapshots%rowtype;
begin
  if p_id is null or p_from is null or p_to is null or p_to<=p_from or p_to-p_from>interval '93 days'
    or p_from<>date_trunc('day',p_from at time zone 'UTC') at time zone 'UTC'
    or p_to<>date_trunc('day',p_to at time zone 'UTC') at time zone 'UTC'
    or p_usd is null or p_usd!~'^-?\d{1,9}(\.\d{1,12})?$' or jsonb_typeof(p_scope) is distinct from 'object'
    or coalesce(p_scope->>'projectId','')!~'^proj_[A-Za-z0-9_-]{1,160}$'
    or jsonb_typeof(p_scope->'apiKeyIds') is distinct from 'array' or jsonb_array_length(p_scope->'apiKeyIds') not between 1 and 20
    or p_fetched_at is null or p_fetched_at>clock_timestamp()+interval '1 minute' then raise exception 'invalid_request';end if;
  if exists(select 1 from jsonb_array_elements_text(p_scope->'apiKeyIds') k where k!~'^key_[A-Za-z0-9_-]{1,160}$') then raise exception 'invalid_request';end if;
  perform pg_advisory_xact_lock(hashtextextended(p_id::text,731));
  select * into v from translator_private.provider_bill_snapshots where id=p_id;
  if found then
    if v.period_from is distinct from p_from or v.period_to is distinct from p_to or v.scope is distinct from p_scope
      or v.official_usd is distinct from p_usd::numeric or v.fetched_at is distinct from p_fetched_at then raise exception 'operation_conflict';end if;
    return jsonb_build_object('id',v.id,'replayed',true);
  end if;
  insert into translator_private.provider_bill_snapshots(id,provider,period_from,period_to,timezone,source,scope,official_usd,reference,fetched_at)
    values(p_id,'openai',p_from,p_to,'UTC','openai_costs_api',p_scope,p_usd::numeric,'OpenAI organization Costs API',p_fetched_at);
  return jsonb_build_object('id',p_id,'replayed',false);
end;$$;
revoke all on function public.record_official_bill(uuid,timestamptz,timestamptz,jsonb,text,timestamptz) from public,anon,authenticated;
grant execute on function public.record_official_bill(uuid,timestamptz,timestamptz,jsonb,text,timestamptz) to service_role;

create or replace function translator_private.admin_cost_summary(p_filter jsonb) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare v_from timestamptz;v_to timestamptz;v_user uuid;v_provider text;v_zone text;v_result jsonb;
begin
  v_zone:=coalesce(p_filter->>'timezone','Asia/Shanghai');if v_zone not in ('UTC','Asia/Shanghai') then raise exception 'invalid_request';end if;
  v_from:=coalesce(nullif(p_filter->>'from','')::date,date '2026-01-01')::timestamp at time zone v_zone;
  v_to:=(coalesce(nullif(p_filter->>'to','')::date,(now() at time zone v_zone)::date)+1)::timestamp at time zone v_zone;
  if v_to<=v_from or v_to-v_from>interval '3660 days' then raise exception 'invalid_request';end if;
  v_user:=nullif(p_filter->>'userId','')::uuid;v_provider:=nullif(p_filter->>'provider','');
  if v_provider is not null and v_provider not in ('openai','deepseek') then raise exception 'invalid_request';end if;
  with items as(select i.* from translator_private.provider_cost_items i
    where i.occurred_at>=v_from and i.occurred_at<v_to
      and (v_user is null or i.user_id=v_user) and (v_provider is null or i.provider=v_provider)),
  requests as(select r.*,
    case when v_provider is null or r.provider=v_provider then r.charged else 0 end as selected_charged,
    case when v_provider is null or r.provider=v_provider then r.refunded else 0 end as selected_refunded
    from translator_private.admin_translation_rows r where r.created_at>=v_from and r.created_at<v_to
      and (v_user is null or r.user_id=v_user) and (v_provider is null or r.provider=v_provider
        or exists(select 1 from items i where i.user_id=r.user_id and i.request_id=r.request_id))),
  cost_totals as(select count(*) filter(where cost_status<>'not_attempted') as provider_requests,
    coalesce(sum(cost_usd),0) as known_cost_usd,
    case when count(*) filter(where cost_usd is null)=0 then coalesce(sum(cost_usd),0) end as cost_usd,
    count(*) filter(where cost_usd is null) as unpriced_requests,
    count(*) filter(where cost_usd is not null) as priced_requests,
    count(*) filter(where cost_status='historical_unavailable') as historical_requests,
    count(*) filter(where cost_status in ('pending','unknown_response','historical_unavailable','missing_usage')) as missing_receipt_requests,
    count(*) filter(where cost_status in ('unknown_price','unknown_time','unknown_service_tier')) as missing_price_requests,
    count(*) filter(where cost_status in ('missing_cache','missing_cache_write')) as missing_cache_requests,
    count(*) filter(where total_tokens is not null and cost_status<>'not_attempted') as metered_requests,
    sum(total_tokens) as total_tokens,sum(input_tokens) as input_tokens,sum(cached_tokens) as cached_tokens,
    sum(cache_write_tokens) as cache_write_tokens,sum(output_tokens) as output_tokens,max(recorded_at) as last_usage_at from items),
  request_totals as(select count(*) as requests,coalesce(sum(selected_charged),0) as charged_characters,
    coalesce(sum(selected_refunded),0) as refunded_characters,sum(source_characters) as source_characters,
    count(*) filter(where reconciliation='mismatch') as mismatches,
    count(*) filter(where charged=0 and exists(select 1 from items i where i.user_id=requests.user_id and i.request_id=requests.request_id and i.cost_usd>0)) as provider_only_requests from requests),
  user_requests as(select user_id,email,count(*) as requests,sum(selected_charged) as charged_characters from requests group by user_id,email),
  user_costs as(select user_id,sum(total_tokens) as total_tokens,coalesce(sum(cost_usd),0) as known_cost_usd,
    case when count(*) filter(where cost_usd is null)=0 then coalesce(sum(cost_usd),0) end as cost_usd,
    count(*) filter(where cost_usd is null) as unpriced_requests from items group by user_id),
  day_requests as(select (created_at at time zone v_zone)::date as day,count(*) as requests,sum(selected_charged) as charged_characters from requests group by 1),
  day_costs as(select (occurred_at at time zone v_zone)::date as day,
    sum(total_tokens) as total_tokens,coalesce(sum(cost_usd),0) as known_cost_usd,
    case when count(*) filter(where cost_usd is null)=0 then coalesce(sum(cost_usd),0) end as cost_usd,
    count(*) filter(where cost_usd is null) as unpriced_requests from items group by 1),
  providers as(select provider,count(*) filter(where cost_status<>'not_attempted') as requests,
    coalesce(sum(cost_usd),0) as known_cost_usd,
    case when count(*) filter(where cost_usd is null)=0 then coalesce(sum(cost_usd),0) end as cost_usd,
    count(*) filter(where cost_usd is null) as unpriced_requests,sum(total_tokens) as total_tokens from items group by provider)
  select jsonb_build_object('totals',(select to_jsonb(c)||to_jsonb(r)||jsonb_build_object('cost_usd_exact',c.cost_usd::text,'known_cost_usd_exact',c.known_cost_usd::text) from cost_totals c,request_totals r),
    'users',(select coalesce(jsonb_agg(coalesce(to_jsonb(r),'{}')||coalesce(to_jsonb(c),'{}')||jsonb_build_object('email',p.email,'known_cost_usd_exact',c.known_cost_usd::text,'cost_usd_exact',c.cost_usd::text) order by p.email),'[]')
      from user_requests r full join user_costs c using(user_id) join public.profiles p on p.id=coalesce(r.user_id,c.user_id)),
    'days',(select coalesce(jsonb_agg(coalesce(to_jsonb(r),'{}')||coalesce(to_jsonb(c),'{}')||jsonb_build_object('known_cost_usd_exact',c.known_cost_usd::text,'cost_usd_exact',c.cost_usd::text) order by coalesce(r.day,c.day) desc),'[]') from day_requests r full join day_costs c using(day)),
    'providers',(select coalesce(jsonb_agg(to_jsonb(p)||jsonb_build_object('cost_usd_exact',p.cost_usd::text,'known_cost_usd_exact',p.known_cost_usd::text) order by provider),'[]') from providers p),
    'providerBalance',(select to_jsonb(b) from translator_private.provider_balance_snapshots b where v_user is null order by fetched_at desc limit 1),
    'officialBills',(select coalesce(jsonb_agg((to_jsonb(b)-'actor_id'-'scope')||jsonb_build_object('official_usd_exact',b.official_usd::text)),'[]') from
      (select distinct on(provider) * from translator_private.provider_bill_snapshots where period_from=v_from and period_to=v_to
        and (v_provider is null or provider=v_provider) and v_user is null order by provider,fetched_at desc)b),
    'from',v_from,'toExclusive',v_to,'timezone',v_zone,'snapshotAt',clock_timestamp(),
    'pricingSource','https://developers.openai.com/api/docs/pricing','priceVersion','provider-attempts-usd-2026-09-15',
    'pricingSources',jsonb_build_array(jsonb_build_object('provider','openai','url','https://developers.openai.com/api/docs/pricing'),
      jsonb_build_object('provider','deepseek','url','https://api-docs.deepseek.com/quick_start/pricing/'))) into v_result;
  return v_result;
end;$$;

-- Manual statement comparisons are immutable audited snapshots. Missing token
-- totals remain NULL; a Costs invoice does not require invented zero tokens.
alter function public.admin_mutate(uuid,uuid,text,text,text,jsonb) rename to admin_mutate_billing_legacy;
alter function public.admin_mutate_billing_legacy(uuid,uuid,text,text,text,jsonb) set schema translator_private;
create function public.admin_mutate(p_actor uuid,p_operation uuid,p_action text,p_target text,p_reason text,p_data jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_role text;v_input jsonb;v_prior public.admin_audit%rowtype;v_result jsonb;v_totals jsonb;v_official numeric;
  v_zone text;v_from timestamptz;v_to timestamptz;v_tokens bigint;v_requests bigint;
begin
  if p_action<>'cost.reconcile' then return translator_private.admin_mutate_billing_legacy(p_actor,p_operation,p_action,p_target,p_reason,p_data);end if;
  v_role:=translator_private.admin_access(p_actor,'billing.write');
  if p_operation is null or p_target not in ('openai','deepseek') or p_reason is null or length(trim(p_reason)) not between 3 and 500
    or p_data is null or coalesce(p_data->>'officialUsd','')!~'^-?\d{1,9}(\.\d{1,12})?$'
    or length(trim(coalesce(p_data->>'reference',''))) not between 3 and 200 then raise exception 'invalid_request';end if;
  v_input:=jsonb_build_object('action',p_action,'target',p_target,'reason',p_reason,'data',p_data);
  perform pg_advisory_xact_lock(72491011);
  select * into v_prior from public.admin_audit where id=p_operation;
  if found then if v_prior.actor_id<>p_actor or v_prior.input<>v_input then raise exception 'operation_conflict';end if;return v_prior.result||jsonb_build_object('replayed',true);end if;
  v_zone:=coalesce(p_data->>'timezone','Asia/Shanghai');if v_zone not in ('UTC','Asia/Shanghai') then raise exception 'invalid_request';end if;
  v_from:=(p_data->>'from')::date::timestamp at time zone v_zone;v_to:=((p_data->>'to')::date+1)::timestamp at time zone v_zone;
  if v_from is null or v_to is null or v_to<=v_from or v_to-v_from>interval '93 days' then raise exception 'invalid_request';end if;
  v_official:=(p_data->>'officialUsd')::numeric;v_tokens:=(p_data->>'officialTokens')::bigint;v_requests:=(p_data->>'officialRequests')::bigint;
  if v_tokens<0 or v_requests<0 then raise exception 'invalid_request';end if;
  v_totals:=translator_private.admin_cost_summary(jsonb_build_object('from',p_data->>'from','to',p_data->>'to','provider',p_target,'timezone',v_zone))->'totals';
  v_result:=jsonb_build_object('provider',p_target,'from',p_data->>'from','to',p_data->>'to','timezone',v_zone,'officialUsd',v_official,'officialUsdExact',v_official::text,
    'officialTokens',v_tokens,'officialRequests',v_requests,'reference',p_data->>'reference','calculated',v_totals,'source','manual_statement',
    'differenceUsd',case when (v_totals->>'unpriced_requests')::bigint=0 then v_official-coalesce((v_totals->>'cost_usd')::numeric,0) end,
    'differenceUsdExact',case when (v_totals->>'unpriced_requests')::bigint=0 then (v_official-coalesce((v_totals->>'cost_usd')::numeric,0))::text end,
    'status',case when (v_totals->>'unpriced_requests')::bigint>0 then 'incomplete'
      when v_official=coalesce((v_totals->>'cost_usd')::numeric,0)
        and (v_tokens is null or v_tokens=coalesce((v_totals->>'total_tokens')::bigint,0))
        and (v_requests is null or v_requests=coalesce((v_totals->>'provider_requests')::bigint,0)) then 'matched' else 'mismatch' end);
  insert into translator_private.provider_bill_snapshots(id,provider,period_from,period_to,timezone,source,scope,official_usd,official_tokens,official_requests,reference,provisional,actor_id)
    values(p_operation,p_target,v_from,v_to,v_zone,'manual_statement','{}',v_official,v_tokens,v_requests,p_data->>'reference',false,p_actor);
  insert into public.admin_audit(id,actor_id,actor_role,action,target_id,reason,input,result) values(p_operation,p_actor,v_role,p_action,p_target,p_reason,v_input,v_result);
  return v_result;
end;$$;
revoke all on function public.admin_mutate(uuid,uuid,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.admin_mutate(uuid,uuid,text,text,text,jsonb) to service_role;

-- The existing provider balance endpoint is owner-only. Adding saved snapshots
-- must not expose that account information to support roles via cost summaries.
alter function public.admin_read(uuid,text,jsonb) rename to admin_read_billing_legacy;
alter function public.admin_read_billing_legacy(uuid,text,jsonb) set schema translator_private;
create function public.admin_read(p_actor uuid,p_kind text,p_filter jsonb default '{}') returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare v jsonb;
begin
  v:=translator_private.admin_read_billing_legacy(p_actor,p_kind,p_filter);
  if p_kind='costs' and translator_private.admin_access(p_actor,'session')<>'owner' then
    return v-'providerBalance'-'officialBills';
  end if;
  return v;
end;$$;
revoke all on function public.admin_read(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.admin_read(uuid,text,jsonb) to service_role;
