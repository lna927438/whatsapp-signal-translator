-- Official money is comparable only for the same provider account, currency
-- and exact period. Historical unscoped statements are retained but excluded.
create function translator_private.normalized_bill_scope(p_provider text,p_scope jsonb) returns jsonb
language plpgsql immutable security invoker set search_path='' as $$
declare keys jsonb;
begin
 if jsonb_typeof(p_scope) is distinct from 'object' then return null;end if;
 if p_provider='deepseek' then
  if coalesce(p_scope->>'credentialDigest','')!~'^[a-f0-9]{64}$' then return null;end if;
  return jsonb_build_object('credentialDigest',p_scope->>'credentialDigest');
 elsif p_provider='openai' then
  if coalesce(p_scope->>'projectId','')!~'^proj_[A-Za-z0-9_-]{1,160}$' or jsonb_typeof(p_scope->'apiKeyIds') is distinct from 'array' then return null;end if;
  if jsonb_array_length(p_scope->'apiKeyIds') not between 1 and 20 or exists(select 1 from jsonb_array_elements(p_scope->'apiKeyIds') v where jsonb_typeof(v) is distinct from 'string' or (v#>>'{}')!~'^key_[A-Za-z0-9_-]{1,160}$') then return null;end if;
  select jsonb_agg(k order by k) into keys from(select distinct value as k from jsonb_array_elements_text(p_scope->'apiKeyIds')) q;
  return jsonb_build_object('projectId',p_scope->>'projectId','apiKeyIds',keys);
 end if;
 return null;
end;$$;
revoke all on function translator_private.normalized_bill_scope(text,jsonb) from public,anon,authenticated;
grant execute on function translator_private.normalized_bill_scope(text,jsonb) to service_role;

create function public.read_current_official_bills(p_actor uuid,p_filter jsonb,p_scopes jsonb) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare v_zone text;v_from timestamptz;v_to timestamptz;v_provider text;v_result jsonb;
begin
 if translator_private.admin_access(p_actor,'session')<>'owner' then raise exception 'admin_forbidden';end if;
 if jsonb_typeof(p_filter) is distinct from 'object' or jsonb_typeof(p_scopes) is distinct from 'object' then raise exception 'invalid_request';end if;
 v_zone:=coalesce(p_filter->>'timezone','Asia/Shanghai');v_provider:=nullif(p_filter->>'provider','');
 if v_zone not in('UTC','Asia/Shanghai') or (v_provider is not null and v_provider not in('openai','deepseek')) then raise exception 'invalid_request';end if;
 v_from:=coalesce(nullif(p_filter->>'from','')::date,date '2026-01-01')::timestamp at time zone v_zone;
 v_to:=(coalesce(nullif(p_filter->>'to','')::date,(now() at time zone v_zone)::date)+1)::timestamp at time zone v_zone;
 if v_to<=v_from or v_to-v_from>interval '3660 days' then raise exception 'invalid_request';end if;
 if nullif(p_filter->>'userId','') is not null then return '[]'::jsonb;end if;
 select coalesce(jsonb_agg((to_jsonb(b)-'scope'-'actor_id')||jsonb_build_object('official_usd_exact',b.official_usd::text,
   'currency','USD','currentAccount',true,'periodComplete',true) order by b.provider),'[]'::jsonb) into v_result
 from(select distinct on(provider) * from translator_private.provider_bill_snapshots s
  where s.period_from=v_from and s.period_to=v_to and s.timezone=v_zone
   and (v_provider is null or s.provider=v_provider)
   and translator_private.normalized_bill_scope(s.provider,s.scope) is not null
   and translator_private.normalized_bill_scope(s.provider,s.scope)=translator_private.normalized_bill_scope(s.provider,p_scopes->s.provider)
  order by provider,fetched_at desc,id desc)b;
 return v_result;
end;$$;
revoke all on function public.read_current_official_bills(uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.read_current_official_bills(uuid,jsonb,jsonb) to service_role;

-- Explicit, audited statement entry. The Worker supplies the current private
-- account scope after validating the public form; clients cannot choose it.
-- Legacy manual statements remain untouched and readable in the audit history.
-- This service-only primitive preserves the supplied reporting timezone. The
-- public Worker form enforces provider-native periods for the main cost card;
-- other internal reconciliation periods are never silently relabelled.
create function public.record_scoped_official_statement(p_actor uuid,p_operation uuid,p_provider text,p_reason text,p_data jsonb,p_scope jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_role text;v_scope jsonb;v_input jsonb;v_prior public.admin_audit%rowtype;v_result jsonb;v_totals jsonb;
 v_zone text;v_from timestamptz;v_to timestamptz;v_official numeric;v_tokens bigint;v_requests bigint;v_provisional boolean;
begin
 v_role:=translator_private.admin_access(p_actor,'billing.write');
 v_scope:=translator_private.normalized_bill_scope(p_provider,p_scope);
 if p_operation is null or p_provider not in('openai','deepseek') or v_scope is null or p_reason is null or length(trim(p_reason)) not between 3 and 500
  or jsonb_typeof(p_data) is distinct from 'object' then raise exception 'invalid_request';end if;
 if exists(select 1 from jsonb_object_keys(p_data) k where k not in('from','to','officialUsd','officialTokens','officialRequests','reference','timezone','provisional'))
  or coalesce(p_data->>'officialUsd','')!~'^-?\d{1,9}(\.\d{1,12})?$' or jsonb_typeof(p_data->'officialUsd') is distinct from 'string'
  or length(trim(coalesce(p_data->>'reference',''))) not between 3 and 200
  or (p_data?'provisional' and jsonb_typeof(p_data->'provisional') is distinct from 'boolean') then raise exception 'invalid_request';end if;
 v_provisional:=coalesce((p_data->>'provisional')::boolean,true);
 v_zone:=coalesce(p_data->>'timezone','Asia/Shanghai');if v_zone not in('UTC','Asia/Shanghai') then raise exception 'invalid_request';end if;
 if coalesce(p_data->>'from','')!~'^\d{4}-\d{2}-\d{2}$' or coalesce(p_data->>'to','')!~'^\d{4}-\d{2}-\d{2}$' then raise exception 'invalid_request';end if;
 v_from:=(p_data->>'from')::date::timestamp at time zone v_zone;v_to:=((p_data->>'to')::date+1)::timestamp at time zone v_zone;
 if v_to<=v_from or v_to-v_from>interval '93 days' or v_to>(date_trunc('day',clock_timestamp() at time zone v_zone)+interval '1 day') at time zone v_zone then raise exception 'invalid_request';end if;
 v_official:=(p_data->>'officialUsd')::numeric;v_tokens:=(p_data->>'officialTokens')::bigint;v_requests:=(p_data->>'officialRequests')::bigint;
 if v_tokens<0 or v_requests<0 then raise exception 'invalid_request';end if;
 v_input:=jsonb_build_object('action','cost.reconcile','target',p_provider,'reason',p_reason,'data',p_data,'accountScopeBound',true);
 perform pg_advisory_xact_lock(72491011);
 select * into v_prior from public.admin_audit where id=p_operation;
 if found then
  if v_prior.actor_id<>p_actor or v_prior.input<>v_input or not exists(
   select 1 from translator_private.provider_bill_snapshots s where s.id=p_operation and s.provider=p_provider
    and translator_private.normalized_bill_scope(s.provider,s.scope)=v_scope
  ) then raise exception 'operation_conflict';end if;
  return v_prior.result||jsonb_build_object('replayed',true);
 end if;
 v_totals:=translator_private.admin_cost_summary(jsonb_build_object('from',p_data->>'from','to',p_data->>'to','provider',p_provider,'timezone',v_zone))->'totals';
 v_result:=jsonb_build_object('provider',p_provider,'from',p_data->>'from','to',p_data->>'to','timezone',v_zone,'officialUsd',v_official,'officialUsdExact',v_official::text,
  'officialTokens',v_tokens,'officialRequests',v_requests,'reference',p_data->>'reference','calculated',v_totals,'source','manual_statement','provisional',v_provisional,'currentAccount',true,
  -- Historical local usage has no credential/project identity. It is useful
  -- as a reference but cannot prove a current-account official difference.
  'differenceUsd',null,'differenceUsdExact',null,'status','incomplete',
  'comparisonBasis','provider_all_accounts_unscoped','comparisonReason','local_account_scope_unavailable');
 insert into translator_private.provider_bill_snapshots(id,provider,period_from,period_to,timezone,source,scope,official_usd,official_tokens,official_requests,reference,provisional,actor_id)
  values(p_operation,p_provider,v_from,v_to,v_zone,'manual_statement',v_scope,v_official,v_tokens,v_requests,p_data->>'reference',v_provisional,p_actor);
 insert into public.admin_audit(id,actor_id,actor_role,action,target_id,reason,input,result) values(p_operation,p_actor,v_role,'cost.reconcile',p_provider,p_reason,v_input,v_result);
 return v_result;
end;$$;
revoke all on function public.record_scoped_official_statement(uuid,uuid,text,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.record_scoped_official_statement(uuid,uuid,text,text,jsonb,jsonb) to service_role;
