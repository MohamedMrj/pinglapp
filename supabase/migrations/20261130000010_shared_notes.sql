-- Pinglapp social S5: shared notes and lists (see PLAN-social.md). Needs 20261128000007_friends.sql.
--
-- A note can be shared with friends, each as an editor ('edit') or a reader ('read'). A shared note lives here, not
-- in anyone's own `notes`: one row with the note's shared part (text and its history) and a revision number.
-- Saving says which revision the change was based on. If someone else saved in between, nothing is overwritten: the
-- function returns the current version and the app merges the two (line by line; on a clash the saved version wins
-- and the other is kept in the note's history), then saves again. So no one's change is ever lost silently.
--
-- Only the owner adds or removes people and can stop sharing (the note then goes back to being the owner's own).
-- People in a note see who else is in it. Ending a friendship, or blocking, removes the other from notes either of
-- them owns. Pictures in a shared note are files under shared/{note id}/ in the note-images bucket: everyone in the
-- note can see them, the owner and editors can add them, and they count towards the owner's storage quota.
-- The tables are invisible to the API roles; everything goes through the functions below.

create table public.shared_notes (
  id         text primary key check (id ~ '^sh-[a-z0-9]{12,40}$'),
  owner      uuid not null references auth.users on delete cascade,
  data       jsonb not null check (jsonb_typeof(data) = 'object' and octet_length(data::text) <= 4000000),
  rev        bigint not null default 1,
  updated_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index shared_notes_owner on public.shared_notes (owner);
create table public.shared_note_members (
  note_id  text not null references public.shared_notes on delete cascade,
  member   uuid not null references auth.users on delete cascade,
  role     text not null check (role in ('edit', 'read')),
  added_at timestamptz not null default now(),
  primary key (note_id, member)
);
create index shared_note_members_member on public.shared_note_members (member);
alter table public.shared_notes enable row level security;
alter table public.shared_note_members enable row level security;
revoke all on public.shared_notes, public.shared_note_members from anon, authenticated;
grant all on public.shared_notes, public.shared_note_members to service_role;

-- 'owner' | 'edit' | 'read' | null: what `who` may do with the shared note `note`.
create or replace function public.shared_note_role(note text, who uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case when s.owner = who then 'owner' else (select m.role from public.shared_note_members m where m.note_id = s.id and m.member = who) end
  from public.shared_notes s where s.id = note;
$$;

-- Check and normalise a member list from the app: [{ "name": "anna", "role": "edit" }, ...] -> (user id, role) rows.
-- Everyone must be a friend of the owner; at most 20 people. Raises with a hint the app translates.
create or replace function public.shared_note_people(owner uuid, people jsonb)
returns table (member uuid, role text)
language plpgsql stable security definer set search_path = '' as $$
declare p jsonb; who uuid; r text; seen uuid[] := '{}';
begin
  if people is null or jsonb_typeof(people) <> 'array' then
    raise exception 'members must be a list' using errcode = 'P0001', hint = 'share_bad';
  end if;
  if jsonb_array_length(people) > 20 then
    raise exception 'at most 20 people' using errcode = 'P0001', hint = 'share_too_many';
  end if;
  for p in select * from jsonb_array_elements(people) loop
    who := public.profile_id(p ->> 'name');
    r := coalesce(p ->> 'role', 'edit');
    if r not in ('edit', 'read') then raise exception 'bad role' using errcode = 'P0001', hint = 'share_bad'; end if;
    if who is null or who = owner or not public.are_friends(owner, who) then
      raise exception 'not friends' using errcode = 'P0001', hint = 'share_not_friend';
    end if;
    if who = any(seen) then continue; end if;
    seen := seen || who;
    member := who; role := r; return next;
  end loop;
end $$;

-- Share a note: `id` is made by the app (sh-...), `data` the note's shared part, `members` as above. Returns the
-- revision (1). Calling it again for a note you already share just returns its revision (a retried request).
create or replace function public.shared_note_create(id text, data jsonb, members jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); cur public.shared_notes; n bigint;
begin
  if me is null then raise exception 'not signed in' using errcode = '42501'; end if;
  select * into cur from public.shared_notes s where s.id = shared_note_create.id;
  if found then
    if cur.owner = me then return cur.rev; end if;
    raise exception 'id taken' using errcode = 'P0001', hint = 'share_bad';
  end if;
  if id is null or id !~ '^sh-[a-z0-9]{12,40}$' or data is null or jsonb_typeof(data) <> 'object' then
    raise exception 'bad note' using errcode = 'P0001', hint = 'share_bad';
  end if;
  if (select count(*) from public.shared_notes s where s.owner = me and s.created_at > now() - interval '1 day') >= 30 then
    raise exception 'too many shared today' using errcode = 'P0001', hint = 'share_limit';
  end if;
  insert into public.shared_notes (id, owner, data, updated_by) values (id, me, data, me);
  insert into public.shared_note_members (note_id, member, role)
  select shared_note_create.id, p.member, p.role from public.shared_note_people(me, members) p;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'nobody to share with' using errcode = 'P0001', hint = 'share_bad'; end if;   -- undoes the insert above
  return 1;
end $$;

-- The owner changes who is in the note and their roles (the list replaces the old one; an empty list is allowed:
-- the note stays shared, with nobody else, until the owner stops sharing).
create or replace function public.shared_note_set_members(id text, members jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'not signed in' using errcode = '42501'; end if;
  if public.shared_note_role(id, me) is distinct from 'owner' then
    raise exception 'not your note' using errcode = 'P0001', hint = 'share_gone';
  end if;
  delete from public.shared_note_members m where m.note_id = shared_note_set_members.id
     and m.member not in (select p.member from public.shared_note_people(me, members) p);   -- checks the list first
  insert into public.shared_note_members (note_id, member, role)
  select shared_note_set_members.id, p.member, p.role from public.shared_note_people(me, members) p
  on conflict (note_id, member) do update set role = excluded.role;
  return true;
end $$;

-- Save a change made on revision `base_rev`. If that is still the current revision, the change is stored and the
-- new revision returned (saved = true). Otherwise nothing changes and the current revision and data come back
-- (saved = false), so the app can merge and try again.
create or replace function public.shared_note_save(id text, base_rev bigint, body jsonb)
returns table (cur_rev bigint, cur_data jsonb, saved boolean)
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); my_role text; new_rev bigint;
begin
  if me is null then raise exception 'not signed in' using errcode = '42501'; end if;
  my_role := public.shared_note_role(id, me);
  if my_role is null then raise exception 'not shared with you' using errcode = 'P0001', hint = 'share_gone'; end if;
  if my_role = 'read' then raise exception 'read only' using errcode = 'P0001', hint = 'share_read_only'; end if;
  if body is null or jsonb_typeof(body) <> 'object' then raise exception 'bad note' using errcode = 'P0001', hint = 'share_bad'; end if;
  update public.shared_notes s set data = body, rev = s.rev + 1, updated_by = me, updated_at = now()
   where s.id = shared_note_save.id and s.rev = base_rev
  returning s.rev into new_rev;
  if new_rev is not null then
    cur_rev := new_rev; cur_data := null; saved := true; return next; return;
  end if;
  select s.rev, s.data into cur_rev, cur_data from public.shared_notes s where s.id = shared_note_save.id;
  saved := false; return next;
end $$;

-- Every shared note you own or are in, with your role and the people in it. `known` is { note id: revision } for the
-- notes this device already has; a note's data is only sent when its revision differs. It can be limited to one note
-- (`one_id`: the open one, checked every few seconds). A note missing from the answer is no longer shared with you.
create or replace function public.shared_notes_sync(known jsonb default '{}', one_id text default null)
returns table (id text, rev bigint, role text, owner_name text, people jsonb, data jsonb, updated_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select s.id, s.rev, public.shared_note_role(s.id, auth.uid()), op.username,
         (select jsonb_agg(jsonb_build_object('username', p.username, 'display_name', p.display_name,
                   'avatar_path', p.avatar_path, 'avatar_style', p.avatar_style, 'role', x.role) order by x.ord, lower(p.username))
            from (select s.owner as uid, 'owner' as role, 0 as ord
                  union all select m.member, m.role, 1 from public.shared_note_members m where m.note_id = s.id) x
            join public.profiles p on p.id = x.uid),
         case when coalesce(known, '{}'::jsonb) ->> s.id = s.rev::text then null else s.data end,
         s.updated_at
  from public.shared_notes s
  join public.profiles op on op.id = s.owner
  where (one_id is null or s.id = one_id)
    and (s.owner = auth.uid() or exists (select 1 from public.shared_note_members m where m.note_id = s.id and m.member = auth.uid()));
$$;

-- Leave a note someone shared with you.
create or replace function public.shared_note_leave(id text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  delete from public.shared_note_members m where m.note_id = shared_note_leave.id and m.member = auth.uid();
  return found;
end $$;

-- Stop sharing a note you own: it is removed here (the app keeps it as your own note; others get a copy in the trash).
-- Remove its pictures (shared/{id}/...) first: once the row is gone, nobody may touch those files any more.
create or replace function public.shared_note_stop(id text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  delete from public.shared_notes s where s.id = shared_note_stop.id and s.owner = auth.uid();
  return found;
end $$;

-- Ending a friendship or blocking someone also ends their sharing with each other (same signatures as before).
create or replace function public.shared_notes_unlink(x uuid, y uuid) returns void
language sql security definer set search_path = '' as $$
  delete from public.shared_note_members m using public.shared_notes s
   where m.note_id = s.id and ((s.owner = x and m.member = y) or (s.owner = y and m.member = x));
$$;

create or replace function public.friend_remove(name text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); them uuid := public.profile_id(name); ended boolean;
begin
  if me is null then raise exception 'not signed in' using errcode = '42501'; end if;
  delete from public.friendships
   where a = least(me, them) and b = greatest(me, them) and (status = 'accepted' or requested_by = me);
  ended := found;
  if them is not null then perform public.shared_notes_unlink(me, them); end if;
  return ended;
end $$;

create or replace function public.block_user(name text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare target uuid;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  select id into target from public.profiles where username = lower(name);
  if target is null or target = auth.uid() then return false; end if;
  insert into public.blocks (blocker, blocked) values (auth.uid(), target) on conflict do nothing;
  delete from public.friendships where a = least(auth.uid(), target) and b = greatest(auth.uid(), target);
  perform public.shared_notes_unlink(auth.uid(), target);
  return true;
end $$;

revoke execute on function public.shared_note_role(text, uuid), public.shared_note_people(uuid, jsonb),
  public.shared_note_create(text, jsonb, jsonb), public.shared_note_set_members(text, jsonb),
  public.shared_note_save(text, bigint, jsonb), public.shared_notes_sync(jsonb, text), public.shared_note_leave(text),
  public.shared_note_stop(text), public.shared_notes_unlink(uuid, uuid), public.friend_remove(text), public.block_user(text)
  from public, anon, authenticated;
grant execute on function public.shared_note_create(text, jsonb, jsonb), public.shared_note_set_members(text, jsonb),
  public.shared_note_save(text, bigint, jsonb), public.shared_notes_sync(jsonb, text), public.shared_note_leave(text),
  public.shared_note_stop(text), public.friend_remove(text), public.block_user(text)
  to authenticated;
grant execute on function public.shared_note_role(text, uuid) to authenticated;   -- used by the storage policies below

-- ---------------------------------------------------------------- pictures in shared notes
-- Files under shared/{note id}/ belong to the note's owner for the quota.
create or replace function public.storage_owner(name text) returns uuid
language sql stable security definer set search_path = '' as $$
  select case when (storage.foldername(name))[1] = 'shared'
              then (select s.owner from public.shared_notes s where s.id = (storage.foldername(name))[2])
              else public.try_uuid((storage.foldername(name))[1]) end;
$$;

create or replace function public.track_storage_use() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op in ('UPDATE', 'DELETE') and public.storage_counts(old.bucket_id) then
    update public.account_private
       set used_bytes = greatest(0, used_bytes - coalesce((old.metadata->>'size')::bigint, 0))
     where id = public.storage_owner(old.name);
  end if;
  if tg_op in ('INSERT', 'UPDATE') and public.storage_counts(new.bucket_id) then
    update public.account_private
       set used_bytes = used_bytes + coalesce((new.metadata->>'size')::bigint, 0)
     where id = public.storage_owner(new.name);
  end if;
  return null;
end $$;

create or replace function public.recount_storage_use() returns void
language sql security definer set search_path = '' as $$
  update public.account_private a
     set used_bytes = coalesce((
       select sum(coalesce((o.metadata->>'size')::bigint, 0))
         from storage.objects o
        where public.storage_counts(o.bucket_id) and public.storage_owner(o.name) = a.id), 0);
$$;

-- Room left for the owner of a shared note.
create or replace function public.shared_note_has_room(note text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select a.used_bytes < a.quota_bytes from public.account_private a
                    join public.shared_notes s on s.owner = a.id where s.id = note), false);
$$;

revoke execute on function public.storage_owner(text), public.shared_note_has_room(text) from public, anon, authenticated;
grant execute on function public.shared_note_has_room(text) to authenticated;
revoke execute on function public.track_storage_use(), public.recount_storage_use() from public, anon, authenticated;
grant execute on function public.recount_storage_use() to service_role;

create policy "ping: shared note pictures: read" on storage.objects for select to authenticated using (
  bucket_id = 'note-images' and (storage.foldername(name))[1] = 'shared'
  and public.shared_note_role((storage.foldername(name))[2], (select auth.uid())) is not null
);
create policy "ping: shared note pictures: add" on storage.objects for insert to authenticated with check (
  bucket_id = 'note-images' and (storage.foldername(name))[1] = 'shared'
  and array_length(storage.foldername(name), 1) = 2
  and public.shared_note_role((storage.foldername(name))[2], (select auth.uid())) in ('owner', 'edit')
  and public.shared_note_has_room((storage.foldername(name))[2])
);
create policy "ping: shared note pictures: remove" on storage.objects for delete to authenticated using (
  bucket_id = 'note-images' and (storage.foldername(name))[1] = 'shared'
  and public.shared_note_role((storage.foldername(name))[2], (select auth.uid())) = 'owner'
);
