-- Administrative reductions are adjustments, never translation consumption.
-- Existing counters and ledger rows are unchanged by this migration.
alter table public.wallets add column lifetime_adjusted_down bigint not null default 0
  check (lifetime_adjusted_down >= 0);

alter function public.admin_mutate(uuid,uuid,text,text,text,jsonb) rename to admin_mutate_before_wallet_remove;
alter function public.admin_mutate_before_wallet_remove(uuid,uuid,text,text,text,jsonb) set schema translator_private;
create function public.admin_mutate(p_actor uuid,p_operation uuid,p_action text,p_target text,p_reason text,p_data jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
  v_role text; v_input jsonb; v_prior public.admin_audit%rowtype;
  v_user uuid; v_wallet public.wallets%rowtype; v_amount bigint; v_expected bigint;
  v_balance bigint; v_ledger uuid; v_result jsonb;
begin
  if p_action not in ('wallet.add','wallet.remove','wallet.adjust') or p_action is null then
    return translator_private.admin_mutate_before_wallet_remove(p_actor,p_operation,p_action,p_target,p_reason,p_data);
  end if;
  if p_operation is null or p_actor is null or p_target is null
    or p_target !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or p_reason is null or length(trim(p_reason)) not between 3 and 500
    or p_data is null or jsonb_typeof(p_data) <> 'object' then raise exception 'invalid_request'; end if;
  -- Share the lock with role changes and earlier admin operations. A revoked
  -- administrator cannot slip through while waiting for the operation lock.
  perform pg_advisory_xact_lock(72491011);
  v_role:=translator_private.admin_access(p_actor,'billing.write');
  v_input:=jsonb_build_object('action',p_action,'target',p_target,'reason',trim(p_reason),'data',p_data);
  select * into v_prior from public.admin_audit where id=p_operation;
  if found then
    if v_prior.actor_id<>p_actor or v_prior.input<>v_input then raise exception 'operation_conflict'; end if;
    return v_prior.result||jsonb_build_object('replayed',true);
  end if;
  if jsonb_typeof(p_data->'amount') is distinct from 'number'
    or p_data->>'amount' !~ '^-?\d{1,10}$' then raise exception 'invalid_request'; end if;
  v_amount:=(p_data->>'amount')::bigint;
  if p_action in ('wallet.add','wallet.remove') and v_amount not between 1 and 1000000000
    or p_action='wallet.adjust' and (v_amount=0 or v_amount not between -1000000000 and 1000000000)
    then raise exception 'invalid_request'; end if;
  if p_action='wallet.add' then
    if p_data - 'amount' <> '{}'::jsonb then raise exception 'invalid_request'; end if;
  else
    if p_data - 'amount' - 'expectedBalance' <> '{}'::jsonb
      or jsonb_typeof(p_data->'expectedBalance') is distinct from 'number'
      or p_data->>'expectedBalance' !~ '^\d{1,16}$'
      then raise exception 'invalid_request'; end if;
    v_expected:=(p_data->>'expectedBalance')::bigint;
    if v_expected > 9007199254740991 then raise exception 'invalid_request'; end if;
  end if;
  if p_action='wallet.remove' then v_amount:=-v_amount; end if;
  v_user:=p_target::uuid;
  perform 1 from public.profiles where id=v_user for share;
  if not found then raise exception 'not_found'; end if;
  -- Translation reservations/completions lock this same wallet row. Validate
  -- the current balance and reservation while holding that lock, then journal
  -- wallet + ledger + immutable audit in the same database transaction.
  select * into v_wallet from public.wallets where user_id=v_user for update;
  if not found then raise exception 'not_found'; end if;
  if v_expected is not null and v_wallet.balance<>v_expected then raise exception 'stale_balance'; end if;
  if v_wallet.balance+v_amount<v_wallet.reserved_characters then raise exception 'insufficient_available'; end if;
  if v_wallet.balance+v_amount>9007199254740991
    or v_wallet.lifetime_credited+greatest(v_amount,0)>9007199254740991
    or v_wallet.lifetime_adjusted_down+greatest(-v_amount,0)>9007199254740991
    then raise exception 'invalid_request'; end if;
  update public.wallets set balance=balance+v_amount,
    lifetime_credited=lifetime_credited+greatest(v_amount,0),
    lifetime_adjusted_down=lifetime_adjusted_down+greatest(-v_amount,0)
    where user_id=v_user returning balance into v_balance;
  insert into public.character_ledger(user_id,type,characters,balance_after,idempotency_key,source,note,metadata)
    values(v_user,'adjustment',v_amount,v_balance,'admin:'||p_operation,'admin-console',trim(p_reason),
      jsonb_build_object('admin_operation_id',p_operation,'action',p_action,'balance_before',v_wallet.balance)) returning id into v_ledger;
  v_result:=jsonb_build_object('operationId',p_operation,'userId',v_user,'characters',v_amount,
    'balanceBefore',v_wallet.balance,'balanceAfter',v_balance,'ledgerId',v_ledger,
    'reservedCharacters',v_wallet.reserved_characters,'availableAfter',v_balance-v_wallet.reserved_characters);
  insert into public.admin_audit(id,actor_id,actor_role,action,target_id,reason,input,result)
    values(p_operation,p_actor,v_role,p_action,p_target,trim(p_reason),v_input,v_result);
  return v_result;
end; $$;
revoke all on function public.admin_mutate(uuid,uuid,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.admin_mutate(uuid,uuid,text,text,text,jsonb) to service_role;
