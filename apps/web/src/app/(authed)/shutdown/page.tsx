import Link from 'next/link';
import { shutdownApi, tasksApi, domainsApi } from '@/lib/api';
import { ShutdownFlow, type KeystoneTask } from './shutdown-flow';

// /shutdown — The Daily Rule evening shutdown (Addendum 06 §6). Three steps,
// under 60 seconds on the phone: score today, pick tomorrow's keystone, set
// tomorrow's re-entry. PWA home-screen shortcut points here.

export const dynamic = 'force-dynamic';

export default async function ShutdownPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const { date } = await searchParams;
  const [context, tasksRes, domainsRes] = await Promise.all([
    shutdownApi.context(date),
    tasksApi.list({ status: 'open' }),
    domainsApi.list(),
  ]);

  // Keystone candidates: every open task, labelled with its domain so the
  // picker can group by domain. Any domain is selectable (day_type is a soft
  // hint, never a wall).
  const domainName = new Map(domainsRes.domains.map((d) => [d.id, d.name]));
  const keystoneTasks: KeystoneTask[] = tasksRes.tasks.map((t) => ({
    id: t.id,
    title: t.title,
    domain_id: t.domain_id,
    domain_name: domainName.get(t.domain_id) ?? 'Unassigned',
    due_date: t.due_date ?? null,
  }));

  return (
    <div>
      <div className="px-5 lg:px-0 pt-4 pb-1 font-mono text-[10px] uppercase tracking-wider text-ink-3">
        <Link href="/today" className="hover:text-ink-2 transition-colors">
          ← Today
        </Link>
      </div>

      <ShutdownFlow context={context} keystoneTasks={keystoneTasks} />
    </div>
  );
}
