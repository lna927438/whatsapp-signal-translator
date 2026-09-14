-- Original-request reconciliation only. Never creates a request or calls AI.
create function public.translation_status(p_user_id uuid, p_request_id text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_request translator_private.translation_requests%rowtype; v_status text;
begin
  select status into v_status from public.profiles where id = p_user_id for share;
  if v_status is distinct from 'active' then raise exception 'account_disabled'; end if;
  perform 1 from public.wallets where user_id = p_user_id for update;
  select * into v_request from translator_private.translation_requests
    where user_id = p_user_id and request_id = p_request_id for update;
  if not found then return jsonb_build_object('state', 'not_found'); end if;
  if v_request.state = 'processing' and v_request.expires_at <= clock_timestamp() then
    update public.wallets set reserved_characters = reserved_characters - v_request.source_characters where user_id = p_user_id;
    update translator_private.translation_requests set state = 'failed', error_code = 'translation_outcome_unknown', updated_at = clock_timestamp()
      where user_id = p_user_id and request_id = p_request_id returning * into v_request;
  end if;
  return jsonb_build_object('state', v_request.state, 'response', v_request.response,
    'requestId', v_request.request_id, 'sourceCharacters', v_request.source_characters, 'error', v_request.error_code);
end;
$$;

-- One statement snapshot: the wallet and its history cannot come from different commits.
create function public.account_snapshot(p_user_id uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'wallet', (select to_jsonb(w) - 'user_id' from public.wallets w where w.user_id = p_user_id),
    'usage', coalesce((select jsonb_agg(u order by u.created_at desc) from (
      select request_id, source_characters, provider, model, latency_ms, created_at
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
      'mismatchedRequests', (select count(*) from public.translation_usage u full join (
        select user_id, idempotency_key, -sum(characters) as charged
        from public.character_ledger where type = 'translation' group by user_id, idempotency_key
      ) l on l.user_id = u.user_id and l.idempotency_key = u.request_id
      where coalesce(u.user_id, l.user_id) = p_user_id
        and (u.request_id is null or l.idempotency_key is null or u.source_characters <> l.charged))
    ),
    'snapshotAt', statement_timestamp()
  ) where exists (select 1 from public.profiles where id = p_user_id and status = 'active');
$$;

revoke all on function public.translation_status(uuid,text) from public, anon, authenticated;
revoke all on function public.account_snapshot(uuid) from public, anon, authenticated;
grant execute on function public.translation_status(uuid,text) to service_role;
grant execute on function public.account_snapshot(uuid) to service_role;
