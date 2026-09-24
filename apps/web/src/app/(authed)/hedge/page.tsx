import Link from 'next/link';
import { ScreenHeader } from '@/components/ScreenHeader';
import { PIVOT_PROTOCOL } from '@/content/pivot-protocol';
import { HedgeForm } from './hedge-form';

// /hedge — log a hedging moment, then run the Pivot Protocol. Hedging is
// using what-could-be to escape what-is (the-daily-rule.md). The log entry
// IS the pivot for the "tinkering" case; for the rest, the card names the
// physical move to make right now.

export const dynamic = 'force-dynamic';

export default function HedgePage() {
  return (
    <div>
      <div className="px-5 lg:px-0 pt-4 pb-1 font-mono text-[10px] uppercase tracking-wider text-ink-3">
        <Link href="/today" className="hover:text-ink-2 transition-colors">
          ← Today
        </Link>
      </div>

      <ScreenHeader eyebrow="The Daily Rule" title="Log a hedge" meta="Name it, then pivot" />
      <div className="hairline mb-4" />

      <div className="px-5 lg:px-0">
        <HedgeForm pivotProtocol={PIVOT_PROTOCOL} />
      </div>
    </div>
  );
}
