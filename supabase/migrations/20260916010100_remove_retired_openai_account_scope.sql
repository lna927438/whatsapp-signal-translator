-- User-requested removal of the retired OpenAI account association.
-- Apply after the DeepSeek-only Worker configuration and credential removal,
-- so an older scheduled task cannot recreate the retired account scope.
-- Preserve every official amount, period, timestamp and customer ledger row.
update translator_private.provider_bill_snapshots
 set scope='{"retired":true,"accountInformationRemoved":true}'::jsonb
 where provider='openai'
  and scope is distinct from '{"retired":true,"accountInformationRemoved":true}'::jsonb;

delete from translator_private.openai_billing_sync;
