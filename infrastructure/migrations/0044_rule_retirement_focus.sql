-- Migration 0044: Daily Rule retirement + Tomorrow's Focus (Addendum 09).
--
-- Two independent pieces, one migration:
--
-- 1) The Rule module's feature flag. The module (Addendum 06) shipped UNGATED —
--    there was no flag to flip — so this adds one, defaulting OFF. That single
--    column retires /shutdown, /recap, /hedge, the two Rule pushes, the Today
--    re-entry strip, and the keystone badge in one move. Data is NOT touched:
--    daily_scores, hedge_logs, rule_pauses and rule_push_log keep every row.
--    A hard delete (drop routes, components, tables) is a backlog item dated no
--    earlier than 30 days out — reversibility until certainty.
--
-- 2) daily_focus — the one piece of the evening pick that survives, transformed:
--    project-level, scoring-free, optional. Deliberately minimal. There is NO
--    status column and NO completion column: the focus is a POINTER, and the
--    target object's real state already lives on the Work page. Nothing in the
--    system may ever count, score, rate, or display adherence to it — that
--    guardrail is the whole reason the scoring apparatus is being retired.
--
-- Note on numbering: Addendum 09 was drafted assuming 0043 was free, but the
-- Work Page build consumed BOTH 0042 (work page) and 0043 (task↔milestone), so
-- this lands at 0044.
--
-- Additive + idempotent.

-- 1) Rule module flag. Mirrors health_module_enabled (0032) and
--    routines_module_enabled (0038): one typed boolean on the singleton.
--    DEFAULT false — unlike the other two, this flag is born off; it exists to
--    retire a module, not to stage one.
alter table app_settings
  add column if not exists rule_module_enabled boolean not null default false;

comment on column app_settings.rule_module_enabled is
  'Daily Rule module visibility (Addendum 06, retired by Addendum 09). Default FALSE — the scoring apparatus is retired. When false: /shutdown, /recap and /hedge 404, the Today re-entry strip + Shutdown button + keystone badge do not render, the Rule API endpoints 404, and the 4pm/8:30pm pushes never fire. All Rule data is retained.';

-- 2) Tomorrow's Focus. One row per date (upsert on the date PK — setting a
--    focus twice for the same day replaces it). target_id is intentionally NOT
--    a foreign key: it points at one of two different tables depending on
--    target_type, which no single FK can express. The app layer validates it
--    against the typed table on write, and reads tolerate a vanished target by
--    rendering nothing.
create table if not exists daily_focus (
  date date primary key,
  target_type text not null check (target_type in ('project','content_item')),
  target_id uuid not null,
  note text,
  created_at timestamptz not null default now()
);

comment on table daily_focus is
  'Tomorrow''s Focus (Addendum 09) — one optional pointer per day at a project or content item. No status, no completion, no adherence tracking anywhere, permanently.';
comment on column daily_focus.target_type is
  'Which table target_id refers to: project or content_item. Validated app-side (no FK can span two tables).';

alter table daily_focus enable row level security;
drop policy if exists daily_focus_authenticated_all on daily_focus;
create policy daily_focus_authenticated_all on daily_focus
  for all to authenticated using (true) with check (true);
