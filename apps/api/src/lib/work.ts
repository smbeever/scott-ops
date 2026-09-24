import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  WorkPayload, WorkDomain, WorkProjectCard, WorkContentRow, WorkDirect, WorkRollup,
} from '@scott-ops/shared/schemas';
import { urgencyFromCounts, parentUrgency, contentUrgency, moveVerb, type Urgency } from '@scott-ops/shared';
import { getAppTz } from './app-settings.js';
import { todayInTz, formatInTz } from './tz.js';

// The Work page's computed manager's map (Addendum 08 §5-6). One aggregation:
// projects + domains + in-flight content + attention flags, per domain, with
// the ordering that is part of the contract. Nothing here is curated.

const IN_FLIGHT_CONTENT = ['outline', 'filming', 'editing', 'derivatives_pending'];
const SHIPPED_CONTENT = ['published', 'done'];

interface TaskRow {
  id: string; domain_id: string; project_id: string | null;
  status: string; due_date: string | null; waiting_since: string | null; waiting_on: string | null;
}
interface ProjectRow {
  id: string; name: string; domain_id: string | null;
  engagement_type: string; target_date: string | null; retainer_anchor_day: number | null;
  status: string;
  company: { name: string } | null;
  milestones: { weight: number; status: string }[] | null;
}
interface ContentRow {
  id: string; title: string; type: string; status: string;
  holder: string; holder_since: string | null; target_publish_date: string | null;
  domain_id: string | null; parent_id: string | null;
}

export async function buildWork(sb: SupabaseClient): Promise<WorkPayload> {
  const tz = await getAppTz();
  const today = todayInTz(tz);

  const [domainsRes, projectsRes, tasksRes, contentRes, childRes, attnRes, activityRes, ideasRes] =
    await Promise.all([
      sb.from('stewardship_domains').select('id, name, parked').eq('active', true).eq('is_system', false),
      sb.from('projects')
        .select('id, name, domain_id, engagement_type, target_date, retainer_anchor_day, status, company:companies(name), milestones(weight, status)')
        .in('status', ['active', 'paused']),
      sb.from('tasks').select('id, domain_id, project_id, status, due_date, waiting_since, waiting_on').neq('status', 'done'),
      sb.from('content_items').select('id, title, type, status, holder, holder_since, target_publish_date, domain_id, parent_id')
        .in('status', IN_FLIGHT_CONTENT).is('archived_at', null),
      // Children (for the "harvest N shorts" verb) — short-clip derivatives.
      // archived children aren't harvestable; bound the row count.
      sb.from('content_items').select('parent_id, type, status').not('parent_id', 'is', null)
        .is('archived_at', null).limit(2000),
      sb.from('attention_items').select('source_type, source_id, urgency').eq('status', 'active'),
      // Explicit limit — latest-per-project needs the recent window, not the
      // PostgREST default cap (matches cadence.ts's pattern).
      sb.from('activity_log').select('project_id, logged_at').order('logged_at', { ascending: false }).limit(5000),
      sb.from('content_items').select('id', { count: 'exact', head: true }).eq('status', 'idea').is('archived_at', null),
    ]);

  for (const r of [domainsRes, projectsRes, tasksRes, contentRes, childRes, attnRes, activityRes]) {
    if (r.error) throw new Error(r.error.message);
  }
  if (ideasRes.error) throw new Error(ideasRes.error.message);

  const domains = (domainsRes.data ?? []) as { id: string; name: string; parked: boolean }[];
  const projects = (projectsRes.data ?? []) as unknown as ProjectRow[];
  const tasks = (tasksRes.data ?? []) as TaskRow[];
  const content = (contentRes.data ?? []) as ContentRow[];

  // Flagged sets by source.
  const flaggedProjects = new Set<string>();
  const flaggedDomains = new Set<string>();
  const flaggedContent = new Set<string>();
  // Highest attention urgency per domain-scoped item — floors the domain pill
  // so the Work chip can never read calmer than an active domain attention
  // item (e.g. domain_stale) that Today already shows as slipping. One source
  // of truth, two displays. high → over, otherwise slipping (due).
  const domainAttnUrgency = new Map<string, Urgency>();
  for (const a of (attnRes.data ?? []) as { source_type: string; source_id: string; urgency: 'low' | 'normal' | 'high' }[]) {
    if (a.source_type === 'project') flaggedProjects.add(a.source_id);
    else if (a.source_type === 'domain') {
      flaggedDomains.add(a.source_id);
      const floor: Urgency = a.urgency === 'high' ? 'over' : 'due';
      if (domainAttnUrgency.get(a.source_id) !== 'over') domainAttnUrgency.set(a.source_id, floor);
    }
    else if (a.source_type === 'content') flaggedContent.add(a.source_id);
  }

  // Flagged content can be in ANY status (idea/published/…), not just the
  // in-flight rows we render — resolve each to its domain for the rollup badge.
  const flaggedContentByDomain = new Map<string, number>();
  if (flaggedContent.size > 0) {
    const { data: fcData, error: fcErr } = await sb
      .from('content_items').select('id, domain_id').in('id', [...flaggedContent]);
    if (fcErr) throw new Error(fcErr.message);
    for (const c of (fcData ?? []) as { id: string; domain_id: string | null }[]) {
      if (c.domain_id) flaggedContentByDomain.set(c.domain_id, (flaggedContentByDomain.get(c.domain_id) ?? 0) + 1);
    }
  }

  // Latest activity per project.
  const latestActivity = new Map<string, string>();
  for (const a of (activityRes.data ?? []) as { project_id: string | null; logged_at: string }[]) {
    if (a.project_id && !latestActivity.has(a.project_id)) latestActivity.set(a.project_id, a.logged_at);
  }

  // Unpublished short-clip child counts per parent (for the harvest verb).
  const unpublishedShorts = new Map<string, number>();
  for (const c of (childRes.data ?? []) as { parent_id: string; type: string; status: string }[]) {
    if (c.type !== 'short_clip' || SHIPPED_CONTENT.includes(c.status)) continue;
    unpublishedShorts.set(c.parent_id, (unpublishedShorts.get(c.parent_id) ?? 0) + 1);
  }

  const projectsByDomain = groupBy(projects, (p) => p.domain_id ?? '');
  const contentByDomain = groupBy(content, (c) => c.domain_id ?? '');
  const tasksByDomain = groupBy(tasks, (t) => t.domain_id);

  const build = (d: { id: string; name: string; parked: boolean }): WorkDomain => {
    const domTasks = tasksByDomain.get(d.id) ?? [];
    const tasksByProject = groupBy(domTasks, (t) => t.project_id ?? '__direct__');

    const projectCards: WorkProjectCard[] = (projectsByDomain.get(d.id) ?? []).map((p) => {
      const pt = tasksByProject.get(p.id) ?? [];
      const counts = bucketTasks(pt, today);
      const rep = representativeWaiting(pt, today);
      const isRetainer = p.engagement_type === 'retainer';
      return {
        id: p.id,
        kind: isRetainer ? 'retainer' : 'target',
        name: p.name,
        client: p.company?.name ?? null,
        target: isRetainer ? null : p.target_date,
        cycle: isRetainer && p.retainer_anchor_day ? computeCycle(p.retainer_anchor_day, today) : null,
        pct: isRetainer ? null : progressPct(p.milestones ?? []),
        open: counts.open,
        overdue: counts.overdue,
        waiting: counts.waiting,
        waitOn: rep?.waiting_on ?? null,
        waitDays: rep?.days ?? null,
        recency: recencyLabel(latestActivity.get(p.id), today, tz),
        flagged: flaggedProjects.has(p.id),
        paused: p.status === 'paused',
        // Pill state, derived here (never authored). A near/past target is a
        // "due" state even with nothing open — a deadline is a state, not a task.
        urgency: urgencyFromCounts({
          overdue: counts.overdue,
          dueToday: counts.today,
          open: counts.open,
          waiting: counts.waiting,
          targetNear:
            !isRetainer && p.target_date != null && daysBetween(today, p.target_date) <= 7,
        }),
      };
    });
    // Card order: flagged first, then target proximity (soonest target first,
    // undated last); retainers sort after by name.
    projectCards.sort((a, b) => {
      if (a.flagged !== b.flagged) return a.flagged ? -1 : 1;
      const at = a.target ?? '9999-12-31';
      const bt = b.target ?? '9999-12-31';
      return at.localeCompare(bt) || a.name.localeCompare(b.name);
    });

    const contentRows: WorkContentRow[] = (contentByDomain.get(d.id) ?? []).map((c) => {
      const holder = c.holder === 'editor' ? 'editor' : 'me';
      // My-move content whose target publish date is within a week or already
      // past — the needs-attention threshold for self-held work (§5).
      const myMoveDue =
        holder === 'me' &&
        c.target_publish_date != null &&
        daysBetween(today, c.target_publish_date) <= 7;
      return {
        id: c.id,
        title: c.title,
        type: c.type,
        status: c.status,
        holder,
        days: c.holder_since ? daysBetween(formatInTz(new Date(c.holder_since), tz), today) : null,
        move: holder === 'me' ? moveVerb(c.status, c.type, unpublishedShorts.get(c.id) ?? 0) : null,
        target: c.target_publish_date,
        myMoveDue,
        flagged: flaggedContent.has(c.id),
        // Pill state: my-move past its publish target is overdue; near-target
        // (myMoveDue) or stuck ≥7d with the editor is due; else on track.
        urgency: contentUrgency({
          holder,
          target: c.target_publish_date,
          myMoveDue,
          days: c.holder_since ? daysBetween(formatInTz(new Date(c.holder_since), tz), today) : null,
          today,
        }),
      };
    });

    const directTasks = tasksByProject.get('__direct__') ?? [];
    const dc = bucketTasks(directTasks, today);
    const direct: WorkDirect = {
      open: dc.open, overdue: dc.overdue, waiting: dc.waiting, waitingAging: dc.waitingAging, today: dc.today,
    };

    // Rollup: totals across the whole domain + a distinct-flagged-object count.
    const all = bucketTasks(domTasks, today);
    const flaggedCount =
      (flaggedDomains.has(d.id) ? 1 : 0) +
      projectCards.filter((p) => p.flagged).length +
      (flaggedContentByDomain.get(d.id) ?? 0);
    const rollup: WorkRollup = { attention: flaggedCount, open: all.open, overdue: all.overdue, waiting: all.waiting };

    // Domain pill escalates from its children, so it can never read calmer than
    // a card inside it (design handoff's domainStatus). `all` includes project
    // tasks, so direct + project overdue both feed the domain's own counts. An
    // active domain-scoped attention item is injected as a pseudo-child so the
    // chip agrees with Today (matters when parked channels unpark and their
    // publish-based rules fire).
    const domainAttnFloor = domainAttnUrgency.get(d.id);
    const urgency = parentUrgency(
      { overdue: all.overdue, dueToday: all.today, open: all.open, waiting: all.waiting },
      [
        ...projectCards.map((p) => p.urgency),
        ...contentRows.map((c) => c.urgency),
        ...(domainAttnFloor ? [domainAttnFloor] : []),
      ],
    );

    return {
      id: d.id, name: d.name, parked: d.parked, urgency, rollup,
      projects: projectCards, content: contentRows, direct,
    };
  };

  const active = domains.filter((d) => !d.parked).map(build);
  const parked = domains.filter((d) => d.parked).map(build);

  // Domain order: attention-flagged first, then by open-work volume.
  const workVolume = (w: WorkDomain) => w.rollup.open + w.rollup.waiting + w.projects.length + w.content.length;
  active.sort((a, b) => {
    if ((a.rollup.attention > 0) !== (b.rollup.attention > 0)) return a.rollup.attention > 0 ? -1 : 1;
    return workVolume(b) - workVolume(a) || a.name.localeCompare(b.name);
  });
  parked.sort((a, b) => a.name.localeCompare(b.name));

  return { domains: active, parked, ideasCount: ideasRes.count ?? 0 };
}

// ─── helpers ─────────────────────────────────────────────────────────────

function groupBy<T>(arr: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const item of arr) {
    const k = key(item);
    const g = m.get(k);
    if (g) g.push(item);
    else m.set(k, [item]);
  }
  return m;
}

function bucketTasks(ts: TaskRow[], today: string) {
  let open = 0, overdue = 0, waiting = 0, waitingAging = 0, todayCount = 0;
  for (const t of ts) {
    if (t.status === 'waiting') {
      waiting++;
      // Blocked ≥7 days — the needs-attention threshold (Addendum 08 §5/§9).
      if (t.waiting_since && daysBetween(t.waiting_since, today) >= 7) waitingAging++;
      continue;
    }
    if (t.status === 'open') {
      open++;
      if (t.due_date && t.due_date < today) overdue++;
      if (t.due_date === today) todayCount++;
    }
  }
  return { open, overdue, waiting, waitingAging, today: todayCount };
}

// Oldest waiting task = the one to surface on the card.
function representativeWaiting(ts: TaskRow[], today: string): { waiting_on: string | null; days: number } | null {
  let best: { waiting_on: string | null; days: number } | null = null;
  for (const t of ts) {
    if (t.status !== 'waiting') continue;
    const days = t.waiting_since ? daysBetween(t.waiting_since, today) : 0;
    if (!best || days > best.days) best = { waiting_on: t.waiting_on, days };
  }
  return best;
}

function progressPct(milestones: { weight: number; status: string }[]): number | null {
  const total = milestones.reduce((s, m) => s + m.weight, 0);
  if (total === 0) return null;
  const done = milestones.filter((m) => m.status === 'done').reduce((s, m) => s + m.weight, 0);
  return Math.round((done / total) * 100);
}

function daysBetween(fromYmd: string, toYmd: string): number {
  const [ay, am, ad] = fromYmd.split('-').map((s) => parseInt(s, 10));
  const [by, bm, bd] = toYmd.split('-').map((s) => parseInt(s, 10));
  return Math.round((Date.UTC(by!, bm! - 1, bd!) - Date.UTC(ay!, am! - 1, ad!)) / 86_400_000);
}

function recencyLabel(latestIso: string | undefined, today: string, tz: string): string {
  if (!latestIso) return 'no activity yet';
  const days = daysBetween(formatInTz(new Date(latestIso), tz), today);
  if (days <= 0) return 'active today';
  if (days <= 3) return `active ${days}d ago`;
  return `quiet ${days}d`;
}

// Retainer cycle position (§4). Day-of-month anchor, clamped to month end.
function computeCycle(anchorDay: number, todayYmd: string): { day: number; length: number } {
  const [y, m, d] = todayYmd.split('-').map((s) => parseInt(s, 10));
  const daysInMonth = (yy: number, mm: number) => new Date(Date.UTC(yy, mm, 0)).getUTCDate(); // mm 1-12
  const clamp = (yy: number, mm: number) => Math.min(anchorDay, daysInMonth(yy, mm));

  const todayUtc = Date.UTC(y!, m! - 1, d!);
  const thisAnchor = Date.UTC(y!, m! - 1, clamp(y!, m!));

  let csY: number, csM: number;
  if (thisAnchor <= todayUtc) { csY = y!; csM = m!; }
  else if (m! === 1) { csY = y! - 1; csM = 12; }
  else { csY = y!; csM = m! - 1; }
  const cycleStart = Date.UTC(csY, csM - 1, clamp(csY, csM));

  const nY = csM === 12 ? csY + 1 : csY;
  const nM = csM === 12 ? 1 : csM + 1;
  const nextAnchor = Date.UTC(nY, nM - 1, clamp(nY, nM));

  const length = Math.round((nextAnchor - cycleStart) / 86_400_000);
  const day = Math.round((todayUtc - cycleStart) / 86_400_000) + 1; // day 1 = anchor day
  return { day, length };
}
