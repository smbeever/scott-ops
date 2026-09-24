-- Migration 0037: dedup log for The Daily Rule's sanctioned pushes (Addendum
-- 06 §7). Two coaching pushes fire once per day — 4:00 PM weekdays ("Begin
-- closing loops") and 8:30 PM daily ("Shutdown"). They piggyback on the
-- per-minute reminders cron and self-gate on app-local time, so a small
-- per-(type, day) claim row makes each fire at-most-once despite the cron
-- running every minute inside the fire window.

create table if not exists rule_push_log (
  push_type text not null,
  local_date date not null,
  sent_at timestamptz not null default now(),
  primary key (push_type, local_date)
);

-- RLS: authenticated-user-all, matching the rest of the user tables. Written
-- by the cron via the service role (which bypasses RLS).
alter table rule_push_log enable row level security;
drop policy if exists rule_push_log_authenticated_all on rule_push_log;
create policy rule_push_log_authenticated_all on rule_push_log
  for all to authenticated using (true) with check (true);

comment on table rule_push_log is
  'Once-per-day claim rows for the Daily Rule sanctioned pushes (Addendum 06). PK (push_type, local_date) makes each push fire at most once per app-local day.';
