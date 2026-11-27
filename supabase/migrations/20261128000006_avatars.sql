-- Pinglapp social S1: creative avatars (see PLAN-social.md).
--
-- Instead of (or until) a photo, a profile shows an avatar that Pinglapp's own code draws from a small spec:
--   {"v":1,"s":body 0-5,"c":colour 0-11,"e":eyes 0-7,"m":mouth 0-7,"a":accessory 0-7,"b":background 0-11}
-- Only exactly these keys, each a small whole number in range, are accepted, so nothing else can be stored here.
-- A photo (avatar_path) is shown instead when there is one. Null = the app draws a default from the username.
-- get_profile() and find_profiles() now also return the spec; their return type changes, so they are dropped and
-- created again (with the same grants).

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
    and (j ->> 'm')::int <= 7 and (j ->> 'a')::int <= 7 and (j ->> 'b')::int <= 11
  );
$$;

alter table public.profiles add column if not exists avatar_style jsonb;
alter table public.profiles drop constraint if exists profiles_avatar_style_valid;
alter table public.profiles add constraint profiles_avatar_style_valid check (public.valid_avatar_style(avatar_style));
grant update (avatar_style) on public.profiles to authenticated;

drop function if exists public.get_profile(text);
create function public.get_profile(name text)
returns table (username text, display_name text, avatar_path text, avatar_style jsonb, bio text, member_since date)
language sql stable security definer set search_path = '' as $$
  select p.username, p.display_name, p.avatar_path, p.avatar_style, p.bio, p.created_at::date
  from public.profiles p
  where p.username = lower(name) and public.can_see_profile(p.id, p.visibility);
$$;

drop function if exists public.find_profiles(text);
create function public.find_profiles(prefix text)
returns table (username text, display_name text, avatar_path text, avatar_style jsonb)
language sql stable security definer set search_path = '' as $$
  select p.username, p.display_name, p.avatar_path, p.avatar_style
  from public.profiles p
  where coalesce(lower(prefix) ~ '^[a-z0-9_]{3,20}$', false)
    and starts_with(p.username, lower(prefix))
    and public.can_see_profile(p.id, p.visibility)
  order by p.username
  limit 20;
$$;

revoke execute on function public.valid_avatar_style(jsonb), public.get_profile(text), public.find_profiles(text)
  from public, anon, authenticated;
grant execute on function public.get_profile(text), public.find_profiles(text) to authenticated;
grant execute on function public.valid_avatar_style(jsonb) to authenticated;   -- the check constraint runs it as the writer
