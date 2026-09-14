-- Staged locally. Apply together with the hardened API; never against production during development.
create table translator_private.security_policy (
  singleton boolean primary key default true check(singleton),
  user_daily_usd numeric(12,4) not null default 5 check(user_daily_usd>0),
  global_daily_usd numeric(12,4) not null default 50 check(global_daily_usd>0),
  user_requests_per_minute integer not null default 60 check(user_requests_per_minute between 1 and 600),
  user_concurrency integer not null default 8 check(user_concurrency between 1 and 32),
  input_upper_usd_per_million numeric(12,4) not null default 10 check(input_upper_usd_per_million>0),
  output_upper_usd_per_million numeric(12,4) not null default 40 check(output_upper_usd_per_million>0),
  enabled boolean not null default true,
  response_retention_days integer not null default 30 check(response_retention_days between 1 and 90)
);
insert into translator_private.security_policy(singleton) values(true);
alter table translator_private.security_policy enable row level security;
revoke all on translator_private.security_policy from public,anon,authenticated;
grant select on translator_private.security_policy to service_role;
grant update(singleton) on translator_private.security_policy to service_role;

create table translator_private.cost_reservations (
  user_id uuid not null references public.profiles(id) on delete cascade,
  request_id text not null,
  maximum_usd numeric(22,12) not null check(maximum_usd>=0),
  created_at timestamptz not null default clock_timestamp(),
  primary key(user_id,request_id)
);
create index cost_reservations_time_idx on translator_private.cost_reservations(created_at,user_id);
alter table translator_private.cost_reservations enable row level security;
revoke all on translator_private.cost_reservations from public,anon,authenticated;
grant select,insert on translator_private.cost_reservations to service_role;

create table translator_private.api_rate_windows (
  user_id uuid not null references public.profiles(id) on delete cascade,
  bucket bigint not null,
  scope text not null check(scope in ('api','admin')),
  requests integer not null check(requests>0),
  primary key(user_id,bucket,scope)
);
alter table translator_private.api_rate_windows enable row level security;
revoke all on translator_private.api_rate_windows from public,anon,authenticated;
grant select,insert,update,delete on translator_private.api_rate_windows to service_role;

create table translator_private.security_events (
  id bigint generated always as identity primary key,
  actor uuid references public.profiles(id) on delete set null,
  code text not null check(code in ('rate_limited','cost_limit','security_paused','mfa_required','mfa_step_up','provider_failure','release_guard','backup_check','account_deleted')),
  bucket bigint not null,
  created_at timestamptz not null default clock_timestamp(),
  unique(actor,code,bucket)
);
alter table translator_private.security_events enable row level security;
revoke all on translator_private.security_events from public,anon,authenticated;
grant select,insert on translator_private.security_events to service_role;
grant usage,select on sequence translator_private.security_events_id_seq to service_role;

create function public.security_rate_limit(p_user_id uuid,p_scope text) returns boolean
language plpgsql security invoker set search_path='' as $$
declare v_requests integer; v_bucket bigint=floor(extract(epoch from clock_timestamp())/60);
begin
  if p_scope not in ('api','admin') then raise exception 'invalid_request'; end if;
  insert into translator_private.api_rate_windows(user_id,bucket,scope,requests) values(p_user_id,v_bucket,p_scope,1)
  on conflict(user_id,bucket,scope) do update set requests=least(translator_private.api_rate_windows.requests+1,10000)
  returning requests into v_requests;
  return v_requests<=case when p_scope='admin' then 120 else 180 end;
end; $$;

create function public.record_security_event(p_actor uuid,p_code text) returns void
language sql security invoker set search_path='' as $$
  insert into translator_private.security_events(actor,code,bucket)
  select p_actor,p_code,floor(extract(epoch from clock_timestamp())/300)
  where exists(select 1 from public.profiles where id=p_actor)
  on conflict(actor,code,bucket) do nothing;
$$;

create function translator_private.guard_translation_cost() returns trigger
language plpgsql security invoker set search_path='' as $$
declare v_policy translator_private.security_policy%rowtype; v_user numeric; v_global numeric; v_reserve numeric;
  v_day timestamptz=date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC'; v_input integer; v_output integer;
begin
  -- A new request alone reserves cost. Existing immutable IDs are replayed before this trigger.
  -- The policy row serializes new reservations globally, across all Worker instances.
  select * into strict v_policy from translator_private.security_policy where singleton for update;
  if not v_policy.enabled then raise exception 'security_paused'; end if;
  if (select count(*) from translator_private.translation_requests where user_id=new.user_id and created_at>clock_timestamp()-interval '1 minute')>=v_policy.user_requests_per_minute
    or (select count(*) from translator_private.translation_requests where user_id=new.user_id and state='processing' and expires_at>clock_timestamp())>=v_policy.user_concurrency then raise exception 'rate_limited'; end if;
  -- Token caps supplied by our Worker are not accepted from a public client.
  v_input=coalesce((new.metadata->>'security_input_token_bound')::integer,new.source_characters*4+16000);
  v_output=coalesce((new.metadata->>'security_output_token_bound')::integer,16384);
  if v_input not between 1 and 262144 or v_output not between 1 and 16384 then raise exception 'invalid_request'; end if;
  v_reserve=(v_input*v_policy.input_upper_usd_per_million+v_output*v_policy.output_upper_usd_per_million)/1000000;
  select coalesce(sum(coalesce(u.cost_usd,r.maximum_usd)) filter(where r.user_id=new.user_id),0),coalesce(sum(coalesce(u.cost_usd,r.maximum_usd)),0)
  into v_user,v_global from translator_private.cost_reservations r left join translator_private.provider_usage u using(user_id,request_id) where r.created_at>=v_day;
  -- Requests from old API builds also count against the daily protection limit.
  select v_user+coalesce(sum(coalesce(u.cost_usd,1)) filter(where u.user_id=new.user_id),0),v_global+coalesce(sum(coalesce(u.cost_usd,1)),0)
  into v_user,v_global from translator_private.provider_usage u where u.started_at>=v_day
    and not exists(select 1 from translator_private.cost_reservations r where r.user_id=u.user_id and r.request_id=u.request_id);
  if v_user+v_reserve>v_policy.user_daily_usd or v_global+v_reserve>v_policy.global_daily_usd then raise exception 'cost_limit'; end if;
  insert into translator_private.cost_reservations(user_id,request_id,maximum_usd) values(new.user_id,new.request_id,v_reserve);
  return new;
end; $$;
create trigger a_security_translation before insert on translator_private.translation_requests for each row execute function translator_private.guard_translation_cost();

-- Only this narrow function can inspect auth.sessions. No auth table is granted to clients.
create function translator_private.admin_session_active(p_actor uuid,p_session uuid) returns boolean
language sql security definer set search_path='' as $$
  select exists(select 1 from auth.sessions s join public.profiles p on p.id=s.user_id join public.admin_roles r on r.user_id=p.id
    where s.id=p_session and s.user_id=p_actor and (s.not_after is null or s.not_after>clock_timestamp()) and p.status='active' and r.role='owner');
$$;
create function public.admin_session_active(p_actor uuid,p_session uuid) returns boolean
language sql security invoker set search_path='' as $$ select translator_private.admin_session_active(p_actor,p_session); $$;

create function public.admin_security_overview(p_actor uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
begin
  perform public.admin_read(p_actor,'session','{}');
  if not exists(select 1 from public.admin_roles where user_id=p_actor and role='owner') then raise exception 'admin_forbidden'; end if;
  return jsonb_build_object('policy',(select to_jsonb(p)-'singleton' from translator_private.security_policy p where singleton),
    'events',coalesce((select jsonb_agg(to_jsonb(e)-'bucket' order by e.created_at desc) from (select * from translator_private.security_events order by created_at desc limit 100)e),'[]'::jsonb),
    'snapshotAt',clock_timestamp());
end; $$;

create function public.security_housekeeping() returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_days integer; v_count integer;
begin
  select response_retention_days into strict v_days from translator_private.security_policy where singleton;
  update translator_private.translation_requests set response=(response-'translation')||'{"contentExpired":true}'::jsonb
    where state='completed' and response ? 'translation' and updated_at<clock_timestamp()-make_interval(days=>v_days);
  get diagnostics v_count=row_count;
  delete from translator_private.api_rate_windows where bucket<floor(extract(epoch from clock_timestamp())/60)-120;
  delete from translator_private.security_events where created_at<clock_timestamp()-interval '90 days';
  return jsonb_build_object('expiredResponses',v_count,'checkedAt',clock_timestamp());
end; $$;

revoke all on function public.security_rate_limit(uuid,text),public.record_security_event(uuid,text),translator_private.guard_translation_cost(),
  translator_private.admin_session_active(uuid,uuid),public.admin_session_active(uuid,uuid),public.admin_security_overview(uuid),public.security_housekeeping() from public,anon,authenticated;
grant execute on function public.security_rate_limit(uuid,text),public.record_security_event(uuid,text),translator_private.guard_translation_cost(),
  translator_private.admin_session_active(uuid,uuid),public.admin_session_active(uuid,uuid),public.admin_security_overview(uuid),public.security_housekeeping() to service_role;

-- Content erasure keeps financial evidence and idempotency tombstones intact.
alter function public.admin_mutate(uuid,uuid,text,text,text,jsonb) rename to admin_mutate_before_security;
alter function public.admin_mutate_before_security(uuid,uuid,text,text,text,jsonb) set schema translator_private;
create function public.admin_mutate(p_actor uuid,p_operation uuid,p_action text,p_target text,p_reason text,p_data jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare v_role text;v_input jsonb;v_prior public.admin_audit%rowtype;v_count integer;v_result jsonb;
begin
  if p_action is distinct from 'user.clear-content' then return translator_private.admin_mutate_before_security(p_actor,p_operation,p_action,p_target,p_reason,p_data);end if;
  v_role:=translator_private.admin_access(p_actor,'users.write');
  if v_role<>'owner' then raise exception 'admin_forbidden';end if;
  if p_operation is null or p_target is null or p_reason is null or length(trim(p_reason)) not between 3 and 500 or p_data is distinct from '{}'::jsonb then raise exception 'invalid_request';end if;
  v_input:=jsonb_build_object('action',p_action,'target',p_target,'reason',p_reason,'data',p_data);
  perform pg_advisory_xact_lock(72491011);
  select * into v_prior from public.admin_audit where id=p_operation;
  if found then
    if v_prior.actor_id<>p_actor or v_prior.input<>v_input then raise exception 'operation_conflict';end if;
    return v_prior.result||jsonb_build_object('replayed',true);
  end if;
  perform 1 from public.profiles where id=p_target::uuid for update;
  if not found then raise exception 'not_found';end if;
  if exists(select 1 from translator_private.translation_requests where user_id=p_target::uuid and state not in ('completed','failed')) then raise exception 'content_pending';end if;
  update translator_private.translation_requests set response=(response-'translation')||'{"contentExpired":true}'::jsonb
    where user_id=p_target::uuid and state='completed' and response ? 'translation';
  get diagnostics v_count=row_count;
  v_result:=jsonb_build_object('userId',p_target,'clearedResponses',v_count,'financialRecordsPreserved',true);
  insert into public.admin_audit(id,actor_id,actor_role,action,target_id,reason,input,result) values(p_operation,p_actor,v_role,p_action,p_target,p_reason,v_input,v_result);
  return v_result;
end;$$;
revoke all on function public.admin_mutate(uuid,uuid,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.admin_mutate(uuid,uuid,text,text,text,jsonb) to service_role;
