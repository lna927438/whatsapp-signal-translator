-- Version-scoped client notices. Existing unversioned rows remain unchanged.
-- Keep the original mutation chain: wallet, security and billing wrappers keep
-- their authorization; notice edits retain one atomic audit/revision transaction.
alter table public.announcements add column release_version text
 check(release_version is null or (length(release_version)<=80 and release_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-(alpha|beta|rc)\.(0|[1-9][0-9]*))?$'));
create or replace function public.client_notices(p_user_id uuid) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare v_rows jsonb;
begin
  if not exists(select 1 from public.profiles where id=p_user_id and status='active') then raise exception 'account_disabled';end if;
  select coalesce(jsonb_agg(x order by x.starts_at desc,x.id),'[]'::jsonb) into v_rows from (
    select a.id,a.title,a.body,a.level,a.popup,a.action,a.revision,a.starts_at,a.ends_at,a.release_version as "releaseVersion",
      (r.displayed_at is not null) as displayed,(r.dismissed_at is not null) as dismissed
    from public.announcements a left join translator_private.announcement_receipts r
      on r.announcement_id=a.id and r.user_id=p_user_id and r.revision=a.revision
    where a.active and a.starts_at<=now() and (a.ends_at is null or a.ends_at>now())
      and (a.target_user_id is null or a.target_user_id=p_user_id)
    order by a.starts_at desc,a.id limit 100
  ) x;
  return jsonb_build_object('notices',v_rows,'serverTime',now());
end;$$;
revoke all on function public.client_notices(uuid) from public,anon,authenticated;
grant execute on function public.client_notices(uuid) to service_role;

create or replace function translator_private.admin_mutate_before_security(p_actor uuid,p_operation uuid,p_action text,p_target text,p_reason text,p_data jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare v_role text;v_prior public.admin_audit%rowtype;v_before public.announcements%rowtype;v_input jsonb;v_result jsonb;v_recipient uuid;v_revision integer;
begin
  if p_action is distinct from 'notice.save' then return translator_private.admin_mutate_before_notices(p_actor,p_operation,p_action,p_target,p_reason,p_data);end if;
  v_role:=translator_private.admin_access(p_actor,'content.write');
  if p_operation is null or p_target is null or p_reason is null or length(trim(p_reason)) not between 3 and 500
    or p_data is null or jsonb_typeof(p_data)<>'object'
    or not (p_data ?& array['title','body','level','active','starts_at','ends_at','popup','audience','recipient','action','expectedRevision'])
    or p_data-array['title','body','level','active','starts_at','ends_at','popup','audience','recipient','action','expectedRevision','releaseVersion']<>'{}'::jsonb
    or (p_data ? 'releaseVersion' and (jsonb_typeof(p_data->'releaseVersion') is distinct from 'string' or length(p_data->>'releaseVersion')>80 or p_data->>'releaseVersion' !~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-(alpha|beta|rc)\.(0|[1-9][0-9]*))?$'))
    or jsonb_typeof(p_data->'title') is distinct from 'string' or length(trim(p_data->>'title')) not between 1 and 120
    or jsonb_typeof(p_data->'body') is distinct from 'string' or length(trim(p_data->>'body')) not between 1 and 3000
    or coalesce(p_data->>'level','') not in ('info','warning','critical')
    or jsonb_typeof(p_data->'active') is distinct from 'boolean' or jsonb_typeof(p_data->'popup') is distinct from 'boolean'
    or coalesce(p_data->>'audience','') not in ('all','user') or coalesce(p_data->>'action','') not in ('none','website','download')
    or jsonb_typeof(p_data->'recipient') is distinct from 'string' or length(p_data->>'recipient')>254
    or jsonb_typeof(p_data->'expectedRevision') is distinct from 'number' or p_data->>'expectedRevision' !~ '^\d{1,9}$'
    or nullif(p_data->>'starts_at','')::timestamptz is null
    or nullif(p_data->>'ends_at','')::timestamptz<= (p_data->>'starts_at')::timestamptz then raise exception 'invalid_request';end if;
  v_input:=jsonb_build_object('action',p_action,'target',p_target,'reason',p_reason,'data',p_data);
  perform pg_advisory_xact_lock(72491011);
  select * into v_prior from public.admin_audit where id=p_operation;
  if found then
    if v_prior.actor_id<>p_actor or v_prior.input<>v_input then raise exception 'operation_conflict';end if;
    return v_prior.result||jsonb_build_object('replayed',true);
  end if;
  if p_data->>'audience'='user' then
    select id into v_recipient from public.profiles where lower(email)=lower(trim(p_data->>'recipient'));
    if v_recipient is null then raise exception 'invalid_recipient';end if;
  elsif trim(p_data->>'recipient')<>'' then raise exception 'invalid_request';end if;
  select * into v_before from public.announcements where id=p_target::uuid for update;
  if coalesce(v_before.revision,0)<>(p_data->>'expectedRevision')::integer then raise exception 'stale_notice';end if;
  v_revision:=coalesce(v_before.revision,0)+1;
  insert into public.announcements(id,title,body,level,active,starts_at,ends_at,popup,target_user_id,action,revision,updated_at,release_version)
    values(p_target::uuid,trim(p_data->>'title'),trim(p_data->>'body'),p_data->>'level',(p_data->>'active')::boolean,
      (p_data->>'starts_at')::timestamptz,nullif(p_data->>'ends_at','')::timestamptz,(p_data->>'popup')::boolean,v_recipient,p_data->>'action',v_revision,now(),case when p_data ? 'releaseVersion' then p_data->>'releaseVersion' else v_before.release_version end)
    on conflict(id) do update set title=excluded.title,body=excluded.body,level=excluded.level,active=excluded.active,
      starts_at=excluded.starts_at,ends_at=excluded.ends_at,popup=excluded.popup,target_user_id=excluded.target_user_id,
      action=excluded.action,revision=excluded.revision,updated_at=excluded.updated_at,release_version=excluded.release_version;
  v_result:=jsonb_build_object('announcement',p_target,'revision',v_revision,'active',(p_data->>'active')::boolean,
    'releaseVersion',case when p_data ? 'releaseVersion' then p_data->>'releaseVersion' else v_before.release_version end,'audience',p_data->>'audience','recipient',nullif(p_data->>'recipient',''),'before',to_jsonb(v_before));
  insert into public.admin_audit(id,actor_id,actor_role,action,target_id,reason,input,result)
    values(p_operation,p_actor,v_role,p_action,p_target,p_reason,v_input,v_result);
  return v_result;
end;$$;
revoke all on function translator_private.admin_mutate_before_security(uuid,uuid,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function translator_private.admin_mutate_before_security(uuid,uuid,text,text,text,jsonb) to service_role;
