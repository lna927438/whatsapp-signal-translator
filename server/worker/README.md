# Realtime Translator Cloudflare API

Backend gateway for the desktop translator.

## Routes

- `GET /health` — public health check.
- `GET /api/me` — current authenticated user profile + wallet.
- `GET /api/wallet` — current character balance.
- `GET /api/usage` — recent translation usage.
- `POST /api/translate` — authenticated translation + atomic character debit.
- `GET /api/admin/{session,overview,users,user,translations,orders,plans,versions,announcements,roles,audit,operation}` — role-gated administration.
- `POST /api/admin/mutate` — validated, idempotent admin operations with an atomic audit entry.

The admin console is deployed at https://admin.hellodog.net. The live database enforces one owner identity; every request is checked with Supabase Auth and the server-side admin policy. The local preview identity service is not in the Worker bundle. See `../../docs/product/admin-live-v1.md` for the live migration registry, actual provider usage accounting and authorization model. Packages and payments remain closed.

All `/api/*` routes require `Authorization: Bearer <Supabase access token>`.

## Required Worker secrets

Configure these in Cloudflare Workers > Settings > Variables and Secrets as **Secret** values:

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SECRET_KEY`
- `OPENAI_API_KEY`
- `DEEPSEEK_API_KEY`

`OPENAI_MODEL` is a normal non-secret variable and defaults to `gpt-5.6-luna` in `wrangler.jsonc`.

## Translation routing

`TRANSLATION_PROVIDER=openai` selects the primary. `TRANSLATION_FALLBACK_PROVIDER=deepseek`
adds the backup, using `DEEPSEEK_MODEL=deepseek-v4-pro`. Each provider uses its own
Worker secret and fixed official API origin. Omitting the fallback preserves the
single-provider route for rollback.

A request can invoke each provider at most once. Provider timeouts, availability
errors and invalid translations can use the backup. Authentication, disabled
accounts, character limits and safety budgets are checked before either call.
The primary gets at most 8 seconds and the backup at most 12, within a shared
20-second budget starting before authentication. Settlement has separate bounded
retries; an uncertain database reply is checked using the same request ID and
never starts another inference.

The database coordinates circuit cooldowns and one recovery probe across Worker
instances. Content-specific translation validation failures affect that request
without declaring an outage for all users. The selected translation produces one
character debit. Both providers failing releases the character reservation;
each provider attempt retains its own metering receipt and unknown costs remain
covered by conservative budget reservations.

Before enabling dual routing, apply the provider circuit and attempt billing
migrations. Verify the new OpenAI credential with a fixed synthetic translation
and verify fallback in an isolated preview before changing production traffic.
`/health` reports configured routing, not a live inference or billing test.

Never commit real secret values to GitHub.

## Local development

Copy `.dev.vars.example` to `.dev.vars`, fill the values locally, then:

```bash
cd server/worker
npm install
npm run dev
```

## Deploy

```bash
cd server/worker
npm install
npx wrangler login
npm run deploy
```

For production, run the release gate and upload an inactive Worker version for
verification, then deploy its explicit version ID. Keep the previous working
version available for rollback. Store sensitive values only in Worker secrets;
do not use a Git push as a deployment action.
