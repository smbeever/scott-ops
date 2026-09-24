-- Migration 0039: the weekly reflection saved with each Sunday recap
-- (Addendum 06 §7). One free-text field per week: "Where did I hedge, what did
-- it cost, what's the pivot next time?" Keyed by the week's Monday.
--
-- (The recap's next-week planning strip writes keystone/day_type straight to
-- daily_scores rows for the coming days — no table of its own.)

create table if not exists weekly_reflections (
  week_start date primary key,   -- the Monday of the week being reflected on
  reflection text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_weekly_reflections_updated_at on weekly_reflections;
create trigger trg_weekly_reflections_updated_at
  before update on weekly_reflections
  for each row execute function set_updated_at();

-- RLS: authenticated-user-all, matching the rest of the user tables.
alter table weekly_reflections enable row level security;
drop policy if exists weekly_reflections_authenticated_all on weekly_reflections;
create policy weekly_reflections_authenticated_all on weekly_reflections
  for all to authenticated using (true) with check (true);

comment on table weekly_reflections is
  'One free-text reflection per week (Addendum 06), keyed by the week''s Monday. Saved from the Sunday recap.';
