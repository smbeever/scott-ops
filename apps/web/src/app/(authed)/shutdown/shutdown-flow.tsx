'use client';

import { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { submitShutdownAction } from './actions';
import type { ShutdownContext, ShutdownResult, ShutdownSubmit } from '@/lib/api';

export interface KeystoneTask {
  id: string;
  title: string;
  domain_id: string;
  domain_name: string;
  due_date: string | null;
}

// The Daily Rule evening shutdown — three steps, phone-first, under a minute.
// It scores the day just lived and plans tomorrow. No live "you're failing"
// state; the verdict appears only after submit.

export function ShutdownFlow({
  context,
  keystoneTasks,
}: {
  context: ShutdownContext;
  keystoneTasks: KeystoneTask[];
}) {
  const todayHasKeystone = Boolean(context.today?.keystone_task_id);

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [result, setResult] = useState<ShutdownResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Step 1 — today's checks (prefill if already scored).
  const [nightHeld, setNightHeld] = useState(context.today?.night_held ?? false);
  const [morningBlock, setMorningBlock] = useState(context.today?.morning_block ?? false);
  const [keystoneDone, setKeystoneDone] = useState(context.today?.keystone_done ?? false);
  const [linesHeld, setLinesHeld] = useState(context.today?.lines_held ?? false);
  const [presentHome, setPresentHome] = useState(context.today?.present_home ?? false);
  const [note, setNote] = useState(context.today?.note ?? '');

  // Step 2 — tomorrow's keystone. Default on for weekdays, off for weekends;
  // if tomorrow is already planned, honor whether it has one. Always
  // skippable so a weekday with no suitable task can never trap the flow.
  const [setKeystone, setSetKeystone] = useState(
    context.tomorrow ? Boolean(context.tomorrow.keystone_task_id) : !context.keystone_optional,
  );
  const [keystoneTaskId, setKeystoneTaskId] = useState<string | null>(
    context.tomorrow?.keystone_task_id ?? null,
  );
  const [doneMeans, setDoneMeans] = useState(context.tomorrow?.keystone_done_means ?? '');
  const [taskFilter, setTaskFilter] = useState('');

  // Step 3 — tomorrow's re-entry + day_type.
  const [reentry, setReentry] = useState(context.tomorrow_defaults.reentry_time.slice(0, 5));
  const [dayType, setDayType] = useState<'client' | 'content' | ''>(
    context.tomorrow_defaults.day_type ?? '',
  );

  const keystoneReady = Boolean(keystoneTaskId) && doneMeans.trim().length > 0;
  // Either skip the keystone entirely, or fully specify it (task + finish line).
  const step2Valid = !setKeystone || keystoneReady;

  function submit() {
    setError(null);
    const scores: ShutdownSubmit['scores'] = {
      night_held: nightHeld,
      morning_block: morningBlock,
      lines_held: linesHeld,
      present_home: presentHome,
      note: note.trim() || null,
    };
    if (todayHasKeystone) scores.keystone_done = keystoneDone;

    const useKeystone = setKeystone && Boolean(keystoneTaskId);
    const payload: ShutdownSubmit = {
      date: context.date,
      scores,
      tomorrow: {
        keystone_task_id: useKeystone ? keystoneTaskId : null,
        keystone_done_means: useKeystone ? doneMeans.trim() : null,
        // A cleared time input → omit it and let the server apply the default,
        // rather than send '' and fail Zod validation.
        reentry_time: reentry || undefined,
        day_type: dayType || null,
      },
    };
    startTransition(async () => {
      const res = await submitShutdownAction(payload);
      if (res.ok) setResult(res.result);
      else setError(res.error);
    });
  }

  if (result) return <Confirmation result={result} />;
  if (context.locked) return <Locked date={context.date} />;

  return (
    <div className="px-5 lg:px-0 max-w-2xl">
      <div className="pt-2 pb-4">
        <div className="eyebrow text-ink-3">Shutdown · {fmtDate(context.date)}</div>
        <StepDots step={step} />
      </div>

      {step === 1 && (
        <StepScore
          todayHasKeystone={todayHasKeystone}
          keystoneDoneMeans={context.today?.keystone_done_means ?? null}
          hedge={context.hedge_summary}
          values={{ nightHeld, morningBlock, keystoneDone, linesHeld, presentHome }}
          set={{ setNightHeld, setMorningBlock, setKeystoneDone, setLinesHeld, setPresentHome }}
          note={note}
          setNote={setNote}
        />
      )}

      {step === 2 && (
        <StepKeystone
          tomorrowDate={context.tomorrow_date}
          optional={context.keystone_optional}
          tasks={keystoneTasks}
          setKeystone={setKeystone}
          setSetKeystone={setSetKeystone}
          keystoneTaskId={keystoneTaskId}
          setKeystoneTaskId={setKeystoneTaskId}
          doneMeans={doneMeans}
          setDoneMeans={setDoneMeans}
          filter={taskFilter}
          setFilter={setTaskFilter}
          events={context.calendar_events}
          tz={context.tz}
        />
      )}

      {step === 3 && (
        <StepReentry
          tomorrowDate={context.tomorrow_date}
          reentry={reentry}
          setReentry={setReentry}
          dayType={dayType}
          setDayType={setDayType}
          events={context.calendar_events}
          tz={context.tz}
        />
      )}

      {error && (
        <p className="mt-4 font-mono text-[10px] uppercase tracking-wider text-accent">
          {error === 'locked' ? 'This day is locked — past the noon window.' : error}
        </p>
      )}

      <div className="flex items-center justify-between gap-3 mt-8 pt-4 border-t border-line">
        {step > 1 ? (
          <BtnGhost onClick={() => setStep((s) => (s - 1) as 1 | 2)}>Back</BtnGhost>
        ) : (
          <span />
        )}
        {step < 3 ? (
          <BtnSolid
            onClick={() => setStep((s) => (s + 1) as 2 | 3)}
            disabled={step === 2 && !step2Valid}
          >
            Next
          </BtnSolid>
        ) : (
          <BtnSolid onClick={submit} disabled={pending || !step2Valid}>
            {pending ? 'Submitting…' : 'Submit shutdown'}
          </BtnSolid>
        )}
      </div>
    </div>
  );
}

// ─── Step 1: score today ─────────────────────────────────────────────────

function StepScore({
  todayHasKeystone,
  keystoneDoneMeans,
  hedge,
  values,
  set,
  note,
  setNote,
}: {
  todayHasKeystone: boolean;
  keystoneDoneMeans: string | null;
  hedge: { count: number; pivoted: number };
  values: {
    nightHeld: boolean; morningBlock: boolean; keystoneDone: boolean;
    linesHeld: boolean; presentHome: boolean;
  };
  set: {
    setNightHeld: (b: boolean) => void; setMorningBlock: (b: boolean) => void;
    setKeystoneDone: (b: boolean) => void; setLinesHeld: (b: boolean) => void;
    setPresentHome: (b: boolean) => void;
  };
  note: string;
  setNote: (s: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <h2 className="font-serif text-[22px] text-ink mb-1">Score today</h2>
      <Check label="Last night held" hint="Shutdown + lights-out that began this day"
        value={values.nightHeld} onChange={set.setNightHeld} />
      <Check label="Morning block" hint="Prayer · workout (or substitute) · Scripture"
        value={values.morningBlock} onChange={set.setMorningBlock} />
      {todayHasKeystone && (
        <Check
          label="Keystone reached its finish line"
          hint={keystoneDoneMeans ? `Done means: ${keystoneDoneMeans}` : 'The one thing, to its finish line'}
          value={values.keystoneDone}
          onChange={set.setKeystoneDone}
        />
      )}
      <Check label="Lines held" hint="No breach — or a breach answered by its pivot"
        value={values.linesHeld} onChange={set.setLinesHeld} />
      <div className="pl-1 -mt-1 mb-1 font-mono text-[10px] uppercase tracking-wider text-ink-3">
        {hedge.count === 0
          ? 'No hedges logged today'
          : `${hedge.count} hedge${hedge.count === 1 ? '' : 's'} logged · ${hedge.pivoted} pivoted`}
      </div>
      <Check label="Present at home" hint="Re-entry through shutdown"
        value={values.presentHome} onChange={set.setPresentHome} />

      <label className="flex flex-col gap-1 mt-3">
        <span className="eyebrow">Note (optional)</span>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          placeholder="Anything worth a line…"
          className="bg-transparent border border-line focus:border-accent focus:outline-none p-2 font-sans text-[14px] text-ink resize-y placeholder:text-ink-3/60"
        />
      </label>
    </div>
  );
}

// ─── Step 2: tomorrow's keystone ─────────────────────────────────────────

function StepKeystone({
  tomorrowDate, optional, tasks,
  setKeystone, setSetKeystone,
  keystoneTaskId, setKeystoneTaskId,
  doneMeans, setDoneMeans,
  filter, setFilter, events, tz,
}: {
  tomorrowDate: string;
  optional: boolean;
  tasks: KeystoneTask[];
  setKeystone: boolean;
  setSetKeystone: (b: boolean) => void;
  keystoneTaskId: string | null;
  setKeystoneTaskId: (id: string | null) => void;
  doneMeans: string;
  setDoneMeans: (s: string) => void;
  filter: string;
  setFilter: (s: string) => void;
  events: ShutdownContext['calendar_events'];
  tz: string;
}) {
  const groups = useMemo(() => groupTasks(tasks, filter), [tasks, filter]);
  const selected = tasks.find((t) => t.id === keystoneTaskId) ?? null;

  return (
    <div className="flex flex-col gap-3">
      <h2 className="font-serif text-[22px] text-ink">Tomorrow&rsquo;s keystone</h2>
      <p className="font-sans text-[13px] text-ink-3 -mt-1">
        The one thing for {fmtDate(tomorrowDate)}, worked to a finish line you write now.
      </p>

      <label className="flex items-center gap-2 cursor-pointer select-none py-1">
        <input
          type="checkbox"
          checked={setKeystone}
          onChange={(e) => setSetKeystone(e.target.checked)}
          className="accent-accent"
        />
        <span className="font-sans text-[14px] text-ink">
          {optional ? 'Set a weekend keystone' : 'Set tomorrow’s keystone'}
        </span>
      </label>

      {setKeystone && (
        <>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter tasks…"
            className="bg-transparent border border-line focus:border-accent focus:outline-none p-2 font-sans text-[14px] text-ink placeholder:text-ink-3/60"
          />
          <div className="max-h-64 overflow-y-auto border border-line divide-y divide-line">
            {groups.length === 0 && (
              <div className="p-3 font-sans text-[13px] text-ink-3">No open tasks match.</div>
            )}
            {groups.map((g) => (
              <div key={g.domain_name}>
                <div className="px-3 pt-2 pb-1 font-mono text-[9px] uppercase tracking-wider text-ink-3 bg-ink/[0.02]">
                  {g.domain_name}
                </div>
                {g.tasks.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setKeystoneTaskId(t.id === keystoneTaskId ? null : t.id)}
                    className={`w-full text-left px-3 py-2 font-sans text-[14px] transition-colors ${
                      t.id === keystoneTaskId ? 'bg-accent/10 text-ink' : 'text-ink-2 hover:bg-ink/[0.03]'
                    }`}
                  >
                    <span className="inline-block w-4">{t.id === keystoneTaskId ? '✓' : ''}</span>
                    {t.title}
                    {t.due_date && (
                      <span className="ml-2 font-mono text-[10px] text-ink-3">due {t.due_date.slice(5)}</span>
                    )}
                  </button>
                ))}
              </div>
            ))}
          </div>

          {selected && (
            <label className="flex flex-col gap-1 mt-1">
              <span className="eyebrow">Done means…</span>
              <input
                value={doneMeans}
                onChange={(e) => setDoneMeans(e.target.value)}
                placeholder="Binary + checkable tomorrow night"
                className="bg-transparent border border-line focus:border-accent focus:outline-none p-2 font-sans text-[14px] text-ink placeholder:text-ink-3/60"
              />
              <span className="font-sans text-[11px] text-ink-3">
                &ldquo;Done&rdquo; must be yes/no — not negotiable at 8:30 PM.
              </span>
            </label>
          )}
        </>
      )}

      <CalendarStrip events={events} tz={tz} label={`${fmtDate(tomorrowDate)} — on the calendar`} />
    </div>
  );
}

// ─── Step 3: re-entry + day_type ─────────────────────────────────────────

function StepReentry({
  tomorrowDate, reentry, setReentry, dayType, setDayType, events, tz,
}: {
  tomorrowDate: string;
  reentry: string;
  setReentry: (s: string) => void;
  dayType: 'client' | 'content' | '';
  setDayType: (d: 'client' | 'content' | '') => void;
  events: ShutdownContext['calendar_events'];
  tz: string;
}) {
  return (
    <div className="flex flex-col gap-4">
      <h2 className="font-serif text-[22px] text-ink">Tomorrow&rsquo;s re-entry</h2>

      <label className="flex flex-col gap-1">
        <span className="eyebrow">Re-entry time</span>
        <input
          type="time"
          value={reentry}
          onChange={(e) => setReentry(e.target.value)}
          className="bg-transparent border border-line focus:border-accent focus:outline-none p-2 font-sans text-[15px] text-ink w-40"
        />
        <span className="font-sans text-[11px] text-ink-3">
          Once set, it&rsquo;s tomorrow&rsquo;s line. The constant is the ritual, not the clock.
        </span>
      </label>

      <div className="flex flex-col gap-1">
        <span className="eyebrow">Day type</span>
        <div className="flex gap-2">
          {(['client', 'content', ''] as const).map((d) => (
            <button
              key={d || 'none'}
              type="button"
              onClick={() => setDayType(d)}
              className={`px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider border transition-colors ${
                dayType === d
                  ? 'bg-ink text-bg border-ink'
                  : 'border-line text-ink-3 hover:text-ink-2'
              }`}
            >
              {d === '' ? 'None' : d}
            </button>
          ))}
        </div>
      </div>

      <CalendarStrip events={events} tz={tz} label={`${fmtDate(tomorrowDate)} — on the calendar`} />
    </div>
  );
}

// ─── Confirmation + locked ───────────────────────────────────────────────

function Confirmation({ result }: { result: ShutdownResult }) {
  const rate =
    result.seven_day_rate == null ? '—' : `${Math.round(result.seven_day_rate * 100)}%`;
  return (
    <div className="px-5 lg:px-0 max-w-2xl pt-10 flex flex-col items-center text-center gap-3">
      <div className="font-serif text-[30px] text-ink">
        {result.won ? 'Day won' : 'Day lost'}
      </div>
      <div className="font-sans text-[14px] text-ink-2">
        {result.won ? '7-day win rate' : 'Costs one day — 7-day win rate'}
      </div>
      <div className="font-mono text-[40px] text-accent tabular-nums">{rate}</div>
      <Link
        href="/today"
        className="mt-6 px-4 py-2 bg-ink text-bg font-mono text-[11px] uppercase tracking-wider hover:bg-ink-2 transition-colors"
      >
        Done
      </Link>
    </div>
  );
}

function Locked({ date }: { date: string }) {
  return (
    <div className="px-5 lg:px-0 max-w-2xl pt-10 flex flex-col items-center text-center gap-3">
      <div className="font-serif text-[22px] text-ink">Locked</div>
      <p className="font-sans text-[14px] text-ink-2">
        {fmtDate(date)} closed at noon the next day. A missed shutdown counts as a lost day —
        that&rsquo;s the rule.
      </p>
      <Link
        href="/today"
        className="mt-4 px-4 py-2 bg-ink text-bg font-mono text-[11px] uppercase tracking-wider hover:bg-ink-2 transition-colors"
      >
        Back to Today
      </Link>
    </div>
  );
}

// ─── Bits ────────────────────────────────────────────────────────────────

function Check({
  label, hint, value, onChange,
}: {
  label: string; hint: string; value: boolean; onChange: (b: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className={`w-full text-left flex items-start gap-3 p-3 border transition-colors ${
        value ? 'border-accent bg-accent/[0.06]' : 'border-line hover:border-ink-3'
      }`}
    >
      <span
        className={`mt-0.5 flex-none w-5 h-5 border flex items-center justify-center font-mono text-[12px] ${
          value ? 'bg-accent border-accent text-bg' : 'border-ink-3 text-transparent'
        }`}
      >
        ✓
      </span>
      <span className="flex flex-col">
        <span className="font-sans text-[15px] text-ink leading-tight">{label}</span>
        <span className="font-sans text-[12px] text-ink-3">{hint}</span>
      </span>
    </button>
  );
}

function CalendarStrip({
  events, label, tz,
}: {
  events: ShutdownContext['calendar_events'];
  label: string;
  tz: string;
}) {
  return (
    <div className="mt-2 border-t border-line pt-2">
      <div className="eyebrow text-ink-3 mb-1">{label}</div>
      {events.length === 0 ? (
        <div className="font-sans text-[13px] text-ink-3">Nothing synced.</div>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {events.map((e) => (
            <li key={e.id} className="font-sans text-[13px] text-ink-2">
              <span className="font-mono text-[11px] text-ink-3 mr-2">
                {e.all_day ? 'All day' : fmtTime(e.start_at, tz)}
              </span>
              {e.title}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StepDots({ step }: { step: 1 | 2 | 3 }) {
  return (
    <div className="flex items-center gap-1.5 mt-2">
      {[1, 2, 3].map((n) => (
        <span
          key={n}
          className={`h-1 rounded-full transition-all ${
            n === step ? 'w-6 bg-accent' : n < step ? 'w-3 bg-ink-3' : 'w-3 bg-line'
          }`}
        />
      ))}
    </div>
  );
}

function BtnSolid({
  children, onClick, disabled,
}: { children: React.ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="px-5 py-2 bg-ink text-bg font-mono text-[11px] uppercase tracking-wider hover:bg-ink-2 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
    >
      {children}
    </button>
  );
}

function BtnGhost({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-4 py-2 font-mono text-[11px] uppercase tracking-wider text-ink-3 hover:text-ink-2 transition-colors"
    >
      {children}
    </button>
  );
}

// ─── helpers ─────────────────────────────────────────────────────────────

function groupTasks(tasks: KeystoneTask[], filter: string) {
  const f = filter.trim().toLowerCase();
  const filtered = f
    ? tasks.filter(
        (t) => t.title.toLowerCase().includes(f) || t.domain_name.toLowerCase().includes(f),
      )
    : tasks;
  const byDomain = new Map<string, KeystoneTask[]>();
  for (const t of filtered) {
    const arr = byDomain.get(t.domain_name) ?? [];
    arr.push(t);
    byDomain.set(t.domain_name, arr);
  }
  return [...byDomain.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([domain_name, ts]) => ({
      domain_name,
      tasks: ts.sort((a, b) => {
        // Due tasks first (soonest), then by title.
        if (a.due_date && b.due_date) return a.due_date.localeCompare(b.due_date);
        if (a.due_date) return -1;
        if (b.due_date) return 1;
        return a.title.localeCompare(b.title);
      }),
    }));
}

function fmtDate(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00`);
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
}

function fmtTime(iso: string, tz: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: tz,
  });
}
