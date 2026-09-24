import type { SupabaseClient } from '@supabase/supabase-js';
import { getAppTz } from './app-settings.js';
import { formatInTz } from './tz.js';

// Live-clear the attention items a mutation just resolved — so acting on the
// underlying thing (logging a conversation, activity, shipping a domain,
// completing a task) removes its attention item immediately instead of
// waiting for the daily cron. NEW items still only arrive via the cron.
// Deletes the live (active/snoozed) items for a source + rule set; dismissed/
// acted/expired history is left alone. Best-effort at the call sites.
export async function clearAttentionForSource(
  sb: SupabaseClient,
  sourceType: string,
  sourceId: string,
  ruleTypes: string[],
): Promise<void> {
  await sb.from('attention_items')
    .delete()
    .eq('source_type', sourceType)
    .eq('source_id', sourceId)
    .in('rule_type', ruleTypes)
    .in('status', ['active', 'snoozed']);
}

// The Attention Engine (Addendum 05 §10). Modeled on observations.ts: rule
// handlers each return CandidateItem[]; runAttention reconciles them against
// stored items and manages the snooze/dismiss/acted lifecycle.
//
// Correctness model (learned the hard way in review):
//   * Liveness + auto-resolve key on (rule_type, source_id), NOT the bucketed
//     dedup_key — so a snoozed item that reactivates under a new time bucket
//     isn't mistaken for a resolved one and expired.
//   * dedup_key (with its time bucket) is used only to scope a DISMISS to one
//     occurrence, so dismissing this year's birthday still resurfaces next year.
//   * Every rule THROWS on a query error, so a transient DB failure is caught
//     as a rule error and that rule's items are left untouched (never mass-
//     expired by an accidental empty result).

export interface CandidateItem {
  rule_type: string;
  source_type: 'person' | 'company' | 'domain' | 'project' | 'conversation' | 'task' | 'content';
  source_id: string;
  title: string;
  detail: string | null;
  suggested_action: string | null;
  score: number;
  dedup_key: string;
}

interface Ctx {
  todayYmd: string;   // YYYY-MM-DD in app tz
  nowIso: string;
  // App timezone. Needed by any rule aging a TIMESTAMPTZ column: slicing the
  // UTC date off such a value and diffing it against todayYmd is off by one
  // for anything stamped after ~17:00 local in a behind-UTC zone.
  tz: string;
}

// Run a Supabase query and THROW on error (Supabase resolves { data:null,
// error } for soft failures without throwing). Returns [] only for a genuine
// empty result, never for a failure — which keeps auto-resolve safe.
async function rows<T>(
  qb: PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const { data, error } = await qb;
  if (error) throw new Error(error.message);
  return data ?? [];
}

// ─── Date helpers (string-based, tz-safe via UTC anchoring) ───────────────

function ymdParts(s: string): [number, number, number] {
  const parts = s.slice(0, 10).split('-');
  return [Number(parts[0]), Number(parts[1]), Number(parts[2])];
}
function daysBetween(fromYmd: string, toYmd: string): number {
  const [fy, fm, fd] = ymdParts(fromYmd);
  const [ty, tm, td] = ymdParts(toYmd);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}
function daysUntil(dateYmd: string, todayYmd: string): number {
  return daysBetween(todayYmd, dateYmd);
}
function daysUntilRecurring(dateYmd: string, todayYmd: string): number {
  const [, m, d] = ymdParts(dateYmd);
  const [ty] = ymdParts(todayYmd);
  let diff = daysBetween(todayYmd, `${ty}-${pad(m)}-${pad(d)}`);
  if (diff < 0) diff = daysBetween(todayYmd, `${ty + 1}-${pad(m)}-${pad(d)}`);
  return diff;
}
const pad = (n: number) => String(n).padStart(2, '0');
function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}
function isoWeekBucket(todayYmd: string): string {
  const [y, m, d] = ymdParts(todayYmd);
  const date = new Date(Date.UTC(y, m - 1, d));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${pad(week)}`;
}
const monthBucket = (ymd: string) => ymd.slice(0, 7);
const yearBucket = (ymd: string) => ymd.slice(0, 4);
const dayBucket = (ymd: string) => ymd.slice(0, 10);

function urgencyFor(score: number): 'low' | 'normal' | 'high' {
  if (score >= 80) return 'high';
  if (score >= 30) return 'normal';
  return 'low';
}
function inDays(days: number): string {
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}
function pickName(rel: { name: string } | { name: string }[] | null | undefined): string | null {
  if (!rel) return null;
  return Array.isArray(rel) ? (rel[0]?.name ?? null) : rel.name;
}

// The occurrence identity of a dedup_key: `rule_type:entity_id`, dropping any
// trailing `:time_bucket`. rule_type has no colons, entity_id is a UUID (no
// colons), buckets use hyphens — so the first two colon-segments are the base.
// Used for liveness + auto-resolve so a snoozed item that reactivates under a
// new bucket still matches its regenerated candidate.
function baseKey(dedupKey: string): string {
  const parts = dedupKey.split(':');
  return parts.length >= 2 ? `${parts[0]}:${parts[1]}` : dedupKey;
}

// ─── Time-triggered rules ─────────────────────────────────────────────────

async function ruleBirthday(sb: SupabaseClient, ctx: Ctx): Promise<CandidateItem[]> {
  const data = await rows<{ id: string; name: string; birthday: string }>(
    sb.from('people').select('id, name, birthday').not('birthday', 'is', null),
  );
  const out: CandidateItem[] = [];
  for (const p of data) {
    const days = daysUntilRecurring(p.birthday, ctx.todayYmd);
    if (days > 7) continue;
    out.push({
      rule_type: 'birthday_upcoming', source_type: 'person', source_id: p.id,
      title: days === 0 ? `${p.name}'s birthday is today` : `${p.name}'s birthday ${inDays(days)}`,
      detail: 'Consider a call or a note.', suggested_action: 'Create task',
      score: 50 + (days <= 1 ? 50 : 0),
      dedup_key: `birthday_upcoming:${p.id}:${yearBucket(ctx.todayYmd)}`,
    });
  }
  return out;
}

async function ruleAnniversary(sb: SupabaseClient, ctx: Ctx): Promise<CandidateItem[]> {
  const data = await rows<{ id: string; name: string; anniversary: string }>(
    sb.from('people').select('id, name, anniversary').not('anniversary', 'is', null),
  );
  const out: CandidateItem[] = [];
  for (const p of data) {
    const days = daysUntilRecurring(p.anniversary, ctx.todayYmd);
    if (days > 14) continue;
    out.push({
      rule_type: 'anniversary_upcoming', source_type: 'person', source_id: p.id,
      title: days === 0 ? `${p.name}'s anniversary is today` : `${p.name}'s anniversary ${inDays(days)}`,
      detail: null, suggested_action: 'Create task',
      score: 40 + (days <= 3 ? 40 : 0),
      dedup_key: `anniversary_upcoming:${p.id}:${yearBucket(ctx.todayYmd)}`,
    });
  }
  return out;
}

async function rulePersonFact(sb: SupabaseClient, ctx: Ctx): Promise<CandidateItem[]> {
  const data = await rows<{
    id: string; person_id: string; fact_value: string; date_relevant: string;
    people: { name: string } | { name: string }[] | null;
  }>(
    sb.from('person_facts')
      .select('id, person_id, fact_value, date_relevant, people(name)')
      .not('date_relevant', 'is', null),
  );
  const out: CandidateItem[] = [];
  for (const f of data) {
    const days = daysUntil(f.date_relevant, ctx.todayYmd);
    if (days < 0 || days > 14) continue;
    const name = pickName(f.people);
    out.push({
      rule_type: 'person_fact_upcoming', source_type: 'person', source_id: f.person_id,
      title: `${name ? name + ': ' : ''}${f.fact_value} ${inDays(days)}`,
      detail: null, suggested_action: 'Open person',
      score: 45 + (days <= 3 ? 40 : 0),
      dedup_key: `person_fact_upcoming:${f.id}:${monthBucket(ctx.todayYmd)}`,
    });
  }
  return out;
}

async function ruleConversationFollowup(sb: SupabaseClient, ctx: Ctx): Promise<CandidateItem[]> {
  const data = await rows<{
    id: string; subject: string | null; summary: string; followup_by: string;
    people: { name: string } | { name: string }[] | null;
    companies: { name: string } | { name: string }[] | null;
  }>(
    sb.from('conversations')
      .select('id, subject, summary, followup_by, person_id, company_id, people(name), companies(name)')
      .eq('requires_followup', true).not('followup_by', 'is', null),
  );
  const out: CandidateItem[] = [];
  for (const c of data) {
    const days = daysUntil(c.followup_by, ctx.todayYmd);
    if (days > 7) continue; // includes overdue (negative)
    const who = pickName(c.people) ?? pickName(c.companies);
    out.push({
      rule_type: 'conversation_followup_due', source_type: 'conversation', source_id: c.id,
      title: `Follow up${who ? ` with ${who}` : ''}${days < 0 ? ' (overdue)' : ` ${inDays(days)}`}`,
      detail: (c.subject || c.summary || '').slice(0, 140), suggested_action: 'Reply / log',
      score: 60 + (days === 0 ? 40 : 0) + (days < 0 ? 80 : 0),
      dedup_key: `conversation_followup_due:${c.id}`,
    });
  }
  return out;
}

async function ruleCompanyReview(sb: SupabaseClient, ctx: Ctx): Promise<CandidateItem[]> {
  const data = await rows<{ id: string; name: string; next_review_at: string }>(
    sb.from('companies').select('id, name, next_review_at')
      .eq('active', true).not('next_review_at', 'is', null),
  );
  const out: CandidateItem[] = [];
  for (const c of data) {
    const days = daysUntil(c.next_review_at, ctx.todayYmd);
    if (days > 14) continue;
    out.push({
      rule_type: 'company_next_review', source_type: 'company', source_id: c.id,
      title: `${c.name} review ${days < 0 ? 'overdue' : inDays(days)}`,
      detail: null, suggested_action: 'Open company', score: 50,
      dedup_key: `company_next_review:${c.id}:${monthBucket(ctx.todayYmd)}`,
    });
  }
  return out;
}

async function ruleTaskDueSoon(sb: SupabaseClient, ctx: Ctx): Promise<CandidateItem[]> {
  const data = await rows<{ id: string; title: string; due_date: string }>(
    sb.from('tasks').select('id, title, due_date')
      .eq('status', 'open').not('due_date', 'is', null),
  );
  const out: CandidateItem[] = [];
  for (const t of data) {
    const days = daysUntil(t.due_date, ctx.todayYmd);
    if (days > 3) continue;
    out.push({
      rule_type: 'task_due_soon', source_type: 'task', source_id: t.id,
      title: `${days < 0 ? 'Overdue' : 'Due'}: ${t.title}`,
      detail: days < 0 ? `Due ${t.due_date}` : inDays(days), suggested_action: 'Complete task',
      score: 55 + (days === 0 ? 50 : 0) + (days < 0 ? 100 : 0),
      dedup_key: `task_due_soon:${t.id}:${dayBucket(ctx.todayYmd)}`,
    });
  }
  return out;
}

// ─── Inactivity-triggered rules ───────────────────────────────────────────

async function ruleCompanySilent(sb: SupabaseClient, ctx: Ctx): Promise<CandidateItem[]> {
  // Per-company check-in cadence (migration 0045). Each active client can set
  // its own interval; null/unset → this default. Replaces the old flat 21-day
  // cutoff. Silent Clients scope stays active_client-only.
  const DEFAULT_INTERVAL = 30;
  const data = await rows<{
    id: string; name: string; last_interaction_at: string | null; checkin_interval_days: number | null;
  }>(
    sb.from('companies').select('id, name, last_interaction_at, relationship_type, checkin_interval_days')
      .eq('active', true).eq('relationship_type', 'active_client'),
  );
  const out: CandidateItem[] = [];
  for (const c of data) {
    const interval = typeof c.checkin_interval_days === 'number' && c.checkin_interval_days > 0
      ? c.checkin_interval_days
      : DEFAULT_INTERVAL;
    // App-tz calendar-day diff (formatInTz, not a UTC .slice) so an evening
    // interaction doesn't read a day short. Never contacted → treat as very
    // silent so a new client without a logged conversation still surfaces.
    const daysSilent = c.last_interaction_at
      ? Math.abs(daysBetween(formatInTz(new Date(c.last_interaction_at), ctx.tz), ctx.todayYmd))
      : 999;
    // Still within this client's cadence → not silent.
    if (c.last_interaction_at && daysSilent < interval) continue;
    out.push({
      rule_type: 'company_silent', source_type: 'company', source_id: c.id,
      title: `Silent client: ${c.name}`,
      detail: c.last_interaction_at ? `No conversation in ${daysSilent} days` : 'No conversation logged yet',
      suggested_action: 'Log check-in',
      // Ramp from the cadence: base 30 at the interval, +20 per extra 2 weeks,
      // clamped to [0,40] so the never-contacted sentinel can't go negative
      // under a very long interval.
      score: 30 + Math.max(0, Math.min(40, Math.floor((daysSilent - interval) / 14) * 20)),
      dedup_key: `company_silent:${c.id}:${isoWeekBucket(ctx.todayYmd)}`,
    });
  }
  return out;
}

async function ruleProjectStalled(sb: SupabaseClient, ctx: Ctx): Promise<CandidateItem[]> {
  const cutoff = daysAgoIso(14);
  const projects = await rows<{ id: string; name: string }>(
    sb.from('projects').select('id, name').eq('status', 'active').eq('kind', 'project'),
  );
  const out: CandidateItem[] = [];
  for (const p of projects) {
    // Throws on error (not treated as "no activity") so a query hiccup can't
    // fabricate a stalled item.
    const recent = await rows<{ id: string }>(
      sb.from('activity_log').select('id').eq('project_id', p.id).gte('logged_at', cutoff).limit(1),
    );
    if (recent.length > 0) continue;
    out.push({
      rule_type: 'project_stalled', source_type: 'project', source_id: p.id,
      title: `Stalled: ${p.name}`, detail: 'No activity logged in 14+ days',
      suggested_action: 'Open project', score: 40,
      dedup_key: `project_stalled:${p.id}:${isoWeekBucket(ctx.todayYmd)}`,
    });
  }
  return out;
}

async function ruleContentStuck(sb: SupabaseClient, ctx: Ctx): Promise<CandidateItem[]> {
  // Sharpened (Addendum 08 §9): fire only when the EDITOR has held it ≥10 days,
  // anchored on holder_since — a true clock — instead of raw editing-status age.
  // Self-edited items (holder='me') are my-move work, surfaced elsewhere, not
  // "stuck with the editor".
  const cutoff = daysAgoIso(10);
  const data = await rows<{ id: string; title: string; holder_since: string | null }>(
    sb.from('content_items')
      .select('id, title, holder_since')
      .eq('status', 'editing').eq('holder', 'editor')
      .not('holder_since', 'is', null).lt('holder_since', cutoff),
  );
  const out: CandidateItem[] = [];
  for (const c of data) {
    // holder_since is TIMESTAMPTZ — convert to the app-tz date before diffing
    // (a UTC slice reads a day early for evening hand-offs).
    const days = c.holder_since
      ? Math.abs(daysBetween(formatInTz(new Date(c.holder_since), ctx.tz), ctx.todayYmd))
      : 10;
    out.push({
      rule_type: 'content_stuck_in_editing', source_type: 'content', source_id: c.id,
      title: `With editor: ${c.title}`,
      detail: `In the editor's hands ${days}d`,
      suggested_action: 'Nudge editor',
      score: 45 + Math.min(35, Math.floor((days - 10) / 7) * 15),
      dedup_key: `content_stuck_in_editing:${c.id}:${isoWeekBucket(ctx.todayYmd)}`,
    });
  }
  return out;
}

// Waiting ≥7 days (Addendum 08 §9): a task blocked on someone else long enough
// to warrant a nudge-or-move-on. waiting_since is the anchor. Waiting tasks are
// excluded from task_due_soon (that rule filters status='open'), so there's no
// double surface. Score ramps weekly past the 7-day mark.
async function ruleTaskWaitingAging(sb: SupabaseClient, ctx: Ctx): Promise<CandidateItem[]> {
  const data = await rows<{ id: string; title: string; waiting_on: string | null; waiting_since: string | null }>(
    sb.from('tasks').select('id, title, waiting_on, waiting_since')
      .eq('status', 'waiting').not('waiting_since', 'is', null),
  );
  const out: CandidateItem[] = [];
  for (const t of data) {
    const days = t.waiting_since ? Math.abs(daysBetween(t.waiting_since.slice(0, 10), ctx.todayYmd)) : 0;
    if (days < 7) continue;
    const who = t.waiting_on?.trim() || 'someone';
    out.push({
      rule_type: 'task_waiting_aging', source_type: 'task', source_id: t.id,
      title: `Waiting ${days}d: ${t.title}`,
      detail: `Waiting on ${who} · ${days}d — nudge or move on?`,
      suggested_action: 'Nudge or move on',
      score: 30 + Math.min(40, Math.floor((days - 7) / 7) * 20),
      dedup_key: `task_waiting_aging:${t.id}:${isoWeekBucket(ctx.todayYmd)}`,
    });
  }
  return out;
}

// Idea resurfacing (Addendum 09 §5). The retired recap page was going to carry
// a Sunday idea strip; instead the job moves into existing machinery. Fires
// only when the backlog is genuinely stale: ≥3 ideas with no review in 30+
// days. Emits exactly ONE item a week — the count is the signal, so N items
// would be noise — anchored on the OLDEST un-reviewed idea, because
// attention_items.source_id must be a real uuid (there is no roll-up source).
// Keep/Archive on the ideas index is what clears them; idea_reviewed_at is the
// "reviewed" stamp, falling back to created_at for never-reviewed ideas.
const IDEAS_AGING_MIN_COUNT = 3;
const IDEAS_AGING_MIN_DAYS = 30;

async function ruleIdeasAging(sb: SupabaseClient, ctx: Ctx): Promise<CandidateItem[]> {
  const data = await rows<{
    id: string; title: string; created_at: string; idea_reviewed_at: string | null;
  }>(
    sb.from('content_items')
      .select('id, title, created_at, idea_reviewed_at')
      .eq('status', 'idea')
      .is('archived_at', null),
  );

  // "Last looked at" = the review stamp, else when it was captured. Both are
  // TIMESTAMPTZ, so convert to the app-tz calendar date before diffing against
  // todayYmd — a raw UTC slice reads a day early for evening stamps.
  const stale = data
    .map((c) => ({
      ...c,
      lastSeen: formatInTz(new Date(c.idea_reviewed_at ?? c.created_at), ctx.tz),
    }))
    .filter((c) => Math.abs(daysBetween(c.lastSeen, ctx.todayYmd)) >= IDEAS_AGING_MIN_DAYS)
    .sort((a, b) => a.lastSeen.localeCompare(b.lastSeen));

  if (stale.length < IDEAS_AGING_MIN_COUNT) return [];

  const oldest = stale[0]!;
  const days = Math.abs(daysBetween(oldest.lastSeen, ctx.todayYmd));
  return [{
    rule_type: 'ideas_aging', source_type: 'content', source_id: oldest.id,
    title: `${stale.length} ideas aging — review`,
    detail: `Oldest untouched ${days}d: "${oldest.title}". Keep the ones worth keeping, archive the rest.`,
    suggested_action: 'Review ideas',
    score: 25,
    // Occurrence identity is the WEEK, not the anchor idea. Keying on
    // oldest.id would change the dedup identity the moment you Keep or
    // Archive anything — inserting a SECOND item in the same week and
    // resurrecting one you just dismissed. source_id still carries the real
    // idea uuid so the row deep-links and satisfies the not-null column.
    dedup_key: `ideas_aging:all:${isoWeekBucket(ctx.todayYmd)}`,
  }];
}

// Observations cadence rules — a domain with any of these is already tracked
// for staleness on the "Slipping" panel, so Attention skips it (no double
// surface). See lib/cadence.ts.
const OBSERVATION_CADENCE_RULES = new Set([
  'days_since_journal', 'days_since_publish', 'no_activity_days',
]);

async function ruleDomainStale(sb: SupabaseClient, ctx: Ctx): Promise<CandidateItem[]> {
  const data = await rows<{
    id: string; name: string; last_shipped_at: string | null;
    failure_patterns: unknown; stale_enabled: boolean | null; stale_days: number | null;
  }>(
    sb.from('stewardship_domains')
      .select('id, name, last_shipped_at, failure_patterns, stale_enabled, stale_days')
      .eq('active', true).eq('is_system', false),
  );
  const out: CandidateItem[] = [];
  for (const d of data) {
    // Per-domain off switch (Addendum 06).
    if (d.stale_enabled === false) continue;
    // Skip domains the Observations engine already tracks for staleness.
    const patterns = Array.isArray(d.failure_patterns) ? d.failure_patterns : [];
    if (patterns.some((p) => OBSERVATION_CADENCE_RULES.has((p as { rule?: string })?.rule ?? ''))) continue;
    // Per-domain threshold; null/invalid → the default 21.
    const thresholdDays = typeof d.stale_days === 'number' && d.stale_days > 0 ? d.stale_days : 21;
    const cutoff = daysAgoIso(thresholdDays);
    if (d.last_shipped_at && d.last_shipped_at > cutoff) continue;
    out.push({
      rule_type: 'domain_stale', source_type: 'domain', source_id: d.id,
      title: `${d.name}: nothing shipped recently`,
      detail: d.last_shipped_at
        ? `Last shipped ${d.last_shipped_at.slice(0, 10)} · ${thresholdDays}d threshold`
        : 'No ship logged yet',
      suggested_action: 'Open domain', score: 30,
      dedup_key: `domain_stale:${d.id}:${isoWeekBucket(ctx.todayYmd)}`,
    });
  }
  return out;
}

async function ruleEmailFollowupFlagged(sb: SupabaseClient): Promise<CandidateItem[]> {
  const cutoff = daysAgoIso(30);
  const data = await rows<{
    id: string; subject: string | null; summary: string;
    people: { name: string } | { name: string }[] | null;
  }>(
    sb.from('conversations').select('id, subject, summary, person_id, people(name)')
      .eq('requires_followup', true).is('followup_by', null).gte('occurred_at', cutoff),
  );
  const out: CandidateItem[] = [];
  for (const c of data) {
    const who = pickName(c.people);
    out.push({
      rule_type: 'email_followup_flagged', source_type: 'conversation', source_id: c.id,
      title: `Follow up flagged${who ? `: ${who}` : ''}`,
      detail: (c.subject || c.summary || '').slice(0, 140), suggested_action: 'Reply / log',
      score: 50, dedup_key: `email_followup_flagged:${c.id}`,
    });
  }
  return out;
}

// ─── Rule registry ────────────────────────────────────────────────────────

type RuleFn = (sb: SupabaseClient, ctx: Ctx) => Promise<CandidateItem[]>;
const RULES: { ruleType: string; fn: RuleFn }[] = [
  { ruleType: 'birthday_upcoming', fn: ruleBirthday },
  { ruleType: 'anniversary_upcoming', fn: ruleAnniversary },
  { ruleType: 'person_fact_upcoming', fn: rulePersonFact },
  { ruleType: 'conversation_followup_due', fn: ruleConversationFollowup },
  { ruleType: 'company_next_review', fn: ruleCompanyReview },
  { ruleType: 'task_due_soon', fn: ruleTaskDueSoon },
  { ruleType: 'task_waiting_aging', fn: ruleTaskWaitingAging },
  { ruleType: 'company_silent', fn: ruleCompanySilent },
  { ruleType: 'project_stalled', fn: ruleProjectStalled },
  { ruleType: 'content_stuck_in_editing', fn: ruleContentStuck },
  { ruleType: 'ideas_aging', fn: ruleIdeasAging },
  { ruleType: 'domain_stale', fn: ruleDomainStale },
  { ruleType: 'email_followup_flagged', fn: ruleEmailFollowupFlagged },
];

export interface AttentionRunResult {
  candidates: number;
  inserted: number;
  refreshed: number;
  reactivated: number;
  auto_resolved: number;
  expired: number;
  rule_errors: string[];
}

const EXPIRE_DAYS = 60;

export async function runAttention(sb: SupabaseClient): Promise<AttentionRunResult> {
  const result: AttentionRunResult = {
    candidates: 0, inserted: 0, refreshed: 0, reactivated: 0,
    auto_resolved: 0, expired: 0, rule_errors: [],
  };

  const tz = await getAppTz();
  const todayYmd = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const nowIso = new Date().toISOString();
  const ctx: Ctx = { todayYmd, nowIso, tz };

  // 1. Reactivate snoozes whose date has arrived — they rejoin the active
  //    surface and are then reconciled by source below (so a still-valid one
  //    refreshes, a resolved one gets auto-resolved).
  {
    const due = await rows<{ id: string }>(
      sb.from('attention_items').select('id').eq('status', 'snoozed').lte('snoozed_until', todayYmd),
    );
    if (due.length) {
      await sb.from('attention_items')
        .update({ status: 'active', last_surfaced_at: nowIso })
        .in('id', due.map((r) => r.id));
      result.reactivated = due.length;
    }
  }

  // 2. Run rules (isolated — a rule that throws is recorded and its items are
  //    left untouched by auto-resolve below).
  const candidates: CandidateItem[] = [];
  const ranOk = new Set<string>();
  for (const { ruleType, fn } of RULES) {
    try {
      candidates.push(...(await fn(sb, ctx)));
      ranOk.add(ruleType);
    } catch (err) {
      result.rule_errors.push(`${ruleType}: ${err instanceof Error ? err.message : 'error'}`);
    }
  }
  result.candidates = candidates.length;

  // 3. Load all stored items. Liveness + auto-resolve key on the OCCURRENCE
  //    identity — the dedup_key minus its trailing time bucket (`rule_type:
  //    entity_id`). This is NOT source_id: for person_fact the identity is the
  //    fact, but source_id is the person, so two upcoming facts for one person
  //    must stay distinct. Dismissed occurrences key on the full dedup_key so
  //    a dismiss scopes to one bucket (e.g. this year's birthday).
  const existing = await rows<{ id: string; dedup_key: string; rule_type: string; source_id: string; status: string }>(
    sb.from('attention_items').select('id, dedup_key, rule_type, source_id, status'),
  );
  const liveByBase = new Map<string, { id: string; status: string }>();
  const dismissedKeys = new Set<string>();
  for (const r of existing) {
    if (r.status === 'active' || r.status === 'snoozed') liveByBase.set(baseKey(r.dedup_key), { id: r.id, status: r.status });
    if (r.status === 'dismissed' || r.status === 'acted_on') dismissedKeys.add(r.dedup_key);
  }

  // 4. Reconcile candidates. One live item per source: refresh it if active,
  //    respect it if snoozed. Otherwise honor a same-occurrence dismiss, else
  //    insert a fresh item.
  const toInsert: CandidateItem[] = [];
  const refreshIds: string[] = [];
  const candidateBases = new Set<string>();
  const insertingBases = new Set<string>();
  for (const c of candidates) {
    const bk = baseKey(c.dedup_key);
    candidateBases.add(bk);
    const live = liveByBase.get(bk);
    if (live) {
      if (live.status === 'active') refreshIds.push(live.id);
      continue; // snoozed → leave it snoozed
    }
    if (dismissedKeys.has(c.dedup_key)) continue; // dismissed for this occurrence
    if (insertingBases.has(bk)) continue;         // already inserting one for this occurrence
    toInsert.push(c);
    insertingBases.add(bk);
  }

  if (toInsert.length) {
    const insertRows = toInsert.map((c) => ({
      rule_type: c.rule_type, source_type: c.source_type, source_id: c.source_id,
      title: c.title, detail: c.detail, suggested_action: c.suggested_action,
      score: c.score, urgency: urgencyFor(c.score), dedup_key: c.dedup_key,
    }));
    const { error } = await sb.from('attention_items')
      .upsert(insertRows, { onConflict: 'dedup_key', ignoreDuplicates: true });
    if (error) throw new Error(`attention insert failed: ${error.message}`);
    result.inserted = insertRows.length;
  }
  if (refreshIds.length) {
    await sb.from('attention_items').update({ last_surfaced_at: nowIso }).in('id', refreshIds);
    result.refreshed = refreshIds.length;
  }

  // 5. Auto-resolve: an active item whose rule ran OK this pass but whose
  //    SOURCE produced no candidate → the situation resolved. Keyed on source
  //    (not the bucketed dedup_key) so a reactivated item under a new bucket
  //    isn't wrongly expired.
  const autoResolveIds: string[] = [];
  for (const r of existing) {
    if (r.status !== 'active') continue;
    if (!ranOk.has(r.rule_type)) continue;                       // rule errored → leave alone
    if (candidateBases.has(baseKey(r.dedup_key))) continue;
    autoResolveIds.push(r.id);
  }
  if (autoResolveIds.length) {
    await sb.from('attention_items').update({ status: 'expired' }).in('id', autoResolveIds);
    result.auto_resolved = autoResolveIds.length;
  }

  // 6. Hard expiry: active items older than 60 days with no action.
  {
    const old = await rows<{ id: string }>(
      sb.from('attention_items').select('id')
        .eq('status', 'active').lt('first_surfaced_at', daysAgoIso(EXPIRE_DAYS)),
    );
    if (old.length) {
      await sb.from('attention_items').update({ status: 'expired' }).in('id', old.map((r) => r.id));
      result.expired = old.length;
    }
  }

  return result;
}
