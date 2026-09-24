-- Migration 0036: The Daily Rule Module — adherence tracking (Addendum 06 §5).
--
-- Three tables that make the dashboard the scorekeeper for The Daily Rule:
--   daily_scores — one row per calendar day, scored at that evening's
--     shutdown. Five human toggles → a generated `won` verdict (4/5 weekday,
--     3/4 weekend). Never a streak; win RATE only (computed at query time).
--   hedge_logs  — a running log of hedging moments + whether a pivot was taken.
--   rule_pauses — declared-in-advance (or retroactively-flagged) date ranges
--     that null a day out of the win-rate denominator entirely.
--
-- The engine scores itself once, at shutdown. The Attention Engine never
-- reads these tables (Addendum 06 standing rule #3). 'today' is always the
-- app-local calendar day (app_settings.timezone), never UTC.

-- One row per day. The row for date D is scored at D's evening shutdown.
create table if not exists daily_scores (
  date date primary key,

  -- The five checks. Nullable until scored; each is a human toggle (never
  -- auto-derived — Addendum 06 Never List). false scores as 0, null as
  -- "not yet scored" (leaves `won` null).
  night_held boolean,        -- shutdown + lights-out that BEGAN this day (evening of D-1)
  morning_block boolean,     -- prayer + workout (or unwell substitute) + scripture
  keystone_done boolean,     -- keystone reached the finish line defined the night before
  lines_held boolean,        -- no breach, OR a breach answered by a logged pivot in the same block
  present_home boolean,      -- re-entry through shutdown

  -- Keystone: an ordinary task flagged for the day. Null on weekends unless
  -- a weekend keystone was opted in. ON DELETE SET NULL so deleting the task
  -- never blocks (matches conversations.task_id).
  keystone_task_id uuid references tasks(id) on delete set null,
  keystone_done_means text,  -- required whenever keystone_task_id is set; written at selection

  reentry_time time not null default '17:00',
  day_type text check (day_type in ('client','content')),  -- null on weekends
  note text,
  submitted_at timestamptz,  -- null until shutdown submitted; enforces the backfill window

  -- The verdict, computed once from the checks. Weekend (no keystone) days
  -- need 3 of 4; weekday (keystone set) days need 4 of 5. Null until enough
  -- checks are set. boolean::int is IMMUTABLE, so a stored generated column
  -- is valid.
  --
  -- Keyed off keystone_done_means (not keystone_task_id): the "done means"
  -- text is written whenever a keystone is committed and is NEVER nulled, so
  -- deleting the underlying task later (keystone_task_id → null via ON DELETE
  -- SET NULL) cannot retroactively flip a lost day to won. A lost day stays
  -- lost.
  won boolean generated always as (
    case
      when keystone_done_means is null then
        ((night_held::int + morning_block::int + lines_held::int + present_home::int) >= 3)
      else
        ((night_held::int + morning_block::int + keystone_done::int + lines_held::int + present_home::int) >= 4)
    end
  ) stored,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists hedge_logs (
  id uuid primary key default gen_random_uuid(),
  ts timestamptz not null default now(),
  description text not null,
  commitment_avoided text,
  pivot_taken boolean not null default false,
  created_via text not null check (created_via in ('voice','ui')) default 'ui',
  created_at timestamptz not null default now()
);

create table if not exists rule_pauses (
  id uuid primary key default gen_random_uuid(),
  start_date date not null,
  end_date date not null,
  reason text not null,
  -- retroactive pause = declared_at::date > start_date; flagged in the recap,
  -- never blocked.
  declared_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- Keep daily_scores.updated_at fresh on every write (matches the rest of the
-- schema's set_updated_at() trigger convention).
drop trigger if exists trg_daily_scores_updated_at on daily_scores;
create trigger trg_daily_scores_updated_at
  before update on daily_scores
  for each row execute function set_updated_at();

-- hedge_logs: "today's" strip and "this week vs last week" recap counts both
-- scan by timestamp.
create index if not exists idx_hedge_logs_ts on hedge_logs(ts desc);
-- rule_pauses: win-rate queries test whether a day falls in any pause range.
create index if not exists idx_rule_pauses_range on rule_pauses(start_date, end_date);

-- RLS: authenticated-user-all, matching every other user table. The service
-- role (cron/ingest) bypasses RLS.
alter table daily_scores enable row level security;
drop policy if exists daily_scores_authenticated_all on daily_scores;
create policy daily_scores_authenticated_all on daily_scores
  for all to authenticated using (true) with check (true);

alter table hedge_logs enable row level security;
drop policy if exists hedge_logs_authenticated_all on hedge_logs;
create policy hedge_logs_authenticated_all on hedge_logs
  for all to authenticated using (true) with check (true);

alter table rule_pauses enable row level security;
drop policy if exists rule_pauses_authenticated_all on rule_pauses;
create policy rule_pauses_authenticated_all on rule_pauses
  for all to authenticated using (true) with check (true);

comment on table daily_scores is
  'The Daily Rule five-check score, one row per day (Addendum 06). Scored at that evening''s shutdown; win RATE only, never a streak.';
comment on column daily_scores.won is
  'Generated verdict: >=3 of 4 (weekend, no keystone) or >=4 of 5 (weekday). Null until enough checks are set; a won day also requires submitted_at.';
comment on column daily_scores.submitted_at is
  'Set when shutdown is submitted. Backfill window: editable through noon of D+1 (app tz), then locked; if never submitted, the day computes as lost.';
comment on table hedge_logs is
  'Hedging moments (Addendum 06). Feeds the shutdown lines_held evidence strip and the Sunday recap.';
comment on table rule_pauses is
  'Declared date ranges excluded from win-rate denominators (Addendum 06 §9). Retroactive when declared_at::date > start_date — flagged in recap, never blocked.';
