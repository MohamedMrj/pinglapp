-- Pinglapp social S2: friends and the inbox (see PLAN-social.md).
--
-- One row per pair of people (a < b). A request is 'pending' until the other person accepts it ('accepted') or
-- declines it (the row is deleted). Only friends will be able to send each other things (reminders, board invites,
-- shared notes: later phases). Everything goes through the functions below; the table itself is invisible to the
-- API roles. Blocking someone ends the friendship. Unanswered requests disappear after 30 days.
-- Friends see each other's profile even if it is hidden from search ("findable" off); blocks still win.

create table public.friendships (
  a            uuid not null references auth.users on delete cascade,
  b            uuid not null references auth.users on delete cascade,
  requested_by uuid not null references auth.users on delete cascade,
  status       text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at   timestamptz not null default now(),
  accepted_at  timestamptz,
  primary key (a, b),
  check (a < b),
  check (requested_by = a or requested_by = b)
);
create index friendships_b on public.friendships (b);
alter table public.friendships enable row level security;
revoke all on public.friendships from anon, authenticated;
grant all on public.friendships to service_role;

create or replace function public.are_friends(x uuid, y uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.friendships f
                 where f.a = least(x, y) and f.b = greatest(x, y) and f.status = 'accepted');
$$;

-- Profiles: friends may see each other's profile even when it isn't findable (blocks still apply).
create or replace function public.can_see_profile(owner uuid, vis text) returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and (
    owner = auth.uid()
    or (not exists (select 1 from public.blocks b where b.blocker = owner and b.blocked = auth.uid())
        and (vis = 'users' or public.are_friends(owner, auth.uid())))
  );
$$;

create or replace function public.profile_id(name text) returns uuid
language sql stable security definer set search_path = '' as $$
  select id from public.profiles where username = lower(name);
$$;

-- 'self' | 'none' | 'outgoing' (you asked) | 'incoming' (they asked) | 'friends'
create or replace function public.friend_status(name text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare me uuid := auth.uid(); them uuid := public.profile_id(name); f public.friendships;
begin
  if me is null then raise exception 'not signed in' using errcode = '42501'; end if;
  if them is null then return 'none'; end if;
  if them = me then return 'self'; end if;
  select * into f from public.friendships where a = least(me, them) and b = greatest(me, them);
  if not found then return 'none'; end if;
  if f.status = 'accepted' then return 'friends'; end if;
  return case when f.requested_by = me then 'outgoing' else 'incoming' end;
end $$;

-- Ask to be friends. If they already asked you, this accepts. Returns the new status.
-- Errors (hints): friend_unknown (no such visible profile), friend_blocked (you blocked them), friend_limit.
create or replace function public.friend_request(name text) returns text
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); them uuid; vis text; f public.friendships;
begin
  if me is null then raise exception 'not signed in' using errcode = '42501'; end if;
  select id, visibility into them, vis from public.profiles where username = lower(name);
  if them is null or them = me or not public.can_see_profile(them, vis) then
    raise exception 'no such profile' using errcode = 'P0001', hint = 'friend_unknown';
  end if;
  if exists (select 1 from public.blocks where blocker = me and blocked = them) then
    raise exception 'you blocked this person' using errcode = 'P0001', hint = 'friend_blocked';
  end if;
  select * into f from public.friendships where a = least(me, them) and b = greatest(me, them);
  if found then
    if f.status = 'accepted' then return 'friends'; end if;
    if f.requested_by = me then return 'outgoing'; end if;
    update public.friendships set status = 'accepted', accepted_at = now() where a = f.a and b = f.b;
    return 'friends';
  end if;
  if (select count(*) from public.friendships where requested_by = me and created_at > now() - interval '1 day') >= 30 then
    raise exception 'too many friend requests' using errcode = 'P0001', hint = 'friend_limit';
  end if;
  insert into public.friendships (a, b, requested_by) values (least(me, them), greatest(me, them), me);
  return 'outgoing';
end $$;

-- Answer a request someone sent you: accept, or decline (the request is removed; they aren't told).
create or replace function public.friend_respond(name text, accept boolean) returns text
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); them uuid := public.profile_id(name);
begin
  if me is null then raise exception 'not signed in' using errcode = '42501'; end if;
  if them is null then return 'none'; end if;
  if accept then
    update public.friendships set status = 'accepted', accepted_at = now()
     where a = least(me, them) and b = greatest(me, them) and status = 'pending' and requested_by = them;
    return case when found then 'friends' else public.friend_status(name) end;
  end if;
  delete from public.friendships
   where a = least(me, them) and b = greatest(me, them) and status = 'pending' and requested_by = them;
  return 'none';
end $$;

-- Stop being friends, or take back a request you sent.
create or replace function public.friend_remove(name text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); them uuid := public.profile_id(name);
begin
  if me is null then raise exception 'not signed in' using errcode = '42501'; end if;
  delete from public.friendships
   where a = least(me, them) and b = greatest(me, them) and (status = 'accepted' or requested_by = me);
  return found;
end $$;

-- Your friends, with what the app needs to show them.
create or replace function public.my_friends()
returns table (username text, display_name text, avatar_path text, avatar_style jsonb, since timestamptz)
language sql stable security definer set search_path = '' as $$
  select p.username, p.display_name, p.avatar_path, p.avatar_style, f.accepted_at
  from public.friendships f
  join public.profiles p on p.id = case when f.a = auth.uid() then f.b else f.a end
  where (f.a = auth.uid() or f.b = auth.uid()) and f.status = 'accepted'
  order by lower(coalesce(p.display_name, p.username));
$$;

-- The inbox: things waiting for your answer. For now, friend requests; later phases add reminders and invites.
-- kind, id (null for friend requests), who sent it, payload, when.
create or replace function public.my_inbox()
returns table (kind text, id bigint, username text, display_name text, avatar_path text, avatar_style jsonb,
               payload jsonb, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select 'friend_request', null::bigint, p.username, p.display_name, p.avatar_path, p.avatar_style, null::jsonb, f.created_at
  from public.friendships f
  join public.profiles p on p.id = f.requested_by
  where (f.a = auth.uid() or f.b = auth.uid()) and f.requested_by <> auth.uid() and f.status = 'pending'
    and not exists (select 1 from public.blocks bl where bl.blocker = auth.uid() and bl.blocked = f.requested_by)
  order by f.created_at desc;
$$;

-- Blocking someone also ends a friendship or request between you (same signature as before).
create or replace function public.block_user(name text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare target uuid;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  select id into target from public.profiles where username = lower(name);
  if target is null or target = auth.uid() then return false; end if;
  insert into public.blocks (blocker, blocked) values (auth.uid(), target) on conflict do nothing;
  delete from public.friendships where a = least(auth.uid(), target) and b = greatest(auth.uid(), target);
  return true;
end $$;

revoke execute on function public.are_friends(uuid, uuid), public.profile_id(text), public.friend_status(text),
  public.friend_request(text), public.friend_respond(text, boolean), public.friend_remove(text), public.my_friends(),
  public.my_inbox(), public.can_see_profile(uuid, text), public.block_user(text)
  from public, anon, authenticated;
grant execute on function public.friend_status(text), public.friend_request(text), public.friend_respond(text, boolean),
  public.friend_remove(text), public.my_friends(), public.my_inbox(), public.block_user(text)
  to authenticated;

-- Unanswered requests go after 30 days.
select cron.schedule('ping-old-friend-requests', '37 3 * * *', $job$
  delete from public.friendships where status = 'pending' and created_at < now() - interval '30 days';
$job$);
