'use client';

import { useMemo, useState, useTransition } from 'react';
import { planWeekAction, saveReflectionAction } from './actions';
import type { PlanDaySlot } from '@/lib/api';

export interface PlannerTask {
  id: string;
  title: string;
  domain_name: string;
}

interface RowState {
  date: string;
  weekday: number;
  keystoneOptional: boolean;
  dayType: 'client' | 'content' | '';
  keystoneTaskId: string;
  doneMeans: string;
}

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function fmtDate(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00`);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// The recap's write half: plan the coming week (per-day keystone + client/
// content) and save the weekly reflection. Everything above this on the page
// is read-only analytics.
export function RecapPlanner({
  planningWeek,
  tasks,
  reflectionWeekStart,
  reflection,
}: {
  planningWeek: PlanDaySlot[];
  tasks: PlannerTask[];
  reflectionWeekStart: string;
  reflection: string;
}) {
  const [rows, setRows] = useState<RowState[]>(() =>
    planningWeek.map((d) => ({
      date: d.date,
      weekday: d.weekday,
      keystoneOptional: d.keystone_optional,
      dayType: d.day_type ?? '',
      keystoneTaskId: d.keystone_task_id ?? '',
      doneMeans: d.keystone_done_means ?? '',
    })),
  );
  const [reflectionText, setReflectionText] = useState(reflection);
  const [planMsg, setPlanMsg] = useState<string | null>(null);
  const [reflectMsg, setReflectMsg] = useState<string | null>(null);
  const [planPending, startPlan] = useTransition();
  const [reflectPending, startReflect] = useTransition();

  const groups = useMemo(() => {
    const byDomain = new Map<string, PlannerTask[]>();
    for (const t of tasks) {
      const arr = byDomain.get(t.domain_name) ?? [];
      arr.push(t);
      byDomain.set(t.domain_name, arr);
    }
    return [...byDomain.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [tasks]);

  function patchRow(date: string, patch: Partial<RowState>) {
    setRows((rs) => rs.map((r) => (r.date === date ? { ...r, ...patch } : r)));
  }

  // A row is invalid only if a keystone task is chosen without a finish line.
  const invalidRow = rows.find((r) => r.keystoneTaskId && r.doneMeans.trim().length === 0);

  function savePlan() {
    setPlanMsg(null);
    if (invalidRow) {
      setPlanMsg(`${WEEKDAY_LABELS[invalidRow.weekday]}: a keystone needs a "done means".`);
      return;
    }
    const days = rows.map((r) => ({
      date: r.date,
      keystone_task_id: r.keystoneTaskId || null,
      keystone_done_means: r.keystoneTaskId ? r.doneMeans.trim() : null,
      day_type: r.dayType || null,
    }));
    startPlan(async () => {
      const res = await planWeekAction({ days });
      setPlanMsg(res.ok ? 'Week planned.' : res.error);
    });
  }

  function saveReflection() {
    setReflectMsg(null);
    startReflect(async () => {
      const res = await saveReflectionAction({
        week_start: reflectionWeekStart,
        reflection: reflectionText,
      });
      setReflectMsg(res.ok ? 'Saved.' : res.error);
    });
  }

  return (
    <>
      {/* ─── Weekly reflection ───────────────────────────────────────── */}
      <section className="px-5 lg:px-0 mt-9">
        <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3 mb-2">
          This week
        </div>
        <p className="font-serif text-[15px] italic text-ink-2 mb-2">
          Where did I hedge, what did it cost, what&rsquo;s the pivot next time?
        </p>
        <textarea
          value={reflectionText}
          onChange={(e) => setReflectionText(e.target.value)}
          rows={4}
          placeholder="Write it plain."
          className="w-full bg-transparent border border-line focus:border-accent focus:outline-none p-3 font-sans text-[14px] text-ink leading-relaxed resize-y placeholder:text-ink-3/60"
        />
        <div className="mt-2 flex items-center gap-3">
          <button
            type="button"
            onClick={saveReflection}
            disabled={reflectPending}
            className="px-4 py-2 bg-ink text-bg font-mono text-[11px] uppercase tracking-wider hover:bg-ink-2 disabled:opacity-40 transition-colors"
          >
            {reflectPending ? 'Saving…' : 'Save reflection'}
          </button>
          {reflectMsg && (
            <span className="font-mono text-[10px] uppercase tracking-wider text-ink-3">{reflectMsg}</span>
          )}
        </div>
      </section>

      {/* ─── Next week's plan ────────────────────────────────────────── */}
      <section className="px-5 lg:px-0 mt-9">
        <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3 mb-3">
          Plan the week ahead
        </div>
        <div className="flex flex-col divide-y divide-line border-y border-line">
          {rows.map((r) => (
            <div key={r.date} className="py-3 flex flex-col gap-2">
              <div className="flex items-center justify-between gap-3">
                <span className="font-sans text-[14px] text-ink">
                  {WEEKDAY_LABELS[r.weekday]}{' '}
                  <span className="font-mono text-[11px] text-ink-3">{fmtDate(r.date)}</span>
                </span>
                <div className="flex gap-1">
                  {(['client', 'content', ''] as const).map((d) => (
                    <button
                      key={d || 'none'}
                      type="button"
                      onClick={() => patchRow(r.date, { dayType: d })}
                      className={`px-2 py-1 font-mono text-[9px] uppercase tracking-wider border transition-colors ${
                        r.dayType === d
                          ? 'bg-ink text-bg border-ink'
                          : 'border-line text-ink-3 hover:text-ink-2'
                      }`}
                    >
                      {d === '' ? 'None' : d}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex flex-col sm:flex-row gap-2">
                <select
                  value={r.keystoneTaskId}
                  onChange={(e) => patchRow(r.date, { keystoneTaskId: e.target.value })}
                  className="bg-transparent border border-line focus:border-accent focus:outline-none p-2 font-sans text-[13px] text-ink sm:w-1/2"
                >
                  <option value="">
                    {r.keystoneOptional ? 'No keystone (optional)' : 'Pick a keystone…'}
                  </option>
                  {/* A previously-planned keystone whose task has since been
                      completed won't be in the open-tasks list — keep a
                      matching option so the select never renders blank. */}
                  {r.keystoneTaskId && !tasks.some((t) => t.id === r.keystoneTaskId) && (
                    <option value={r.keystoneTaskId}>Currently planned keystone</option>
                  )}
                  {groups.map(([domain, ts]) => (
                    <optgroup key={domain} label={domain}>
                      {ts.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.title}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                {r.keystoneTaskId && (
                  <input
                    value={r.doneMeans}
                    onChange={(e) => patchRow(r.date, { doneMeans: e.target.value })}
                    placeholder="Done means…"
                    className="bg-transparent border border-line focus:border-accent focus:outline-none p-2 font-sans text-[13px] text-ink sm:w-1/2 placeholder:text-ink-3/60"
                  />
                )}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            onClick={savePlan}
            disabled={planPending}
            className="px-4 py-2 bg-ink text-bg font-mono text-[11px] uppercase tracking-wider hover:bg-ink-2 disabled:opacity-40 transition-colors"
          >
            {planPending ? 'Saving…' : 'Save plan'}
          </button>
          {planMsg && (
            <span className="font-mono text-[10px] uppercase tracking-wider text-ink-3">{planMsg}</span>
          )}
        </div>
      </section>
    </>
  );
}
