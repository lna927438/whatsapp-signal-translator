-- Reduce repeated historical scans in admin overview and cost reports.
-- Preserve monetary arithmetic, reconciliation, role permissions and ledger data.
-- DDL fails promptly rather than holding up active translation requests.
set local lock_timeout = '1s';
set local statement_timeout = '10s';
-- Aggregate refund history once rather than probing it for every translation.
-- Ordinary text equality, per-user scope, numeric sums and NULL behavior are unchanged.
create or replace view translator_private.admin_translation_rows with (security_invoker=true) as
 WITH debits AS (
         SELECT character_ledger.user_id,
            character_ledger.idempotency_key AS request_id,
            count(*) AS debit_count,
            - sum(character_ledger.characters) AS charged,
            min(character_ledger.id::text) AS ledger_id,
            max(character_ledger.created_at) AS created_at
           FROM public.character_ledger
          WHERE character_ledger.type = 'translation'::public.ledger_type
          GROUP BY character_ledger.user_id, character_ledger.idempotency_key
        ), rows AS (
         SELECT COALESCE(r.user_id, u.user_id, d.user_id) AS user_id,
            COALESCE(r.request_id, u.request_id, d.request_id) AS request_id,
            COALESCE(r.source_characters, u.source_characters) AS source_characters,
            u.source_characters AS usage_characters,
            COALESCE(u.cache_hit, false) AS cache_hit,
            COALESCE(r.state,
                CASE
                    WHEN u.id IS NOT NULL THEN 'completed'::text
                    ELSE 'unknown'::text
                END) AS state,
                CASE
                    WHEN r.error_code ~ '^[a-z_]{1,64}$'::text THEN r.error_code
                    ELSE NULL::text
                END AS error_code,
            u.provider,
            u.model,
            u.source_language,
            u.target_language,
            u.latency_ms,
            COALESCE(d.charged, 0::numeric) AS charged,
            COALESCE(d.debit_count, 0::bigint) AS debit_count,
            d.ledger_id,
            r.expires_at,
            COALESCE(r.created_at, u.created_at, d.created_at) AS created_at,
                CASE
                    WHEN (r.state = ANY (ARRAY['processing'::text, 'failed'::text])) AND COALESCE(d.charged, 0::numeric) <> 0::numeric THEN 'mismatch'::text
                    WHEN r.state = 'processing'::text THEN 'pending'::text
                    WHEN r.state = 'failed'::text AND COALESCE(d.charged, 0::numeric) = 0::numeric THEN 'not_charged'::text
                    WHEN r.state = 'completed'::text AND r.billable_characters = 0 AND COALESCE(d.charged, 0::numeric) = 0::numeric AND (EXISTS ( SELECT 1
                       FROM translator_private.translation_repairs x
                      WHERE x.user_id = r.user_id AND x.repair_request_id = r.request_id)) THEN 'free'::text
                    WHEN u.cache_hit AND COALESCE(d.charged, 0::numeric) = 0::numeric THEN 'cache'::text
                    WHEN u.source_characters = 0 AND COALESCE(d.charged, 0::numeric) = 0::numeric THEN 'free'::text
                    WHEN COALESCE(d.debit_count, 0::bigint) = 1 AND u.source_characters::numeric = d.charged AND COALESCE(r.source_characters, u.source_characters)::numeric = d.charged AND COALESCE(r.state, 'completed'::text) = 'completed'::text THEN 'matched'::text
                    ELSE 'mismatch'::text
                END AS reconciliation
           FROM translator_private.translation_requests r
             FULL JOIN public.translation_usage u ON u.user_id = r.user_id AND u.request_id = r.request_id
             FULL JOIN debits d ON d.user_id = COALESCE(r.user_id, u.user_id) AND d.request_id = COALESCE(r.request_id, u.request_id)
        )
 SELECT rows.user_id,
    rows.request_id,
    rows.source_characters,
    rows.usage_characters,
    rows.cache_hit,
    rows.state,
    rows.error_code,
    rows.provider,
    rows.model,
    rows.source_language,
    rows.target_language,
    rows.latency_ms,
    rows.charged,
    rows.debit_count,
    rows.ledger_id,
    rows.expires_at,
    rows.created_at,
    rows.reconciliation,
    p.email,
    p.username,
    COALESCE(refunds.characters, 0::numeric) AS refunded
   FROM rows
     JOIN public.profiles p ON p.id = rows.user_id
     LEFT JOIN (
       SELECT user_id, metadata->>'original_ledger_id' AS original_ledger_id,
         sum(characters) AS characters
       FROM public.character_ledger
       WHERE type='refund'::public.ledger_type
       GROUP BY user_id, metadata->>'original_ledger_id'
     ) refunds ON refunds.user_id=rows.user_id AND refunds.original_ledger_id=rows.ledger_id;


create or replace function translator_private.admin_cost_summary(p_filter jsonb) returns jsonb
language plpgsql stable security invoker set search_path='' set plan_cache_mode='force_custom_plan' set work_mem='8MB' as $$
declare v_from timestamptz;v_to timestamptz;v_user uuid;v_provider text;v_zone text;v_result jsonb;
begin
  v_zone:=coalesce(p_filter->>'timezone','Asia/Shanghai');if v_zone not in ('UTC','Asia/Shanghai') then raise exception 'invalid_request';end if;
  v_from:=coalesce(nullif(p_filter->>'from','')::date,date '2026-01-01')::timestamp at time zone v_zone;
  v_to:=(coalesce(nullif(p_filter->>'to','')::date,(now() at time zone v_zone)::date)+1)::timestamp at time zone v_zone;
  if v_to<=v_from or v_to-v_from>interval '3660 days' then raise exception 'invalid_request';end if;
  v_user:=nullif(p_filter->>'userId','')::uuid;v_provider:=nullif(p_filter->>'provider','');
  if v_provider is not null and v_provider not in ('openai','deepseek') then raise exception 'invalid_request';end if;
  -- User scope is safe here; a date predicate is not. Legacy provider time
  -- may fall in the report while the request's preferred created_at does not.
  with ledger_rows as materialized (
    select r.user_id,r.request_id,r.source_characters,r.provider,
      r.charged,r.refunded,r.created_at,r.reconciliation,r.email
    from translator_private.admin_translation_rows r
    where v_user is null or r.user_id=v_user
  ), attempt_keys as materialized (
    -- Any historical attempt suppresses the legacy fallback, even when that
    -- attempt is outside the selected reporting period. Never date-filter keys.
    select a.user_id,a.request_id from translator_private.provider_attempt_usage a
    where v_user is null or a.user_id=v_user
    group by a.user_id,a.request_id
  ), item_source as (
    -- Keep the original request-existence join. Only unused projections vanish.
    select a.user_id,a.request_id,a.provider,a.started_at as occurred_at,
      a.input_tokens,a.cached_tokens,a.cache_write_tokens,a.output_tokens,a.total_tokens,
      a.cost_status,a.cost_usd,a.finished_at as recorded_at
    from translator_private.provider_attempt_usage a
    join translator_private.translation_requests r using(user_id,request_id)
    union all
    select r.user_id,r.request_id,coalesce(p.provider,r.provider),coalesce(p.started_at,r.created_at),
      p.input_tokens,p.cached_tokens,null::bigint,p.output_tokens,p.total_tokens,
      coalesce(p.cost_status,'historical_unavailable'),p.cost_usd,p.recorded_at
    from ledger_rows r left join translator_private.provider_usage p using(user_id,request_id)
    where not exists(select 1 from attempt_keys a
      where a.user_id=r.user_id and a.request_id=r.request_id)
  ), items as materialized (
    select i.* from item_source i where i.occurred_at>=v_from and i.occurred_at<v_to
      and (v_user is null or i.user_id=v_user) and (v_provider is null or i.provider=v_provider)
  ), item_keys as (
    -- One row per key preserves EXISTS semantics even across multiple attempts.
    -- Ordinary equality deliberately does not match a NULL orphan request_id.
    select user_id,request_id,bool_or(cost_usd>0) as has_positive_cost
    from items group by user_id,request_id
  ), requests as (
    select r.*,coalesce(k.has_positive_cost,false) as has_positive_cost,
      case when v_provider is null or r.provider=v_provider then r.charged else 0 end as selected_charged,
      case when v_provider is null or r.provider=v_provider then r.refunded else 0 end as selected_refunded
    from ledger_rows r left join item_keys k on k.user_id=r.user_id and k.request_id=r.request_id
    where r.created_at>=v_from and r.created_at<v_to
      and (v_provider is null or r.provider=v_provider or k.user_id is not null)
  ),
  cost_totals as(select count(*) filter(where cost_status<>'not_attempted') as provider_requests,
    coalesce(sum(cost_usd),0) as known_cost_usd,
    case when count(*) filter(where cost_usd is null)=0 then coalesce(sum(cost_usd),0) end as cost_usd,
    count(*) filter(where cost_usd is null) as unpriced_requests,
    count(*) filter(where cost_usd is not null) as priced_requests,
    count(*) filter(where cost_status='historical_unavailable') as historical_requests,
    count(*) filter(where cost_status in ('pending','unknown_response','historical_unavailable','missing_usage')) as missing_receipt_requests,
    count(*) filter(where cost_status in ('unknown_price','unknown_time','unknown_service_tier')) as missing_price_requests,
    count(*) filter(where cost_status in ('missing_cache','missing_cache_write')) as missing_cache_requests,
    count(*) filter(where total_tokens is not null and cost_status<>'not_attempted') as metered_requests,
    sum(total_tokens) as total_tokens,sum(input_tokens) as input_tokens,sum(cached_tokens) as cached_tokens,
    sum(cache_write_tokens) as cache_write_tokens,sum(output_tokens) as output_tokens,max(recorded_at) as last_usage_at from items),
  request_totals as(select count(*) as requests,coalesce(sum(selected_charged),0) as charged_characters,
    coalesce(sum(selected_refunded),0) as refunded_characters,sum(source_characters) as source_characters,
    count(*) filter(where reconciliation='mismatch') as mismatches,
    count(*) filter(where charged=0 and has_positive_cost) as provider_only_requests from requests),
  user_requests as(select user_id,email,count(*) as requests,sum(selected_charged) as charged_characters from requests group by user_id,email),
  user_costs as(select user_id,sum(total_tokens) as total_tokens,coalesce(sum(cost_usd),0) as known_cost_usd,
    case when count(*) filter(where cost_usd is null)=0 then coalesce(sum(cost_usd),0) end as cost_usd,
    count(*) filter(where cost_usd is null) as unpriced_requests from items group by user_id),
  day_requests as(select (created_at at time zone v_zone)::date as day,count(*) as requests,sum(selected_charged) as charged_characters from requests group by 1),
  day_costs as(select (occurred_at at time zone v_zone)::date as day,
    sum(total_tokens) as total_tokens,coalesce(sum(cost_usd),0) as known_cost_usd,
    case when count(*) filter(where cost_usd is null)=0 then coalesce(sum(cost_usd),0) end as cost_usd,
    count(*) filter(where cost_usd is null) as unpriced_requests from items group by 1),
  providers as(select provider,count(*) filter(where cost_status<>'not_attempted') as requests,
    coalesce(sum(cost_usd),0) as known_cost_usd,
    case when count(*) filter(where cost_usd is null)=0 then coalesce(sum(cost_usd),0) end as cost_usd,
    count(*) filter(where cost_usd is null) as unpriced_requests,sum(total_tokens) as total_tokens from items group by provider)
  select jsonb_build_object('totals',(select to_jsonb(c)||to_jsonb(r)||jsonb_build_object('cost_usd_exact',c.cost_usd::text,'known_cost_usd_exact',c.known_cost_usd::text) from cost_totals c,request_totals r),
    'users',(select coalesce(jsonb_agg(coalesce(to_jsonb(r),'{}')||coalesce(to_jsonb(c),'{}')||jsonb_build_object('email',p.email,'known_cost_usd_exact',c.known_cost_usd::text,'cost_usd_exact',c.cost_usd::text) order by p.email),'[]')
      from user_requests r full join user_costs c using(user_id) join public.profiles p on p.id=coalesce(r.user_id,c.user_id)),
    'days',(select coalesce(jsonb_agg(coalesce(to_jsonb(r),'{}')||coalesce(to_jsonb(c),'{}')||jsonb_build_object('known_cost_usd_exact',c.known_cost_usd::text,'cost_usd_exact',c.cost_usd::text) order by coalesce(r.day,c.day) desc),'[]') from day_requests r full join day_costs c using(day)),
    'providers',(select coalesce(jsonb_agg(to_jsonb(p)||jsonb_build_object('cost_usd_exact',p.cost_usd::text,'known_cost_usd_exact',p.known_cost_usd::text) order by provider),'[]') from providers p),
    'providerBalance',(select to_jsonb(b) from translator_private.provider_balance_snapshots b where v_user is null order by fetched_at desc limit 1),
    'officialBills',(select coalesce(jsonb_agg((to_jsonb(b)-'actor_id'-'scope')||jsonb_build_object('official_usd_exact',b.official_usd::text)),'[]') from
      (select distinct on(provider) * from translator_private.provider_bill_snapshots where period_from=v_from and period_to=v_to
        and (v_provider is null or provider=v_provider) and v_user is null order by provider,fetched_at desc)b),
    'from',v_from,'toExclusive',v_to,'timezone',v_zone,'snapshotAt',clock_timestamp(),
    'pricingSource','https://developers.openai.com/api/docs/pricing','priceVersion','provider-attempts-usd-2026-09-15',
    'pricingSources',jsonb_build_array(jsonb_build_object('provider','openai','url','https://developers.openai.com/api/docs/pricing'),
      jsonb_build_object('provider','deepseek','url','https://api-docs.deepseek.com/quick_start/pricing/'))) into v_result;
  return v_result;
end;$$;

-- Settings are scoped to these admin reads, never to client requests or the server.
alter function public.admin_overview(uuid) set work_mem = '8MB';
alter function public.admin_overview(uuid) set plan_cache_mode = 'force_custom_plan';