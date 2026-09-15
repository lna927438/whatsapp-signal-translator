-- Shared across Worker isolates, cron and admin pages. This stores account
-- balance observations, never inferred spending or customer character debits.
create table translator_private.provider_balance_refresh (
 provider text primary key check(provider='deepseek'),scope_digest text not null check(scope_digest~'^[a-f0-9]{64}$'),
 snapshot_id uuid references translator_private.provider_balance_snapshots(id) on delete set null,
 lease_token uuid,lease_until timestamptz,next_refresh_at timestamptz not null default '-infinity',
 last_attempt_at timestamptz,last_error text,last_error_at timestamptz,
 completed_token uuid,completed_hash text,
 check((lease_token is null)=(lease_until is null)),
 check(last_error is null or last_error in('provider_permission','provider_rate_limited','provider_unavailable','provider_invalid_response','storage_unavailable','timeout'))
);
alter table translator_private.provider_balance_refresh enable row level security;
revoke all on translator_private.provider_balance_refresh from public,anon,authenticated;
grant select,insert,update on translator_private.provider_balance_refresh to service_role;

create function translator_private.deepseek_balance_status(p_scope text) returns jsonb
language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('provider','deepseek','available',b.available,'balances',coalesce(b.balances,'[]'::jsonb),
  'fetchedAt',b.fetched_at,'snapshotAt',b.fetched_at,'checkedAt',clock_timestamp(),
  'stale',b.id is null or b.fetched_at<clock_timestamp()-interval '120 seconds' or s.last_error is not null,
  'sync',jsonb_build_object('status',case when s.lease_until>clock_timestamp() then 'refreshing'
    when s.last_error is not null then 'error' when b.id is null or b.fetched_at<clock_timestamp()-interval '120 seconds' then 'stale' else 'fresh' end,
   'lastAttemptAt',s.last_attempt_at,'lastError',s.last_error,'lastErrorAt',s.last_error_at,
   'nextRefreshAt',case when isfinite(s.next_refresh_at) then s.next_refresh_at end,
   'refreshIntervalSeconds',30,'staleAfterSeconds',120))
 from translator_private.provider_balance_refresh s left join translator_private.provider_balance_snapshots b on b.id=s.snapshot_id
 where s.provider='deepseek' and s.scope_digest=p_scope;
$$;
revoke all on function translator_private.deepseek_balance_status(text) from public,anon,authenticated;
grant execute on function translator_private.deepseek_balance_status(text) to service_role;

create function public.claim_deepseek_balance_refresh(p_scope text,p_token uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare s translator_private.provider_balance_refresh%rowtype;t timestamptz:=clock_timestamp();acquired boolean:=false;
begin
 if p_scope is null or p_scope!~'^[a-f0-9]{64}$' or p_token is null then raise exception 'invalid_request';end if;
 insert into translator_private.provider_balance_refresh(provider,scope_digest) values('deepseek',p_scope) on conflict(provider) do nothing;
 select * into s from translator_private.provider_balance_refresh where provider='deepseek' for update;
 if s.scope_digest<>p_scope then
  -- Never show a previous credential/account's balance after configuration changes.
  update translator_private.provider_balance_refresh set scope_digest=p_scope,snapshot_id=null,lease_token=null,lease_until=null,
   next_refresh_at='-infinity',last_attempt_at=null,last_error=null,last_error_at=null,completed_token=null,completed_hash=null where provider='deepseek';
  select * into s from translator_private.provider_balance_refresh where provider='deepseek';
 end if;
 if s.lease_until<=t then
  update translator_private.provider_balance_refresh set lease_token=null,lease_until=null,last_error='timeout',last_error_at=t where provider='deepseek';
  s.lease_token:=null;s.lease_until:=null;
 end if;
 if s.lease_token is null and s.next_refresh_at<=t then
  update translator_private.provider_balance_refresh set lease_token=p_token,lease_until=t+interval '20 seconds',
   next_refresh_at=t+interval '30 seconds',last_attempt_at=t where provider='deepseek';acquired:=true;
 end if;
 return translator_private.deepseek_balance_status(p_scope)||jsonb_build_object('claimed',acquired);
end;$$;
revoke all on function public.claim_deepseek_balance_refresh(text,uuid) from public,anon,authenticated;
grant execute on function public.claim_deepseek_balance_refresh(text,uuid) to service_role;

create function public.finish_deepseek_balance_refresh(p_scope text,p_token uuid,p_result jsonb,p_error text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare s translator_private.provider_balance_refresh%rowtype;t timestamptz:=clock_timestamp();v jsonb;at_time timestamptz;
 result_hash text:=md5(jsonb_build_object('result',p_result,'error',p_error)::text);
begin
 if p_scope is null or p_scope!~'^[a-f0-9]{64}$' or p_token is null then raise exception 'invalid_request';end if;
 if p_error is not null and p_error not in('provider_permission','provider_rate_limited','provider_unavailable','provider_invalid_response','storage_unavailable','timeout') then raise exception 'invalid_request';end if;
 select * into s from translator_private.provider_balance_refresh where provider='deepseek' for update;
 if not found or s.scope_digest<>p_scope then return jsonb_build_object('ignored',true);end if;
 if s.completed_token=p_token then
  if s.completed_hash is distinct from result_hash then raise exception 'operation_conflict';end if;
  return translator_private.deepseek_balance_status(p_scope);
 end if;
 if s.lease_token is distinct from p_token then return translator_private.deepseek_balance_status(p_scope)||jsonb_build_object('ignored',true);end if;
 if s.lease_until<=t then
  update translator_private.provider_balance_refresh set lease_token=null,lease_until=null,last_error='timeout',last_error_at=t where provider='deepseek';
  return translator_private.deepseek_balance_status(p_scope)||jsonb_build_object('ignored',true);
 end if;
 if p_error is null then
  if jsonb_typeof(p_result) is distinct from 'object' or jsonb_typeof(p_result->'available') is distinct from 'boolean'
   or jsonb_typeof(p_result->'balances') is distinct from 'array' or jsonb_typeof(p_result->'fetchedAt') is distinct from 'string' then raise exception 'invalid_request';end if;
  for v in select value from jsonb_array_elements(p_result->'balances') loop
   if jsonb_typeof(v->'total') is distinct from 'string' or jsonb_typeof(v->'granted') is distinct from 'string' or jsonb_typeof(v->'paid') is distinct from 'string' then raise exception 'invalid_request';end if;
   if coalesce(v->>'total','')!~'^-?\d{1,12}(\.\d{1,12})?$' or coalesce(v->>'granted','')!~'^-?\d{1,12}(\.\d{1,12})?$'
    or coalesce(v->>'paid','')!~'^-?\d{1,12}(\.\d{1,12})?$' then raise exception 'invalid_request';end if;
   if (v->>'total')::numeric<>(v->>'granted')::numeric+(v->>'paid')::numeric then raise exception 'invalid_request';end if;
  end loop;
  at_time:=(p_result->>'fetchedAt')::timestamptz;
  if at_time<s.last_attempt_at-interval '1 minute' or at_time>t+interval '1 minute' then raise exception 'invalid_request';end if;
  perform public.record_provider_balance(p_token,p_result->'balances',(p_result->>'available')::boolean,at_time);
  update translator_private.provider_balance_refresh set snapshot_id=p_token,last_error=null,last_error_at=null where provider='deepseek';
 else
  if p_result is not null then raise exception 'invalid_request';end if;
  update translator_private.provider_balance_refresh set last_error=p_error,last_error_at=t where provider='deepseek';
 end if;
 update translator_private.provider_balance_refresh set lease_token=null,lease_until=null,completed_token=p_token,completed_hash=result_hash where provider='deepseek';
 return translator_private.deepseek_balance_status(p_scope);
end;$$;
revoke all on function public.finish_deepseek_balance_refresh(text,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.finish_deepseek_balance_refresh(text,uuid,jsonb,text) to service_role;
