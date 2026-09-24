import type { SupabaseClient } from '@supabase/supabase-js';
import { addDays, localWallTimeIso } from './tz.js';

// Shared math for The Daily Rule (Addendum 06). Win-rate + the backfill
// window live here so the shutdown route and the Sunday recap compute them
// identically.

// The backfill deadline for scoring day D: noon (app-local) of D+1. Editable
// from D's afternoon through then; after it, the row locks. Computed as local
// 12:00 directly (DST-correct), not midnight + 12h of elapsed time.
export function backfillDeadlineIso(dateLocal: string, tz: string): string {
  return localWallTimeIso(addDays(dateLocal, 1), 12, 0, tz);
}

// A day D is locked once we're past noon of D+1.
export function isLocked(dateLocal: string, tz: string, now: Date): boolean {
  return now.getTime() > new Date(backfillDeadlineIso(dateLocal, tz)).getTime();
}

export interface WinRate {
  won: number;
  scorable: number;
  rate: number | null; // 0..1, null when there are no scorable days
}

interface PauseRow {
  start_date: string;
  end_date: string;
}
interface ScoreRow {
  date: string;
  won: boolean | null;
  submitted_at: string | null;
}

// Win rate over the `days`-day window ending at endDateLocal (inclusive).
//   scorable day = a date in the window not covered by any rule_pauses range.
//   won day      = won = true AND submitted_at is not null.
//   rate         = won / scorable  (an unsubmitted scorable day is "not won").
export async function computeWinRate(
  sb: SupabaseClient,
  endDateLocal: string,
  days: number,
  tz: string,
): Promise<WinRate> {
  // Build the window of calendar dates [endDate-(days-1) .. endDate].
  const windowDates: string[] = [];
  for (let i = days - 1; i >= 0; i--) windowDates.push(addDays(endDateLocal, -i));
  const startDate = windowDates[0]!;

  const [pausesRes, scoresRes] = await Promise.all([
    sb
      .from('rule_pauses')
      .select('start_date, end_date')
      .lte('start_date', endDateLocal)
      .gte('end_date', startDate),
    sb
      .from('daily_scores')
      .select('date, won, submitted_at')
      .gte('date', startDate)
      .lte('date', endDateLocal),
  ]);
  if (pausesRes.error) throw new Error(pausesRes.error.message);
  if (scoresRes.error) throw new Error(scoresRes.error.message);

  const pauses = (pausesRes.data ?? []) as PauseRow[];
  const scoreByDate = new Map<string, ScoreRow>();
  for (const r of (scoresRes.data ?? []) as ScoreRow[]) scoreByDate.set(r.date, r);

  const isPaused = (date: string) =>
    pauses.some((p) => p.start_date <= date && date <= p.end_date);

  let scorable = 0;
  let won = 0;
  for (const date of windowDates) {
    if (isPaused(date)) continue;
    scorable++;
    const row = scoreByDate.get(date);
    if (row && row.won === true && row.submitted_at) won++;
  }

  return { won, scorable, rate: scorable > 0 ? won / scorable : null };
}

const CHECK_KEYS = [
  'night_held', 'morning_block', 'keystone_done', 'lines_held', 'present_home',
] as const;
type CheckKey = (typeof CHECK_KEYS)[number];
type CheckRow = {
  date: string;
  submitted_at: string | null;
  keystone_done_means: string | null;
} & Record<CheckKey, boolean | null>;

export type PerCheckRates = Record<CheckKey, { passed: number; total: number; rate: number | null }>;

// Per-check pass rates over the trailing `days`-day window: for each of the
// five checks, passed / total across submitted, non-paused days. keystone_done
// only counts days that actually had a keystone (keystone_done_means set) —
// otherwise weekend/keystone-less days would drag its rate down unfairly.
export async function computePerCheckRates(
  sb: SupabaseClient,
  endDateLocal: string,
  days: number,
  tz: string,
): Promise<PerCheckRates> {
  const windowDates: string[] = [];
  for (let i = days - 1; i >= 0; i--) windowDates.push(addDays(endDateLocal, -i));
  const startDate = windowDates[0]!;
  const windowSet = new Set(windowDates);

  const [pausesRes, scoresRes] = await Promise.all([
    sb.from('rule_pauses').select('start_date, end_date').lte('start_date', endDateLocal).gte('end_date', startDate),
    sb
      .from('daily_scores')
      .select('date, submitted_at, keystone_done_means, night_held, morning_block, keystone_done, lines_held, present_home')
      .gte('date', startDate)
      .lte('date', endDateLocal),
  ]);
  if (pausesRes.error) throw new Error(pausesRes.error.message);
  if (scoresRes.error) throw new Error(scoresRes.error.message);

  const pauses = (pausesRes.data ?? []) as { start_date: string; end_date: string }[];
  const isPaused = (date: string) => pauses.some((p) => p.start_date <= date && date <= p.end_date);

  const acc: PerCheckRates = {
    night_held: { passed: 0, total: 0, rate: null },
    morning_block: { passed: 0, total: 0, rate: null },
    keystone_done: { passed: 0, total: 0, rate: null },
    lines_held: { passed: 0, total: 0, rate: null },
    present_home: { passed: 0, total: 0, rate: null },
  };

  for (const row of (scoresRes.data ?? []) as CheckRow[]) {
    if (!row.submitted_at) continue;
    if (!windowSet.has(row.date) || isPaused(row.date)) continue;
    for (const key of CHECK_KEYS) {
      // keystone_done only applies to days that had a keystone.
      if (key === 'keystone_done' && row.keystone_done_means == null) continue;
      acc[key].total += 1;
      if (row[key] === true) acc[key].passed += 1;
    }
  }
  for (const key of CHECK_KEYS) {
    acc[key].rate = acc[key].total > 0 ? acc[key].passed / acc[key].total : null;
  }
  return acc;
}
