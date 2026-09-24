import Link from 'next/link';
import { recapApi, tasksApi, domainsApi, type RecapPayload } from '@/lib/api';
import { CHECK_ORDER, CHECK_LABELS } from '@scott-ops/shared';
import { RecapPlanner, type PlannerTask } from './recap-planner';

// /recap — the Sunday mirror. Win RATE only (never a streak): rolling 7- and
// 30-day rates, per-check pass rates with the weakest called out as the
// current constraint, and this week's hedges vs last. Read-only; next-week
// planning + the weekly reflection land in the following slice.

export const dynamic = 'force-dynamic';

function pct(rate: number | null): string {
  return rate == null ? '—' : `${Math.round(rate * 100)}%`;
}

export default async function RecapPage() {
  const [recap, tasksRes, domainsRes] = await Promise.all([
    recapApi.get(),
    tasksApi.list({ status: 'open' }),
    domainsApi.list(),
  ]);
  const domainName = new Map(domainsRes.domains.map((d) => [d.id, d.name]));
  const plannerTasks: PlannerTask[] = tasksRes.tasks.map((t) => ({
    id: t.id,
    title: t.title,
    domain_name: domainName.get(t.domain_id) ?? 'Unassigned',
  }));

  return (
    <div className="pb-24">
      <div className="px-5 lg:px-0 pt-4 pb-1 font-mono text-[10px] uppercase tracking-wider text-ink-3">
        <Link href="/today" className="hover:text-ink-2 transition-colors">
          ← Today
        </Link>
      </div>

      <div className="px-5 lg:px-0 pt-2">
        <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3 mb-2">
          The Daily Rule · Recap
        </div>
        <h1 className="font-serif text-[26px] font-semibold leading-none tracking-[-0.5px] text-ink">
          The week in review
        </h1>
      </div>
      <div className="hairline-strong mt-3 mx-5 lg:mx-0" />

      {/* ─── Win rates ───────────────────────────────────────────────── */}
      <section className="px-5 lg:px-0 mt-6 grid grid-cols-2 gap-4">
        {[
          { label: '7-day win rate', wr: recap.seven_day },
          { label: '30-day win rate', wr: recap.thirty_day },
        ].map(({ label, wr }) => (
          <div key={label} className="border border-line p-4">
            <div className="font-mono text-[10px] uppercase tracking-wider text-ink-3">{label}</div>
            <div className="font-mono text-[40px] text-accent tabular-nums leading-tight mt-1">
              {pct(wr.rate)}
            </div>
            <div className="font-sans text-[12px] text-ink-3">
              {wr.won} of {wr.scorable} {wr.scorable === 1 ? 'day' : 'days'} won
            </div>
          </div>
        ))}
      </section>

      {/* ─── Per-check pass rates ────────────────────────────────────── */}
      <section className="px-5 lg:px-0 mt-9">
        <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3 mb-3">
          Per check · trailing 30 days
        </div>
        <div className="flex flex-col gap-3">
          {CHECK_ORDER.map((key) => {
            const c = recap.per_check[key];
            const isConstraint = recap.current_constraint === key;
            return (
              <div key={key}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-sans text-[14px] text-ink">
                    {CHECK_LABELS[key]}
                    {isConstraint && (
                      <span className="ml-2 font-mono text-[9px] uppercase tracking-wider text-accent">
                        Current constraint
                      </span>
                    )}
                  </span>
                  <span className="font-mono text-[12px] text-ink-2 tabular-nums">
                    {pct(c.rate)}
                    <span className="text-ink-3">
                      {' '}
                      · {c.passed}/{c.total}
                    </span>
                  </span>
                </div>
                <div className="mt-1 h-1.5 bg-line">
                  <div
                    className={isConstraint ? 'h-full bg-accent' : 'h-full bg-ink-2'}
                    style={{ width: c.rate == null ? '0%' : `${Math.round(c.rate * 100)}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* ─── Hedges ──────────────────────────────────────────────────── */}
      <section className="px-5 lg:px-0 mt-9">
        <div className="flex items-baseline justify-between mb-3">
          <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-3">
            Hedges this week
          </div>
          <div className="font-mono text-[10px] uppercase tracking-wider text-ink-3">
            {recap.hedges_this_week_count} vs {recap.hedges_prior_week_count} prior
          </div>
        </div>
        {recap.hedges_this_week.length === 0 ? (
          <p className="font-serif text-[15px] text-ink-2 italic">No hedges logged this week.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line border-y border-line">
            {recap.hedges_this_week.map((h) => (
              <li key={h.id} className="py-2.5">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-sans text-[14px] text-ink leading-snug">{h.description}</span>
                  {h.pivot_taken && (
                    <span className="font-mono text-[9px] uppercase tracking-wider text-ink-3 shrink-0">
                      pivoted
                    </span>
                  )}
                </div>
                {h.commitment_avoided && (
                  <div className="font-sans text-[12px] text-ink-3 mt-0.5">
                    avoided: {h.commitment_avoided}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ─── Retroactive pauses (flagged) ────────────────────────────── */}
      {recap.retroactive_pauses.length > 0 && (
        <section className="px-5 lg:px-0 mt-9">
          <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-accent mb-2">
            Retroactive pauses
          </div>
          <ul className="flex flex-col gap-1">
            {recap.retroactive_pauses.map((p) => (
              <li key={p.id} className="font-sans text-[13px] text-ink-2">
                {p.start_date} → {p.end_date} · {p.reason}{' '}
                <span className="font-mono text-[10px] text-ink-3">
                  (declared {p.declared_at.slice(0, 10)})
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <RecapPlanner
        planningWeek={recap.planning_week}
        tasks={plannerTasks}
        reflectionWeekStart={recap.reflection_week_start}
        reflection={recap.reflection}
      />
    </div>
  );
}
