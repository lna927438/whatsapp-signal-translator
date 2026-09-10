-- Attribute new usage to the server-selected provider. Preserve legacy OpenAI claims.
create or replace function public.complete_translation(
  p_user_id uuid, p_request_id text, p_claim_token uuid,
  p_translation text, p_model text, p_latency_ms integer
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_status text;
  v_request translator_private.translation_requests%rowtype;
  v_balance bigint;
  v_response jsonb;
  v_error text;
begin
  select status into v_status from public.profiles where id = p_user_id for share;
  perform 1 from public.wallets where user_id = p_user_id for update;
  select * into v_request from translator_private.translation_requests
  where user_id = p_user_id and request_id = p_request_id for update;
  if not found then raise exception 'request_not_found'; end if;
  if v_request.claim_token is distinct from p_claim_token then raise exception 'request_id_conflict'; end if;
  if v_request.state <> 'processing' then
    if v_status is distinct from 'active' then raise exception 'account_disabled'; end if;
    return jsonb_build_object('state', v_request.state, 'response', v_request.response, 'error', v_request.error_code);
  end if;
  if v_status is distinct from 'active' then v_error := 'account_disabled';
  elsif v_request.expires_at <= clock_timestamp() then v_error := 'translation_outcome_unknown';
  end if;
  if v_error is not null then
    update public.wallets set reserved_characters = reserved_characters - v_request.source_characters where user_id = p_user_id;
    update translator_private.translation_requests set state = 'failed', error_code = v_error, updated_at = clock_timestamp()
    where user_id = p_user_id and request_id = p_request_id;
    return jsonb_build_object('state', 'failed', 'error', v_error);
  end if;
  if p_translation is null or length(trim(p_translation)) = 0 or length(p_translation) > 100000
     or p_model is null or p_latency_ms is null or p_latency_ms < 0 then
    raise exception 'invalid_request';
  end if;
  update public.wallets set balance = balance - v_request.source_characters,
    reserved_characters = reserved_characters - v_request.source_characters,
    lifetime_debited = lifetime_debited + v_request.source_characters
  where user_id = p_user_id returning balance into v_balance;

  insert into public.character_ledger(user_id, type, characters, balance_after, idempotency_key, source, note, metadata)
  values (p_user_id, 'translation', -v_request.source_characters, v_balance, p_request_id,
          'cloudflare-translate', '实时翻译', v_request.metadata || jsonb_build_object('model', p_model));
  insert into public.translation_usage(user_id, request_id, account_id, conversation_id, provider, model,
    source_language, target_language, source_characters, cache_hit, latency_ms)
  values (p_user_id, p_request_id, v_request.metadata->>'account_id', v_request.metadata->>'conversation_id',
    case when v_request.metadata->>'provider' = 'deepseek' then 'deepseek' else 'openai' end, p_model, v_request.metadata->>'source_language', v_request.metadata->>'target_language',
    v_request.source_characters, false, p_latency_ms);

  v_response := jsonb_build_object('requestId', p_request_id, 'translation', p_translation,
    'sourceCharacters', v_request.source_characters, 'balanceAfter', v_balance,
    'latencyMs', p_latency_ms, 'model', p_model);
  update translator_private.translation_requests set state = 'completed', response = v_response, updated_at = clock_timestamp()
  where user_id = p_user_id and request_id = p_request_id;
  return jsonb_build_object('state', 'completed', 'response', v_response);
end;
$$;

revoke all on function public.complete_translation(uuid,text,uuid,text,text,integer) from public, anon, authenticated;
grant execute on function public.complete_translation(uuid,text,uuid,text,text,integer) to service_role;
