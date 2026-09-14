-- Private administrator notes never enter profiles or the client account snapshot.
create table translator_private.user_notes (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  note text not null default '' check (char_length(note)<=1000),
  revision bigint not null default 1 check (revision>0),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);
alter table translator_private.user_notes enable row level security;
revoke all on translator_private.user_notes from public,anon,authenticated;
grant select,insert,update on translator_private.user_notes to service_role;

alter function public.admin_read(uuid,text,jsonb) rename to admin_read_before_notes;
alter function public.admin_read_before_notes(uuid,text,jsonb) set schema translator_private;
create function public.admin_read(p_actor uuid,p_kind text,p_filter jsonb default '{}') returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare v_result jsonb;v_rows jsonb;v_query text:=lower(trim(coalesce(p_filter->>'q','')));
  v_status text:=coalesce(p_filter->>'status','');v_offset integer:=coalesce((p_filter->>'offset')::integer,0);
begin
  if p_kind='users' then
    perform translator_private.admin_access(p_actor,'users');
    if v_offset<0 or v_offset>100000 or length(v_query)>160 then raise exception 'invalid_request';end if;
    select coalesce(jsonb_agg(x),'[]') into v_rows from (
      select p.id,p.email,p.username,p.plan_code,p.status,p.created_at,p.last_seen_at,w.balance,w.reserved_characters,
        coalesce(n.note,'') as admin_note,coalesce(n.revision,0) as note_revision,n.updated_at as note_updated_at,
        (select count(*) from public.devices d where d.user_id=p.id) as devices
      from public.profiles p left join public.wallets w on w.user_id=p.id left join translator_private.user_notes n on n.user_id=p.id
      where (v_query='' or position(v_query in lower(coalesce(p.email,'')||' '||coalesce(p.username,'')||' '||p.id::text||' '||coalesce(n.note,'')))>0)
        and (v_status='' or p.status=v_status)
      order by p.created_at desc,p.id limit 26 offset v_offset
    ) x;
    return jsonb_build_object('rows',coalesce((select jsonb_agg(value) from jsonb_array_elements(v_rows) with ordinality where ordinality<=25),'[]'),
      'hasMore',jsonb_array_length(v_rows)>25,'offset',v_offset,'snapshotAt',statement_timestamp());
  end if;
  v_result:=translator_private.admin_read_before_notes(p_actor,p_kind,p_filter);
  if p_kind='user' then
    return jsonb_set(v_result,'{profile}',(v_result->'profile')||coalesce((select jsonb_build_object('admin_note',n.note,'note_revision',n.revision,'note_updated_at',n.updated_at)
      from translator_private.user_notes n where n.user_id=(p_filter->>'userId')::uuid),jsonb_build_object('admin_note','','note_revision',0,'note_updated_at',null)));
  end if;
  return v_result;
end;$$;
revoke all on function public.admin_read(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.admin_read(uuid,text,jsonb) to service_role;

alter function public.admin_mutate(uuid,uuid,text,text,text,jsonb) rename to admin_mutate_before_notes;
alter function public.admin_mutate_before_notes(uuid,uuid,text,text,text,jsonb) set schema translator_private;
create function public.admin_mutate(p_actor uuid,p_operation uuid,p_action text,p_target text,p_reason text,p_data jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare v_role text;v_prior public.admin_audit%rowtype;v_input jsonb;v_before translator_private.user_notes%rowtype;v_result jsonb;v_note text;
begin
  if p_action is distinct from 'user.note' then return translator_private.admin_mutate_before_notes(p_actor,p_operation,p_action,p_target,p_reason,p_data);end if;
  v_role:=translator_private.admin_access(p_actor,'users.write');
  if p_operation is null or p_target is null or p_reason is null or length(trim(p_reason)) not between 3 and 500
    or p_data is null or jsonb_typeof(p_data)<>'object' or jsonb_typeof(p_data->'note') is distinct from 'string'
    or jsonb_typeof(p_data->'expectedRevision') is distinct from 'number' or p_data->>'expectedRevision' !~ '^\d{1,15}$'
    or p_data-'note'-'expectedRevision'<>'{}'::jsonb or length(p_data->>'note')>1000 then raise exception 'invalid_request';end if;
  v_note:=trim(p_data->>'note');
  v_input:=jsonb_build_object('action',p_action,'target',p_target,'reason',p_reason,'data',p_data);
  perform pg_advisory_xact_lock(72491011);
  select * into v_prior from public.admin_audit where id=p_operation;
  if found then
    if v_prior.actor_id<>p_actor or v_prior.input<>v_input then raise exception 'operation_conflict';end if;
    return v_prior.result||jsonb_build_object('replayed',true);
  end if;
  perform 1 from public.profiles where id=p_target::uuid for share;
  if not found then raise exception 'not_found';end if;
  select * into v_before from translator_private.user_notes where user_id=p_target::uuid for update;
  if coalesce(v_before.revision,0)<>(p_data->>'expectedRevision')::bigint then raise exception 'stale_note';end if;
  insert into translator_private.user_notes(user_id,note,revision,updated_at,updated_by)
    values(p_target::uuid,v_note,1,now(),p_actor)
    on conflict(user_id) do update set note=excluded.note,revision=translator_private.user_notes.revision+1,updated_at=now(),updated_by=p_actor;
  select jsonb_build_object('userId',user_id,'note',note,'revision',revision,'updatedAt',updated_at,'previousNote',coalesce(v_before.note,''))
    into v_result from translator_private.user_notes where user_id=p_target::uuid;
  insert into public.admin_audit(id,actor_id,actor_role,action,target_id,reason,input,result)
    values(p_operation,p_actor,v_role,p_action,p_target,p_reason,v_input,v_result);
  return v_result;
end;$$;
revoke all on function public.admin_mutate(uuid,uuid,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.admin_mutate(uuid,uuid,text,text,text,jsonb) to service_role;
