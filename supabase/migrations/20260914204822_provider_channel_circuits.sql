-- Persistent health decisions shared by every Worker instance. Route leases
-- contain only request identifiers and diagnostic codes, never message content.
create table translator_private.provider_circuits (
  provider text not null check(provider in ('openai','deepseek')),
  model text not null check(length(model) between 1 and 200),
  generation integer not null default 0 check(generation>=0),
  failures integer not null default 0 check(failures between 0 and 2),
  backoff_level integer not null default 0 check(backoff_level between 0 and 5),
  open_until timestamptz,
  probe_token uuid, probe_until timestamptz,
  last_error text, updated_at timestamptz not null default clock_timestamp(),
  primary key(provider,model),
  check((probe_token is null)=(probe_until is null))
);
create table translator_private.provider_route_leases (
  user_id uuid not null, request_id text not null, claim_token uuid not null,
  provider text not null, model text not null,
  allowed boolean not null, generation integer not null, probe_token uuid,
  retry_after_ms integer not null default 0,
  acquired_at timestamptz not null default clock_timestamp(),
  outcome_at timestamptz, outcome_success boolean, outcome_error text,
  outcome_applied boolean,
  primary key(user_id,request_id,provider,model),
  foreign key(user_id,request_id) references translator_private.translation_requests(user_id,request_id) on delete cascade,
  foreign key(provider,model) references translator_private.provider_circuits(provider,model),
  check(retry_after_ms between 0 and 300000)
);
alter table translator_private.provider_circuits enable row level security;
alter table translator_private.provider_route_leases enable row level security;
revoke all on translator_private.provider_circuits,translator_private.provider_route_leases from public,anon,authenticated;
grant select,insert,update,delete on translator_private.provider_circuits,translator_private.provider_route_leases to service_role;

create function public.provider_route_acquire(p_user_id uuid,p_request_id text,p_claim_token uuid,p_provider text,p_model text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  v_request translator_private.translation_requests%rowtype;
  v_circuit translator_private.provider_circuits%rowtype;
  v_lease translator_private.provider_route_leases%rowtype;
  v_now timestamptz:=clock_timestamp(); v_allowed boolean:=false; v_retry integer:=0; v_probe uuid;
begin
  -- All route functions use request -> circuit -> lease lock order. They never
  -- take wallet/provider-usage locks, so settlement can keep its existing order.
  select * into v_request from translator_private.translation_requests
    where user_id=p_user_id and request_id=p_request_id for update;
  if not found then raise exception 'request_not_found'; end if;
  if v_request.claim_token is distinct from p_claim_token then raise exception 'request_id_conflict'; end if;
  if v_request.state<>'processing' or v_request.expires_at<=v_now then raise exception 'request_not_processing'; end if;
  if v_request.metadata->>'metering_version' is distinct from '2'
    or jsonb_typeof(v_request.metadata->'provider_plan') is distinct from 'array'
    or p_provider is null or p_provider not in ('openai','deepseek')
    or p_model is null or length(p_model) not between 1 and 200 then raise exception 'invalid_request'; end if;
  if not exists(select 1 from jsonb_array_elements(v_request.metadata->'provider_plan') item
    where item->>'provider'=p_provider and item->>'model'=p_model) then raise exception 'invalid_request'; end if;
  insert into translator_private.provider_circuits(provider,model) values(p_provider,p_model) on conflict do nothing;
  select * into v_circuit from translator_private.provider_circuits where provider=p_provider and model=p_model for update;
  select * into v_lease from translator_private.provider_route_leases
    where user_id=p_user_id and request_id=p_request_id and provider=p_provider and model=p_model for update;
  if found then
    if v_lease.claim_token is distinct from p_claim_token then raise exception 'request_id_conflict'; end if;
    -- A lost acquisition reply may be retried; an already reported attempt may
    -- never be re-enabled. The request claim owns the one provider invocation.
    return jsonb_build_object('allowed',v_lease.allowed and v_lease.outcome_at is null
      and v_circuit.generation=v_lease.generation
      and (v_circuit.open_until is null or v_lease.probe_token=v_circuit.probe_token and v_circuit.probe_until>clock_timestamp()),
      'generation',v_lease.generation,'probeToken',v_lease.probe_token,'retryAfterMs',v_lease.retry_after_ms);
  end if;
  v_now:=clock_timestamp();
  if v_circuit.open_until is null then v_allowed:=true;
  elsif v_circuit.open_until>v_now then
    v_retry:=least(300000,greatest(1,ceil(extract(epoch from(v_circuit.open_until-v_now))*1000)::integer));
  elsif v_circuit.probe_token is not null and v_circuit.probe_until>v_now then
    v_retry:=least(25000,greatest(1,ceil(extract(epoch from(v_circuit.probe_until-v_now))*1000)::integer));
  else
    -- Only one half-open request per provider/model. A new generation also
    -- fences a late response from an abandoned probe.
    v_allowed:=true; v_probe:=gen_random_uuid();
    update translator_private.provider_circuits set generation=generation+1,
      probe_token=v_probe,probe_until=v_now+interval '25 seconds',updated_at=v_now
      where provider=p_provider and model=p_model returning * into v_circuit;
  end if;
  insert into translator_private.provider_route_leases(user_id,request_id,claim_token,provider,model,allowed,generation,probe_token,retry_after_ms)
    values(p_user_id,p_request_id,p_claim_token,p_provider,p_model,v_allowed,v_circuit.generation,v_probe,v_retry);
  return jsonb_build_object('allowed',v_allowed,'generation',v_circuit.generation,'probeToken',v_probe,'retryAfterMs',v_retry);
end; $$;

create function public.provider_route_outcome(p_user_id uuid,p_request_id text,p_claim_token uuid,p_provider text,p_model text,
  p_generation integer,p_probe_token text,p_success boolean,p_error_code text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  v_request translator_private.translation_requests%rowtype;
  v_circuit translator_private.provider_circuits%rowtype;
  v_lease translator_private.provider_route_leases%rowtype;
  v_now timestamptz:=clock_timestamp(); v_applied boolean:=false;
  v_hard boolean; v_transient boolean; v_failures integer; v_level integer; v_delay integer;
begin
  if p_success is null or p_generation is null or p_generation<0
    or p_error_code is not null and p_error_code!~'^[a-z][a-z0-9_]{0,99}$'
    or p_success and p_error_code is not null then raise exception 'invalid_request'; end if;
  select * into v_request from translator_private.translation_requests
    where user_id=p_user_id and request_id=p_request_id for update;
  if not found then raise exception 'request_not_found'; end if;
  if v_request.claim_token is distinct from p_claim_token then raise exception 'request_id_conflict'; end if;
  select * into v_circuit from translator_private.provider_circuits where provider=p_provider and model=p_model for update;
  if not found then raise exception 'route_not_acquired'; end if;
  select * into v_lease from translator_private.provider_route_leases
    where user_id=p_user_id and request_id=p_request_id and provider=p_provider and model=p_model for update;
  if not found or not v_lease.allowed then raise exception 'route_not_acquired'; end if;
  if v_lease.claim_token is distinct from p_claim_token or v_lease.generation<>p_generation
    or v_lease.probe_token::text is distinct from p_probe_token then raise exception 'request_id_conflict'; end if;
  if v_lease.outcome_at is not null then
    if v_lease.outcome_success is distinct from p_success or v_lease.outcome_error is distinct from p_error_code then
      raise exception 'operation_conflict'; end if;
    return jsonb_build_object('recorded',true,'applied',v_lease.outcome_applied);
  end if;
  v_now:=clock_timestamp();
  -- Ignore user/account/budget/safety errors. Only enumerated upstream failures
  -- change the shared provider health; no arbitrary error text is persisted.
  -- Generic 400/422 responses may be caused by just this request's content or
  -- size. They use its backup without disabling the provider for other users.
  v_hard:=coalesce(p_error_code in ('provider_auth','provider_quota','provider_model','provider_permission'),false);
  -- A difficult message may fail language/literal validation while the service
  -- is healthy. Such requests may use their backup, but cannot trip a circuit
  -- shared with other users.
  v_transient:=coalesce(p_error_code in ('provider_timeout','provider_unavailable','provider_rate_limit'),false);
  -- Outcomes arriving after the parent request expired remain auditable, but
  -- are too old to describe current provider health, even for a normal lease.
  if v_request.expires_at>v_now and v_circuit.generation=p_generation and (v_lease.probe_token is null
    or v_circuit.probe_token=v_lease.probe_token and v_circuit.probe_until>v_now) then
    if p_success then
      -- A normal healthy success preserves its generation for concurrent calls.
      -- Successful recovery advances it so old probe outcomes stay fenced out.
      update translator_private.provider_circuits set failures=0,backoff_level=0,open_until=null,
        probe_token=null,probe_until=null,last_error=null,updated_at=v_now,
        generation=generation+case when v_lease.probe_token is not null then 1 else 0 end
        where provider=p_provider and model=p_model;
      v_applied:=true;
    elsif v_hard or v_transient then
      v_failures:=least(2,v_circuit.failures+1);
      if v_hard or v_lease.probe_token is not null or v_failures>=2 then
        v_level:=least(5,v_circuit.backoff_level+1);
        v_delay:=case when v_hard then 300 else least(300,30*(2^(v_level-1))::integer) end;
        update translator_private.provider_circuits set failures=2,backoff_level=v_level,
          open_until=v_now+make_interval(secs=>v_delay),probe_token=null,probe_until=null,
          generation=generation+1,last_error=p_error_code,updated_at=v_now
          where provider=p_provider and model=p_model;
      else
        update translator_private.provider_circuits set failures=v_failures,last_error=p_error_code,updated_at=v_now
          where provider=p_provider and model=p_model;
      end if;
      v_applied:=true;
    elsif v_lease.probe_token is not null then
      -- This probe never established provider health (for example a local user
      -- cancellation); release its lease without treating it as a provider fault.
      update translator_private.provider_circuits set probe_token=null,probe_until=null,generation=generation+1,
        updated_at=v_now where provider=p_provider and model=p_model;
    end if;
  end if;
  update translator_private.provider_route_leases set outcome_at=v_now,outcome_success=p_success,
    outcome_error=p_error_code,outcome_applied=v_applied
    where user_id=p_user_id and request_id=p_request_id and provider=p_provider and model=p_model;
  return jsonb_build_object('recorded',true,'applied',v_applied);
end; $$;
revoke all on function public.provider_route_acquire(uuid,text,uuid,text,text),
  public.provider_route_outcome(uuid,text,uuid,text,text,integer,text,boolean,text) from public,anon,authenticated;
grant execute on function public.provider_route_acquire(uuid,text,uuid,text,text),
  public.provider_route_outcome(uuid,text,uuid,text,text,integer,text,boolean,text) to service_role;
