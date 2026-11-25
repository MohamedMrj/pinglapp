-- Ping: scheduled clean-up inside the database (pg_cron is included in Supabase Free).
-- cron.schedule() with an existing job name replaces that job, so running this file again is safe.

create extension if not exists pg_cron;

-- Tombstones (deleted items) are kept 90 days so every device hears about the deletion, the same as TOMBSTONE_MS in
-- the app. After that they are removed.
select cron.schedule('ping-tombstones', '17 3 * * *', $job$
  delete from public.reminders where deleted and server_at < now() - interval '90 days';
  delete from public.notes     where deleted and server_at < now() - interval '90 days';
  delete from public.boards    where deleted and server_at < now() - interval '90 days';
$job$);

-- Recount storage usage from the files themselves, in case the running total ever drifted.
select cron.schedule('ping-recount-storage', '41 3 * * 0', $job$ select public.recount_storage_use(); $job$);
