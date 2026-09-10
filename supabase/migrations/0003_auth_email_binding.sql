-- Keep the public profile email synchronized with Supabase Auth and prevent ordinary clients
-- from modifying server-owned account fields such as email, plan_code, and status.

create or replace function public.sync_profile_email_from_auth()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.email is distinct from old.email then
    update public.profiles
    set email = new.email,
        updated_at = now()
    where id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_email_updated on auth.users;
create trigger on_auth_user_email_updated
after update of email on auth.users
for each row execute function public.sync_profile_email_from_auth();

-- Revoke broad profile updates granted by the earlier baseline migration.
-- Authenticated users may edit only cosmetic/self-service profile fields.
revoke update on table public.profiles from authenticated;
grant update (username, display_name, avatar_url) on public.profiles to authenticated;

-- Existing row-level policy still limits updates to auth.uid() = id.
-- service_role retains its full table privileges from 0002_data_api_grants.sql.
