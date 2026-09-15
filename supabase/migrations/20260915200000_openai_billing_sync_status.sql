-- Sync health is separate from immutable official amounts. Scope rotation
-- cannot expose the previous account's error, and stale completions cannot
-- replace a more recent attempt's outcome.
create table translator_private.openai_billing_sync (
 scope jsonb primary key check(translator_private.normalized_bill_scope('openai',scope) is not null
  and translator_private.normalized_bill_scope('openai',scope)=scope),
 attempt_id uuid not null,attempted_at timestamptz not null,finished_at timestamptz not null,
 error_code text check(error_code in('billing_account_deactivated','billing_permission','billing_data_incomplete','billing_unavailable')),
 check(finished_at>=attempted_at)
);
alter table translator_private.openai_billing_sync enable row level security;
revoke all on translator_private.openai_billing_sync from public,anon,authenticated;
grant select,insert,update on translator_private.openai_billing_sync to service_role;

create function public.record_openai_billing_sync(p_scope jsonb,p_attempt uuid,p_started_at timestamptz,p_finished_at timestamptz,p_error text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_scope jsonb;v_prior translator_private.openai_billing_sync%rowtype;
begin
 v_scope:=translator_private.normalized_bill_scope('openai',p_scope);
 if v_scope is null or p_attempt is null or p_started_at is null or p_finished_at is null
  or not isfinite(p_started_at) or not isfinite(p_finished_at) or p_finished_at<p_started_at
  or p_started_at<clock_timestamp()-interval '15 minutes' or p_finished_at>clock_timestamp()+interval '1 minute'
  or (p_error is not null and p_error not in('billing_account_deactivated','billing_permission','billing_data_incomplete','billing_unavailable')) then raise exception 'invalid_request';end if;
 perform pg_advisory_xact_lock(72491021,hashtext(v_scope::text));
 select * into v_prior from translator_private.openai_billing_sync where scope=v_scope for update;
 if found then
  if v_prior.attempt_id=p_attempt then
   if v_prior.attempted_at<>p_started_at or v_prior.finished_at<>p_finished_at or v_prior.error_code is distinct from p_error then raise exception 'operation_conflict';end if;
   return jsonb_build_object('recorded',true,'replayed',true);
  end if;
  if (p_started_at,p_attempt::text)<=(v_prior.attempted_at,v_prior.attempt_id::text) then return jsonb_build_object('recorded',false,'outdated',true);end if;
 end if;
 insert into translator_private.openai_billing_sync(scope,attempt_id,attempted_at,finished_at,error_code)
 values(v_scope,p_attempt,p_started_at,p_finished_at,p_error)
 on conflict(scope) do update set attempt_id=excluded.attempt_id,attempted_at=excluded.attempted_at,
  finished_at=excluded.finished_at,error_code=excluded.error_code;
 return jsonb_build_object('recorded',true);
end;$$;
revoke all on function public.record_openai_billing_sync(jsonb,uuid,timestamptz,timestamptz,text) from public,anon,authenticated;
grant execute on function public.record_openai_billing_sync(jsonb,uuid,timestamptz,timestamptz,text) to service_role;

create function public.read_openai_billing_sync(p_scope jsonb)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare v_scope jsonb;v_result jsonb;
begin
 v_scope:=translator_private.normalized_bill_scope('openai',p_scope);if v_scope is null then raise exception 'invalid_request';end if;
 select jsonb_build_object('status',case when s.scope is null then 'unknown' when s.error_code is not null then 'error' else 'fresh' end,
  'lastAttemptAt',s.attempted_at,'lastSuccessAt',(select max(b.fetched_at) from translator_private.provider_bill_snapshots b
   where b.provider='openai' and b.source='openai_costs_api' and translator_private.normalized_bill_scope('openai',b.scope)=v_scope),
  'errorCode',s.error_code) into v_result from(select 1)q left join translator_private.openai_billing_sync s on s.scope=v_scope;
 return v_result;
end;$$;
revoke all on function public.read_openai_billing_sync(jsonb) from public,anon,authenticated;
grant execute on function public.read_openai_billing_sync(jsonb) to service_role;
