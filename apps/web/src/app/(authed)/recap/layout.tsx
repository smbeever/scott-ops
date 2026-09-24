import { notFound } from 'next/navigation';
import { getFeatureFlag } from '@/lib/app-settings';

// Retirement guard (Addendum 09). /recap carried the win rates, the
// constraint, the planning strip and the weekly reflection — all retired with
// the scoring apparatus. rule_module_enabled defaults false, so this 404s.
// Code and data (daily_scores, weekly_reflections) are retained.
export default async function RecapLayout({ children }: { children: React.ReactNode }) {
  if (!(await getFeatureFlag('rule_module_enabled'))) {
    notFound();
  }
  return <>{children}</>;
}
