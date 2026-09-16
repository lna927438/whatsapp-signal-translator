-- Owner-confirmed lifetime paid funding, distinct from official usage bills
-- and customer character ledgers. No production amounts are seeded here.
create table translator_private.provider_funding_confirmations (
 id uuid primary key, provider text not null check(provider='deepseek'),
 scope_digest text not null check(scope_digest~'^[a-f0-9]{64}$'), currency text not null check(currency='USD'),
 cumulative_top_ups numeric(24,12) not null check(cumulative_top_ups>=0 and cumulative_top_ups<1000000000000),
 cumulative_cash_refunds numeric(24,12) not null check(cumulative_cash_refunds>=0 and cumulative_cash_refunds<=cumulative_top_ups),
 balance_snapshot_id uuid references translator_private.provider_balance_snapshots(id) on delete set null,
 balance_fetched_at timestamptz not null, confirmed_paid_balance numeric(24,12) not null,
 confirmed_at timestamptz not null default clock_timestamp(), actor_id uuid references public.profiles(id) on delete set null,
 reference text not null check(length(reference) between 3 and 200)
);
create table translator_private.provider_funding_state (
 scope_digest text primary key check(scope_digest~'^[a-f0-9]{64}$'),
 confirmation_id uuid not null references translator_private.provider_funding_confirmations(id),
 attention_at timestamptz
);
alter table translator_private.provider_funding_confirmations enable row level security;
alter table translator_private.provider_funding_state enable row level security;
revoke all on translator_private.provider_funding_confirmations,translator_private.provider_funding_state from public,anon,authenticated;
grant select,insert on translator_private.provider_funding_confirmations to service_role;
grant select,insert,update on translator_private.provider_funding_state to service_role;

create function translator_private.deepseek_funding_status(p_scope text) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare c translator_private.provider_funding_confirmations%rowtype; f translator_private.provider_funding_state%rowtype;
 s translator_private.provider_balance_refresh%rowtype;b translator_private.provider_balance_snapshots%rowtype;
 usd jsonb;net numeric;used numeric;state text;reason text;
begin
 select * into s from translator_private.provider_balance_refresh where provider='deepseek' and scope_digest=p_scope;
 select * into b from translator_private.provider_balance_snapshots where id=s.snapshot_id;
 select value into usd from jsonb_array_elements(coalesce(b.balances,'[]')) where value->>'currency'='USD';
 select * into f from translator_private.provider_funding_state where scope_digest=p_scope;
 select * into c from translator_private.provider_funding_confirmations where id=f.confirmation_id and scope_digest=p_scope;
 if c.id is null then state:='unconfigured';reason:='funding_not_confirmed';
 elsif usd is null then state:='needs_confirmation';reason:='official_usd_balance_missing';
 else
  net:=c.cumulative_top_ups-c.cumulative_cash_refunds;used:=net-(usd->>'paid')::numeric;
  if f.attention_at is not null or (usd->>'paid')::numeric>c.confirmed_paid_balance then state:='needs_confirmation';reason:='paid_balance_increased';
  elsif used<0 then state:='needs_confirmation';reason:='funding_balance_inconsistent';
  elsif b.fetched_at<c.balance_fetched_at then state:='needs_confirmation';reason:='balance_precedes_confirmation';
  elsif s.last_error is not null or b.fetched_at<clock_timestamp()-interval '120 seconds' then state:='stale';reason:='balance_not_fresh';
  else state:='ready';end if;
 end if;
 return jsonb_build_object('basis','confirmed_paid_funding_minus_official_paid_balance','scope','current_account_lifetime','currency','USD',
  'status',state,'reason',reason,'cumulativeTopUps',c.cumulative_top_ups::text,'cumulativeCashRefunds',c.cumulative_cash_refunds::text,
  'netPaidFunding',(c.cumulative_top_ups-c.cumulative_cash_refunds)::text,'paidBalance',usd->>'paid','grantedBalance',usd->>'granted',
  'usedPaid',case when state in('ready','stale') then used::text end,'balanceFetchedAt',b.fetched_at,'confirmedAt',c.confirmed_at,
  'basisSource',case when c.id is not null then 'owner_confirmation' end);
end;$$;
revoke all on function translator_private.deepseek_funding_status(text) from public,anon,authenticated;
grant execute on function translator_private.deepseek_funding_status(text) to service_role;

alter function translator_private.deepseek_balance_status(text) rename to deepseek_balance_status_before_funding;
create function translator_private.deepseek_balance_status(p_scope text) returns jsonb
language sql stable security invoker set search_path='' as $$
 select translator_private.deepseek_balance_status_before_funding(p_scope)||jsonb_build_object('funding',translator_private.deepseek_funding_status(p_scope));
$$;
revoke all on function translator_private.deepseek_balance_status(text) from public,anon,authenticated;
grant execute on function translator_private.deepseek_balance_status(text) to service_role;

-- An unexplained paid-balance increase may be a top-up or a provider credit.
-- Do not infer either. Retain the warning even if subsequent spending hides it.
alter function public.finish_deepseek_balance_refresh(text,uuid,jsonb,text) rename to finish_deepseek_balance_refresh_before_funding;
create function public.finish_deepseek_balance_refresh(p_scope text,p_token uuid,p_result jsonb,p_error text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare s translator_private.provider_balance_refresh%rowtype;prior_paid numeric;next_paid numeric;v jsonb;
begin
 select * into s from translator_private.provider_balance_refresh where provider='deepseek' and scope_digest=p_scope for update;
 select (value->>'paid')::numeric into prior_paid from translator_private.provider_balance_snapshots b,
  lateral jsonb_array_elements(b.balances) where b.id=s.snapshot_id and value->>'currency'='USD';
 v:=public.finish_deepseek_balance_refresh_before_funding(p_scope,p_token,p_result,p_error);
 if p_error is null and s.snapshot_id is distinct from p_token and exists(
   select 1 from translator_private.provider_balance_refresh where provider='deepseek' and scope_digest=p_scope and snapshot_id=p_token
 ) then
  select (value->>'paid')::numeric into next_paid from jsonb_array_elements(p_result->'balances') where value->>'currency'='USD';
  if next_paid>prior_paid then
   update translator_private.provider_funding_state set attention_at=coalesce(attention_at,clock_timestamp()) where scope_digest=p_scope;
  end if;
 end if;
 if v->>'provider'='deepseek' then return v||jsonb_build_object('funding',translator_private.deepseek_funding_status(p_scope));end if;
 return v;
end;$$;
revoke all on function public.finish_deepseek_balance_refresh(text,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.finish_deepseek_balance_refresh(text,uuid,jsonb,text) to service_role;

create function public.confirm_deepseek_funding(p_actor uuid,p_operation uuid,p_reason text,p_data jsonb,p_scope text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare prior public.admin_audit%rowtype;input jsonb;result jsonb;s translator_private.provider_balance_refresh%rowtype;
 b translator_private.provider_balance_snapshots%rowtype;c translator_private.provider_funding_confirmations%rowtype;
 usd jsonb;topups numeric;refunds numeric;at_time timestamptz;
begin
 if translator_private.admin_access(p_actor,'session')<>'owner' then raise exception 'admin_forbidden';end if;
 if p_operation is null or p_scope is null or p_scope!~'^[a-f0-9]{64}$' or length(trim(coalesce(p_reason,''))) not between 3 and 500
  or jsonb_typeof(p_data) is distinct from 'object' then raise exception 'invalid_request';end if;
 if exists(select 1 from jsonb_object_keys(p_data) k where k not in('currency','cumulativeTopUps','cumulativeCashRefunds','balanceFetchedAt','reference'))
  or p_data->>'currency' is distinct from 'USD' or length(trim(coalesce(p_data->>'reference',''))) not between 3 and 200
  or jsonb_typeof(p_data->'cumulativeTopUps') is distinct from 'string' or jsonb_typeof(p_data->'cumulativeCashRefunds') is distinct from 'string'
  or coalesce(p_data->>'cumulativeTopUps','')!~'^\d{1,12}(\.\d{1,12})?$' or coalesce(p_data->>'cumulativeCashRefunds','')!~'^\d{1,12}(\.\d{1,12})?$'
  or jsonb_typeof(p_data->'balanceFetchedAt') is distinct from 'string' then raise exception 'invalid_request';end if;
 topups:=(p_data->>'cumulativeTopUps')::numeric;refunds:=(p_data->>'cumulativeCashRefunds')::numeric;at_time:=(p_data->>'balanceFetchedAt')::timestamptz;
 if refunds>topups then raise exception 'invalid_request';end if;
 input:=jsonb_build_object('action','provider.funding.confirm','target','deepseek','reason',p_reason,'data',p_data,'accountScopeBound',true);
 perform pg_advisory_xact_lock(72491011);
 select * into prior from public.admin_audit where id=p_operation;
 if found then
  if prior.actor_id<>p_actor or prior.input<>input or not exists(select 1 from translator_private.provider_funding_confirmations where id=p_operation and scope_digest=p_scope)
   then raise exception 'operation_conflict';end if;
  return prior.result||jsonb_build_object('replayed',true);
 end if;
 select * into s from translator_private.provider_balance_refresh where provider='deepseek' and scope_digest=p_scope for update;
 select * into b from translator_private.provider_balance_snapshots where id=s.snapshot_id;
 if b.id is null or b.fetched_at is distinct from at_time or b.fetched_at<clock_timestamp()-interval '120 seconds' or s.last_error is not null
  then raise exception 'stale_provider_balance';end if;
 select value into usd from jsonb_array_elements(b.balances) where value->>'currency'='USD';
 if usd is null or topups-refunds<(usd->>'paid')::numeric then raise exception 'funding_balance_inconsistent';end if;
 select x.* into c from translator_private.provider_funding_state f join translator_private.provider_funding_confirmations x on x.id=f.confirmation_id where f.scope_digest=p_scope;
 if c.id is not null and (topups<c.cumulative_top_ups or refunds<c.cumulative_cash_refunds) then raise exception 'funding_totals_decreased';end if;
 -- A second top-up cannot be booked against the old, pre-arrival balance.
 if c.id is not null and topups>c.cumulative_top_ups and not exists(
   select 1 from translator_private.provider_funding_state where scope_digest=p_scope and attention_at is not null
 ) then raise exception 'funding_movement_not_observed';end if;
 insert into translator_private.provider_funding_confirmations(id,provider,scope_digest,currency,cumulative_top_ups,cumulative_cash_refunds,balance_snapshot_id,balance_fetched_at,confirmed_paid_balance,actor_id,reference)
  values(p_operation,'deepseek',p_scope,'USD',topups,refunds,b.id,b.fetched_at,(usd->>'paid')::numeric,p_actor,trim(p_data->>'reference'));
 insert into translator_private.provider_funding_state(scope_digest,confirmation_id) values(p_scope,p_operation)
  on conflict(scope_digest) do update set confirmation_id=p_operation,attention_at=null;
 result:=jsonb_build_object('provider','deepseek','funding',translator_private.deepseek_funding_status(p_scope));
 insert into public.admin_audit(id,actor_id,actor_role,action,target_id,reason,input,result)
  values(p_operation,p_actor,'owner','provider.funding.confirm','deepseek',p_reason,input,result);
 return result;
end;$$;
revoke all on function public.confirm_deepseek_funding(uuid,uuid,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.confirm_deepseek_funding(uuid,uuid,text,jsonb,text) to service_role;
