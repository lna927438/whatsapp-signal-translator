# Translation permissions and request coordination

Prepared against commit `586977072d7a2c84c50d4a192bd08f3d1b761ef7`.
This branch prepares the fix. It does not apply production migrations or publish a Worker/installer.

The website Worker builds non-production branches automatically. A review branch/PR
can trigger a website preview even without merging to main. Production API updates
are triggered by main and must follow database migration verification.

## Behavior

- The permissions migration removes ordinary-role table defaults, including TRUNCATE,
  TRIGGER and REFERENCES, then explicitly restores business SELECT permissions,
  the three editable profile columns and owner-scoped device writes. Existing RLS
  ownership rules remain. Trigger functions and server-only wallet/request RPCs are
  not executable by anonymous or ordinary authenticated users.
- The gateway verifies the Supabase access token and reads the server-owned profile
  status. Anything other than `active`, including a missing profile, returns 403.
  Database claim and completion functions independently check status under a row lock.
- Each `(user_id, request_id)` has a durable claim and canonical payload hash. The
  hash includes text, languages, account/conversation, bounded context and model.
  Reusing an ID with different input returns 409 before an upstream call. In-flight
  duplicates return 202; successful duplicates return the previously stored response.
- A claim reserves source characters before inference. Completion debits the wallet,
  writes the ledger and usage, and stores the response in one database transaction.
  A failed usage insert rolls all of those writes back. Lost completion responses can
  safely be retried with the same claim token and translation result.
- Client retries reuse an identical request body and header ID. Platform message IDs
  produce stable IDs across provider instances and token refreshes. Calls without a
  platform message ID represent new operations unless the caller supplies `requestId`.
  The body ID remains authoritative for compatibility with 0.4.3's differing header ID.

## Failure semantics and data retention

- Provider calls time out after 45 seconds. A provider failure is terminal for that
  request ID and releases its reservation; it is never automatically executed again.
  An explicit new operation must use a new ID. This favors avoiding duplicate upstream
  spend over automatically retrying an ambiguous upstream timeout.
- Claims abandoned by a crashed Worker expire after five minutes. The next translation
  request by that user releases expired reservations. Completion also checks expiry.
  Terminal rows remain as tombstones so an expired request cannot be executed again.
- A database outage after the model completed can leave an outcome unknown and a
  temporary reservation. The gateway returns 503; a retry only checks the original
  claim. After expiry the user is not charged. External model costs cannot be rolled
  back across a Worker crash or provider timeout: this is not distributed exactly-once
  execution between OpenAI and PostgreSQL.
- Completed translated output is stored in `translator_private.translation_requests`
  to support replay. Source text/context are not stored there, only a hash and account,
  conversation and language metadata. The private table has RLS enabled and no grants
  to frontend roles. Account deletion cascades to these records. No time-based purge is
  enabled by this change; any future purge must retain request-ID tombstones or return
  an explicit expired-result error instead of silently issuing another translation.
- Local translation cache hits and legacy DeepL/Google providers are unchanged. The
  active-account gate applies to authenticated cloud endpoints, including result replay.

## Verification

Run from the repository root:

```sh
npm ci --prefix tests --ignore-scripts --no-audit --no-fund
npm run typecheck --prefix tests
npm test --prefix tests
```

Tests execute the actual migrations/RPCs in local PGlite (PostgreSQL WASM), with a small
Auth fixture and deliberately broad original grants. Only the historical pgcrypto
extension creation is skipped; `gen_random_uuid` is provided by PostgreSQL itself.
Gateway tests replace ALL outbound fetches with a strict local adapter and a fake model.
They do not read credentials, call paid APIs, send mail or connect to production.
They cover overlapping gateway requests, successful replay, changed-input conflicts,
account isolation, suspension before/during inference, reservation exhaustion/expiry,
lost responses, atomic usage failures, legacy collisions and client retry identities.
The local verification run passed all 25 tests and strict TypeScript checking.

PGlite serializes SQL execution. The separate `npm run test:postgres --prefix tests`
suite uses a native PostgreSQL 17 instance and creates/drops a uniquely named temporary
database. Set `TRANSLATOR_TEST_PG_URL` to a disposable loopback PostgreSQL instance;
remote hosts are refused. The GitHub regression workflow provisions PostgreSQL 17.6,
matching the production major/minor version observed during this review.

Native tests force 20 independent database connections to wait on the same row lock,
then release them together. They verify one claim, one settlement, quota exhaustion,
completion/failure races, a suspension committed while completion is blocked, legacy
debit idempotency, ordinary-role permissions, atomic rollback and gateway/model call
counts. The model remains mocked; native SQL and transaction locks are real.
These tests do not replace a Windows/Cloudflare runtime smoke test. `/health` exposes
`release: translation-coordination-v1` to identify the updated gateway after deployment.

## Controlled rollout (requires separate production approval)

1. Confirm a restorable database backup and compare the current schema to the reviewed
   baseline. Production already has the effects of 0001-0003 but no migration history;
   do NOT blindly run the full migration directory with `db push`.
2. Rehearse only the two new migrations on an isolated PostgreSQL 17/Supabase staging
   database, including concurrent transactions and a real PostgREST service-role call.
3. Apply `20260910144003_harden_translation_permissions.sql`, then
   `20260910144139_coordinate_translation_requests.sql`, each atomically. Check grants,
   RLS, RPC exposure and advisors. No application account or balance is removed.
4. Deploy the API Worker at the reviewed commit. Both API domains target this Worker;
   an old Worker does not have the new replay protection, so avoid leaving mixed
   old/new API versions serving translation traffic after the cutover.
5. Build and validate a Windows installer containing the client retry fix before
   separately approving an R2 release. This branch intentionally does not alter the
   version number or overwrite the existing 0.4.3 download.
6. Verify with controlled test accounts: duplicate request (one model call, one debit),
   different payload with same ID (409), disabled account (403), provider failure (no
   debit), and request accounting consistency.

Rollback must not drop the request table or its tombstones, re-grant ordinary-role
privileges, or clear reservations while workers are active. Prefer a forward fix; if
the API must be rolled back, stop new translations, allow/resolve in-flight claims and
check reservations first. Rolling back to the old Worker restores its known duplicate
model-call behavior even though legacy balance writes still respect reservations.
