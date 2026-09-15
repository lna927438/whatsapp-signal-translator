-- A transaction can start before another transaction, then wait for its wallet
-- lock. Record the actual ledger insertion time after that lock is acquired;
-- now() would misleadingly backdate the later debit to transaction start.
-- Existing ledger timestamps, balances, character amounts and IDs stay intact.
alter table public.character_ledger alter column created_at set default clock_timestamp();
