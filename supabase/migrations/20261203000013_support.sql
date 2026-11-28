-- Pinglapp: "Rapportera ett problem" (Settings → Hjälp och feedback). The report itself is never stored here: the Edge
-- Function send-feedback emails it to support@pinglapp.com (through Brevo). This table only counts sends, so nobody
-- can flood the support inbox, or use up the Brevo emails that sign-up and log-in need (300 a day on the free plan).
-- Safe to run while the previous app version is live: nothing in it uses this.
--
-- Limits: one account 5 a day; all guests together 20 a day (they also pass the robot check); everyone together 40 a
-- day. Rows go after 2 days. Only the service role (the Edge Function) can call support_slot().

create table if not exists public.support_sends (
  id         bigint generated always as identity primary key,
  user_id    uuid references auth.users on delete cascade,     -- null: someone without an account
  created_at timestamptz not null default now()
);
create index if not exists support_sends_created on public.support_sends (created_at);
create index if not exists support_sends_user on public.support_sends (user_id, created_at) where user_id is not null;
alter table public.support_sends enable row level security;
revoke all on public.support_sends from public, anon, authenticated;
grant select, insert, delete on public.support_sends to service_role;

-- Takes one send if the limits allow it: 'ok', 'user_limit' (this account, today) or 'day_limit' (everyone, today).
create or replace function public.support_slot(who uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare total int; mine int;
begin
  perform pg_advisory_xact_lock(hashtext('pinglapp.support_slot'));   -- two sends at once can't both take the last one
  delete from public.support_sends where created_at < now() - interval '2 days';
  select count(*) into total from public.support_sends where created_at > now() - interval '1 day';
  if total >= 40 then return 'day_limit'; end if;
  if who is null then
    select count(*) into mine from public.support_sends where user_id is null and created_at > now() - interval '1 day';
    if mine >= 20 then return 'day_limit'; end if;
  else
    select count(*) into mine from public.support_sends where user_id = who and created_at > now() - interval '1 day';
    if mine >= 5 then return 'user_limit'; end if;
  end if;
  insert into public.support_sends (user_id) values (who);
  return 'ok';
end $$;

revoke execute on function public.support_slot(uuid) from public, anon, authenticated;
grant execute on function public.support_slot(uuid) to service_role;
