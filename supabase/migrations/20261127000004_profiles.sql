-- Pinglapp phase 5: profiles.
--
-- Avatars are public files (bucket `avatars`, {user_id}/avatar.webp), shown to others through get_profile() and
-- find_profiles(). Users write `avatar_path` themselves, so it may only name their own avatar file, plus a version
-- number that changes with every new picture (otherwise browsers and the CDN keep showing the old one):
--   {user_id}/avatar.webp?v={digits}
-- Anything else (another user's file, an outside address, a script) is refused.

alter table public.profiles drop constraint if exists profiles_avatar_path_own;
alter table public.profiles add constraint profiles_avatar_path_own
  check (avatar_path is null or avatar_path ~ ('^' || id::text || '/avatar\.webp\?v=[0-9]{1,15}$'));
