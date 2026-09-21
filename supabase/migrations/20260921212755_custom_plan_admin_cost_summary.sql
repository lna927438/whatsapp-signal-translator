-- This report combines optional user/provider predicates over historical rows.
-- Production EXPLAIN measured a parameter-independent cached plan at 2882 ms
-- versus 366 ms with the actual month/provider parameters. Replan this one
-- report function per call; keep all SQL, results, grants and other plans intact.
-- https://www.postgresql.org/docs/current/sql-prepare.html
set local lock_timeout = '1s';
set local statement_timeout = '10s';

alter function translator_private.admin_cost_summary(jsonb)
  set plan_cache_mode = 'force_custom_plan';
