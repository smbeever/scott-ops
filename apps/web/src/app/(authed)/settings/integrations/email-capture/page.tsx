import Link from 'next/link';
import { ScreenHeader } from '@/components/ScreenHeader';
import { SettingsSection } from '../../settings-section';
import { emailCaptureApi, ApiError, type EmailCaptureSummary } from '@/lib/api';
import { getAppTimezone } from '@/lib/app-settings';
import { CopyButton } from './CopyButton';
import { AddSenderForm } from './AddSenderForm';
import { RateLimitForm } from './RateLimitForm';
import { rotateCaptureAddressAction, removeAllowlistAction } from './actions';

// /settings/integrations/email-capture — Addendum 04.
// Manage the inbound-email capture address, allow-listed senders,
// rate limit, and recent capture activity.

export default async function EmailCapturePage() {
  let summary: EmailCaptureSummary | null = null;
  let error: string | null = null;
  try {
    summary = await emailCaptureApi.summary();
  } catch (err) {
    error = err instanceof ApiError ? `API ${err.status}` : (err as Error).message;
  }
  const tz = await getAppTimezone();

  return (
    <div>
      <ScreenHeader
        eyebrow="Settings · Integrations"
        title="Email Capture"
        meta="Forward-to-dashboard"
      />
      <div className="hairline" />
      <div className="mx-5 lg:mx-0 mt-4">
        <Link
          href="/settings/integrations"
          className="font-mono text-[10px] uppercase tracking-wider text-ink-3 hover:text-ink transition-colors"
        >
          ← All integrations
        </Link>
      </div>

      {error && (
        <div className="mx-5 lg:mx-0 mt-4 px-4 py-3 bg-accent text-bg text-[13px]">
          Couldn&rsquo;t read status: {error}
        </div>
      )}

      {summary && (
        <>
          <ConfiguredBanner summary={summary} />
          <AddressSection summary={summary} />
          <AllowlistSection summary={summary} />
          <RateLimitSection summary={summary} />
          <RecentCapturesSection summary={summary} tz={tz} />
        </>
      )}
    </div>
  );
}

function ConfiguredBanner({ summary }: { summary: EmailCaptureSummary }) {
  const gaps: string[] = [];
  if (!summary.inbound_configured) {
    gaps.push('INBOUND_WEBHOOK_SECRET or CAPTURE_DOMAIN missing on the API');
  }
  if (!summary.sendgrid_configured) {
    gaps.push('SENDGRID_API_KEY or SENDGRID_FROM_EMAIL missing (auto-replies disabled)');
  }
  if (gaps.length === 0) return null;
  return (
    <div className="mx-5 lg:mx-0 mt-4 px-4 py-3 border border-line text-ink-2 text-[12px] font-sans">
      <div className="font-mono text-[10px] uppercase tracking-wider text-ink-3 mb-1">
        Setup gaps
      </div>
      <ul className="list-disc pl-5 space-y-1">
        {gaps.map((g) => <li key={g}>{g}</li>)}
      </ul>
    </div>
  );
}

function AddressSection({ summary }: { summary: EmailCaptureSummary }) {
  const addr = summary.active_address;
  return (
    <SettingsSection title="Your capture address">
      {addr ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <code className="flex-1 min-w-[240px] bg-line/30 px-3 py-2 font-mono text-[13px] text-ink break-all">
              {addr.address}
            </code>
            <CopyButton text={addr.address} />
          </div>
          <p className="font-sans text-[12px] text-ink-3 leading-relaxed">
            Forward any email to this address. Emails from allow-listed senders
            get parsed into tasks, notes, or CRM interactions and confirmed by
            auto-reply. Everything else is silently rejected and logged below.
          </p>
          <form action={rotateCaptureAddressAction}>
            <button
              type="submit"
              className="self-start px-3 py-2 border border-line text-ink-2 hover:border-accent hover:text-accent font-mono text-[10px] uppercase tracking-wider transition-colors"
            >
              Rotate address (revokes current)
            </button>
          </form>
        </div>
      ) : summary.capture_domain ? (
        <div className="flex flex-col gap-3">
          <p className="font-sans text-[13px] text-ink-2 leading-relaxed">
            No active capture address yet. Generate one to start receiving mail.
          </p>
          <form action={rotateCaptureAddressAction}>
            <button
              type="submit"
              className="self-start bg-ink hover:bg-ink-2 text-bg font-sans font-semibold text-[13px] uppercase tracking-wider px-4 py-2.5 transition-colors"
            >
              Generate first address
            </button>
          </form>
        </div>
      ) : (
        <p className="font-sans text-[13px] text-ink-3 leading-relaxed">
          Set <code className="font-mono">CAPTURE_DOMAIN</code> in the API{' '}
          <code>.env</code> (e.g. <code className="font-mono">capture.scott-ops.example</code>)
          before generating an address.
        </p>
      )}
    </SettingsSection>
  );
}

function AllowlistSection({ summary }: { summary: EmailCaptureSummary }) {
  return (
    <SettingsSection title="Allowed senders">
      <p className="font-sans text-[13px] text-ink-3 leading-relaxed">
        Only these senders can get their emails parsed. Everything else
        returns 200 silently and lands in the log below. At least one entry
        must remain — the last row can&rsquo;t be removed.
      </p>
      <div className="flex flex-col gap-2 mt-3">
        {summary.allowlist.length === 0 && (
          <p className="font-mono text-[11px] uppercase tracking-wider text-accent">
            Empty — no email will be processed until you add a sender.
          </p>
        )}
        {summary.allowlist.map((s) => (
          <div
            key={s.id}
            className="flex flex-wrap items-center gap-3 py-2 border-b border-line/50 last:border-0"
          >
            <span className="flex-1 min-w-[200px] font-mono text-[13px] text-ink break-all">
              {s.email_address}
            </span>
            {s.label && (
              <span className="font-sans text-[12px] text-ink-3">{s.label}</span>
            )}
            <form action={removeAllowlistAction}>
              <input type="hidden" name="id" value={s.id} />
              <button
                type="submit"
                className="font-mono text-[10px] uppercase tracking-wider text-ink-3 hover:text-accent transition-colors"
              >
                Remove
              </button>
            </form>
          </div>
        ))}
      </div>
      <div className="mt-4 pt-4 border-t border-line">
        <AddSenderForm />
      </div>
    </SettingsSection>
  );
}

function RateLimitSection({ summary }: { summary: EmailCaptureSummary }) {
  if (!summary.active_address) return null;
  return (
    <SettingsSection title="Rate limit">
      <p className="font-sans text-[13px] text-ink-3 leading-relaxed">
        Max processed emails per hour before the endpoint returns 429 to
        SendGrid (which will retry with backoff). Default 100.
      </p>
      <div className="mt-3">
        <RateLimitForm current={summary.active_address.rate_limit_per_hour} />
      </div>
    </SettingsSection>
  );
}

function RecentCapturesSection({
  summary,
  tz,
}: {
  summary: EmailCaptureSummary;
  tz: string;
}) {
  return (
    <SettingsSection title="Recent captures">
      {summary.recent_log.length === 0 ? (
        <p className="font-sans text-[13px] text-ink-3">
          No inbound emails logged yet.
        </p>
      ) : (
        <div className="flex flex-col">
          {summary.recent_log.map((entry) => (
            <LogRow key={entry.id} entry={entry} tz={tz} />
          ))}
        </div>
      )}
    </SettingsSection>
  );
}

function LogRow({
  entry,
  tz,
}: {
  entry: EmailCaptureSummary['recent_log'][number];
  tz: string;
}) {
  const when = new Date(entry.received_at).toLocaleString('en-US', {
    timeZone: tz,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  const statusColor =
    entry.status === 'processed'
      ? 'text-ink'
      : entry.status === 'rate_limited' || entry.status.startsWith('rejected')
      ? 'text-ink-3'
      : 'text-accent';
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2 border-b border-line/40 last:border-0 font-sans text-[13px]">
      <span className="font-mono text-[11px] uppercase tracking-wider text-ink-3 w-24 shrink-0">
        {when}
      </span>
      <span className={`font-mono text-[10px] uppercase tracking-wider ${statusColor}`}>
        {entry.status.replace(/_/g, ' ')}
      </span>
      <span className="font-mono text-[12px] text-ink-2 break-all">
        {entry.from_address ?? '(unknown)'}
      </span>
      <span className="flex-1 min-w-[200px] text-ink truncate">
        {entry.subject ?? '(no subject)'}
      </span>
      {entry.actions_created.length > 0 && (
        <span className="font-mono text-[10px] uppercase tracking-wider text-ink-3">
          {entry.actions_created.length} action
          {entry.actions_created.length === 1 ? '' : 's'}
        </span>
      )}
      {entry.error_message && (
        <span className="w-full font-mono text-[11px] text-accent pl-24">
          {entry.error_message}
        </span>
      )}
    </div>
  );
}
