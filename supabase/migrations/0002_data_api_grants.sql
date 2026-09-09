-- Explicit Data API grants for projects created with
-- "Automatically expose new tables" disabled.
--
-- Supabase now requires explicit Postgres grants before tables/functions in
-- public are reachable through PostgREST / supabase-js. RLS still controls
-- which rows authenticated users can access.

-- Schema access
grant usage on schema public to authenticated, service_role;

-- Signed-in desktop users: least-privilege access. RLS policies from
-- 0001_core_schema.sql continue to restrict access to each user's own rows.
grant select, update on table public.profiles to authenticated;
grant select on table public.wallets to authenticated;
grant select on table public.character_ledger to authenticated;
grant select on table public.translation_usage to authenticated;
grant select on table public.plans to authenticated;
grant select on table public.orders to authenticated;
grant select, insert, update on table public.devices to authenticated;
grant select on table public.app_versions to authenticated;
grant select on table public.announcements to authenticated;
grant select on table public.admin_roles to authenticated;

-- Cloudflare Worker / future admin backend. The Supabase secret key maps to
-- service_role; keep this key server-side only. service_role bypasses RLS, so
-- these grants deliberately cover the backend operations required by the API.
grant select, insert, update, delete on table public.profiles to service_role;
grant select, insert, update, delete on table public.wallets to service_role;
grant select, insert, update, delete on table public.character_ledger to service_role;
grant select, insert, update, delete on table public.translation_usage to service_role;
grant select, insert, update, delete on table public.plans to service_role;
grant select, insert, update, delete on table public.orders to service_role;
grant select, insert, update, delete on table public.devices to service_role;
grant select, insert, update, delete on table public.app_versions to service_role;
grant select, insert, update, delete on table public.announcements to service_role;
grant select, insert, update, delete on table public.admin_roles to service_role;

-- The wallet RPCs were granted in 0001, but repeat them here so this migration
-- is self-healing if the project was created under the newer Supabase defaults.
grant execute on function public.consume_characters(uuid,bigint,text,text,text,jsonb) to service_role;
grant execute on function public.credit_characters(uuid,bigint,text,text,text,jsonb) to service_role;

-- Keep anonymous clients out of account/billing data.
revoke all on table public.profiles from anon;
revoke all on table public.wallets from anon;
revoke all on table public.character_ledger from anon;
revoke all on table public.translation_usage from anon;
revoke all on table public.plans from anon;
revoke all on table public.orders from anon;
revoke all on table public.devices from anon;
revoke all on table public.app_versions from anon;
revoke all on table public.announcements from anon;
revoke all on table public.admin_roles from anon;
