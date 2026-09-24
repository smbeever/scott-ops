import type { FastifyPluginAsync } from 'fastify';
import {
  ShutdownSubmitSchema,
  CreateHedgeLogSchema,
  UpdateHedgeLogSchema,
  defaultDayTypeForDate,
  defaultReentryTimeForDate,
  CHECK_ORDER,
  PlanWeekSubmitSchema,
  WeeklyReflectionSubmitSchema,
  type ShutdownContext,
  type ShutdownResult,
  type CalendarEventLite,
  type DailyScore,
  type RecapPayload,
  type CheckKey,
  type HedgeLog,
  type RulePause,
  type PlanDaySlot,
  type DayType,
} from '@scott-ops/shared/schemas';
import { getAppTz, getFeatureFlag } from '../lib/app-settings.js';
import { todayInTz, addDays, startOfLocalDayIso, formatInTz, localWeekday } from '../lib/tz.js';
import { computeWinRate, computePerCheckRates, backfillDeadlineIso, isLocked } from '../lib/daily-rule.js';

// /api/shutdown/* — The Daily Rule shutdown flow (Addendum 06 §6). One
// context read powers the three-step flow; one submit scores day D and plans
// day D+1. All day-boundaries are app-local (never UTC). The Attention Engine
// never touches these tables — the Rule scores itself once, here.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const dailyRuleRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAuth);
  // Retirement gate (Addendum 09). rule_module_enabled defaults FALSE, so this
  // whole group — shutdown context/submit, daily scores, recap, plan-week,
  // weekly reflections, keystones, hedges — 404s as if it never existed. The
  // tables keep every row; a hard delete is a ≥30-day backlog item. Mirrors the
  // Health module's gate (Addendum 05).
  app.addHook('preHandler', async (_req, reply) => {
    if (!(await getFeatureFlag('rule_module_enabled'))) {
      return reply.code(404).send({ error: 'not_found' });
    }
  });

  // Everything the /shutdown flow needs, in one request.
  app.get<{ Querystring: { date?: string } }>(
    '/api/shutdown/context',
    async (req, reply) => {
      const tz = await getAppTz();
      const today = todayInTz(tz);
      const date = req.query.date ?? today;
      if (!DATE_RE.test(date)) {
        return reply.code(400).send({ error: 'invalid_date' });
      }
      // You score today or backfill a past day — never a day that hasn't
      // happened. (Lexical compare on YYYY-MM-DD is chronological.)
      if (date > today) {
        return reply.code(400).send({ error: 'future_date' });
      }
      const tomorrow = addDays(date, 1);

      const dayStartIso = startOfLocalDayIso(date, tz);
      const nextDayStartIso = startOfLocalDayIso(tomorrow, tz);
      const dayAfterStartIso = startOfLocalDayIso(addDays(date, 2), tz);

      const [todayRes, tomorrowRes, hedgeRes, eventsRes] = await Promise.all([
        req.supabase!.from('daily_scores').select('*').eq('date', date).maybeSingle(),
        req.supabase!.from('daily_scores').select('*').eq('date', tomorrow).maybeSingle(),
        req.supabase!
          .from('hedge_logs')
          .select('pivot_taken')
          .gte('ts', dayStartIso)
          .lt('ts', nextDayStartIso),
        req.supabase!
          .from('calendar_events')
          .select('id, title, start_at, all_day')
          .gte('start_at', nextDayStartIso)
          .lt('start_at', dayAfterStartIso)
          .order('start_at', { ascending: true }),
      ]);
      if (todayRes.error) throw app.httpErrors.internalServerError(todayRes.error.message);
      if (tomorrowRes.error) throw app.httpErrors.internalServerError(tomorrowRes.error.message);
      if (hedgeRes.error) throw app.httpErrors.internalServerError(hedgeRes.error.message);
      if (eventsRes.error) throw app.httpErrors.internalServerError(eventsRes.error.message);

      const hedges = (hedgeRes.data ?? []) as { pivot_taken: boolean }[];
      const tomorrowRow = (tomorrowRes.data ?? null) as DailyScore | null;

      const context: ShutdownContext = {
        date,
        tomorrow_date: tomorrow,
        tz,
        today: (todayRes.data ?? null) as DailyScore | null,
        tomorrow: tomorrowRow,
        // If tomorrow's row already exists, honor its stored plan — including
        // an explicit null day_type ("None"). Only fall back to defaults when
        // there's no row yet.
        tomorrow_defaults: {
          day_type: tomorrowRow ? tomorrowRow.day_type : defaultDayTypeForDate(tomorrow),
          reentry_time: tomorrowRow ? tomorrowRow.reentry_time : defaultReentryTimeForDate(tomorrow),
        },
        keystone_optional: defaultDayTypeForDate(tomorrow) === null,
        hedge_summary: {
          count: hedges.length,
          pivoted: hedges.filter((h) => h.pivot_taken).length,
        },
        calendar_events: (eventsRes.data ?? []) as CalendarEventLite[],
        locked: isLocked(date, tz, new Date()),
        backfill_deadline: backfillDeadlineIso(date, tz),
      };
      return context;
    },
  );

  // A single day's row (or null if unscored/unplanned). Powers the Today
  // re-entry strip; kept lightweight vs the full context read.
  app.get<{ Params: { date: string } }>('/api/daily-scores/:date', async (req, reply) => {
    if (!DATE_RE.test(req.params.date)) {
      return reply.code(400).send({ error: 'invalid_date' });
    }
    const { data, error } = await req.supabase!
      .from('daily_scores')
      .select('*')
      .eq('date', req.params.date)
      .maybeSingle();
    if (error) throw app.httpErrors.internalServerError(error.message);
    return { score: (data ?? null) as DailyScore | null };
  });

  // ─── Recap (Sunday) ─────────────────────────────────────────────────

  // The weekly mirror: rolling win rates, per-check pass rates + the current
  // constraint, this-week-vs-prior hedge counts, and flagged retroactive
  // pauses. Read-only; the planning strip + weekly reflection land next.
  app.get('/api/recap', async (req) => {
    const tz = await getAppTz();
    const today = todayInTz(tz);

    // Hedge windows: this week = trailing 7 days, prior week = the 7 before.
    const weekStartIso = startOfLocalDayIso(addDays(today, -6), tz);
    const tomorrowStartIso = startOfLocalDayIso(addDays(today, 1), tz);
    const priorStartIso = startOfLocalDayIso(addDays(today, -13), tz);

    const [sevenDay, thirtyDay, perCheck, hedgesThisWeek, priorCountRes, pausesRes] =
      await Promise.all([
        computeWinRate(req.supabase!, today, 7, tz),
        computeWinRate(req.supabase!, today, 30, tz),
        computePerCheckRates(req.supabase!, today, 30, tz),
        req.supabase!
          .from('hedge_logs')
          .select('*')
          .gte('ts', weekStartIso)
          .lt('ts', tomorrowStartIso)
          .order('ts', { ascending: false }),
        req.supabase!
          .from('hedge_logs')
          .select('id', { count: 'exact', head: true })
          .gte('ts', priorStartIso)
          .lt('ts', weekStartIso),
        // Pauses touching the trailing 30 days, to flag any retroactive ones.
        req.supabase!
          .from('rule_pauses')
          .select('*')
          .gte('end_date', addDays(today, -30)),
      ]);

    if (hedgesThisWeek.error) throw app.httpErrors.internalServerError(hedgesThisWeek.error.message);
    if (priorCountRes.error) throw app.httpErrors.internalServerError(priorCountRes.error.message);
    if (pausesRes.error) throw app.httpErrors.internalServerError(pausesRes.error.message);

    // Current constraint = the check with the lowest pass rate among those
    // with data; ties break by canonical order (earliest check wins).
    let currentConstraint: CheckKey | null = null;
    let worstRate = Infinity;
    for (const key of CHECK_ORDER) {
      const c = perCheck[key];
      if (c.total === 0 || c.rate == null) continue;
      if (c.rate < worstRate) {
        worstRate = c.rate;
        currentConstraint = key;
      }
    }

    // Retroactive = declared after the pause began, compared in APP-LOCAL
    // dates (declared_at is timestamptz/UTC; an evening same-day declaration
    // must not be mis-flagged in a west-of-UTC zone).
    const retroactivePauses = ((pausesRes.data ?? []) as RulePause[]).filter(
      (p) => formatInTz(new Date(p.declared_at), tz) > p.start_date,
    );

    // Next-week planning strip: the seven days ahead + any plan already set.
    const planDates: string[] = [];
    for (let i = 1; i <= 7; i++) planDates.push(addDays(today, i));
    // Reflection is keyed by this week's Monday.
    const weekStart = addDays(today, -((localWeekday(today) + 6) % 7));

    const [planRowsRes, reflectionRes] = await Promise.all([
      req.supabase!
        .from('daily_scores')
        .select('date, day_type, keystone_task_id, keystone_done_means')
        .in('date', planDates),
      req.supabase!
        .from('weekly_reflections')
        .select('reflection')
        .eq('week_start', weekStart)
        .maybeSingle(),
    ]);
    if (planRowsRes.error) throw app.httpErrors.internalServerError(planRowsRes.error.message);
    if (reflectionRes.error) throw app.httpErrors.internalServerError(reflectionRes.error.message);

    const planByDate = new Map(
      ((planRowsRes.data ?? []) as Array<{
        date: string; day_type: DayType | null;
        keystone_task_id: string | null; keystone_done_means: string | null;
      }>).map((r) => [r.date, r]),
    );
    const planningWeek: PlanDaySlot[] = planDates.map((date) => {
      const row = planByDate.get(date);
      return {
        date,
        weekday: localWeekday(date),
        // Existing plan wins (incl. an explicit null); else the weekday default.
        day_type: row ? row.day_type : defaultDayTypeForDate(date),
        keystone_task_id: row?.keystone_task_id ?? null,
        keystone_done_means: row?.keystone_done_means ?? null,
        keystone_optional: defaultDayTypeForDate(date) === null,
      };
    });

    const payload: RecapPayload = {
      today,
      seven_day: sevenDay,
      thirty_day: thirtyDay,
      per_check: perCheck,
      current_constraint: currentConstraint,
      hedges_this_week: (hedgesThisWeek.data ?? []) as HedgeLog[],
      hedges_this_week_count: hedgesThisWeek.data?.length ?? 0,
      hedges_prior_week_count: priorCountRes.count ?? 0,
      retroactive_pauses: retroactivePauses,
      planning_week: planningWeek,
      reflection_week_start: weekStart,
      reflection: (reflectionRes.data?.reflection as string | undefined) ?? '',
    };
    return payload;
  });

  // Plan the coming week — upsert keystone/day_type onto each date's row.
  app.post('/api/plan-week', async (req, reply) => {
    const parsed = PlanWeekSubmitSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_payload', details: parsed.error.flatten() });
    }
    const rows = parsed.data.days.map((d) => {
      const keystoneTaskId = d.keystone_task_id ?? null;
      return {
        date: d.date,
        keystone_task_id: keystoneTaskId,
        keystone_done_means: keystoneTaskId ? (d.keystone_done_means ?? null) : null,
        day_type: d.day_type ?? null,
      };
    });
    // Upsert on date — only the planning columns are set, so any existing
    // scores on those rows are preserved.
    const { error } = await req.supabase!
      .from('daily_scores')
      .upsert(rows, { onConflict: 'date' });
    if (error) throw app.httpErrors.internalServerError(error.message);
    return reply.code(200).send({ planned: rows.length });
  });

  // Save the weekly reflection (upsert by the week's Monday).
  app.post('/api/weekly-reflections', async (req, reply) => {
    const parsed = WeeklyReflectionSubmitSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_payload', details: parsed.error.flatten() });
    }
    const { data, error } = await req.supabase!
      .from('weekly_reflections')
      .upsert(
        { week_start: parsed.data.week_start, reflection: parsed.data.reflection },
        { onConflict: 'week_start' },
      )
      .select('*')
      .single();
    if (error) throw app.httpErrors.internalServerError(error.message);
    return data;
  });

  // Active keystone task ids — today's + tomorrow's. Lets task surfaces badge
  // the flagged task without each row doing its own lookup.
  app.get('/api/keystones/active', async (req) => {
    const tz = await getAppTz();
    const today = todayInTz(tz);
    const { data, error } = await req.supabase!
      .from('daily_scores')
      .select('keystone_task_id')
      .in('date', [today, addDays(today, 1)])
      .not('keystone_task_id', 'is', null);
    if (error) throw app.httpErrors.internalServerError(error.message);
    const ids = [...new Set((data ?? []).map((r) => r.keystone_task_id as string))];
    return { task_ids: ids };
  });

  // ─── Hedge log ──────────────────────────────────────────────────────

  // Log a hedge. created_via defaults to 'ui'; the voice grammar will pass
  // 'voice'. On save the client shows the Pivot Protocol card.
  app.post('/api/hedges', async (req, reply) => {
    const parsed = CreateHedgeLogSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_payload',
        details: parsed.error.flatten().fieldErrors,
      });
    }
    const { data, error } = await req.supabase!
      .from('hedge_logs')
      .insert({
        description: parsed.data.description,
        commitment_avoided: parsed.data.commitment_avoided ?? null,
        pivot_taken: parsed.data.pivot_taken ?? false,
        created_via: parsed.data.created_via ?? 'ui',
      })
      .select('*')
      .single();
    if (error) throw app.httpErrors.internalServerError(error.message);
    return reply.code(201).send(data);
  });

  // Edit a hedge — chiefly flipping pivot_taken after the Pivot card.
  app.patch<{ Params: { id: string } }>('/api/hedges/:id', async (req, reply) => {
    const parsed = UpdateHedgeLogSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_payload',
        details: parsed.error.flatten().fieldErrors,
      });
    }
    if (Object.keys(parsed.data).length === 0) {
      return reply.code(400).send({ error: 'empty_payload' });
    }
    const { data, error } = await req.supabase!
      .from('hedge_logs')
      .update(parsed.data)
      .eq('id', req.params.id)
      .select('*')
      .single();
    if (error) throw app.httpErrors.internalServerError(error.message);
    return data;
  });

  // Submit the shutdown: score day D, plan day D+1, return the confirmation.
  app.post('/api/shutdown', async (req, reply) => {
    const parsed = ShutdownSubmitSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_payload',
        details: parsed.error.flatten().fieldErrors,
      });
    }
    const { date, scores, tomorrow } = parsed.data;
    const tz = await getAppTz();
    const now = new Date();

    // Can't score a future day, and can't edit a day past its backfill window.
    if (date > todayInTz(tz)) {
      return reply.code(400).send({ error: 'future_date' });
    }
    if (isLocked(date, tz, now)) {
      return reply.code(409).send({ error: 'locked', deadline: backfillDeadlineIso(date, tz) });
    }

    const tomorrowDate = addDays(date, 1);

    // Row D: set the scores + note + submitted_at. Upsert on `date` so we
    // don't clobber the keystone/day_type/reentry fields set last night — only
    // the provided score columns are updated on conflict.
    const scoreRow: Record<string, unknown> = { date, submitted_at: now.toISOString() };
    for (const k of ['night_held', 'morning_block', 'keystone_done', 'lines_held', 'present_home'] as const) {
      if (scores[k] !== undefined) scoreRow[k] = scores[k];
    }
    if (scores.note !== undefined) scoreRow.note = scores.note;

    // Row D+1: plan tomorrow. Weekend-skipped keystone → null. Defaults fill
    // reentry/day_type when the client didn't override them.
    const keystoneTaskId = tomorrow.keystone_task_id ?? null;
    const planRow: Record<string, unknown> = {
      date: tomorrowDate,
      keystone_task_id: keystoneTaskId,
      keystone_done_means: keystoneTaskId ? (tomorrow.keystone_done_means ?? null) : null,
      reentry_time: tomorrow.reentry_time ?? defaultReentryTimeForDate(tomorrowDate),
      day_type:
        tomorrow.day_type !== undefined ? tomorrow.day_type : defaultDayTypeForDate(tomorrowDate),
    };

    const [scoreUpsert, planUpsert] = await Promise.all([
      req.supabase!.from('daily_scores').upsert(scoreRow, { onConflict: 'date' }).select('won').single(),
      req.supabase!.from('daily_scores').upsert(planRow, { onConflict: 'date' }).select('date').single(),
    ]);
    if (scoreUpsert.error) throw app.httpErrors.internalServerError(scoreUpsert.error.message);
    if (planUpsert.error) throw app.httpErrors.internalServerError(planUpsert.error.message);

    const winRate = await computeWinRate(req.supabase!, date, 7, tz);

    const result: ShutdownResult = {
      date,
      won: (scoreUpsert.data as { won: boolean | null }).won === true,
      seven_day_rate: winRate.rate,
    };
    return reply.code(200).send(result);
  });
};
