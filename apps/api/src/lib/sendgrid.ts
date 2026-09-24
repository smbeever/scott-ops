import { env } from './env.js';

// SendGrid Mail Send v3 client — just what we need for inbound-email
// auto-reply confirmations. The official @sendgrid/mail package would
// pull in a lot for one API call; direct fetch is simpler and doesn't
// add a dependency.
//
// If SENDGRID_API_KEY or SENDGRID_FROM_EMAIL is unset, sendEmail() is
// a no-op that returns { skipped: true }. Callers can log the skip
// but shouldn't treat it as a failure — the inbound side works fine
// without outbound; auto-replies are a nice-to-have.

export interface SendEmailArgs {
  to: string;
  subject: string;
  text: string;
  // Optional in-reply-to Message-ID so the auto-reply threads in the
  // sender's client. Include leading and trailing angle brackets.
  inReplyTo?: string;
}

export interface SendEmailResult {
  ok: boolean;
  skipped?: true;
  status?: number;
  error?: string;
}

export function isSendGridConfigured(): boolean {
  return Boolean(env.SENDGRID_API_KEY && env.SENDGRID_FROM_EMAIL);
}

export async function sendEmail(args: SendEmailArgs): Promise<SendEmailResult> {
  if (!isSendGridConfigured()) {
    return { ok: true, skipped: true };
  }
  const apiKey = env.SENDGRID_API_KEY!;
  const from = env.SENDGRID_FROM_EMAIL!;
  const fromName = env.SENDGRID_FROM_NAME;

  const body: Record<string, unknown> = {
    personalizations: [
      {
        to: [{ email: args.to }],
        subject: args.subject,
      },
    ],
    from: { email: from, name: fromName },
    content: [{ type: 'text/plain', value: args.text }],
  };

  if (args.inReplyTo) {
    body.headers = {
      'In-Reply-To': args.inReplyTo,
      References: args.inReplyTo,
    };
  }

  try {
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (res.status >= 200 && res.status < 300) {
      return { ok: true, status: res.status };
    }
    const errorBody = await res.text();
    return { ok: false, status: res.status, error: errorBody.slice(0, 500) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'unknown_error' };
  }
}
