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
| `migrations/…_avatars.sql` | Social S1: `profiles.avatar_style` (creative avatar spec, checked by `valid_avatar_style`); `get_profile` / `find_profiles` return it |
| `migrations/…_friends.sql` | Social S2: `friendships` (only through `friend_*` RPCs), `my_friends`, `my_inbox`; friends see each other's private profile; blocking ends a friendship; `pg_cron` removes unanswered requests after 30 days |
| `migrations/…_inbox_items.sql` | Social S3: `inbox_items` (kind `reminder`), `send_reminder(name, body)` (friends only, 1–300 chars, ≤ 50/day), `answer_item(item)`; `my_inbox` now also returns waiting items from friends; `pg_cron` removes answered items after a day and unanswered after 30 days |
| `migrations/…_board_invites.sql` | Social S4: inbox kind `board_invite` (payload `{room, title}`, room id `^[a-z0-9]{12,40}$` checked by the table and `send_board_invite(name, room, title)`); friends only, ≤ 50/day (own limit; reminders' limit now counts reminders only), a repeat invite to the same room returns the waiting one; `my_inbox` shows invites for one day |
| `migrations/…_shared_notes.sql` | Social S5: `shared_notes` (data + `rev`) and `shared_note_members` (edit/read), only through `shared_note_create / set_members / save / leave / stop` and `shared_notes_sync`; saving needs the current revision (else the current version comes back for the app to merge); friends only, ≤ 20 people, ≤ 30 new shares/day; unfriending or blocking unlinks; storage policies for `note-images/shared/{note}/…` (members read, owner + editors add, owner removes), counted on the owner's quota (`storage_owner`). **Redeploy `delete-account` after applying this** (it now also removes pictures of notes the user shared) |
| `migrations/…_retention.sql` | Phase 6: `pg_cron` removes reports older than 12 months (as `privacy.html` says) |
| `migrations/…_push.sql` | Phase 7b: `push_subscriptions` (one per device, only push-service addresses, ≤ 10 per account) and `push_schedule` (per reminder, the next ≤ 30 due times, worked out by the app), through `push_subscribe / push_unsubscribe / push_schedule_set`; `push_take_due` / `push_report` for the Edge Function only; `pg_cron` job `ping-push` calls `push_tick()` every minute, which asks the Edge Function to send (URL + secret from Vault) |
| `migrations/…_friend_push.sql` | E1: accessories 0–11 in `valid_avatar_style` (December pack); push for friend events: triggers on `friendships` / `inbox_items` queue ids in `push_events` (only for devices that want the kind, ≤ 5/hour per pair, ≤ 30/hour per sender), `push_subscriptions.muted` set through `push_subscribe(…, muted_kinds)`, `push_take_events` (service role; re-checks pending/friends/blocks), `push_tick` also runs when events wait |
| `migrations/…_support.sql` | Support form: `support_sends` (only when and from which account, no content; removed after 2 days) and `support_slot(who)` for the Edge Function only: ≤ 5/day per account, ≤ 20/day without an account, ≤ 40/day in all |
| `functions/delete-account/` | Phase 6 Edge Function: deletes the signed-in user's files in every bucket, then the user (all rows cascade) |
| `functions/send-due-pushes/` | Phase 7b Edge Function: takes what is due, sends encrypted Web Push (RFC 8291 + VAPID, plain WebCrypto, no library), reports delivered / gone / failed. Since E1 also friend events (texts in sv/en made here) |
| `functions/send-feedback/` | Support form ("Rapportera ett problem"): checks the session or the Turnstile answer, takes a `support_slot`, emails the text, screenshots (JPEG/PNG, ≤ 3) and technical details as plain text to support@pinglapp.com through Brevo's API, Reply-To the address given |
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
- `push.test.mjs` runs `send-due-pushes`' logic (its `/*PUSH-START*/` block): the encryption is decrypted with
  `http_ece` (the reference implementation), the VAPID token is verified, and a run with a stand-in admin client
  sends one message per device and reports delivered / gone / failed. It also runs `sw.js`'s `push` handler.
- `feedback.test.mjs` runs `send-feedback`'s logic (its `/*FEEDBACK-START*/` block) with stand-ins for the admin
  client, Turnstile and Brevo: who may send, what is refused, what the email looks like.

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

## Phase 7b setup (reminders when Pinglapp is closed: Web Push)

Do it on **staging first**, hand-test, then the same on **prod** (with its own keys and secret).

1. **Keys.** In `Ping/tests`: `node make-vapid.mjs`. It prints `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and
   `PUSH_CRON_SECRET`. Put all three in your password manager. One set per project; never reuse staging's on prod.
2. **Migration:** run `migrations/…_push.sql` in the SQL Editor (it enables `pg_net` and schedules the job; until
   step 4 is done the job does nothing).
3. **Edge Function `send-due-pushes`:** Edge Functions → Deploy a new function → Via editor, name `send-due-pushes`,
   paste `functions/send-due-pushes/index.ts`, Deploy; in its Details turn **Verify JWT off** (the cron secret is the
   check). Then Edge Functions → **Secrets**: add `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `PUSH_CRON_SECRET`.
4. **Vault** (SQL Editor), so the minute job can call the function:
   ```sql
   select vault.create_secret('https://<project ref>.supabase.co/functions/v1/send-due-pushes', 'push_function_url');
   select vault.create_secret('<PUSH_CRON_SECRET>', 'push_cron_secret');
   ```
   To change one later: `select vault.update_secret((select id from vault.secrets where name = 'push_cron_secret'), '<new>');`
5. **App:** paste the **public** key into `index.html` → `ACCT_PROJECTS.<project>.vapid` (public by design, like the
   publishable key). Empty = the app shows nothing about push on that project.
6. **Check:** SQL Editor `select * from cron.job_run_details where command like '%push_tick%' order by start_time desc
   limit 5;` (succeeded, every minute) and, after a reminder was due, Edge Functions → `send-due-pushes` → Logs /
   Invocations (200 with `{"ok":1,…}`). `select * from net._http_response order by created desc limit 5;` shows what
   the function answered pg_net.

Costs on the free plan: the job only calls the function in a minute when something is due (at most ~43 000
invocations a month, the free tier has 500 000).

## E1 setup (December avatar items + push for friend events)

Needs Phase 7b on the project. No new keys or secrets. Staging first, hand test, then prod; **both steps before the
app code reaches `main`** (the old app keeps working with the new database and function).

1. **Migration:** run `migrations/20261202000012_friend_push.sql` in the SQL Editor. It widens the avatar check
   (accessories 0–11), adds `push_subscriptions.muted`, the `push_events` queue with its two triggers,
   `push_take_events()`, and replaces `push_subscribe` (one optional argument more) and `push_tick`.
2. **Edge Function:** redeploy `send-due-pushes` with the new `functions/send-due-pushes/index.ts` (Verify JWT stays
   off; same secrets). Deployed before the migration it still sends reminders and logs
   `send-due-pushes events … does not exist` once a minute at most; after the migration that stops.
3. **Check:** from outside, `rpc/push_take_events` with `{"max_rows":1}` answers `42501` (exists, not for the API).
   With two accounts on staging (one with push on): send a friend request; within a minute
   `select kind, taken_at from public.push_events order by id desc limit 3;` shows it taken, and the notification
   arrives ("<name> vill bli din vän"). Clicking it opens Pinglapp on Vänner.

## Support form setup ("Rapportera ett problem")

Settings → Hjälp och feedback (and the footer) opens a form that the Edge Function `send-feedback` emails to
support@pinglapp.com through Brevo's email API, with screenshots attached and Reply going to the address the person
gave. Without the function (or when it fails) the form offers the person's own email app instead, so nothing is lost.
Staging first, hand test, then prod; the app works before these steps too (it just falls back to the email app).

1. **Migration:** run `migrations/20261203000013_support.sql` in the SQL Editor (`support_sends` + `support_slot()`:
   ≤ 5 a day per account, ≤ 20 a day for everyone without an account, ≤ 40 a day in all, so the Brevo quota that
   sign-up and log-in emails need is never used up).
2. **Brevo API key** (not the SMTP key): Brevo → your name (top right) → **SMTP & API** → **API Keys** → Generate a
   new API key, name it `pinglapp-<project>-feedback`. Put it in your password manager. An API key starts with
   `xkeysib-`; the SMTP key (`xsmtpsib-…`) does not work here, Brevo answers `401 Key not found`. If the function's log later
   says *unrecognised IP address*, open Brevo → **Security → Authorised IPs** and turn off blocking of unknown IP
   addresses for the API (Edge Functions don't have fixed addresses).
3. **Turnstile secret:** Cloudflare → Turnstile → the pinglapp.com widget → **Settings** → copy the **Secret key** (the
   same one that is in Supabase → Attack protection → Captcha).
4. **Edge Function `send-feedback`:** Edge Functions → Deploy a new function → Via editor, name `send-feedback`, paste
   `functions/send-feedback/index.ts`, Deploy; in its Details turn **Verify JWT off** (people without an account send
   too; the function checks the session or the robot check itself). Edge Functions → **Secrets**: add `BREVO_API_KEY`
   and `TURNSTILE_SECRET`.
5. **Check:** in the app, Settings → Hjälp och feedback → send a test signed in and one signed out (with a screenshot).
   Both arrive at support@pinglapp.com within a minute, from `no-reply@pinglapp.com`, subject `[Pinglapp] Bugg: …`;
   Reply goes to the address typed in the form. Errors: Edge Functions → `send-feedback` → Logs (`send-feedback brevo
   <status>` = Brevo refused: key or IP setting).

## Backups (prod)

`.github/workflows/backup.yml` runs every Monday at 02:23 UTC (and with **Run workflow**). It dumps the prod database
(schemas `public`, `auth`, `storage`) with `pg_dump`, copies every file in Storage (`avatars`, `note-images`,
`boards`) over Supabase's S3 connection, packs both, **encrypts the pack on the runner** (gpg, AES-256) and keeps it as
a workflow artifact for **30 days** (the privacy policy says deleted accounts are gone from backups within 30 days).
The repo is public and so are artifacts, which is why only the encrypted file ever leaves the runner. Supabase's free
plan has no backups of its own, so this is the only copy of user data outside Supabase.

### Setting it up (once)

Add five **repository secrets** (GitHub → the repo → Settings → Secrets and variables → Actions → New repository
secret):

| Secret | Where to get it |
|---|---|
| `PROD_DB_URL` | Supabase (prod) → **Connect** → **Session pooler** → the URI (port **5432**), with `[YOUR-PASSWORD]` replaced by the database password. If you don't have the password, reset it under Project Settings → Database; the app doesn't use it, so nothing else changes. |
| `PROD_S3_ENDPOINT` | Storage → Settings → **S3 Connection** (turn on "Enable connection via S3 protocol" if it's off) → **Endpoint** |
| `PROD_S3_ACCESS_KEY_ID` | Same page → **New access key** (description e.g. `github-backup`) → Access key ID |
| `PROD_S3_SECRET_ACCESS_KEY` | Shown once, together with the key above |
| `BACKUP_PASSPHRASE` | Make a long random one in your password manager (32+ characters) and keep it there. **Without it no backup can ever be read**, and anyone who has it plus an artifact can read everything. |

Then **Actions → Weekly backup (prod) → Run workflow**. A green run ends with an artifact
`pinglapp-prod-YYYY-MM-DD`. Try decrypting it once (below) so you know the passphrase works.

What the secrets can do: `PROD_DB_URL` gives full access to the database, the S3 key full access to Storage. GitHub
only hands them to workflows in this repo started by its owner (never to forks or pull requests), and masks them in
logs. If one leaks: reset the database password / revoke the S3 key in Supabase and update the secret.

### Reading a backup

1. Actions → Weekly backup (prod) → a run → **Artifacts** → download, and unzip: `pinglapp-prod-YYYY-MM-DD.tar.gz.gpg`.
2. Decrypt (gpg comes with Git for Windows; use Git Bash), then unpack:
   ```sh
   gpg --decrypt pinglapp-prod-YYYY-MM-DD.tar.gz.gpg > backup.tar.gz     # asks for BACKUP_PASSPHRASE
   mkdir backup && tar -xzf backup.tar.gz -C backup
   ```
   Inside: `database.dump` (pg_dump custom format), `storage/<bucket>/<path>` (the files), `about.json`.
3. See what's in the dump without restoring anything: `pg_restore --list backup/database.dump`.
4. To read rows, restore into a **local** Postgres (not a Supabase project):
   ```sh
   createdb pinglapp_restore
   psql -d pinglapp_restore -c "create role anon; create role authenticated; create role service_role;"
   pg_restore --no-owner --no-privileges -d pinglapp_restore backup/database.dump   # some Supabase-only objects may warn; the tables load
   ```
   Then, for example, `select data from public.notes where user_id = '<user id>' and id = '<note id>';`. To give one
   person back something they lost, put it back by hand in the prod SQL Editor (an `insert … on conflict … do update`
   with `updated` set to the current time in milliseconds, so the sync guard accepts it and their devices pull it).
   Delete the local copy when done: it is personal data.

### Restoring everything (disaster recovery, outline)

Only if the prod project itself is lost. Do it with care (and ideally with help):
1. Create a new Supabase project (eu-west-1) and apply every migration in `migrations/` in order, then set it up as in
   this guide (auth settings, SMTP, providers, Turnstile, `delete-account`).
2. Restore the users first: `pg_restore --data-only --no-owner -d "<new session pooler URI>" -n auth -t users -t identities backup/database.dump`.
   The sign-up trigger creates empty `profiles` / `account_private` rows; delete those, then restore the app's data:
   `pg_restore --data-only --no-owner -d "<URI>" -n public backup/database.dump`.
3. Files: for each bucket, `aws s3 sync backup/storage/<bucket> s3://<bucket> --endpoint-url <new endpoint>` (with an S3
   key of the new project). Storage records the files itself; don't restore the `storage` schema. Then run
   `select public.recount_storage_use();`.
4. Point `ACCT_PROJECTS.prod` in `index.html` (and `keep-alive.yml`) at the new project, and update the OAuth
   redirect URLs at Google and Microsoft.

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
