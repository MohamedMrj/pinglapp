# Ping accounts: backend setup

Everything the server side of Ping accounts needs. The plan behind it is `PLAN-accounts.md` (kept outside this repo).
Nothing here contains secrets: only the public **anon** key ever goes into the app. The **service_role** key and the
database password stay in the Supabase dashboard, Edge Function secrets and GitHub secrets.

## What's here

| Path | What it is |
|---|---|
| `migrations/…_core.sql` | Tables, row-level security, grants, newest-wins triggers, sign-up trigger, username/profile/block/report functions |
| `migrations/…_storage.sql` | Buckets (`avatars`, `note-images`, `boards`), own-folder policies, per-user quota |
| `migrations/…_jobs.sql` | `pg_cron`: tombstone cleanup after 90 days, weekly storage recount |

Tests (in `../tests`, run with `npm test`):

- `db.test.mjs` runs the migrations in PGlite (real Postgres in WebAssembly) and checks the rules as the real API roles:
  user A can't read or change user B's data, the server keeps the newest version, quota and usage can't be edited by
  users, blocks and the privacy setting hide profiles, and a deleted account leaves no rows.
- `cloud.test.mjs` tests the app's sync logic (the `/*CLOUD-START*/` block in `index.html`) against an in-memory server
  with the same rules, including two devices editing offline.

## One-time setup (phase 0)

Do these in order. Each step is free except the domain.

1. **Domain.** Buy it, then in the Ping GitHub repo: Settings → Pages → Custom domain, and add the DNS records GitHub
   shows. Turn on "Enforce HTTPS".
2. **Supabase projects.** At supabase.com create two free projects, **ping-staging** and **ping-prod**, both in region
   **Stockholm (eu-north-1)**. Save each database password in a password manager.
   Accept the DPA: Organization settings → Legal documents.
3. **Apply the migrations** to staging first (no Docker needed):
   ```
   npx supabase login
   npx supabase link --project-ref <staging-project-ref>
   npx supabase db push
   ```
   (Or paste the three files, in order, into Dashboard → SQL Editor.)
4. **Email (SMTP).** Create a Brevo or Resend account, add the domain, and add the SPF, DKIM and DMARC records it gives
   you. In Supabase: Authentication → Emails → SMTP settings, sender `no-reply@<domain>`. Raise the email rate limit
   (Authentication → Rate limits) from the default if needed.
5. **Auth settings** (Authentication → URL configuration): Site URL `https://<domain>`, redirect URLs
   `https://<domain>/**` and `http://localhost:*/**` (staging only). Keep "Confirm email" on.
6. **Turnstile.** Cloudflare dashboard → Turnstile → add a site for `<domain>`. Put the secret key in Supabase:
   Authentication → Attack protection → Captcha (Turnstile). The site key goes in the app.
7. **Google sign-in.** Google Cloud console → APIs & Services → Credentials → OAuth client (Web). Authorised redirect URI:
   `https://<project-ref>.supabase.co/auth/v1/callback`. Scopes: email, profile only. Paste the client id and secret
   into Supabase → Authentication → Sign In / Providers → Google.
8. **Microsoft sign-in.** entra.microsoft.com → App registrations → New, "Accounts in any organizational directory and
   personal Microsoft accounts", same redirect URI as Google. Create a client secret and put it in Supabase under the
   provider called **Azure** (tenant URL: leave as `common`).
9. **Check:** sign up a test user on staging with a Gmail address. Phase 0 is done when the confirmation email lands in
   the inbox, not spam.

Then repeat steps 3–8 for **ping-prod** when staging works.

## Things that differ from the plan, and why

- **Quota.** Supabase Storage creates a file's row before it knows the file's size, so a policy can't refuse "this
  upload would go over the limit". Instead each bucket has a per-file size limit (avatar 200 KB, picture 3 MB, board
  15 MB), and uploads are refused once usage has reached the quota. A user can go over by at most one file.
  `used_bytes` is updated by a trigger and recounted weekly.
- **Profiles aren't readable as a table by others.** Other users' profiles are only reachable through
  `get_profile(username)` and `find_profiles(prefix)` (min. 3 characters, max. 20 results), so nobody can list every
  user with one query. Blocks and reports also go through functions, because the app never learns other users' ids.
- **Username changes:** the first change is free, after that one per 30 days.
- **Grants.** Since 30 Oct 2026 Supabase no longer grants new tables to the API automatically, so every table revokes
  everything and grants exactly what the app needs (e.g. users may update only `language` and `time_zone` in
  `account_private`, never `quota_bytes` or `used_bytes`).

## Still to check on the real project

PGlite stands in for Supabase's `auth`, `storage` and `cron` schemas, so these need a check on staging:

- that the `track_storage_use` trigger on `storage.objects` is allowed and sees `metadata->>'size'` after an upload;
- that the `on_auth_user_created` trigger runs for email, Google and Microsoft sign-ups;
- that `pg_cron` jobs show up under Integrations → Cron.
