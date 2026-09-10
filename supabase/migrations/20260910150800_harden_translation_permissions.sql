-- Re-establish application grants instead of inheriting broad project defaults.
-- No data is deleted and existing ownership RLS policies remain in place.
revoke create on schema public from public, anon, authenticated;
grant usage on schema public to authenticated, service_role;

revoke all on table
  public.profiles, public.wallets, public.character_ledger, public.translation_usage,
  public.plans, public.orders, public.devices, public.app_versions,
  public.announcements, public.admin_roles
from public, anon, authenticated;

-- Table-level REVOKE does not remove older column-level grants.
revoke all (id, username, email, display_name, avatar_url, plan_code, status, created_at, updated_at)
on public.profiles from public, anon, authenticated;

grant select on table
  public.profiles, public.wallets, public.character_ledger, public.translation_usage,
  public.plans, public.orders, public.devices, public.app_versions,
  public.announcements, public.admin_roles
to authenticated;
grant update (username, display_name, avatar_url) on public.profiles to authenticated;
grant insert, update on public.devices to authenticated;

revoke all on function public.consume_characters(uuid,bigint,text,text,text,jsonb) from public, anon, authenticated;
revoke all on function public.credit_characters(uuid,bigint,text,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.consume_characters(uuid,bigint,text,text,text,jsonb) to service_role;
grant execute on function public.credit_characters(uuid,bigint,text,text,text,jsonb) to service_role;

-- Trigger invocation continues to work; clients cannot call these as RPCs.
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.sync_profile_email_from_auth() from public, anon, authenticated;
revoke all on function public.set_updated_at() from public, anon, authenticated;
alter function public.set_updated_at() set search_path = '';

-- Some projects contain this automatically installed event trigger.
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    execute 'revoke all on function public.rls_auto_enable() from public, anon, authenticated';
  end if;
end;
$$;
