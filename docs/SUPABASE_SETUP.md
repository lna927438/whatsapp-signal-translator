# Supabase setup for Realtime Translator

## 1. Check project region first

The project region is permanent for the life of the project. If the primary production audience is in the United States, recreate the project in a US region before storing production data. If Asia-Pacific is intentional, keep the current project.

## 2. Apply the initial schema

1. Open the Supabase project dashboard.
2. Open **SQL Editor** from the left sidebar.
3. Click **New query**.
4. Open `supabase/migrations/0001_core_schema.sql` from this repository.
5. Copy the entire SQL file into the SQL Editor.
6. Click **Run**.
7. Confirm that the query completes without errors.

The migration creates:

- `profiles`
- `wallets`
- `character_ledger`
- `translation_usage`
- `plans`
- `orders`
- `devices`
- `app_versions`
- `announcements`
- `admin_roles`
- RLS policies
- signup bootstrap trigger
- atomic character credit/debit RPCs that are restricted to `service_role`

## 3. Verify tables

Open **Table Editor** and confirm the tables above exist.

Do not manually add user balances from the Windows client. Wallet writes must eventually go through the server using the service role.

## 4. Configure Auth

Open **Authentication > Providers > Email**.

Recommended initial settings:

- Email/password: enabled
- Confirm email: enabled for production; may be temporarily disabled during local testing
- Secure password rules: enabled

Then configure **Authentication > URL Configuration** later after the website domain is ready.

## 5. Get public project configuration

Open **Project Settings > API** (or the project API keys page in the current Supabase UI).

Record locally:

- Project URL
- Publishable / anon key

These values may be used by the website and desktop app.

Never expose or commit:

- `service_role` key
- database password
- SMTP credentials
- Stripe secret keys
- OpenAI API key

The `service_role` key belongs only in the backend server environment.

## 6. Suggested backend architecture

Desktop/Web -> Cloudflare Worker -> Supabase/OpenAI/Stripe

The backend should own:

- username/email login bridge
- authenticated `/translate`
- balance checks
- atomic character debit
- Stripe webhook handling
- admin actions
- version/update endpoints

## 7. Next implementation milestone

After the schema is applied successfully:

1. Build Cloudflare Worker API.
2. Add Supabase Auth register/login/refresh/logout.
3. Migrate desktop v0.4 local auth to online auth.
4. Replace local character wallet with server wallet.
5. Move the OpenAI API key out of the desktop app and into Worker secrets.
6. Build the website user center and admin panel.
