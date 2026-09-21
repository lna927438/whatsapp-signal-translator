-- Scope each reconciliation input before its FULL JOIN. Preserve all output,
-- orphan usage/debit handling, one-statement snapshot, grants and billing rows.
-- Function replacement acquires no locks on user data and aborts promptly if busy.
set local lock_timeout = '1s';
set local statement_timeout = '10s';

CREATE OR REPLACE FUNCTION public.account_snapshot(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'wallet', (select to_jsonb(w) - 'user_id' from public.wallets w where w.user_id = p_user_id),
    'usage', coalesce((select jsonb_agg(u order by u.created_at desc) from (
      select request_id, source_language, target_language, source_characters, provider, model, latency_ms, created_at
      from public.translation_usage where user_id = p_user_id order by created_at desc limit 100
    ) u), '[]'::jsonb),
    'ledger', coalesce((select jsonb_agg(l order by l.created_at desc) from (
      select idempotency_key as request_id, type, characters, balance_after, created_at
      from public.character_ledger where user_id = p_user_id order by created_at desc limit 100
    ) l), '[]'::jsonb),
    'reconciliation', jsonb_build_object(
      'translationDebit', (select coalesce(-sum(characters), 0) from public.character_ledger where user_id = p_user_id and type = 'translation'),
      'usageCharacters', (select coalesce(sum(source_characters), 0) from public.translation_usage where user_id = p_user_id),
      'duplicateDebits', (select count(*) from (select idempotency_key from public.character_ledger where user_id = p_user_id and type = 'translation' group by idempotency_key having count(*) <> 1) d),
      'mismatchedRequests', (select count(*) from (select * from public.translation_usage where user_id = p_user_id) u full join (
        select user_id, idempotency_key, -sum(characters) as charged
        from public.character_ledger where type = 'translation' and user_id = p_user_id group by user_id, idempotency_key
      ) l on l.user_id = u.user_id and l.idempotency_key = u.request_id
      where coalesce(u.user_id, l.user_id) = p_user_id
        and (u.request_id is null or l.idempotency_key is null or u.source_characters <> l.charged))
    ),
    'snapshotAt', statement_timestamp()
  ) where exists (select 1 from public.profiles where id = p_user_id and status = 'active');
$function$
