-- Pinglapp phase 6: how long reports are kept, as the privacy policy (privacy.html) says.
--
-- A report holds the reporter's id and their text about another user. Reports older than 12 months are removed,
-- handled or not. (Reports about a deleted account already go with it; a deleted reporter's reports stay, without
-- the link to them, until they are 12 months old.)
-- cron.schedule() with an existing job name replaces that job, so running this file again is safe.

select cron.schedule('ping-old-reports', '29 3 * * *', $job$
  delete from public.reports where created_at < now() - interval '12 months';
$job$);
