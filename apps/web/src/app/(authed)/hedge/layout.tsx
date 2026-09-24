import { notFound } from 'next/navigation';
import { getFeatureFlag } from '@/lib/app-settings';

// Retirement guard (Addendum 09). Hedge capture is retired — the protocol
// lives on paper now. rule_module_enabled defaults false, so /hedge 404s.
// hedge_logs keeps every row; a hard delete is a ≥30-day backlog item.
export default async function HedgeLayout({ children }: { children: React.ReactNode }) {
  if (!(await getFeatureFlag('rule_module_enabled'))) {
    notFound();
  }
  return <>{children}</>;
}
