-- Pinglapp: file storage (avatars, pictures in notes, whiteboards) and the per-user quota.
--
-- Every file lives under a folder named after its owner's user id: {user_id}/...
--
-- The quota, and why it is enforced in two parts: Supabase Storage creates the file's row before it knows the size
-- (the size arrives in a later update), so a policy can't refuse "this file would go over the limit". Instead:
--   1. each bucket has a size limit per file, enforced by Storage itself, and
--   2. uploads are refused once a user's usage has reached their quota.
-- So a user can go over the quota by at most one file. `used_bytes` is kept up to date by a trigger, and a weekly job
-- recounts it from scratch in case it ever drifts.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('avatars',     'avatars',     true,  204800,   array['image/webp', 'image/png', 'image/jpeg']),
  ('note-images', 'note-images', false, 3145728,  array['image/webp', 'image/png', 'image/jpeg', 'image/gif']),
  ('boards',      'boards',      false, 15728640, array['application/json'])
on conflict (id) do update set
  public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- Pictures in notes and boards count towards the quota; the avatar (max 200 KB) doesn't.
create or replace function public.storage_counts(bucket text) returns boolean
language sql immutable set search_path = '' as $$
  select bucket in ('note-images', 'boards');
$$;

create or replace function public.storage_has_room() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select a.used_bytes < a.quota_bytes from public.account_private a where a.id = auth.uid()), false);
$$;

-- Keeps account_private.used_bytes in step with the files (size is in metadata->>'size').
create or replace function public.track_storage_use() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op in ('UPDATE', 'DELETE') and public.storage_counts(old.bucket_id) then
    update public.account_private
       set used_bytes = greatest(0, used_bytes - coalesce((old.metadata->>'size')::bigint, 0))
     where id = public.try_uuid((storage.foldername(old.name))[1]);
  end if;
  if tg_op in ('INSERT', 'UPDATE') and public.storage_counts(new.bucket_id) then
    update public.account_private
       set used_bytes = used_bytes + coalesce((new.metadata->>'size')::bigint, 0)
     where id = public.try_uuid((storage.foldername(new.name))[1]);
  end if;
  return null;
end $$;

create trigger track_storage_use after insert or update or delete on storage.objects
  for each row execute function public.track_storage_use();

-- Recount everyone's usage from the files themselves (run weekly by pg_cron, see the jobs migration).
create or replace function public.recount_storage_use() returns void
language sql security definer set search_path = '' as $$
  update public.account_private a
     set used_bytes = coalesce((
       select sum(coalesce((o.metadata->>'size')::bigint, 0))
         from storage.objects o
        where public.storage_counts(o.bucket_id)
          and (storage.foldername(o.name))[1] = a.id::text), 0);
$$;

revoke execute on function public.storage_counts(text), public.storage_has_room(), public.track_storage_use(),
  public.recount_storage_use() from public, anon, authenticated;
grant execute on function public.storage_counts(text), public.storage_has_room() to authenticated;   -- used by the policies below
grant execute on function public.recount_storage_use() to service_role;

-- Your own folder only. The avatar must be exactly {user_id}/avatar.webp, so there is one per user.
-- New files and replaced files are refused once the quota is used up (the avatar is exempt).
create policy "ping: own files: read" on storage.objects for select to authenticated using (
  bucket_id in ('avatars', 'note-images', 'boards')
  and (storage.foldername(name))[1] = (select auth.uid())::text
);
create policy "ping: own files: add" on storage.objects for insert to authenticated with check (
  bucket_id in ('avatars', 'note-images', 'boards')
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and (bucket_id <> 'avatars' or name = (select auth.uid())::text || '/avatar.webp')
  and (not public.storage_counts(bucket_id) or public.storage_has_room())
);
create policy "ping: own files: replace" on storage.objects for update to authenticated using (
  bucket_id in ('avatars', 'note-images', 'boards')
  and (storage.foldername(name))[1] = (select auth.uid())::text
) with check (
  bucket_id in ('avatars', 'note-images', 'boards')
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and (bucket_id <> 'avatars' or name = (select auth.uid())::text || '/avatar.webp')
  and (not public.storage_counts(bucket_id) or public.storage_has_room())
);
create policy "ping: own files: remove" on storage.objects for delete to authenticated using (
  bucket_id in ('avatars', 'note-images', 'boards')
  and (storage.foldername(name))[1] = (select auth.uid())::text
);
