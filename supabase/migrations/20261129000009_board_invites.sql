-- Pinglapp social S4: invite a friend to a live whiteboard (see PLAN-social.md). Needs 20261129000008_inbox_items.sql.
--
-- While you share a board live, you can invite a friend: an inbox item of kind 'board_invite' with the board's title
-- and its live-sharing room id. The recipient's app builds the join link itself (no links from other users are ever
-- shown); the room id must look like one the app makes. The host has to be online for the board to be reachable, so
-- an invite is shown for one day only. At most 50 invites a day; inviting the same friend to the same room again
-- while the first invite is still waiting changes nothing. Old items are removed by the job from migration 008.

alter table public.inbox_items drop constraint inbox_items_kind_check;   -- was: kind in ('reminder')
alter table public.inbox_items add constraint inbox_items_kind_valid check (kind in ('reminder', 'board_invite'));
alter table public.inbox_items add constraint inbox_items_board_invite_shape check (kind <> 'board_invite' or (
  jsonb_typeof(payload -> 'room') = 'string' and (payload ->> 'room') ~ '^[a-z0-9]{12,40}$'
  and jsonb_typeof(payload -> 'title') = 'string' and char_length(payload ->> 'title') <= 80
  and payload - 'room' - 'title' = '{}'::jsonb));

-- Invite the friend `name` to the live board `room` (title shown to them, cut to 80 characters). Returns the item id.
-- Errors (hints): send_not_friend, send_room_bad (not a room id the app makes), send_limit.
create or replace function public.send_board_invite(name text, room text, title text) returns bigint
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); them uuid := public.profile_id(name); ttl text := left(btrim(coalesce(title, '')), 80); old_id bigint; new_id bigint;
begin
  if me is null then raise exception 'not signed in' using errcode = '42501'; end if;
  if them is null or them = me or not public.are_friends(me, them) then
    raise exception 'not friends' using errcode = 'P0001', hint = 'send_not_friend';
  end if;
  if room is null or room !~ '^[a-z0-9]{12,40}$' then
    raise exception 'bad room id' using errcode = 'P0001', hint = 'send_room_bad';
  end if;
  select id into old_id from public.inbox_items
   where sender = me and recipient = them and kind = 'board_invite' and payload ->> 'room' = room
     and answered_at is null and created_at > now() - interval '1 day';
  if old_id is not null then return old_id; end if;
  if (select count(*) from public.inbox_items
       where sender = me and kind = 'board_invite' and created_at > now() - interval '1 day') >= 50 then
    raise exception 'too many invites today' using errcode = 'P0001', hint = 'send_limit';
  end if;
  insert into public.inbox_items (sender, recipient, kind, payload)
  values (me, them, 'board_invite', jsonb_build_object('room', room, 'title', ttl))
  returning id into new_id;
  return new_id;
end $$;

-- The reminder limit (migration 008) counted every kind; now it counts reminders only.
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
  if (select count(*) from public.inbox_items
       where sender = me and kind = 'reminder' and created_at > now() - interval '1 day') >= 50 then
    raise exception 'too many sent today' using errcode = 'P0001', hint = 'send_limit';
  end if;
  insert into public.inbox_items (sender, recipient, kind, payload)
  values (me, them, 'reminder', jsonb_build_object('text', txt))
  returning id into new_id;
  return new_id;
end $$;

-- The inbox, as in 008, but a board invite is shown for one day only.
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
    where i.recipient = auth.uid() and i.answered_at is null
      and i.created_at > now() - case when i.kind = 'board_invite' then interval '1 day' else interval '30 days' end
      and public.are_friends(i.sender, auth.uid())
  ) x
  order by x.created_at desc;
$$;

revoke execute on function public.send_board_invite(text, text, text), public.send_reminder(text, text), public.my_inbox()
  from public, anon, authenticated;
grant execute on function public.send_board_invite(text, text, text), public.send_reminder(text, text), public.my_inbox()
  to authenticated;
