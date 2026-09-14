-- Reserve a conservative cost at the configured model's documented peak rate.
-- Unknown outcomes retain a nonzero reservation; customer wallets are untouched.
-- Verified 2026-09-15: https://api-docs.deepseek.com/quick_start/pricing/
create function translator_private.translation_cost_bound(p_metadata jsonb,p_characters integer,
  p_input_upper numeric,p_output_upper numeric,p_at timestamptz)
returns numeric language plpgsql immutable security invoker set search_path='' as $$
declare v_input integer; v_output integer; v_input_rate numeric:=p_input_upper; v_output_rate numeric:=p_output_upper;
begin
  v_input:=coalesce((p_metadata->>'security_input_token_bound')::integer,p_characters*4+16000);
  v_output:=coalesce((p_metadata->>'security_output_token_bound')::integer,16384);
  if v_input not between 1 and 262144 or v_output not between 1 and 16384 then raise exception 'invalid_request'; end if;
  if p_metadata->>'metering_version'='1' and p_metadata->>'provider'='deepseek' and p_at>=timestamptz '2026-09-12 00:00:00+00' then
    if p_metadata->>'requested_model' in ('deepseek-flash','deepseek-v4-flash','deepseek-v4-flash-vision-exp') then
      v_input_rate:=0.30; v_output_rate:=1.20;
    elsif p_metadata->>'requested_model'='deepseek-v4-pro' then
      v_input_rate:=1.32; v_output_rate:=3.96;
    end if;
  end if;
  -- Full output cap and uncached peak input, even during off-peak hours.
  return (v_input*v_input_rate+v_output*v_output_rate)/1000000;
end; $$;
revoke all on function translator_private.translation_cost_bound(jsonb,integer,numeric,numeric,timestamptz) from public,anon,authenticated;
grant execute on function translator_private.translation_cost_bound(jsonb,integer,numeric,numeric,timestamptz) to service_role;

create or replace function translator_private.guard_translation_cost() returns trigger
language plpgsql security invoker set search_path='' as $$
declare v_policy translator_private.security_policy%rowtype; v_user numeric; v_global numeric; v_reserve numeric;
  v_day timestamptz=date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC';
begin
  select * into strict v_policy from translator_private.security_policy where singleton for update;
  if not v_policy.enabled then raise exception 'security_paused'; end if;
  if (select count(*) from translator_private.translation_requests where user_id=new.user_id and created_at>clock_timestamp()-interval '1 minute')>=v_policy.user_requests_per_minute
    or (select count(*) from translator_private.translation_requests where user_id=new.user_id and state='processing' and expires_at>clock_timestamp())>=v_policy.user_concurrency then raise exception 'rate_limited'; end if;
  v_reserve:=translator_private.translation_cost_bound(new.metadata,new.source_characters,
    v_policy.input_upper_usd_per_million,v_policy.output_upper_usd_per_million,new.created_at);
  select coalesce(sum(coalesce(u.cost_usd,r.maximum_usd)) filter(where r.user_id=new.user_id),0),coalesce(sum(coalesce(u.cost_usd,r.maximum_usd)),0)
  into v_user,v_global from translator_private.cost_reservations r left join translator_private.provider_usage u using(user_id,request_id) where r.created_at>=v_day;
  select v_user+coalesce(sum(coalesce(u.cost_usd,1)) filter(where u.user_id=new.user_id),0),v_global+coalesce(sum(coalesce(u.cost_usd,1)),0)
  into v_user,v_global from translator_private.provider_usage u where u.started_at>=v_day
    and not exists(select 1 from translator_private.cost_reservations r where r.user_id=u.user_id and r.request_id=u.request_id);
  if v_user+v_reserve>v_policy.user_daily_usd or v_global+v_reserve>v_policy.global_daily_usd then raise exception 'cost_limit'; end if;
  insert into translator_private.cost_reservations(user_id,request_id,maximum_usd) values(new.user_id,new.request_id,v_reserve);
  return new;
end; $$;

-- Use the same policy lock as new claims, so recovery and admissions serialize.
do $$ begin perform 1 from translator_private.security_policy where singleton for update; end; $$;
update translator_private.cost_reservations r set maximum_usd=least(r.maximum_usd,
  translator_private.translation_cost_bound(t.metadata,t.source_characters,p.input_upper_usd_per_million,p.output_upper_usd_per_million,t.created_at))
from translator_private.translation_requests t,translator_private.security_policy p
where p.singleton and r.user_id=t.user_id and r.request_id=t.request_id
  and t.created_at>=timestamptz '2026-09-12 00:00:00+00'
  and t.metadata->>'metering_version'='1' and t.metadata->>'provider'='deepseek'
  and t.metadata->>'requested_model' in ('deepseek-flash','deepseek-v4-flash','deepseek-v4-flash-vision-exp','deepseek-v4-pro');
