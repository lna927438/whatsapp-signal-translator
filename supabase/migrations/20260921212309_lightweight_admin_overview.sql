-- The frequently refreshed overview needs only operational counts. Keep the
-- existing full admin_read/summary API intact for explicit billing reports.
-- No provider receipt/cost history is read and no ledger row is changed here.
set local lock_timeout = '1s';
set local statement_timeout = '10s';

create function public.admin_overview(p_actor uuid) returns jsonb
language plpgsql stable security invoker set search_path='' as $$
declare
  v_today timestamptz:=((now() at time zone 'Asia/Shanghai')::date::timestamp at time zone 'Asia/Shanghai');
  v_from timestamptz:=timestamp '2026-01-01' at time zone 'Asia/Shanghai';
  v_to timestamptz:=(((now() at time zone 'Asia/Shanghai')::date+1)::timestamp at time zone 'Asia/Shanghai');
begin
  perform translator_private.admin_access(p_actor,'overview');
  return jsonb_build_object(
    'users',(select count(*) from public.profiles),
    'activeUsers',(select count(*) from public.profiles where status='active'),
    'recentClients',(select count(*) from public.profiles where last_seen_at>now()-interval '2 minutes'),
    'todayCharacters',(select coalesce(sum(-characters),0) from public.character_ledger where type='translation' and created_at>=v_today),
    'pendingOrders',(select count(*) from public.orders where status='pending'),
    'pendingTranslations',(select count(*) from translator_private.translation_requests where state='processing'),
    'costs',jsonb_build_object('mismatches',(
      select count(*) from translator_private.admin_translation_rows
      where created_at>=v_from and created_at<v_to and reconciliation='mismatch')),
    'snapshotAt',statement_timestamp());
end;$$;
revoke all on function public.admin_overview(uuid) from public,anon,authenticated;
grant execute on function public.admin_overview(uuid) to service_role;
