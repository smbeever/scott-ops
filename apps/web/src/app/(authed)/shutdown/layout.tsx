import { notFound } from 'next/navigation';
import { getFeatureFlag } from '@/lib/app-settings';

// Retirement guard (Addendum 09). The Daily Rule's scoring apparatus is
// retired: rule_module_enabled defaults false, so /shutdown renders the
// standard 404 — matching the API, which 404s /api/shutdown/*. The flow's
// code and every daily_scores row are retained; flipping the flag on in
// Settings → Modules restores it intact.
export default async function ShutdownLayout({ children }: { children: React.ReactNode }) {
  if (!(await getFeatureFlag('rule_module_enabled'))) {
    notFound();
  }
  return <>{children}</>;
}
