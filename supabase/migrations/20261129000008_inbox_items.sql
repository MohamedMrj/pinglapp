-- Pinglapp social S3: send a reminder to a friend (see PLAN-social.md). Needs 20261128000007_friends.sql.
--
-- A friend sends a short text ("Ring mamma imorgon 18:00"); it waits in the recipient's inbox until they add it as
-- their own reminder (the text is parsed on their device) or say no thanks. Only friends can send, at most 50 a day,
-- 1–300 characters. Later phases add other kinds (board invites). The table is invisible to the API roles; everything
-- goes through the functions below. Answered items go after a day, unanswered ones after 30 days. The sender is told
-- nothing about what the recipient did (no read receipts). If the two stop being friends (or one blocks the other),
-- waiting items are no longer shown.

create table public.inbox_items (
  id          bigint generated always as identity primary key,
  sender      uuid not null references auth.users on delete cascade,
  recipient   uuid not null references auth.users on delete cascade,
  kind        text not null check (kind in ('reminder')),
  payload     jsonb not null,
  created_at  timestamptz not null default now(),
  answered_at timestamptz,
  check (sender <> recipient),
  check (kind <> 'reminder' or (jsonb_typeof(payload -> 'text') = 'string'
                                and char_length(payload ->> 'text') between 1 and 300
                                and payload - 'text' = '{}'::jsonb))
);
create index inbox_items_recipient on public.inbox_items (recipient, created_at desc) where answered_at is null;
create index inbox_items_sender on public.inbox_items (sender, created_at);
alter table public.inbox_items enable row level security;
revoke all on public.inbox_items from anon, authenticated;
grant all on public.inbox_items to service_role;

-- Send `body` as a reminder to the friend `name`. Returns the new item's id.
-- Errors (hints): send_not_friend (no such person, or not friends), send_text_bad (empty or over 300), send_limit.
create or replace function public.send_reminder(name text, body text) returns bigint
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); them uuid := public.profile_id(name); txt text := btrim(coalesce(body, '')); new_id bigint;
begin
  if me is null then raise exception 'not signed in' using errcode = '42501'; end if;
  if them is null or them = me or not public.are_friends(me, them) then
    raise exception 'not friends' using errcode = 'P0001', hint = 'send_not_friend';
  end if;
  if char_length(txt) < 1 or char_length(txt) > 300 then
    raise exception 'text must be 1-300 characters' using errcode = 'P0001', hint = 'send_text_bad';
  end if;
  if (select count(*) from public.inbox_items where sender = me and created_at > now() - interval '1 day') >= 50 then
    raise exception 'too many sent today' using errcode = 'P0001', hint = 'send_limit';
  end if;
  insert into public.inbox_items (sender, recipient, kind, payload)
  values (me, them, 'reminder', jsonb_build_object('text', txt))
  returning id into new_id;
  return new_id;
end $$;

-- Mark an item in your inbox as answered (added or declined: the sender isn't told which). True if it was waiting.
create or replace function public.answer_item(item bigint) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  update public.inbox_items set answered_at = now()
   where id = item and recipient = auth.uid() and answered_at is null;
  return found;
end $$;

-- The inbox: friend requests (as before) plus items from friends that are still waiting. Same columns as before.
create or replace function public.my_inbox()
returns table (kind text, id bigint, username text, display_name text, avatar_path text, avatar_style jsonb,
               payload jsonb, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select * from (
    select 'friend_request'::text as kind, null::bigint as id, p.username, p.display_name, p.avatar_path, p.avatar_style,
           null::jsonb as payload, f.created_at
    from public.friendships f
    join public.profiles p on p.id = f.requested_by
    where (f.a = auth.uid() or f.b = auth.uid()) and f.requested_by <> auth.uid() and f.status = 'pending'
      and not exists (select 1 from public.blocks bl where bl.blocker = auth.uid() and bl.blocked = f.requested_by)
    union all
    select i.kind, i.id, p.username, p.display_name, p.avatar_path, p.avatar_style, i.payload, i.created_at
    from public.inbox_items i
    join public.profiles p on p.id = i.sender
    where i.recipient = auth.uid() and i.answered_at is null and i.created_at > now() - interval '30 days'
      and public.are_friends(i.sender, auth.uid())
  ) x
  order by x.created_at desc;
$$;

revoke execute on function public.send_reminder(text, text), public.answer_item(bigint), public.my_inbox()
  from public, anon, authenticated;
grant execute on function public.send_reminder(text, text), public.answer_item(bigint), public.my_inbox()
  to authenticated;

-- Answered items go after a day (kept that long so the daily limit still counts them); unanswered after 30 days.
select cron.schedule('ping-old-inbox-items', '41 3 * * *', $job$
  delete from public.inbox_items
   where (answered_at is not null and answered_at < now() - interval '1 day')
      or created_at < now() - interval '30 days';
$job$);
