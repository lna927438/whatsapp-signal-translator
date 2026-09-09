# Realtime Translator Cloudflare API

Backend gateway for the desktop translator.

## Routes

- `GET /health` — public health check.
- `GET /api/me` — current authenticated user profile + wallet.
- `GET /api/wallet` — current character balance.
- `GET /api/usage` — recent translation usage.
- `POST /api/translate` — authenticated translation + atomic character debit.

All `/api/*` routes require `Authorization: Bearer <Supabase access token>`.

## Required Worker secrets

Configure these in Cloudflare Workers > Settings > Variables and Secrets as **Secret** values:

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SECRET_KEY`
- `OPENAI_API_KEY`

`OPENAI_MODEL` is a normal non-secret variable and defaults to `gpt-5.6-luna` in `wrangler.jsonc`.

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

For production, prefer Cloudflare's GitHub integration and store sensitive values only in Worker secrets.
