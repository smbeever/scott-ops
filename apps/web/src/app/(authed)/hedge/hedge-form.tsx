'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { createHedgeAction, setPivotTakenAction } from './actions';
import type { PIVOT_PROTOCOL as PivotProtocol } from '@/content/pivot-protocol';
import type { HedgeLog } from '@/lib/api';

// Log a hedge, then show the Pivot Protocol. Two states: the capture form,
// then the card. Keep the form to seconds — a hedge caught is worth more
// than a hedge described perfectly.

export function HedgeForm({ pivotProtocol }: { pivotProtocol: typeof PivotProtocol }) {
  const [description, setDescription] = useState('');
  const [commitment, setCommitment] = useState('');
  const [hedge, setHedge] = useState<HedgeLog | null>(null);
  const [pivotTaken, setPivotTaken] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function save() {
    setError(null);
    startTransition(async () => {
      const res = await createHedgeAction({
        description,
        commitment_avoided: commitment || null,
      });
      if (res.ok) {
        setHedge(res.hedge);
        setPivotTaken(res.hedge.pivot_taken);
      } else {
        setError(res.error);
      }
    });
  }

  function togglePivot(next: boolean) {
    setPivotTaken(next); // optimistic
    startTransition(async () => {
      if (!hedge) return;
      const res = await setPivotTakenAction(hedge.id, next);
      if (!res.ok) {
        setPivotTaken(!next); // revert
        setError(res.error);
      }
    });
  }

  // ─── Post-save: the Pivot Protocol card ───────────────────────────────
  if (hedge) {
    return (
      <div className="max-w-2xl flex flex-col gap-4">
        <p className="font-sans text-[13px] text-ink-3">
          Logged. Now the pivot — {pivotProtocol.intro}
        </p>

        <div className="border border-line divide-y divide-line">
          {pivotProtocol.pivots.map((p) => (
            <div key={p.trigger} className="p-3">
              <div className="font-mono text-[10px] uppercase tracking-wider text-accent mb-1">
                {p.trigger}
              </div>
              <div className="font-sans text-[14px] text-ink leading-snug">{p.response}</div>
            </div>
          ))}
        </div>

        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={pivotTaken}
            onChange={(e) => togglePivot(e.target.checked)}
            disabled={pending}
            className="accent-accent"
          />
          <span className="font-sans text-[14px] text-ink">I took the pivot</span>
        </label>

        {error && (
          <span className="font-mono text-[10px] uppercase tracking-wider text-accent">{error}</span>
        )}

        <div className="flex items-center gap-3 pt-1">
          <Link
            href="/today"
            className="px-4 py-2 bg-ink text-bg font-mono text-[11px] uppercase tracking-wider hover:bg-ink-2 transition-colors"
          >
            Done
          </Link>
          <button
            type="button"
            onClick={() => {
              setHedge(null);
              setDescription('');
              setCommitment('');
              setPivotTaken(false);
              setError(null);
            }}
            className="font-mono text-[10px] uppercase tracking-wider text-ink-3 hover:text-ink-2 transition-colors"
          >
            Log another
          </button>
        </div>
      </div>
    );
  }

  // ─── Capture form ─────────────────────────────────────────────────────
  return (
    <div className="max-w-2xl flex flex-col gap-4">
      <label className="flex flex-col gap-1">
        <span className="eyebrow">What&rsquo;s the hedge?</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          autoFocus
          rows={3}
          placeholder="Spinning up something new · tinkering · researching past the decision · …"
          className="bg-transparent border border-line focus:border-accent focus:outline-none p-3 font-sans text-[15px] text-ink leading-relaxed resize-y placeholder:text-ink-3/60"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="eyebrow">What&rsquo;s being avoided? (optional)</span>
        <input
          value={commitment}
          onChange={(e) => setCommitment(e.target.value)}
          placeholder="The commitment with a name and a ship date"
          className="bg-transparent border border-line focus:border-accent focus:outline-none p-2 font-sans text-[14px] text-ink placeholder:text-ink-3/60"
        />
      </label>

      <div className="flex items-center gap-3 pt-1">
        <button
          type="button"
          onClick={save}
          disabled={pending || description.trim().length === 0}
          className="px-4 py-2 bg-ink text-bg font-mono text-[11px] uppercase tracking-wider hover:bg-ink-2 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {pending ? 'Logging…' : 'Log hedge'}
        </button>
        {error && (
          <span className="font-mono text-[10px] uppercase tracking-wider text-accent">{error}</span>
        )}
      </div>
    </div>
  );
}
