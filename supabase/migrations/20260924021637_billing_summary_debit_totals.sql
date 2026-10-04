-- Automatic dashboard refreshes need character totals and saved statements,
-- not per-attempt historical cost reconstruction. Keep that report on demand.
set local lock_timeout = '1s';
set local statement_timeout = '10s';

create or replace function public.admin_billing_summary(p_actor uuid, p_filter jsonb default '{}')
returns jsonb language plpgsql stable security invoker
set search_path = '' set plan_cache_mode = 'force_custom_plan' set work_mem = '8MB'
-- Whole-account headline sums must not turn underestimated debit groups into
-- thousands of per-request heap/index probes. This setting ends with the call.
set enable_nestloop = 'off' as $$
declare
  v_access text;
  v_zone text;
  v_from timestamptz;
  v_to timestamptz;
  v_provider text;
  v_result jsonb;
begin
  v_access := translator_private.admin_access(p_actor, 'translations');
  if p_filter is null or jsonb_typeof(p_filter) <> 'object'
    or p_filter ? 'userId' then
    raise exception 'invalid_request';
  end if;
  v_zone := coalesce(p_filter->>'timezone', 'Asia/Shanghai');
  if v_zone not in ('UTC', 'Asia/Shanghai') then raise exception 'invalid_request'; end if;
  v_from := coalesce(nullif(p_filter->>'from', '')::date, date '2026-01-01')::timestamp at time zone v_zone;
  v_to := (coalesce(nullif(p_filter->>'to', '')::date, (now() at time zone v_zone)::date) + 1)::timestamp at time zone v_zone;
  if v_to <= v_from or v_to-v_from > interval '3660 days' then raise exception 'invalid_request'; end if;
  v_provider := nullif(p_filter->>'provider', '');
  if v_provider is not null and v_provider not in ('openai', 'deepseek') then raise exception 'invalid_request'; end if;

  -- Only debit groups can contribute nonzero charge/refund totals. Starting
  -- from them preserves orphan groups and request-date precedence while
  -- avoiding the full historical reconciliation view on every refresh.
  with debits as (
    select l.user_id,l.idempotency_key as request_id,-sum(l.characters) as charged,
      min(l.id::text) as ledger_id,max(l.created_at) as created_at
    from public.character_ledger l where l.type='translation'
    group by l.user_id,l.idempotency_key
  ), refunds as (
    select l.user_id,l.metadata->>'original_ledger_id' as ledger_id,sum(l.characters) as refunded
    from public.character_ledger l where l.type='refund'
    group by l.user_id,l.metadata->>'original_ledger_id'
  )
  select jsonb_build_object(
    'totals', jsonb_build_object(
      'charged_characters', coalesce(sum(d.charged), 0),
      'refunded_characters', coalesce(sum(f.refunded), 0)),
    'from', v_from, 'toExclusive', v_to, 'timezone', v_zone,
    'snapshotAt', statement_timestamp())
  into v_result
  from debits d
  join public.profiles p on p.id=d.user_id
  left join translator_private.translation_requests r on r.user_id=d.user_id and r.request_id=d.request_id
  left join public.translation_usage u on u.user_id=d.user_id and u.request_id=d.request_id
  left join refunds f on f.user_id=d.user_id and f.ledger_id=d.ledger_id
  where coalesce(r.created_at,u.created_at,d.created_at) >= v_from
    and coalesce(r.created_at,u.created_at,d.created_at) < v_to
    and (v_provider is null or u.provider = v_provider);

  -- The gateway replaces this marker with only the current provider account's
  -- saved statements, using each provider's native billing period. Never expose
  -- historical account snapshots from the generic cost report here.
  if v_access = 'owner' then
    v_result := v_result || jsonb_build_object('officialBills', jsonb_build_array());
  end if;
  return v_result;
end;
$$;

revoke all on function public.admin_billing_summary(uuid,jsonb) from public, anon, authenticated;
grant execute on function public.admin_billing_summary(uuid,jsonb) to service_role;
