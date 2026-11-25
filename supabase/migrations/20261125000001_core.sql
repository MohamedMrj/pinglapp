-- Ping: accounts, profiles and synced data.
--
-- Every table has row-level security (RLS) on. Since 30 Oct 2026 Supabase no longer grants new tables to the API
-- roles automatically, so each table below revokes everything and then grants exactly what the app needs.
-- The app only ever holds the public "anon" key; what a signed-in user may touch is decided here.
--
-- Synced items (reminders, notes, boards) are stored whole as jsonb, so new fields in Ping need no migration.
-- `updated` is Ping's own change stamp (ms). `server_at` is set by the server on every write and is the sync cursor,
-- because device clocks can't be trusted to say "what changed since".

-- ---------------------------------------------------------------- helpers

create or replace function public.is_reserved_username(name text) returns boolean
language sql immutable set search_path = '' as $$
  select name = any (array[
    'admin', 'administrator', 'root', 'system', 'support', 'help', 'helpdesk', 'ping', 'pingapp', 'staff', 'team',
    'moderator', 'mod', 'official', 'security', 'abuse', 'postmaster', 'webmaster', 'hostmaster', 'noreply', 'no_reply',
    'info', 'contact', 'mail', 'email', 'api', 'www', 'owner', 'null', 'undefined', 'anonymous', 'guest', 'user', 'users',
    'me', 'settings', 'account', 'accounts', 'login', 'logout', 'signin', 'signup', 'register', 'privacy', 'terms',
    'billing', 'status', 'about'
  ]);
$$;

-- Lower-case letters, digits and _ only, 3–20 characters, not reserved.
create or replace function public.valid_username(name text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(name ~ '^[a-z0-9_]{3,20}$', false) and not public.is_reserved_username(name);
$$;

create or replace function public.try_uuid(s text) returns uuid
language plpgsql immutable set search_path = '' as $$
begin
  return s::uuid;
exception when others then
  return null;
end $$;

-- ---------------------------------------------------------------- profiles (public part of an account)
-- Others never read this table directly (that would let anyone list every user). They go through
-- get_profile() / find_profiles(), which apply the privacy setting and blocks.

create table public.profiles (
  id                  uuid primary key references auth.users on delete cascade,
  username            text not null unique check (username ~ '^[a-z0-9_]{3,20}$'),
  display_name        text check (char_length(display_name) <= 50),
  avatar_path         text check (char_length(avatar_path) <= 200),
  bio                 text check (char_length(bio) <= 300),
  visibility          text not null default 'users' check (visibility in ('users', 'private')),
  username_changed_at timestamptz,            -- null until the first change; then at most one change per 30 days
  created_at          timestamptz not null default now()
);
-- 'users' = any signed-in user can find and see the profile; 'private' = only you.

-- ---------------------------------------------------------------- private account data (only you)

create table public.account_private (
  id                uuid primary key references auth.users on delete cascade,
  language          text not null default 'sv' check (language in ('sv', 'en')),
  time_zone         text check (char_length(time_zone) <= 64),
  terms_accepted_at timestamptz,
  quota_bytes       bigint not null default 26214400,   -- 25 MB for pictures and boards together
  used_bytes        bigint not null default 0           -- kept up to date by a trigger on storage.objects
);

-- ---------------------------------------------------------------- synced items

create table public.reminders (
  user_id   uuid not null default auth.uid() references auth.users on delete cascade,
  id        text not null check (char_length(id) between 1 and 100),
  data      jsonb not null check (octet_length(data::text) <= 4000000),
  updated   bigint not null,
  deleted   boolean not null default false,           -- tombstone: the item was deleted at `updated`
  next_due  timestamptz,                              -- for server-sent reminders later (phase 7)
  server_at timestamptz not null default now(),
  primary key (user_id, id)
);
create table public.notes (
  user_id   uuid not null default auth.uid() references auth.users on delete cascade,
  id        text not null check (char_length(id) between 1 and 100),
  data      jsonb not null check (octet_length(data::text) <= 4000000),
  updated   bigint not null,
  deleted   boolean not null default false,
  server_at timestamptz not null default now(),
  primary key (user_id, id)
);
-- A board's row holds only its metadata; the drawing itself is a file in the `boards` storage bucket.
create table public.boards (
  user_id   uuid not null default auth.uid() references auth.users on delete cascade,
  id        text not null check (char_length(id) between 1 and 100),
  data      jsonb not null check (octet_length(data::text) <= 100000),
  updated   bigint not null,
  deleted   boolean not null default false,
  server_at timestamptz not null default now(),
  primary key (user_id, id)
);
create index reminders_sync on public.reminders (user_id, server_at);
create index notes_sync     on public.notes     (user_id, server_at);
create index boards_sync    on public.boards    (user_id, server_at);

create table public.user_settings (
  user_id          uuid primary key default auth.uid() references auth.users on delete cascade,
  data             jsonb not null default '{}' check (octet_length(data::text) <= 100000),
  settings_updated bigint not null default 0,
  server_at        timestamptz not null default now()
);

-- Newest wins, decided on the server too, so two devices pushing at once can't put an older version back.
--  * A stamp more than a day in the future (a device with a wrong clock) is refused: it would win every merge.
--  * An update only goes through if it is newer. On equal stamps a deletion beats a live item (as in mergeData);
--    otherwise the server keeps what it has and the app adopts the server's copy.
-- A refused row is skipped silently (return null), so the rest of a batch still goes through; the app sees which
-- rows came back and fetches the server's copy of the others.
create or replace function public.sync_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.updated > (extract(epoch from now()) * 1000)::bigint + 86400000 then
    return null;
  end if;
  if tg_op = 'UPDATE' then
    if new.user_id is distinct from old.user_id or new.id is distinct from old.id then
      raise exception 'an item can''t change owner or id' using errcode = '42501';
    end if;
    if new.updated < old.updated or (new.updated = old.updated and not (new.deleted and not old.deleted)) then
      return null;
    end if;
  end if;
  new.server_at := clock_timestamp();
  return new;
end $$;

create or replace function public.settings_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.settings_updated > (extract(epoch from now()) * 1000)::bigint + 86400000 then
    return null;
  end if;
  if tg_op = 'UPDATE' then
    if new.user_id is distinct from old.user_id then
      raise exception 'settings can''t change owner' using errcode = '42501';
    end if;
    if new.settings_updated <= old.settings_updated then
      return null;
    end if;
  end if;
  new.server_at := clock_timestamp();
  return new;
end $$;

create trigger sync_guard before insert or update on public.reminders for each row execute function public.sync_guard();
create trigger sync_guard before insert or update on public.notes     for each row execute function public.sync_guard();
create trigger sync_guard before insert or update on public.boards    for each row execute function public.sync_guard();
create trigger settings_guard before insert or update on public.user_settings for each row execute function public.settings_guard();

-- ---------------------------------------------------------------- blocks and reports
-- Only reachable through the functions further down (the app never knows other users' ids).

create table public.blocks (
  blocker    uuid not null references auth.users on delete cascade,
  blocked    uuid not null references auth.users on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker, blocked),
  check (blocker <> blocked)
);
create index blocks_blocked on public.blocks (blocked);

create table public.reports (
  id         bigint generated always as identity primary key,
  reporter   uuid references auth.users on delete set null,
  target     uuid references auth.users on delete cascade,
  reason     text not null check (char_length(reason) between 1 and 500),
  created_at timestamptz not null default now(),
  handled_at timestamptz
);

-- ---------------------------------------------------------------- row-level security and grants

alter table public.profiles        enable row level security;
alter table public.account_private enable row level security;
alter table public.reminders       enable row level security;
alter table public.notes           enable row level security;
alter table public.boards          enable row level security;
alter table public.user_settings   enable row level security;
alter table public.blocks          enable row level security;
alter table public.reports         enable row level security;

revoke all on public.profiles, public.account_private, public.reminders, public.notes, public.boards,
  public.user_settings, public.blocks, public.reports from anon, authenticated;
grant all on public.profiles, public.account_private, public.reminders, public.notes, public.boards,
  public.user_settings, public.blocks, public.reports to service_role;

-- Your own synced data: read and write your rows only. No delete: deletions are tombstones (deleted = true),
-- which the cleanup job removes after 90 days. Deleting the account removes everything (on delete cascade).
create policy "own rows: read"   on public.reminders for select to authenticated using (user_id = (select auth.uid()));
create policy "own rows: add"    on public.reminders for insert to authenticated with check (user_id = (select auth.uid()));
create policy "own rows: change" on public.reminders for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own rows: read"   on public.notes for select to authenticated using (user_id = (select auth.uid()));
create policy "own rows: add"    on public.notes for insert to authenticated with check (user_id = (select auth.uid()));
create policy "own rows: change" on public.notes for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own rows: read"   on public.boards for select to authenticated using (user_id = (select auth.uid()));
create policy "own rows: add"    on public.boards for insert to authenticated with check (user_id = (select auth.uid()));
create policy "own rows: change" on public.boards for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own rows: read"   on public.user_settings for select to authenticated using (user_id = (select auth.uid()));
create policy "own rows: add"    on public.user_settings for insert to authenticated with check (user_id = (select auth.uid()));
create policy "own rows: change" on public.user_settings for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
grant select, insert, update on public.reminders, public.notes, public.boards, public.user_settings to authenticated;

-- Your own profile: read it, and change the free-text fields. The username goes through set_username().
create policy "own profile: read"   on public.profiles for select to authenticated using (id = (select auth.uid()));
create policy "own profile: change" on public.profiles for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));
grant select on public.profiles to authenticated;
grant update (display_name, bio, avatar_path, visibility) on public.profiles to authenticated;

-- Your private account data: read it, and change language and time zone. Quota and usage are server-only.
create policy "own account: read"   on public.account_private for select to authenticated using (id = (select auth.uid()));
create policy "own account: change" on public.account_private for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));
grant select on public.account_private to authenticated;
grant update (language, time_zone) on public.account_private to authenticated;

-- Blocks: you can see the list of people you blocked (through my_blocks()); changes go through block_user().
create policy "own blocks: read" on public.blocks for select to authenticated using (blocker = (select auth.uid()));
grant select on public.blocks to authenticated;
-- Reports: write-only, through report_user(). The operator reads them with the service role.

-- ---------------------------------------------------------------- new accounts
-- Runs when someone signs up (any method). It must never make a sign-up fail: problems are logged and the app asks
-- for a username when an account has no profile yet (e.g. after Google or Microsoft sign-in).

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  n text := lower(coalesce(meta->>'username', ''));
  dn text := nullif(left(trim(coalesce(meta->>'display_name', meta->>'full_name', meta->>'name', '')), 50), '');
begin
  insert into public.account_private (id, language, terms_accepted_at)
  values (new.id, case when meta->>'lang' = 'en' then 'en' else 'sv' end,
          case when meta->>'terms' = 'true' then now() end)
  on conflict (id) do nothing;
  if public.valid_username(n) then
    begin
      insert into public.profiles (id, username, display_name) values (new.id, n, dn);
    exception when unique_violation then
      null;   -- taken in the meantime: the app asks for another name
    end;
  end if;
  return new;
exception when others then
  raise warning 'handle_new_user(%): %', new.id, sqlerrm;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------- functions the app calls (RPC)
-- Functions are executable by PUBLIC by default; each one below is limited to the roles that need it.

-- Live check while typing a username in the sign-up form. Returns only true/false.
create or replace function public.username_available(name text) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.valid_username(lower(name))
     and not exists (select 1 from public.profiles p where p.username = lower(name));
$$;

-- Pick a username (first time, e.g. after Google sign-in) or change it (at most once per 30 days).
-- Errors carry a hint the app translates: username_invalid, username_taken, username_too_soon.
create or replace function public.set_username(name text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  n text := lower(trim(coalesce(name, '')));
  cur public.profiles;
  dn text;
begin
  if me is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if not public.valid_username(n) then
    raise exception 'invalid username' using errcode = '22023', hint = 'username_invalid';
  end if;
  select * into cur from public.profiles where id = me;
  if found then
    if cur.username = n then
      return n;
    end if;
    if cur.username_changed_at is not null and cur.username_changed_at > now() - interval '30 days' then
      raise exception 'username changed recently' using errcode = 'P0001', hint = 'username_too_soon';
    end if;
    update public.profiles set username = n, username_changed_at = now() where id = me;
  else
    select nullif(left(trim(coalesce(u.raw_user_meta_data->>'display_name', u.raw_user_meta_data->>'full_name',
                                       u.raw_user_meta_data->>'name', '')), 50), '')
      into dn from auth.users u where u.id = me;
    insert into public.profiles (id, username, display_name) values (me, n, dn);
  end if;
  return n;
exception when unique_violation then
  raise exception 'username taken' using errcode = '23505', hint = 'username_taken';
end $$;

-- Accepting the terms is recorded with the server's time (users can't write the column themselves).
create or replace function public.accept_terms() returns void
language sql security definer set search_path = '' as $$
  update public.account_private set terms_accepted_at = coalesce(terms_accepted_at, now()) where id = auth.uid();
$$;

-- Can the signed-in user see this profile? Their own always; others' only if it is visible to users and the owner
-- hasn't blocked them. (security definer: the blocks table is otherwise invisible to the blocked person.)
create or replace function public.can_see_profile(owner uuid, vis text) returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and (
    owner = auth.uid()
    or (vis = 'users' and not exists (select 1 from public.blocks b where b.blocker = owner and b.blocked = auth.uid()))
  );
$$;

-- Another user's public profile by username. Never email, data or activity.
create or replace function public.get_profile(name text)
returns table (username text, display_name text, avatar_path text, bio text, member_since date)
language sql stable security definer set search_path = '' as $$
  select p.username, p.display_name, p.avatar_path, p.bio, p.created_at::date
  from public.profiles p
  where p.username = lower(name) and public.can_see_profile(p.id, p.visibility);
$$;

-- Find people by the start of their username: signed-in users only, at least 3 characters, at most 20 results,
-- which makes listing every user slow and noisy.
create or replace function public.find_profiles(prefix text)
returns table (username text, display_name text, avatar_path text)
language sql stable security definer set search_path = '' as $$
  select p.username, p.display_name, p.avatar_path
  from public.profiles p
  where coalesce(lower(prefix) ~ '^[a-z0-9_]{3,20}$', false)
    and starts_with(p.username, lower(prefix))
    and public.can_see_profile(p.id, p.visibility)
  order by p.username
  limit 20;
$$;

create or replace function public.block_user(name text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare target uuid;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  select id into target from public.profiles where username = lower(name);
  if target is null or target = auth.uid() then return false; end if;
  insert into public.blocks (blocker, blocked) values (auth.uid(), target) on conflict do nothing;
  return true;
end $$;

create or replace function public.unblock_user(name text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare target uuid;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  select id into target from public.profiles where username = lower(name);
  delete from public.blocks where blocker = auth.uid() and blocked = target;
  return found;
end $$;

create or replace function public.my_blocks() returns table (username text, blocked_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select p.username, b.created_at from public.blocks b join public.profiles p on p.id = b.blocked
  where b.blocker = auth.uid() order by p.username;
$$;

-- Report a profile (e.g. an inappropriate name or picture). At most 20 reports a day per person.
create or replace function public.report_user(name text, reason text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare target uuid;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  if (select count(*) from public.reports r where r.reporter = auth.uid() and r.created_at > now() - interval '1 day') >= 20 then
    raise exception 'too many reports' using errcode = 'P0001', hint = 'report_limit';
  end if;
  select id into target from public.profiles where username = lower(name);
  if target is null or target = auth.uid() then return false; end if;
  insert into public.reports (reporter, target, reason) values (auth.uid(), target, left(trim(reason), 500));
  return true;
end $$;

revoke execute on function public.is_reserved_username(text), public.valid_username(text), public.try_uuid(text),
  public.sync_guard(), public.settings_guard(), public.handle_new_user(), public.username_available(text),
  public.set_username(text), public.accept_terms(), public.can_see_profile(uuid, text), public.get_profile(text),
  public.find_profiles(text), public.block_user(text), public.unblock_user(text), public.my_blocks(),
  public.report_user(text, text)
  from public, anon, authenticated;
grant execute on function public.username_available(text) to anon, authenticated;
grant execute on function public.set_username(text), public.accept_terms(), public.get_profile(text),
  public.find_profiles(text), public.block_user(text), public.unblock_user(text), public.my_blocks(),
  public.report_user(text, text)
  to authenticated;
