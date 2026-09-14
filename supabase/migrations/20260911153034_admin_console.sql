-- Local-first admin console. Apply only after the separate production review.
-- Caller identity is verified by the gateway. Only service_role may invoke RPCs.
create table public.admin_audit (
  id uuid primary key,
  actor_id uuid not null,
  actor_role text not null,
  action text not null,
  target_id text not null,
  reason text not null check (length(reason) between 3 and 500),
  input jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.admin_audit enable row level security;
revoke all on public.admin_audit from public, anon, authenticated;
grant select, insert on public.admin_audit to service_role;
revoke update, delete, truncate on public.admin_audit from service_role;
create index admin_audit_created_idx on public.admin_audit(created_at desc, id);
create index admin_audit_target_idx on public.admin_audit(target_id, created_at desc);

alter table public.app_versions add column channel text not null default 'stable'
  check (channel in ('stable','beta'));
alter table public.app_versions add column sha256 text;
alter table public.app_versions add column updated_at timestamptz not null default now();
update public.app_versions set channel='beta' where version ~* '(beta|alpha|rc)';

create function translator_private.admin_access(p_actor uuid, p_scope text)
returns text language plpgsql stable security invoker set search_path='' as $$
declare v_role text;
begin
  select a.role into v_role from public.admin_roles a join public.profiles p on p.id=a.user_id
    where a.user_id=p_actor and p.status='active';
  if v_role is null or v_role not in ('owner','admin','support','finance','editor') then
    raise exception 'admin_forbidden';
  end if;
  if v_role='owner' or (v_role='admin' and p_scope <> 'roles.write')
    or (v_role='support' and p_scope in ('overview','users','translations'))
    or (v_role='finance' and p_scope in ('overview','users','translations','orders','plans','audit','billing.write'))
    or (v_role='editor' and p_scope in ('overview','versions','announcements','content.write'))
    or p_scope='session' then return v_role; end if;
  raise exception 'admin_forbidden';
end;
$$;
revoke all on function translator_private.admin_access(uuid,text) from public, anon, authenticated;
grant execute on function translator_private.admin_access(uuid,text) to service_role;

-- Explicit projection: never expose source text, translated text, tokens or metadata.
create view translator_private.admin_translation_rows with (security_invoker=true) as
with debits as (
  select user_id, idempotency_key as request_id, count(*) as debit_count,
    -sum(characters) as charged, min(id::text) as ledger_id, max(created_at) as created_at
  from public.character_ledger where type='translation' group by user_id,idempotency_key
), rows as (
  select coalesce(r.user_id,u.user_id,d.user_id) as user_id,
    coalesce(r.request_id,u.request_id,d.request_id) as request_id,
    coalesce(r.source_characters,u.source_characters) as source_characters,
    u.source_characters as usage_characters, coalesce(u.cache_hit,false) as cache_hit,
    coalesce(r.state,case when u.id is not null then 'completed' else 'unknown' end) as state,
    case when r.error_code ~ '^[a-z_]{1,64}$' then r.error_code else null end as error_code,
    u.provider,u.model,u.source_language,u.target_language,u.latency_ms,
    coalesce(d.charged,0) as charged, coalesce(d.debit_count,0) as debit_count, d.ledger_id,
    r.expires_at, coalesce(r.created_at,u.created_at,d.created_at) as created_at,
    case when r.state in ('processing','failed') and coalesce(d.charged,0)<>0 then 'mismatch'
      when r.state='processing' then 'pending'
      when r.state='failed' and coalesce(d.charged,0)=0 then 'not_charged'
      when u.cache_hit and coalesce(d.charged,0)=0 then 'cache'
      when u.source_characters=0 and coalesce(d.charged,0)=0 then 'free'
      when coalesce(d.debit_count,0)=1 and u.source_characters=d.charged
        and coalesce(r.source_characters,u.source_characters)=d.charged
        and coalesce(r.state,'completed')='completed' then 'matched'
      else 'mismatch' end as reconciliation
  from translator_private.translation_requests r
  full join public.translation_usage u on u.user_id=r.user_id and u.request_id=r.request_id
  full join debits d on d.user_id=coalesce(r.user_id,u.user_id) and d.request_id=coalesce(r.request_id,u.request_id)
)
select rows.*,p.email,p.username,
  coalesce((select sum(l.characters) from public.character_ledger l where l.user_id=rows.user_id
    and l.type='refund' and l.metadata->>'original_ledger_id'=rows.ledger_id),0) as refunded
from rows join public.profiles p on p.id=rows.user_id;
revoke all on translator_private.admin_translation_rows from public, anon, authenticated;
grant select on translator_private.admin_translation_rows to service_role;

create function public.admin_read(p_actor uuid,p_kind text,p_filter jsonb default '{}')
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare
  v_role text; v_rows jsonb; v_detail jsonb; v_total bigint;
  v_query text:=lower(trim(coalesce(p_filter->>'q','')));
  v_limit integer:=25; v_offset integer:=coalesce((p_filter->>'offset')::integer,0);
  v_user uuid:=nullif(p_filter->>'userId','')::uuid;
  v_status text:=coalesce(p_filter->>'status','');
begin
  v_role:=translator_private.admin_access(p_actor,case when p_kind='user' then 'users' when p_kind='operation' then 'session' else p_kind end);
  if v_offset<0 or v_offset>100000 or length(v_query)>160 then raise exception 'invalid_request'; end if;
  if p_kind='operation' then
    select result into v_detail from public.admin_audit where id=(p_filter->>'operationId')::uuid and actor_id=p_actor;
    return jsonb_build_object('found',v_detail is not null,'result',v_detail,'snapshotAt',statement_timestamp());
  elsif p_kind='session' then
    return jsonb_build_object('id',p_actor,'role',v_role,'email',(select email from public.profiles where id=p_actor),'snapshotAt',statement_timestamp());
  elsif p_kind='overview' then
    return jsonb_build_object('users',(select count(*) from public.profiles),
      'activeUsers',(select count(*) from public.profiles where status='active'),
      'todayCharacters',(select coalesce(-sum(characters),0) from public.character_ledger where type='translation' and created_at>=date_trunc('day',now())),
      'pendingOrders',(select count(*) from public.orders where status='pending'),
      'pendingTranslations',(select count(*) from translator_private.translation_requests where state='processing'),
      'snapshotAt',statement_timestamp());
  elsif p_kind='users' then
    select coalesce(jsonb_agg(x),'[]') into v_rows from (
      select p.id,p.email,p.username,p.plan_code,p.status,p.created_at,w.balance,w.reserved_characters,
        (select count(*) from public.devices d where d.user_id=p.id) as devices
      from public.profiles p left join public.wallets w on w.user_id=p.id
      where (v_query='' or position(v_query in lower(coalesce(p.email,'')||' '||coalesce(p.username,'')||' '||p.id::text))>0)
        and (v_status='' or p.status=v_status)
      order by p.created_at desc,p.id limit v_limit+1 offset v_offset
    ) x;
  elsif p_kind='user' then
    select jsonb_build_object('profile',jsonb_build_object('id',p.id,'email',p.email,'username',p.username,
      'plan_code',p.plan_code,'status',p.status,'created_at',p.created_at),
      'wallet',to_jsonb(w)-'user_id',
      'devices',coalesce((select jsonb_agg(d) from (select id,device_name,platform,app_version,status,last_seen_at from public.devices where user_id=p.id order by last_seen_at desc limit 50) d),'[]'),
      'deviceCount',(select count(*) from public.devices where user_id=p.id),
      'ledger',coalesce((select jsonb_agg(l) from (select id,type,characters,balance_after,idempotency_key,source,created_at from public.character_ledger where user_id=p.id order by created_at desc,id limit 50) l),'[]'),
      'ledgerCount',(select count(*) from public.character_ledger where user_id=p.id),
      'ledgerBalance',(select coalesce(sum(characters),0) from public.character_ledger where user_id=p.id),
      'mismatches',(select count(*) from translator_private.admin_translation_rows where user_id=p.id and reconciliation='mismatch')
    ) into v_detail from public.profiles p left join public.wallets w on w.user_id=p.id where p.id=v_user;
    if v_detail is null then raise exception 'not_found'; end if;
    return v_detail||jsonb_build_object('snapshotAt',statement_timestamp());
  elsif p_kind='translations' then
    select coalesce(jsonb_agg(x),'[]') into v_rows from (
      select * from translator_private.admin_translation_rows
      where (v_user is null or user_id=v_user)
        and (v_query='' or position(v_query in lower(coalesce(request_id,'')||' '||coalesce(email,'')))>0)
        and (v_status='' or reconciliation=v_status)
      order by created_at desc,user_id,request_id limit v_limit+1 offset v_offset
    ) x;
  elsif p_kind='orders' then
    select coalesce(jsonb_agg(x),'[]') into v_rows from (
      select o.id,o.user_id,p.email,o.provider,o.provider_order_id,o.status,o.plan_code,o.amount_cents,
        o.currency,o.characters,o.created_at,o.paid_at
      from public.orders o join public.profiles p on p.id=o.user_id
      where (v_user is null or o.user_id=v_user) and (v_status='' or o.status::text=v_status)
        and (v_query='' or position(v_query in lower(o.id::text||' '||coalesce(p.email,'')||' '||coalesce(o.provider_order_id,'')))>0)
      order by o.created_at desc,o.id limit v_limit+1 offset v_offset
    ) x;
  elsif p_kind='plans' then
    select coalesce(jsonb_agg(x),'[]') into v_rows from (select code,name,included_characters,price_cents,currency,active,updated_at
      from public.plans order by created_at,code limit v_limit+1 offset v_offset) x;
  elsif p_kind='versions' then
    select coalesce(jsonb_agg(x),'[]') into v_rows from (select version,platform,channel,download_url,sha256,release_notes,active,created_at,updated_at
      from public.app_versions order by created_at desc,version limit v_limit+1 offset v_offset) x;
  elsif p_kind='announcements' then
    select coalesce(jsonb_agg(x),'[]') into v_rows from (select id,title,body,level,active,starts_at,ends_at,created_at
      from public.announcements order by created_at desc,id limit v_limit+1 offset v_offset) x;
  elsif p_kind='roles' then
    select coalesce(jsonb_agg(x),'[]') into v_rows from (select a.user_id,p.email,a.role,p.status,a.created_at from public.admin_roles a
      join public.profiles p on p.id=a.user_id order by a.created_at,a.user_id limit v_limit+1 offset v_offset) x;
  elsif p_kind='audit' then
    select coalesce(jsonb_agg(x),'[]') into v_rows from (
      select a.id,a.actor_id,p.email as actor_email,a.actor_role,a.action,a.target_id,a.reason,a.result,a.created_at
      from public.admin_audit a left join public.profiles p on p.id=a.actor_id
      where v_query='' or position(v_query in lower(a.id::text||' '||a.target_id||' '||a.action||' '||coalesce(p.email,'')))>0
      order by a.created_at desc,a.id limit v_limit+1 offset v_offset
    ) x;
  else raise exception 'invalid_request'; end if;
  return jsonb_build_object('rows',coalesce((select jsonb_agg(value) from jsonb_array_elements(v_rows) with ordinality where ordinality<=v_limit),'[]'),
    'hasMore',jsonb_array_length(v_rows)>v_limit,'offset',v_offset,'snapshotAt',statement_timestamp());
end;
$$;

create function public.admin_mutate(p_actor uuid,p_operation uuid,p_action text,p_target text,p_reason text,p_data jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  v_role text; v_existing public.admin_audit%rowtype; v_result jsonb; v_before jsonb;
  v_user uuid; v_wallet public.wallets%rowtype; v_ledger public.character_ledger%rowtype;
  v_amount bigint; v_ledger_type public.ledger_type:='adjustment'; v_ledger_id uuid;
  v_order public.orders%rowtype; v_plan public.plans%rowtype; v_input jsonb;
  v_status text; v_target_role text; v_balance bigint; v_scope text;
begin
  v_scope:=case when p_action in ('wallet.adjust','translation.refund','order.create','order.settle','order.cancel','plan.save') then 'billing.write'
    when p_action in ('version.save','announcement.save') then 'content.write'
    when p_action='role.set' then 'roles.write' when p_action='user.update' then 'users.write' else '' end;
  if v_scope='' or p_operation is null or p_actor is null or p_target is null or length(p_target)>160
    or p_reason is null or length(trim(p_reason)) not between 3 and 500 or p_data is null then raise exception 'invalid_request'; end if;
  -- Serialize admin mutations, including changes to the last owner. Does not lock translations globally.
  perform pg_advisory_xact_lock(72491011);
  v_role:=translator_private.admin_access(p_actor,v_scope);
  v_input:=jsonb_build_object('action',p_action,'target',p_target,'reason',trim(p_reason),'data',p_data);
  select * into v_existing from public.admin_audit where id=p_operation;
  if found then
    if v_existing.actor_id<>p_actor or v_existing.input<>v_input then raise exception 'operation_conflict'; end if;
    return v_existing.result||jsonb_build_object('replayed',true);
  end if;

  if p_action='role.set' then
    v_user:=p_target::uuid; v_target_role:=p_data->>'role';
    if v_target_role not in ('owner','admin','support','finance','editor','none') or v_target_role is null then raise exception 'invalid_request'; end if;
    perform 1 from public.profiles where id=v_user and status='active' for update;
    if not found then raise exception 'not_found'; end if;
    select role into v_status from public.admin_roles where user_id=v_user;
    if v_status='owner' and v_target_role<>'owner' and
      (select count(*) from public.admin_roles a join public.profiles p on p.id=a.user_id where a.role='owner' and p.status='active')<=1
      then raise exception 'last_owner'; end if;
    if v_target_role='none' then delete from public.admin_roles where user_id=v_user;
    else insert into public.admin_roles(user_id,role) values(v_user,v_target_role) on conflict(user_id) do update set role=excluded.role; end if;
    v_result:=jsonb_build_object('before',v_status,'role',v_target_role);
  elsif p_action='user.update' then
    v_user:=p_target::uuid;
    select jsonb_build_object('status',status,'plan_code',plan_code) into v_before from public.profiles where id=v_user for update;
    if not found then raise exception 'not_found'; end if;
    if p_data->>'status' not in ('active','blocked') or not exists(select 1 from public.plans where code=p_data->>'plan_code') then raise exception 'invalid_request'; end if;
    if p_data->>'status'='blocked' then
      if v_user=p_actor then raise exception 'self_disable'; end if;
      if exists(select 1 from public.admin_roles where user_id=v_user) and v_role<>'owner' then raise exception 'admin_forbidden'; end if;
      if exists(select 1 from public.admin_roles where user_id=v_user and role='owner') and
        (select count(*) from public.admin_roles a join public.profiles p on p.id=a.user_id where a.role='owner' and p.status='active')<=1 then raise exception 'last_owner'; end if;
    end if;
    update public.profiles set status=p_data->>'status',plan_code=p_data->>'plan_code' where id=v_user;
    v_result:=jsonb_build_object('before',v_before,'status',p_data->>'status','plan_code',p_data->>'plan_code');
  elsif p_action='plan.save' then
    if p_target !~ '^[a-z][a-z0-9_-]{0,39}$' or length(trim(p_data->>'name')) not between 1 and 80
      or (p_data->>'characters')::bigint not between 0 and 1000000000 or (p_data->>'price')::integer not between 0 and 100000000
      or p_data->>'currency' !~ '^[A-Z]{3}$' then raise exception 'invalid_request'; end if;
    select to_jsonb(p)-'metadata' into v_before from public.plans p where code=p_target;
    insert into public.plans(code,name,included_characters,price_cents,currency,active)
      values(p_target,trim(p_data->>'name'),(p_data->>'characters')::bigint,(p_data->>'price')::integer,p_data->>'currency',(p_data->>'active')::boolean)
      on conflict(code) do update set name=excluded.name,included_characters=excluded.included_characters,price_cents=excluded.price_cents,currency=excluded.currency,active=excluded.active;
    v_result:=jsonb_build_object('before',v_before,'plan',p_target);
  elsif p_action='version.save' then
    if p_target !~ '^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?$' or p_data->>'channel' not in ('stable','beta')
      or length(p_data->>'notes')>10000 or length(p_data->>'url')>2000 then raise exception 'invalid_request'; end if;
    if (p_target ~* '(beta|alpha|rc)') and p_data->>'channel'='stable' then raise exception 'invalid_request'; end if;
    if (p_data->>'active')::boolean and (p_data->>'url' !~ '^https://[^/\s]+/' or p_data->>'sha256' !~ '^[a-f0-9]{64}$') then raise exception 'invalid_release'; end if;
    select to_jsonb(v) into v_before from public.app_versions v where version=p_target;
    insert into public.app_versions(version,platform,channel,download_url,sha256,release_notes,active)
      values(p_target,'windows',p_data->>'channel',nullif(p_data->>'url',''),nullif(p_data->>'sha256',''),p_data->>'notes',(p_data->>'active')::boolean)
      on conflict(version) do update set channel=excluded.channel,download_url=excluded.download_url,sha256=excluded.sha256,release_notes=excluded.release_notes,active=excluded.active,updated_at=now();
    v_result:=jsonb_build_object('before',v_before,'version',p_target,'active',(p_data->>'active')::boolean);
  elsif p_action='announcement.save' then
    if length(trim(p_data->>'title')) not between 1 and 120 or length(trim(p_data->>'body')) not between 1 and 10000
      or p_data->>'level' not in ('info','warning','critical') then raise exception 'invalid_request'; end if;
    if nullif(p_data->>'ends_at','')::timestamptz <= (p_data->>'starts_at')::timestamptz then raise exception 'invalid_request'; end if;
    select to_jsonb(a) into v_before from public.announcements a where id=p_target::uuid;
    insert into public.announcements(id,title,body,level,active,starts_at,ends_at)
      values(p_target::uuid,trim(p_data->>'title'),trim(p_data->>'body'),p_data->>'level',(p_data->>'active')::boolean,(p_data->>'starts_at')::timestamptz,nullif(p_data->>'ends_at','')::timestamptz)
      on conflict(id) do update set title=excluded.title,body=excluded.body,level=excluded.level,active=excluded.active,starts_at=excluded.starts_at,ends_at=excluded.ends_at;
    v_result:=jsonb_build_object('before',v_before,'announcement',p_target);
  else
    -- Determine the account without acquiring a lower-order lock. All money operations
    -- use the same profile -> wallet -> request/order lock order as translation RPCs.
    if p_action in ('wallet.adjust','order.create') then v_user:=p_target::uuid;
    elsif p_action='translation.refund' then
      select user_id into v_user from public.character_ledger where id=p_target::uuid and type='translation';
    else select user_id into v_user from public.orders where id=p_target::uuid; end if;
    if v_user is null then raise exception 'not_found'; end if;
    perform 1 from public.profiles where id=v_user for share;
    select * into v_wallet from public.wallets where user_id=v_user for update;
    if not found then raise exception 'not_found'; end if;
    if p_action='wallet.adjust' then
      v_amount:=(p_data->>'amount')::bigint;
      if v_amount is null or v_amount=0 or abs(v_amount)>1000000000 then raise exception 'invalid_request'; end if;
      if (p_data->>'expectedBalance')::bigint is distinct from v_wallet.balance then raise exception 'stale_balance'; end if;
    elsif p_action='translation.refund' then
      select * into v_ledger from public.character_ledger where id=p_target::uuid and user_id=v_user and type='translation';
      if exists(select 1 from public.character_ledger where user_id=v_user and idempotency_key='admin-refund:'||p_target) then raise exception 'already_refunded'; end if;
      v_amount:=-v_ledger.characters; v_ledger_type:='refund';
      if v_amount is null or v_amount<=0 then raise exception 'invalid_request'; end if;
    elsif p_action='order.create' then
      select * into v_plan from public.plans where code=p_data->>'plan_code' and active;
      if not found or v_plan.included_characters<=0 then raise exception 'invalid_plan'; end if;
      insert into public.orders(id,user_id,provider,status,plan_code,amount_cents,currency,characters)
        values(p_operation,v_user,'manual','pending',v_plan.code,v_plan.price_cents,v_plan.currency,v_plan.included_characters) returning * into v_order;
      v_result:=jsonb_build_object('orderId',v_order.id,'status','pending','characters',v_order.characters,'amount_cents',v_order.amount_cents);
    else
      select * into v_order from public.orders where id=p_target::uuid for update;
      if v_order.provider<>'manual' then raise exception 'external_order'; end if;
      if v_order.status<>'pending' then raise exception 'order_final'; end if;
      if p_action='order.cancel' then
        update public.orders set status='cancelled' where id=v_order.id;
        v_result:=jsonb_build_object('orderId',v_order.id,'status','cancelled');
      else
        if length(trim(p_data->>'reference')) not between 3 and 120 then raise exception 'invalid_request'; end if;
        update public.orders set status='paid',paid_at=now(),provider_order_id='manual:'||trim(p_data->>'reference') where id=v_order.id;
        v_amount:=v_order.characters; v_ledger_type:='recharge';
      end if;
    end if;
    if v_amount is not null then
      if v_wallet.balance+v_amount<v_wallet.reserved_characters then raise exception 'insufficient_available'; end if;
      update public.wallets set balance=balance+v_amount,lifetime_credited=lifetime_credited+greatest(v_amount,0),
        lifetime_debited=lifetime_debited+greatest(-v_amount,0) where user_id=v_user returning balance into v_balance;
      insert into public.character_ledger(user_id,type,characters,balance_after,idempotency_key,source,note,metadata)
        values(v_user,v_ledger_type,v_amount,v_balance,case when p_action='translation.refund' then 'admin-refund:'||p_target else 'admin:'||p_operation::text end,
          'admin',trim(p_reason),jsonb_build_object('operation_id',p_operation,'original_ledger_id',case when p_action='translation.refund' then p_target else null end)) returning id into v_ledger_id;
      v_result:=jsonb_build_object('userId',v_user,'balanceBefore',v_wallet.balance,'balanceAfter',v_balance,'characters',v_amount,'ledgerId',v_ledger_id);
    end if;
  end if;
  if v_result is null then raise exception 'invalid_request'; end if;
  v_result:=v_result||jsonb_build_object('operationId',p_operation);
  insert into public.admin_audit(id,actor_id,actor_role,action,target_id,reason,input,result)
    values(p_operation,p_actor,v_role,p_action,p_target,trim(p_reason),v_input,v_result);
  return v_result;
end;
$$;
revoke all on function public.admin_read(uuid,text,jsonb) from public,anon,authenticated;
revoke all on function public.admin_mutate(uuid,uuid,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.admin_read(uuid,text,jsonb) to service_role;
grant execute on function public.admin_mutate(uuid,uuid,text,text,text,jsonb) to service_role;
