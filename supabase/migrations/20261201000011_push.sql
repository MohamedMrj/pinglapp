-- Pinglapp phase 7b: reminders that arrive when Pinglapp is closed (Web Push). See PLAN-mobile.md.
--
-- * push_subscriptions: one row per device that switched it on (the browser's push address and keys). A device that
--   signs in to another account moves over to it. At most 10 devices per account (the oldest goes).
-- * push_schedule: per reminder, the next few times it is due (≤ 30, within 40 days), worked out by the app (which has
--   the full scheduler: repeats, weekdays, cron, clock changes, snooze). The server never parses schedules; it only
--   sends what is due. A repeating reminder therefore keeps arriving for ~30 days without the app being opened; any
--   sync tops the list up. Accounts without a device keep no schedule at all.
-- * Every minute pg_cron calls push_tick(), which asks the Edge Function `send-due-pushes` to send. The function's URL
--   and a shared secret are kept in Vault (set by hand, see supabase/README.md → "Phase 7b setup"); until they are
--   set, push_tick() does nothing.
-- Both tables are invisible to the API roles; the app uses the functions below, the Edge Function uses service_role.

create extension if not exists pg_net;

create table public.push_subscriptions (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users on delete cascade,
  -- only the browsers' own push services, so the sender can't be pointed at any other address
  endpoint   text not null unique check (char_length(endpoint) <= 1000 and endpoint ~ ('^https://(fcm\.googleapis\.com|'
               || '[a-z0-9.-]+\.push\.apple\.com|updates\.push\.services\.mozilla\.com|[a-z0-9.-]+\.notify\.windows\.com)/')),
  p256dh     text not null check (p256dh ~ '^[A-Za-z0-9_-]{80,100}$'),
  auth       text not null check (auth ~ '^[A-Za-z0-9_-]{16,30}$'),
  lang       text not null default 'sv' check (lang in ('sv', 'en')),
  created_at timestamptz not null default now(),
  last_ok_at timestamptz,
  failures   int not null default 0
);
create index push_subscriptions_user on public.push_subscriptions (user_id, created_at);
alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon, authenticated;
grant all on public.push_subscriptions to service_role;

create table public.push_schedule (
  user_id     uuid not null references auth.users on delete cascade,
  reminder_id text not null check (char_length(reminder_id) between 1 and 100),
  title       text not null check (char_length(title) between 1 and 300),
  times       timestamptz[] not null check (cardinality(times) between 1 and 30),
  sent_until  timestamptz not null default '-infinity',     -- times up to here have been sent (or skipped)
  next_at     timestamptz,                                  -- the first time after sent_until; null = nothing left
  updated_at  timestamptz not null default now(),
  primary key (user_id, reminder_id)
);
create index push_schedule_next on public.push_schedule (next_at) where next_at is not null;
alter table public.push_schedule enable row level security;
revoke all on public.push_schedule from anon, authenticated;
grant all on public.push_schedule to service_role;

-- Save (or refresh) this device's push subscription. Returns true.
create or replace function public.push_subscribe(endpoint_url text, key_p256dh text, key_auth text, lang_code text)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'not signed in' using errcode = '42501'; end if;
  insert into public.push_subscriptions as s (user_id, endpoint, p256dh, auth, lang)
  values (me, endpoint_url, key_p256dh, key_auth, case when lang_code = 'en' then 'en' else 'sv' end)
  on conflict (endpoint) do update
    set user_id = me, p256dh = excluded.p256dh, auth = excluded.auth, lang = excluded.lang, failures = 0,
        created_at = case when s.user_id = me then s.created_at else now() end;
  delete from public.push_subscriptions where id in (
    select id from public.push_subscriptions where user_id = me order by created_at desc, id desc offset 10);
  return true;
end $$;

-- Forget this device (switched off, signed out). True if it was there.
create or replace function public.push_unsubscribe(endpoint_url text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  delete from public.push_subscriptions s where s.endpoint = endpoint_url and s.user_id = auth.uid();
  return found;
end $$;

-- Set when reminders are due. `items`: [{ "id": text, "title": text, "times": [epoch ms, …] }], at most 500 per call.
-- An item with no times (done, deleted, nothing coming) is removed. `replace`: also remove every reminder not listed
-- (a full upload). Times in the past or more than 40 days ahead are dropped; at most 30 per reminder are kept.
-- Returns whether the account has a device to send to; without one nothing is kept and the app can wait.
create or replace function public.push_schedule_set(items jsonb, replace boolean default false) returns boolean
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); it jsonb; ts timestamptz[]; ttl text;
begin
  if me is null then raise exception 'not signed in' using errcode = '42501'; end if;
  if jsonb_typeof(items) is distinct from 'array' or jsonb_array_length(items) > 500 then
    raise exception 'items must be an array of at most 500' using errcode = 'P0001', hint = 'push_items_bad';
  end if;
  if not exists (select 1 from public.push_subscriptions where user_id = me) then
    delete from public.push_schedule where user_id = me;
    return false;
  end if;
  if replace then
    delete from public.push_schedule where user_id = me
       and reminder_id not in (select x ->> 'id' from jsonb_array_elements(items) x where x ? 'id');
  end if;
  for it in select * from jsonb_array_elements(items) loop
    if jsonb_typeof(it -> 'id') is distinct from 'string' or char_length(it ->> 'id') not between 1 and 100 then
      raise exception 'bad item id' using errcode = 'P0001', hint = 'push_items_bad';
    end if;
    ttl := left(btrim(coalesce(it ->> 'title', '')), 300);
    if ttl = '' then ttl := '…'; end if;
    select array_agg(x.t order by x.t) into ts from (
      select a.t from (
        select distinct to_timestamp((v #>> '{}')::double precision / 1000) as t
          from jsonb_array_elements(case when jsonb_typeof(it -> 'times') = 'array' then it -> 'times' else '[]' end) v
         where jsonb_typeof(v) = 'number') a
       where a.t > now() and a.t < now() + interval '40 days'
       order by a.t limit 30) x;
    if ts is null then
      delete from public.push_schedule where user_id = me and reminder_id = it ->> 'id';
    else
      insert into public.push_schedule as p (user_id, reminder_id, title, times, next_at, updated_at)
      values (me, it ->> 'id', ttl, ts, ts[1], now())
      on conflict (user_id, reminder_id) do update
        set title = excluded.title, times = excluded.times, updated_at = now(),
            next_at = (select min(x.t) from unnest(excluded.times) x(t) where x.t > p.sent_until);
    end if;
  end loop;
  if (select count(*) from public.push_schedule where user_id = me) > 2000 then
    raise exception 'too many reminders with times' using errcode = 'P0001', hint = 'push_items_bad';
  end if;
  return true;
end $$;

-- For the Edge Function (service_role only): take what is due now, mark it sent, and return one row per device to
-- send to. A time more than an hour late is skipped (no flood after downtime). Only the latest due time of each
-- reminder is sent.
create or replace function public.push_take_due(max_rows int default 500)
returns table (sub_id bigint, endpoint text, p256dh text, auth text, lang text, reminder_id text, title text, at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare t0 timestamptz := now();
begin
  return query
  with due as (
    select p.user_id, p.reminder_id, p.sent_until as prev from public.push_schedule p
     where p.next_at is not null and p.next_at <= t0
     order by p.next_at limit max_rows
     for update skip locked
  ), done as (
    update public.push_schedule p
       set sent_until = t0,
           next_at = (select min(x.t) from unnest(p.times) x(t) where x.t > t0)
      from due
     where p.user_id = due.user_id and p.reminder_id = due.reminder_id
    returning p.user_id, p.reminder_id, p.title,
              (select max(x.t) from unnest(p.times) x(t)
                where x.t <= t0 and x.t > greatest(due.prev, t0 - interval '1 hour')) as due_at
  )
  select s.id, s.endpoint, s.p256dh, s.auth, s.lang, d.reminder_id, d.title, d.due_at
    from done d join public.push_subscriptions s on s.user_id = d.user_id
   where d.due_at is not null;
end $$;

-- For the Edge Function: what happened. `ok` delivered; `gone` the push service says the device is no longer there
-- (removed); `failed` any other error (removed after 20 failures in a row).
create or replace function public.push_report(ok bigint[], gone bigint[], failed bigint[]) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.push_subscriptions set last_ok_at = now(), failures = 0 where id = any (ok);
  delete from public.push_subscriptions where id = any (gone);
  update public.push_subscriptions set failures = failures + 1 where id = any (failed);
  delete from public.push_subscriptions where failures >= 20;
end $$;

-- Called by pg_cron every minute: ask the Edge Function to send. Needs two Vault secrets (see README); without them,
-- nothing happens.
create or replace function public.push_tick() returns void
language plpgsql security definer set search_path = '' as $$
declare fn_url text; secret text;
begin
  if not exists (select 1 from public.push_schedule where next_at <= now()) then return; end if;
  select decrypted_secret into fn_url from vault.decrypted_secrets where name = 'push_function_url';
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'push_cron_secret';
  if fn_url is null or secret is null then return; end if;
  perform net.http_post(url := fn_url, body := '{}'::jsonb,
                        headers := jsonb_build_object('content-type', 'application/json', 'x-cron-secret', secret),
                        timeout_milliseconds := 55000);
end $$;

revoke execute on function public.push_subscribe(text, text, text, text), public.push_unsubscribe(text),
  public.push_schedule_set(jsonb, boolean), public.push_take_due(int), public.push_report(bigint[], bigint[], bigint[]),
  public.push_tick() from public, anon, authenticated;
grant execute on function public.push_subscribe(text, text, text, text), public.push_unsubscribe(text),
  public.push_schedule_set(jsonb, boolean) to authenticated;
grant execute on function public.push_take_due(int), public.push_report(bigint[], bigint[], bigint[]) to service_role;

select cron.schedule('ping-push', '* * * * *', $job$ select public.push_tick(); $job$);
