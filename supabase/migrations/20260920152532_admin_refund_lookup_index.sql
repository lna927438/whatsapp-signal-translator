-- Admin summaries use the exact user + original ledger text to sum refunds.
-- A per-user date index scans ordinary debits again for every translated row;
-- this small partial index visits only matching refunds as history grows.
-- Do not change the equality, SUM, ledger data, RLS, grants or billing functions.
-- A competing ledger write makes this migration fail promptly and roll back.
set local lock_timeout = '1s';
set local statement_timeout = '10s';

create index character_ledger_refund_original_idx
  on public.character_ledger (user_id, (metadata ->> 'original_ledger_id'))
  include (characters)
  where type = 'refund';
