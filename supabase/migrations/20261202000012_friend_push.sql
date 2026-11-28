-- Pinglapp E1 (see PLAN-engage.md): December avatar items, and push notifications for friend events.
-- Needs 20261128000006_avatars.sql, 20261128000007_friends.sql, 20261129000008/9 (inbox items) and
-- 20261201000011_push.sql. Safe to run while the previous app version is live: the old app keeps working unchanged.
--
-- 1. Avatars: four new accessories (8 Santa hat, 9 Lucia crown, 10 gingerbread, 11 scarf), so `a` may now be 0-11.
--    Only the range widens; every saved avatar stays valid.
-- 2. Friend events: when something lands in your inbox (a friend request, a reminder from a friend, a board invite)
--    and you have a device with push on, that device gets a notification ("Anna vill bli din vän").
--    * Triggers on friendships / inbox_items put a small row in push_events (who, from whom, what kind, which item:
--      ids only, no text). Nothing is queued for accounts without a device that wants that kind.
--    * Each device can turn a kind off (push_subscriptions.muted, sent by the app with push_subscribe). On by default.
--    * The minute job (push_tick) now also runs when events wait; the Edge Function send-due-pushes takes them with
--      push_take_events(), which checks again at sending time, exactly as my_inbox() does: still waiting, still friends,
--      no block either way. The text (the friend's name, the reminder text or board title) is read then and sent
--      encrypted for the device, like reminders.
--    * Per sender: at most 5 notifications an hour to the same person and 30 an hour in all (the inbox still gets
--      everything; only the notification is skipped). Events are dropped after an hour unsent, rows after a day.
--    * A trigger never makes the request itself fail: notifications are a bonus.

-- 1. Avatars ----------------------------------------------------------------------------------------------------
create or replace function public.valid_avatar_style(j jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select j is null or (
    jsonb_typeof(j) = 'object'
    and (select count(*) from jsonb_object_keys(j)) = 7
    and j ?& array['v', 's', 'c', 'e', 'm', 'a', 'b']
    and coalesce((select bool_and(jsonb_typeof(j -> k) = 'number' and (j ->> k) ~ '^[0-9]{1,2}$')
                  from unnest(array['v', 's', 'c', 'e', 'm', 'a', 'b']) as k), false)
    and (j ->> 'v')::int = 1
    and (j ->> 's')::int <= 5 and (j ->> 'c')::int <= 11 and (j ->> 'e')::int <= 7
    and (j ->> 'm')::int <= 7 and (j ->> 'a')::int <= 11 and (j ->> 'b')::int <= 11
  );
$$;

-- 2. Friend events -----------------------------------------------------------------------------------------------
alter table public.push_subscriptions add column if not exists muted text[] not null default '{}';
alter table public.push_subscriptions drop constraint if exists push_subscriptions_muted_valid;
alter table public.push_subscriptions add constraint push_subscriptions_muted_valid
  check (muted <@ array['friend', 'reminder', 'board']::text[]);

create table public.push_events (
  id         bigint generated always as identity primary key,
  recipient  uuid not null references auth.users on delete cascade,
  sender     uuid not null references auth.users on delete cascade,
  kind       text not null check (kind in ('friend', 'reminder', 'board')),
  item_id    bigint,                               -- inbox_items.id for 'reminder' and 'board'
  created_at timestamptz not null default now(),
  taken_at   timestamptz                           -- handed to the sender function (or skipped)
);
create index push_events_waiting on public.push_events (created_at) where taken_at is null;
create index push_events_sender on public.push_events (sender, created_at);
alter table public.push_events enable row level security;
revoke all on public.push_events from anon, authenticated;
grant all on public.push_events to service_role;

-- Save (or refresh) this device's push subscription. `muted_kinds`: the friend events this device doesn't want
-- ('friend', 'reminder', 'board'; others are ignored). Null keeps what the device had (the previous app version
-- doesn't send it). Returns true.
drop function if exists public.push_subscribe(text, text, text, text);
create function public.push_subscribe(endpoint_url text, key_p256dh text, key_auth text, lang_code text,
                                      muted_kinds text[] default null)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid();
        m text[] := array(select distinct k from unnest(coalesce(muted_kinds, '{}')) k
                           where k in ('friend', 'reminder', 'board') order by k);
begin
  if me is null then raise exception 'not signed in' using errcode = '42501'; end if;
  insert into public.push_subscriptions as s (user_id, endpoint, p256dh, auth, lang, muted)
  values (me, endpoint_url, key_p256dh, key_auth, case when lang_code = 'en' then 'en' else 'sv' end, m)
  on conflict (endpoint) do update
    set user_id = me, p256dh = excluded.p256dh, auth = excluded.auth, lang = excluded.lang, failures = 0,
        muted = case when muted_kinds is not null then excluded.muted when s.user_id = me then s.muted else '{}' end,
        created_at = case when s.user_id = me then s.created_at else now() end;
  delete from public.push_subscriptions where id in (
    select id from public.push_subscriptions where user_id = me order by created_at desc, id desc offset 10);
  return true;
end $$;

-- Queue a notification for `to_user`, if they have a device that wants this kind and the sender is within the limits.
create or replace function public.push_event_add(to_user uuid, from_user uuid, what text, item bigint) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.push_subscriptions s where s.user_id = to_user and not (what = any (s.muted))) then
    return;
  end if;
  if (select count(*) from public.push_events e
       where e.sender = from_user and e.recipient = to_user and e.created_at > now() - interval '1 hour') >= 5
     or (select count(*) from public.push_events e
          where e.sender = from_user and e.created_at > now() - interval '1 hour') >= 30 then
    return;
  end if;
  insert into public.push_events (recipient, sender, kind, item_id) values (to_user, from_user, what, item);
end $$;

create or replace function public.push_on_friendship() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'pending' then
    begin
      perform public.push_event_add(case when new.requested_by = new.a then new.b else new.a end, new.requested_by, 'friend', null);
    exception when others then null;              -- never fail the request over a notification
    end;
  end if;
  return null;
end $$;

create or replace function public.push_on_inbox_item() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.kind in ('reminder', 'board_invite') then
    begin
      perform public.push_event_add(new.recipient, new.sender, case new.kind when 'reminder' then 'reminder' else 'board' end, new.id);
    exception when others then null;
    end;
  end if;
  return null;
end $$;

drop trigger if exists friendships_push on public.friendships;
create trigger friendships_push after insert on public.friendships
  for each row execute function public.push_on_friendship();
drop trigger if exists inbox_items_push on public.inbox_items;
create trigger inbox_items_push after insert on public.inbox_items
  for each row execute function public.push_on_inbox_item();

-- For the Edge Function (service_role only): take the waiting events and return one row per device to send to, with
-- what the notification says. Checked again now: the request or item is still waiting, the two are still friends
-- (for items), nobody blocked anybody, and the device hasn't turned the kind off. Older than an hour: skipped.
create or replace function public.push_take_events(max_rows int default 500)
returns table (sub_id bigint, endpoint text, p256dh text, auth text, lang text, kind text, event_id bigint,
               username text, display_name text, body text)
language plpgsql security definer set search_path = '' as $$
declare t0 timestamptz := now();
begin
  delete from public.push_events pe where pe.created_at < t0 - interval '1 day';
  return query
  with ev as (
    select pe.id from public.push_events pe
     where pe.taken_at is null
     order by pe.created_at limit max_rows
     for update skip locked
  ), took as (
    update public.push_events pe set taken_at = t0
      from ev where pe.id = ev.id
    returning pe.id, pe.recipient, pe.sender, pe.kind, pe.item_id, pe.created_at
  ), ok as (
    select t.id, t.recipient, t.kind, p.username, p.display_name,
           case t.kind when 'reminder' then i.payload ->> 'text' when 'board' then i.payload ->> 'title' end as body
      from took t
      join public.profiles p on p.id = t.sender
      left join public.inbox_items i on i.id = t.item_id and i.recipient = t.recipient and i.sender = t.sender
     where t.created_at > t0 - interval '1 hour'
       and not exists (select 1 from public.blocks b
                        where (b.blocker = t.recipient and b.blocked = t.sender)
                           or (b.blocker = t.sender and b.blocked = t.recipient))
       and case t.kind
             when 'friend' then exists (select 1 from public.friendships f
                                         where f.a = least(t.recipient, t.sender) and f.b = greatest(t.recipient, t.sender)
                                           and f.status = 'pending' and f.requested_by = t.sender)
             else i.id is not null and i.answered_at is null and public.are_friends(t.sender, t.recipient)
           end
  )
  select s.id, s.endpoint, s.p256dh, s.auth, s.lang, ok.kind, ok.id, ok.username, ok.display_name, ok.body
    from ok join public.push_subscriptions s on s.user_id = ok.recipient and not (ok.kind = any (s.muted));
end $$;

-- The minute job: as before, plus when friend events wait.
create or replace function public.push_tick() returns void
language plpgsql security definer set search_path = '' as $$
declare fn_url text; secret text;
begin
  if not exists (select 1 from public.push_schedule where next_at <= now())
     and not exists (select 1 from public.push_events where taken_at is null) then
    return;
  end if;
  select decrypted_secret into fn_url from vault.decrypted_secrets where name = 'push_function_url';
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'push_cron_secret';
  if fn_url is null or secret is null then return; end if;
  perform net.http_post(url := fn_url, body := '{}'::jsonb,
                        headers := jsonb_build_object('content-type', 'application/json', 'x-cron-secret', secret),
                        timeout_milliseconds := 55000);
end $$;

revoke execute on function public.push_subscribe(text, text, text, text, text[]), public.push_event_add(uuid, uuid, text, bigint),
  public.push_on_friendship(), public.push_on_inbox_item(), public.push_take_events(int), public.push_tick()
  from public, anon, authenticated;
grant execute on function public.push_subscribe(text, text, text, text, text[]) to authenticated;
grant execute on function public.push_take_events(int) to service_role;
