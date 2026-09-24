import type { SupabaseClient } from '@supabase/supabase-js';
import { env } from './env.js';
import { getAppTz } from './app-settings.js';
import { todayInTz, nowMinutesInTz, localWeekday } from './tz.js';
import { sendPushover } from './pushover.js';

// The Daily Rule's sanctioned pushes (Addendum 06 §7) — two of the five
// coaching moments. 4:00 PM weekdays "Begin closing loops" and 8:30 PM daily
// "Shutdown". They piggyback on the per-minute reminders cron and self-gate on
// app-local time (so no DST drift), claiming a rule_push_log row so each fires
// at most once per local day even though the cron runs every minute in the
// fire window. Task/calendar reminders are exempt from all of this — they run
// on their own schedule.

// Tolerate cron gaps/jitter: fire anytime within this many minutes after the
// target. The per-(type, day) claim row prevents repeats inside the window.
const FIRE_WINDOW_MIN = 20;

interface SanctionedPush {
  type: string;
  atMinutes: number; // minutes since local midnight
  weekdaysOnly: boolean;
  title: string;
  message: string;
  path: string;
}

const PUSHES: readonly SanctionedPush[] = [
  {
    type: 'closing_loops',
    atMinutes: 16 * 60, // 4:00 PM
    weekdaysOnly: true,
    title: 'Begin closing loops',
    message: 'Nothing stays open to follow me home.',
    path: '/today',
  },
  {
    type: 'shutdown',
    atMinutes: 20 * 60 + 30, // 8:30 PM
    weekdaysOnly: false,
    title: 'Shutdown',
    message: 'Score the day. Pick tomorrow’s keystone. Set re-entry.',
    path: '/shutdown',
  },
];

export async function runRulePushes(
  sb: SupabaseClient,
): Promise<{ dispatched: number; failed: number }> {
  const tz = await getAppTz();
  const today = todayInTz(tz);
  const nowMin = nowMinutesInTz(tz);
  const weekday = localWeekday(today); // 0 = Sun .. 6 = Sat
  const isWeekday = weekday >= 1 && weekday <= 5;
  const base = env.WEB_APP_URL.replace(/\/$/, '');

  let dispatched = 0;
  let failed = 0;

  for (const p of PUSHES) {
    if (nowMin < p.atMinutes || nowMin >= p.atMinutes + FIRE_WINDOW_MIN) continue;
    if (p.weekdaysOnly && !isWeekday) continue;

    // Claim today's send. On PK conflict (already sent), skip quietly.
    const { error: claimErr } = await sb
      .from('rule_push_log')
      .insert({ push_type: p.type, local_date: today });
    if (claimErr) {
      // 23505 = unique_violation → already fired today. Anything else is a
      // real failure worth counting (but don't send without a claim).
      if (claimErr.code !== '23505') failed++;
      continue;
    }

    // sendPushover's fetch can either return { ok: false } or THROW on a
    // transient network error. Treat both as a failed send so we always reach
    // the claim-release below — otherwise a thrown fetch would leave the claim
    // committed and silently swallow the push for the whole day.
    let sent = false;
    try {
      const res = await sendPushover({
        title: p.title,
        message: p.message,
        url: `${base}${p.path}`,
        url_title: 'Open dashboard',
        priority: 0,
      });
      sent = res.ok;
    } catch {
      sent = false;
    }

    if (sent) {
      dispatched++;
    } else {
      // Release the claim so the next minute (still inside the window) retries.
      failed++;
      await sb
        .from('rule_push_log')
        .delete()
        .eq('push_type', p.type)
        .eq('local_date', today);
    }
  }

  return { dispatched, failed };
}
