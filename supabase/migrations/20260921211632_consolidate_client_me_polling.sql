-- The gateway first validates the bearer token with Auth. This service-only
-- routine bundles the account polling work without caching status or balances.
create function public.client_me(p_user_id uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare v_profile jsonb; v_wallet jsonb;
begin
  select jsonb_build_object('id',p.id,'username',p.username,'email',p.email,
    'plan_code',p.plan_code,'status',p.status,'created_at',p.created_at)
  into v_profile from public.profiles p where p.id=p_user_id and p.status='active';
  if v_profile is null then raise exception 'account_disabled'; end if;

  -- Return, rather than raise, so rejected attempts still increment the same
  -- existing per-user window. It must not be possible to poll a free rate limit.
  if not public.security_rate_limit(p_user_id,'api') then
    return jsonb_build_object('error','rate_limited');
  end if;

  perform public.touch_client_presence(p_user_id);
  select jsonb_build_object('balance',w.balance,'reserved_characters',w.reserved_characters,
    'lifetime_credited',w.lifetime_credited,'lifetime_debited',w.lifetime_debited,
    'lifetime_adjusted_down',w.lifetime_adjusted_down,'updated_at',w.updated_at)
  into v_wallet from public.wallets w where w.user_id=p_user_id;

  return jsonb_build_object('profile',v_profile,'wallet',coalesce(v_wallet,
    jsonb_build_object('balance',0,'lifetime_credited',0,'lifetime_debited',0,
      'lifetime_adjusted_down',0,'updated_at',null)));
end; $$;
revoke all on function public.client_me(uuid) from public,anon,authenticated;
grant execute on function public.client_me(uuid) to service_role;
