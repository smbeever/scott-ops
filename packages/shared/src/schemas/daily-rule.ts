import { z } from 'zod';

// The Daily Rule Module (Addendum 06). Mirrors migration 0036.
//   daily_scores — one row per day, five human toggles → a generated `won`.
//   hedge_logs  — hedging moments + whether a pivot was taken.
//   rule_pauses — date ranges excluded from the win-rate denominator.
// Win RATE only — a lost day costs exactly one day, never a streak.

export const DayTypeSchema = z.enum(['client', 'content']);
export type DayType = z.infer<typeof DayTypeSchema>;

// A Postgres `time` serializes as HH:MM:SS; the UI sends HH:MM. Accept both.
const TimeStringSchema = z
  .string()
  .regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Expected HH:MM or HH:MM:SS');

export const DailyScoreSchema = z.object({
  date: z.string().date(),
  night_held: z.boolean().nullable(),
  morning_block: z.boolean().nullable(),
  keystone_done: z.boolean().nullable(),
  lines_held: z.boolean().nullable(),
  present_home: z.boolean().nullable(),
  keystone_task_id: z.string().uuid().nullable(),
  keystone_done_means: z.string().nullable(),
  reentry_time: z.string(),
  day_type: DayTypeSchema.nullable(),
  note: z.string().nullable(),
  submitted_at: z.string().datetime({ offset: true }).nullable(),
  won: z.boolean().nullable(),
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }),
});
export type DailyScore = z.infer<typeof DailyScoreSchema>;

export const HedgeLogSchema = z.object({
  id: z.string().uuid(),
  ts: z.string().datetime({ offset: true }),
  description: z.string().min(1),
  commitment_avoided: z.string().nullable(),
  pivot_taken: z.boolean(),
  created_via: z.enum(['voice', 'ui']),
  created_at: z.string().datetime({ offset: true }),
});
export type HedgeLog = z.infer<typeof HedgeLogSchema>;

export const CreateHedgeLogSchema = z.object({
  description: z.string().min(1),
  commitment_avoided: z.string().nullable().optional(),
  pivot_taken: z.boolean().optional(),
  created_via: z.enum(['voice', 'ui']).optional(),
});
export type CreateHedgeLog = z.infer<typeof CreateHedgeLogSchema>;

// Post-capture edit — primarily flipping "pivot taken" after the Pivot
// Protocol card is shown.
export const UpdateHedgeLogSchema = z.object({
  pivot_taken: z.boolean().optional(),
  description: z.string().min(1).optional(),
  commitment_avoided: z.string().nullable().optional(),
});
export type UpdateHedgeLog = z.infer<typeof UpdateHedgeLogSchema>;

export const RulePauseSchema = z.object({
  id: z.string().uuid(),
  start_date: z.string().date(),
  end_date: z.string().date(),
  reason: z.string().min(1),
  declared_at: z.string().datetime({ offset: true }),
  created_at: z.string().datetime({ offset: true }),
});
export type RulePause = z.infer<typeof RulePauseSchema>;

// The shutdown submit. Scores apply to `date` (day D just lived); the
// `tomorrow` block plans day D+1 (keystone + re-entry + day_type). A keystone
// requires a binary "done means" finish line — enforced here and server-side.
export const ShutdownSubmitSchema = z.object({
  date: z.string().date(),
  scores: z.object({
    night_held: z.boolean().nullable().optional(),
    morning_block: z.boolean().nullable().optional(),
    keystone_done: z.boolean().nullable().optional(),
    lines_held: z.boolean().nullable().optional(),
    present_home: z.boolean().nullable().optional(),
    note: z.string().nullable().optional(),
  }),
  tomorrow: z
    .object({
      keystone_task_id: z.string().uuid().nullable().optional(),
      keystone_done_means: z.string().nullable().optional(),
      reentry_time: TimeStringSchema.optional(),
      day_type: DayTypeSchema.nullable().optional(),
    })
    .refine(
      (t) =>
        !t.keystone_task_id ||
        (typeof t.keystone_done_means === 'string' && t.keystone_done_means.trim().length > 0),
      {
        message: 'A keystone needs a "done means" finish line.',
        path: ['keystone_done_means'],
      },
    ),
});
export type ShutdownSubmit = z.infer<typeof ShutdownSubmitSchema>;

// ─── day_type + re-entry defaults (Addendum 06 §5 / the-daily-rule.md §The Week)

// Client days: Mon/Tue/Thu. Content days: Wed/Fri. Weekends: none.
// Indexed by JS weekday (0 = Sun .. 6 = Sat).
export const DAY_TYPE_BY_WEEKDAY: readonly (DayType | null)[] = [
  null,      // Sun
  'client',  // Mon
  'client',  // Tue
  'content', // Wed
  'client',  // Thu
  'content', // Fri
  null,      // Sat
];

// Weekday of a YYYY-MM-DD, timezone-independent (a calendar date has a fixed
// weekday). 0 = Sunday .. 6 = Saturday.
export function weekdayOfLocalDate(localDate: string): number {
  const [y, m, d] = localDate.split('-').map((s) => parseInt(s, 10));
  return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
}

export function defaultDayTypeForDate(localDate: string): DayType | null {
  return DAY_TYPE_BY_WEEKDAY[weekdayOfLocalDate(localDate)] ?? null;
}

// Default re-entry: 17:00, except summer Fridays (Jun 1 – Aug 31) → 15:00
// (rolling to the lake by 3:00). Hardcoded for v1 per the spec.
export function defaultReentryTimeForDate(localDate: string): string {
  const weekday = weekdayOfLocalDate(localDate);
  const month = parseInt(localDate.slice(5, 7), 10);
  if (weekday === 5 && month >= 6 && month <= 8) return '15:00';
  return '17:00';
}

// ─── Response DTOs (server → shutdown flow) ──────────────────────────────

export interface CalendarEventLite {
  id: string;
  title: string;
  start_at: string;
  all_day: boolean;
}

// Everything the /shutdown flow needs in one request. `date` is the day being
// scored (today in app tz, or an in-window backfill date); `tomorrow_date` is
// the day being planned.
export interface ShutdownContext {
  date: string;
  tomorrow_date: string;
  // App timezone (e.g. America/Denver) — the client formats calendar event
  // times in it, not the device zone.
  tz: string;
  today: DailyScore | null;
  tomorrow: DailyScore | null;
  tomorrow_defaults: { day_type: DayType | null; reentry_time: string };
  // D+1 is a weekend → the keystone step is offered but default-skipped.
  keystone_optional: boolean;
  // Today's hedges, for the Step 1 lines_held evidence strip.
  hedge_summary: { count: number; pivoted: number };
  // Tomorrow's synced calendar events (display only, never a suggestion).
  calendar_events: CalendarEventLite[];
  // Past the noon-of-D+1 backfill deadline: the row is read-only.
  locked: boolean;
  backfill_deadline: string;
}

// The post-submit confirmation moment: won/lost + the rolling 7-day rate.
export interface ShutdownResult {
  date: string;
  won: boolean;
  seven_day_rate: number | null; // 0..1, null when no scorable days yet
}

// ─── Recap (Sunday) ──────────────────────────────────────────────────────

export interface WinRateDto {
  won: number;
  scorable: number;
  rate: number | null; // 0..1, null when no scorable days
}

export type CheckKey =
  | 'night_held'
  | 'morning_block'
  | 'keystone_done'
  | 'lines_held'
  | 'present_home';

export const CHECK_ORDER: readonly CheckKey[] = [
  'night_held', 'morning_block', 'keystone_done', 'lines_held', 'present_home',
];

export const CHECK_LABELS: Record<CheckKey, string> = {
  night_held: 'Last night held',
  morning_block: 'Morning block',
  keystone_done: 'Keystone',
  lines_held: 'Lines held',
  present_home: 'Present at home',
};

export interface CheckRateDto {
  passed: number;
  total: number;
  rate: number | null;
}

// One day in the next-week planning strip. Reflects the current daily_scores
// plan for that date (empty until planned).
export interface PlanDaySlot {
  date: string;
  weekday: number; // 0 = Sun .. 6 = Sat
  day_type: DayType | null;
  keystone_task_id: string | null;
  keystone_done_means: string | null;
  keystone_optional: boolean; // weekend → keystone is optional
}

export interface RecapPayload {
  today: string;
  seven_day: WinRateDto;
  thirty_day: WinRateDto;
  // Per-check pass rates over the trailing 30 days (submitted, non-paused
  // days). keystone_done's denominator is only days that had a keystone.
  per_check: Record<CheckKey, CheckRateDto>;
  // The weakest check with enough data — "Current constraint".
  current_constraint: CheckKey | null;
  hedges_this_week: HedgeLog[];
  hedges_this_week_count: number;
  hedges_prior_week_count: number;
  // Pauses declared after they began (declared_at date > start_date) — flagged.
  retroactive_pauses: RulePause[];
  // Next-week planning strip: the seven days ahead, with any plan already set.
  planning_week: PlanDaySlot[];
  // The weekly reflection, keyed by this week's Monday.
  reflection_week_start: string;
  reflection: string;
}

// Plan the coming week: upsert keystone/day_type onto each date's daily_scores
// row (planning columns only — scores are untouched).
export const PlanWeekSubmitSchema = z.object({
  days: z
    .array(
      z
        .object({
          date: z.string().date(),
          keystone_task_id: z.string().uuid().nullable().optional(),
          keystone_done_means: z.string().nullable().optional(),
          day_type: DayTypeSchema.nullable().optional(),
        })
        .refine(
          (d) =>
            !d.keystone_task_id ||
            (typeof d.keystone_done_means === 'string' && d.keystone_done_means.trim().length > 0),
          { message: 'A keystone needs a "done means" finish line.', path: ['keystone_done_means'] },
        ),
    )
    .max(14),
});
export type PlanWeekSubmit = z.infer<typeof PlanWeekSubmitSchema>;

export const WeeklyReflectionSubmitSchema = z.object({
  week_start: z.string().date(),
  reflection: z.string(),
});
export type WeeklyReflectionSubmit = z.infer<typeof WeeklyReflectionSubmitSchema>;
