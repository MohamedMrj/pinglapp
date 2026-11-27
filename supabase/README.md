# Pinglapp accounts: backend setup

Everything the server side of Pinglapp accounts needs. The plan behind it is `PLAN-accounts.md` (kept outside this repo).
Nothing here contains secrets: only the public **anon** key ever goes into the app. The **service_role** key and the
database password stay in the Supabase dashboard, Edge Function secrets and GitHub secrets.

## What's here

| Path | What it is |
|---|---|
| `migrations/…_core.sql` | Tables, row-level security, grants, newest-wins triggers, sign-up trigger, username/profile/block/report functions |
| `migrations/…_storage.sql` | Buckets (`avatars`, `note-images`, `boards`), own-folder policies, per-user quota |
| `migrations/…_jobs.sql` | `pg_cron`: tombstone cleanup after 90 days, weekly storage recount |
| `migrations/…_profiles.sql` | Phase 5: `avatar_path` may only name your own avatar file, `{id}/avatar.webp?v={n}` |
| `migrations/…_retention.sql` | Phase 6: `pg_cron` removes reports older than 12 months (as `privacy.html` says) |
| `functions/delete-account/` | Phase 6 Edge Function: deletes the signed-in user's files in every bucket, then the user (all rows cascade) |
| `templates/` | The auth email templates pasted into Authentication → Emails (copies, for the record) |

Tests (in `../tests`, run with `npm test`):

- `db.test.mjs` runs the migrations in PGlite (real Postgres in WebAssembly) and checks the rules as the real API roles:
  user A can't read or change user B's data, the server keeps the newest version, quota and usage can't be edited by
  users, blocks and the privacy setting hide profiles, and a deleted account leaves no rows.
- `cloud.test.mjs` tests the app's sync logic (the `/*CLOUD-START*/` block in `index.html`) against an in-memory server
  with the same rules, including two devices editing offline.
- `delete-account.test.mjs` runs the Edge Function's logic (its `/*DELETE-START*/` block) against a stand-in admin
  client: wrong username or no session deletes nothing; files in sub-folders and beyond 1000 go; if files can't be
  removed, the user isn't deleted either.

## Phase 6 setup (account settings, delete account)

1. **Migration:** run `migrations/…_retention.sql` in the SQL Editor.
2. **Edge Function `delete-account`.** Either the dashboard: Edge Functions → Deploy a new function → Via editor, name
   `delete-account`, paste `functions/delete-account/index.ts`, Deploy; then in the function's Details turn
   **Verify JWT off**. Or the CLI: `npx supabase functions deploy delete-account --no-verify-jwt --project-ref <ref>`.
   Verify JWT is off on purpose: the function checks the session itself with `auth.getUser()` (which also works with
   the new non-JWT API keys) and answers CORS preflight requests, which carry no session. It uses the
   `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` secrets that Supabase gives every function; nothing to add.
   Allowed browser origins are listed at the top of the file (`pinglapp.com`, `localhost:8080`).
3. **Authentication → Sign In / Providers → Email:** keep **Secure email change** on (a link to both the old and the
   new address), and turn **Secure password change** on (a session older than 24 hours must type a code sent by email
   before the password changes; the app shows the code field when Supabase asks). The code arrives with the
   **Reauthentication** template, which must contain `{{ .Token }}` (ours does).
4. **Hand test:** change email (both links), change password (with a fresh session: no code; to see the code step,
   test with a session older than a day), download all my data, then delete a throwaway account and check in the
   dashboard that its user, its rows and its files (Storage, all three buckets) are gone.

## One-time setup (phase 0)

Do these in order. Each step is free except the domain.

1. **Domain: done (2026-11-25).** `pinglapp.com` is served by GitHub Pages from the `pinglapp` repo. Its DNS is in
   Cloudflare, every record set to **DNS only** (a proxied record makes Cloudflare proxy the whole name). The old
   address `mohamedmrj.github.io/ping/` hands people's data over; see `../MOVING.md`. The old `ping` repo must never
   get a custom domain.
2. **Supabase projects.** At supabase.com create two free projects, **pinglapp-staging** and **pinglapp-prod**, both in region
   **Stockholm (eu-north-1)**. Save each database password in a password manager.
   Accept the DPA: Organization settings → Legal documents.
3. **Apply the migrations** to staging first (no Docker needed):
   ```
   npx supabase login
   npx supabase link --project-ref <staging-project-ref>
   npx supabase db push
   ```
   (Or paste the files, in order, into Dashboard → SQL Editor. Each later migration is applied once, on its own.)
4. **Email (SMTP).** Create a Brevo or Resend account, add the domain, and add the SPF, DKIM and DMARC records it gives
   you in Cloudflare (DNS only). In Supabase: Authentication → Emails → SMTP settings, sender `no-reply@pinglapp.com`. Raise the email rate limit
   (Authentication → Rate limits) from the default if needed.
5. **Auth settings** (Authentication → URL configuration): Site URL `https://pinglapp.com`, redirect URLs
   `https://pinglapp.com/**` and `http://localhost:*/**` (staging only). Keep "Confirm email" on.
6. **Turnstile (robot check).** The app side is built: log-in, sign-up and forgot-password send a Turnstile answer
   whenever the project in `ACCT_PROJECTS` (in `index.html`) has a `turnstile` site key. **Do it in this order**, or
   nobody can log in for a while:
   1. Cloudflare dashboard → Turnstile → Add widget. Hostnames: `pinglapp.com`, and `localhost` for local testing
      (if Cloudflare won't accept `localhost`, test locally with Cloudflare's always-pass test keys instead). Widget
      mode: **Managed**. Pre-clearance: off.
   2. Put the **site key** in `ACCT_PROJECTS.<project>.turnstile`, then publish it (commit and push). Check in the
      browser that the dialog still logs you in (no captcha is required yet, so a missing answer can't break anything).
   3. Then put the **secret key** in Supabase: Authentication → Attack protection → Enable Captcha protection →
      provider Turnstile. From now on Supabase refuses log-in, sign-up and reset without an answer.
   Turning it off again is the same in reverse: switch Captcha off in Supabase first, then remove the site key.
   Cloudflare's script (`challenges.cloudflare.com`) loads only when one of those three forms is shown; mention
   Cloudflare as a processor in the privacy policy (phase 6).
7. **Google sign-in.** Google Cloud console → APIs & Services → Credentials → OAuth client (Web). Authorised redirect URI:
   `https://<project-ref>.supabase.co/auth/v1/callback`. Scopes: email, profile only. Paste the client id and secret
   into Supabase → Authentication → Sign In / Providers → Google.
8. **Microsoft sign-in.** entra.microsoft.com → App registrations → New, "Accounts in any organizational directory and
   personal Microsoft accounts", same redirect URI as Google. Create a client secret and put it in Supabase under the
   provider called **Azure** (tenant URL: leave as `common`).
9. **Check:** sign up a test user on staging with a Gmail address. Phase 0 is done when the confirmation email lands in
   the inbox, not spam.

Then repeat steps 3–8 for **pinglapp-prod** when staging works.

## Trying accounts on your own computer

Which project the app uses (`acctProjectName()` in `index.html`; projects are listed in `ACCT_PROJECTS`):

| Address | Project |
|---|---|
| `pinglapp.com` | **prod** (`qezhjjcxarugwgqahlik`, eu-west-1) |
| `localhost` / `127.0.0.1` (a local copy) | **staging** (`bdvoxzkozkrxefpwuzkr`, eu-west-1) |
| anything else, e.g. the old address | none (no accounts) |

Opening any address once with `?accounts=staging` or `?accounts=prod` switches that browser to that project, and
`?accounts=off` switches accounts off there. The choice is remembered until `?accounts=default`. So a local copy tries
prod with http://localhost:8080/?accounts=prod (prod must then list `http://localhost:8080/**` as a redirect URL).

1. In the staging project: Authentication → URL Configuration. Site URL `https://pinglapp.com`; under Redirect URLs add
   `http://localhost:8080/**` and `https://pinglapp.com/**`. Without this, links in emails go to the wrong address.
2. In a terminal: `cd Ping/tests` then `npm run serve`, and open http://localhost:8080.
3. Click **Logga in** in the header. Until SMTP is set up (step 4 above), Supabase's own test mailer sends only a few
   emails an hour, from Supabase's address, and they may land in spam. Open the links in the same browser.

## Things that differ from the plan, and why

- **Quota.** Supabase Storage creates a file's row before it knows the file's size, so a policy can't refuse "this
  upload would go over the limit". Instead each bucket has a per-file size limit (avatar 200 KB, picture 3 MB, board
  15 MB), and uploads are refused once usage has reached the quota. A user can go over by at most one file.
  `used_bytes` is updated by a trigger and recounted weekly.
- **Profiles aren't readable as a table by others.** Other users' profiles are only reachable through
  `get_profile(username)` and `find_profiles(prefix)` (min. 3 characters, max. 20 results), so nobody can list every
  user with one query. Blocks and reports also go through functions, because the app never learns other users' ids.
- **Username changes:** the first change is free, after that one per 30 days.
- **Avatars are public files.** The `avatars` bucket is public so pictures load without a signed link. So anyone
  with a picture's address can see it, even if the profile is hidden (the app says so), and the address contains the
  owner's user id. That's acceptable: no rule depends on ids being secret; everything checks `auth.uid()`.
  `avatar_path` carries `?v={time}` so a new picture gets a new address and no cache shows the old one.
- **Grants.** Since 30 Oct 2026 Supabase no longer grants new tables to the API automatically, so every table revokes
  everything and grants exactly what the app needs (e.g. users may update only `language` and `time_zone` in
  `account_private`, never `quota_bytes` or `used_bytes`).

## Checked on the real project (staging, 2026-11-25)

PGlite stands in for Supabase's `auth`, `storage` and `cron` schemas, so these were checked by hand on staging:

- ✅ email sign-up and confirmation; `on_auth_user_created` made the profile (the username from sign-up showed up);
- ✅ sync of reminders, notes, settings, pictures and boards between two browsers;
- ✅ the storage meter showed real usage, so the `track_storage_use` trigger on `storage.objects` works;
- ✅ email through Brevo SMTP (sender `no-reply@pinglapp.com`), 2026-11-25;
- ✅ Turnstile site key in the app; log-in still works (Captcha not yet required in Supabase);
- ⬜ Google and Microsoft sign-up (providers enabled 2026-11-27, not tried yet);
- ⬜ profiles (phase 5): apply `…_profiles.sql`, then edit profile, upload a picture, find, block, report;
- ⬜ `pg_cron` jobs under Integrations → Cron (three after phase 6: `ping-tombstones`, `ping-recount-storage`, `ping-old-reports`);
- ✅ phase 6: `…_retention.sql`, `delete-account` deployed, secure password change on; the hand test above (2026-11-27).
