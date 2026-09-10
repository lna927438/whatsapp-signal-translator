-- Preserve only allowlisted provider failure categories; never store raw provider messages.
create or replace function public.fail_translation(p_user_id uuid, p_request_id text, p_claim_token uuid, p_error_code text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_request translator_private.translation_requests%rowtype;
  v_code text := case when p_error_code = any(array['provider_auth','provider_quota','provider_model','provider_permission','provider_request','provider_rate_limit','provider_timeout','provider_unavailable','provider_empty']) then p_error_code else 'translation_failed' end;
begin
  perform 1 from public.profiles where id = p_user_id for share;
  perform 1 from public.wallets where user_id = p_user_id for update;
  select * into v_request from translator_private.translation_requests
  where user_id = p_user_id and request_id = p_request_id for update;
  if not found then raise exception 'request_not_found'; end if;
  if v_request.claim_token is distinct from p_claim_token then raise exception 'request_id_conflict'; end if;
  if v_request.state = 'processing' then
    update public.wallets set reserved_characters = reserved_characters - v_request.source_characters where user_id = p_user_id;
    update translator_private.translation_requests set state = 'failed', error_code = v_code, updated_at = clock_timestamp()
    where user_id = p_user_id and request_id = p_request_id;
    return jsonb_build_object('state', 'failed', 'error', v_code);
  end if;
  return jsonb_build_object('state', v_request.state, 'response', v_request.response, 'error', v_request.error_code);
end;
$$;

revoke all on function public.fail_translation(uuid,text,uuid,text) from public, anon, authenticated;
grant execute on function public.fail_translation(uuid,text,uuid,text) to service_role;
