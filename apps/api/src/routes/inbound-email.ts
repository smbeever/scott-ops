import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { simpleParser } from 'mailparser';
import {
  SendGridInboundPayloadSchema,
  type SendGridInboundPayload,
  CreateCaptureSenderAllowlistEntrySchema,
  UpdateCaptureEmailAddressSchema,
} from '@scott-ops/shared/schemas';
import { env } from '../lib/env.js';
import { supabaseAdmin, isSupabaseConfigured } from '../lib/supabase.js';
import { parseTranscript, type EmailContext } from '../lib/parser.js';
import { executeActions, type ActionResult } from '../lib/executor.js';
import { isAnthropicConfigured } from '../lib/anthropic.js';
import { sendEmail } from '../lib/sendgrid.js';
import { summarizeEmail, gmailDeepLink } from '../lib/email-summary.js';
import { getAppTz } from '../lib/app-settings.js';

// POST /api/inbound-email/:secret
//
// SendGrid Inbound Parse posts here for every email received at
// capture-*@capture.scott-ops.example. Auth: the {secret} path segment
// must match INBOUND_WEBHOOK_SECRET (timing-safe compare). All other
// checks — active capture address, sender allowlist, SPF verdict,
// per-address rate limit — return 200 silently and log the reason
// so a probing attacker can't tell what tripped the rejection.
//
// Every request produces exactly one row in email_capture_log,
// whatever the outcome. Feed the "Recent captures" panel in Settings.

// ─── Path secret compare ─────────────────────────────────────────────────
function checkSecret(provided: string): boolean {
  const expected = env.INBOUND_WEBHOOK_SECRET;
  if (!expected) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ─── SendGrid multipart → object ─────────────────────────────────────────
// SendGrid Inbound Parse posts multipart/form-data with a mix of text
// fields (from, to, subject, text, html, spf, etc) and attachment files
// (attachment1..N). We only care about the text fields for parsing;
// attachments get logged as a count and ignored per Addendum 04 §5.
async function collectMultipartFields(
  req: FastifyRequest,
): Promise<{ fields: Record<string, string>; attachmentCount: number }> {
  const fields: Record<string, string> = {};
  let attachmentCount = 0;
  for await (const part of req.parts()) {
    if (part.type === 'field') {
      const val = part.value;
      fields[part.fieldname] = typeof val === 'string' ? val : String(val);
    } else {
      // Drain attachment streams so the socket doesn't stall. We don't
      // do anything else with them in v1.
      attachmentCount += 1;
      try {
        await part.toBuffer();
      } catch {
        // Attachment read failed — skip and continue
      }
    }
  }
  return { fields, attachmentCount };
}

// ─── Sender allowlist lookup (case-insensitive) ─────────────────────────
async function isSenderAllowed(fromEmail: string): Promise<boolean> {
  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from('capture_sender_allowlist')
    .select('id')
    .eq('active', true)
    .ilike('email_address', fromEmail)
    .limit(1)
    .maybeSingle();
  if (error) return false;
  return Boolean(data);
}

// ─── Active capture-address lookup ──────────────────────────────────────
async function getActiveCaptureAddress(
  toEmail: string,
): Promise<{ id: string; rate_limit_per_hour: number } | null> {
  const sb = supabaseAdmin();
  const { data } = await sb
    .from('capture_email_addresses')
    .select('id, address, rate_limit_per_hour')
    .eq('active', true)
    .ilike('address', toEmail)
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  return { id: data.id as string, rate_limit_per_hour: data.rate_limit_per_hour as number };
}

// ─── Per-address rate limit ─────────────────────────────────────────────
async function countProcessedLastHour(toAddress: string): Promise<number> {
  const sb = supabaseAdmin();
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count } = await sb
    .from('email_capture_log')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'processed')
    .ilike('to_address', toAddress)
    .gte('received_at', oneHourAgo);
  return count ?? 0;
}

// ─── Auto-reply rate limit (per sender, 1 per hour) ─────────────────────
async function shouldAutoReply(fromAddress: string): Promise<boolean> {
  const sb = supabaseAdmin();
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count } = await sb
    .from('email_capture_log')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'processed')
    .ilike('from_address', fromAddress)
    .gte('received_at', oneHourAgo);
  // count includes the row we just wrote (which triggers this reply), so
  // "already replied" means count >= 2.
  return (count ?? 0) < 2;
}

// ─── Log writer ─────────────────────────────────────────────────────────
interface LogRowArgs {
  from_address: string | null;
  to_address: string | null;
  subject: string | null;
  status:
    | 'processed'
    | 'rejected_sender'
    | 'rejected_spam'
    | 'rejected_no_active_address'
    | 'parse_error'
    | 'rate_limited';
  actions_created?: unknown[];
  error_message?: string;
  raw_payload?: Record<string, unknown>;
}
async function writeLog(args: LogRowArgs): Promise<void> {
  const sb = supabaseAdmin();
  await sb.from('email_capture_log').insert({
    from_address: args.from_address,
    to_address: args.to_address,
    subject: args.subject,
    status: args.status,
    actions_created: args.actions_created ?? [],
    error_message: args.error_message ?? null,
    raw_payload: args.raw_payload ?? {},
  });
}

// ─── Envelope parser ────────────────────────────────────────────────────
// SendGrid ships an `envelope` field: a JSON string of the form
// {"to":["capture-x@capture.scott-ops.example"],"from":"sender@..."}.
// Envelope is more authoritative than the header `to`/`from` fields
// because those can be forged. We prefer envelope where present.
function parseEnvelope(raw: string): { to?: string; from?: string } {
  try {
    const parsed = JSON.parse(raw) as { to?: string[] | string; from?: string };
    const toRaw = parsed.to;
    const to = Array.isArray(toRaw) ? toRaw[0] : toRaw;
    return { to, from: parsed.from };
  } catch {
    return {};
  }
}

// Strip "Name" <email@example.com> down to "email@example.com".
function extractEmail(v: string): string {
  const m = v.match(/<([^>]+)>/);
  const inner = m?.[1] ?? v;
  return inner.trim().toLowerCase();
}

// Pull the Message-ID out of SendGrid's raw `headers` blob (parsed mode
// has no top-level message_id field). Returns the id including or without
// angle brackets — gmailDeepLink strips them either way.
function extractMessageIdFromHeaders(headers: string): string | undefined {
  const m = headers.match(/^message-id:\s*(.+)$/im);
  return m?.[1]?.trim() || undefined;
}

// ─── Auto-reply body ────────────────────────────────────────────────────
function buildReplyBody(
  originalSubject: string,
  results: ActionResult[],
  publicUrl?: string,
): string {
  const successes = results.filter((r) => r.status === 'success');
  const skipped = results.filter((r) => r.status === 'skipped');
  const failed = results.filter((r) => r.status === 'failed');

  const lines: string[] = ['Processed by dashboard.', ''];
  if (successes.length) {
    lines.push('Actions taken:');
    for (const r of successes) lines.push(`- ${r.message}`);
    lines.push('');
  }
  if (skipped.length) {
    lines.push('Skipped:');
    for (const r of skipped) lines.push(`- ${r.message} (${r.action})`);
    lines.push('');
  }
  if (failed.length) {
    lines.push('Failed:');
    for (const r of failed) lines.push(`- ${r.message} (${r.action})`);
    lines.push('');
  }
  if (!successes.length && !skipped.length && !failed.length) {
    lines.push('No actions extracted from this email.', '');
  }
  if (publicUrl) {
    lines.push(`Review captures: ${publicUrl}/settings/integrations/email-capture`);
    lines.push('');
  }
  lines.push('—');
  lines.push('This is an automated confirmation from your personal operations dashboard.');
  return lines.join('\n');
}

// ─── Route ──────────────────────────────────────────────────────────────
export const inboundEmailRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Params: { secret: string } }>(
    '/api/inbound-email/:secret',
    async (req, reply) => {
      // Absolute prerequisites — if secret's not set or supabase missing,
      // this endpoint can't function. Return 503 so SendGrid retries later.
      if (!env.INBOUND_WEBHOOK_SECRET) {
        return reply.code(503).send({ error: 'inbound_disabled' });
      }
      if (!isSupabaseConfigured()) {
        return reply.code(503).send({ error: 'supabase_not_configured' });
      }
      if (!checkSecret(req.params.secret)) {
        // Unauth path — log NOTHING (would give attackers a signal).
        return reply.code(401).send({ error: 'unauthorized' });
      }
      if (!req.isMultipart()) {
        return reply.code(400).send({ error: 'expected_multipart' });
      }

      // Parse multipart form.
      let fields: Record<string, string>;
      let attachmentCount: number;
      try {
        ({ fields, attachmentCount } = await collectMultipartFields(req));
      } catch (err) {
        req.log.error({ err }, 'inbound-email multipart parse failed');
        return reply.code(400).send({ error: 'multipart_parse_failed' });
      }

      // Validate against the SendGrid schema.
      const parsed = SendGridInboundPayloadSchema.safeParse(fields);
      if (!parsed.success) {
        req.log.warn(
          { flat: parsed.error.flatten() },
          'inbound-email payload validation failed',
        );
        await writeLog({
          from_address: fields.from ?? null,
          to_address: fields.to ?? null,
          subject: fields.subject ?? null,
          status: 'parse_error',
          error_message: 'sendgrid_payload_schema_mismatch',
          raw_payload: fields,
        });
        return reply.code(200).send({ status: 'logged' });
      }
      const payload: SendGridInboundPayload = parsed.data;

      // Resolve authoritative from/to from the envelope.
      const envelope = parseEnvelope(payload.envelope);
      const fromEmail = extractEmail(envelope.from ?? payload.from);
      const toEmail = extractEmail(envelope.to ?? payload.to);

      // SPF verdict must be pass. Anything else → spam bucket.
      // SendGrid's spf field format is "verdict=... verdictReason=..." or
      // just "pass"/"fail" depending on version; check for the pass token.
      if (payload.spf && !/pass/i.test(payload.spf)) {
        await writeLog({
          from_address: fromEmail,
          to_address: toEmail,
          subject: payload.subject,
          status: 'rejected_spam',
          error_message: `spf=${payload.spf}`,
          raw_payload: payload,
        });
        return reply.code(200).send({ status: 'logged' });
      }

      // Optional: SendGrid spam-score-based gate. Configurable in the
      // Inbound Parse UI; when checked, spam_score is present in the
      // payload. Reject anything above 5.0 (common SpamAssassin cutoff).
      const spamScore = typeof payload.spam_score === 'string'
        ? parseFloat(payload.spam_score)
        : typeof payload.spam_score === 'number' ? payload.spam_score : null;
      if (spamScore !== null && !isNaN(spamScore) && spamScore >= 5) {
        await writeLog({
          from_address: fromEmail,
          to_address: toEmail,
          subject: payload.subject,
          status: 'rejected_spam',
          error_message: `spam_score=${spamScore}`,
          raw_payload: payload,
        });
        return reply.code(200).send({ status: 'logged' });
      }

      // Active capture address lookup.
      const captureAddr = await getActiveCaptureAddress(toEmail);
      if (!captureAddr) {
        await writeLog({
          from_address: fromEmail,
          to_address: toEmail,
          subject: payload.subject,
          status: 'rejected_no_active_address',
          raw_payload: payload,
        });
        return reply.code(200).send({ status: 'logged' });
      }

      // Sender allowlist.
      const allowed = await isSenderAllowed(fromEmail);
      if (!allowed) {
        await writeLog({
          from_address: fromEmail,
          to_address: toEmail,
          subject: payload.subject,
          status: 'rejected_sender',
          raw_payload: payload,
        });
        return reply.code(200).send({ status: 'logged' });
      }

      // Rate limit.
      const processedCount = await countProcessedLastHour(toEmail);
      if (processedCount >= captureAddr.rate_limit_per_hour) {
        await writeLog({
          from_address: fromEmail,
          to_address: toEmail,
          subject: payload.subject,
          status: 'rate_limited',
          error_message: `count=${processedCount}/${captureAddr.rate_limit_per_hour}`,
          raw_payload: payload,
        });
        // 429 so SendGrid backs off and retries.
        return reply.code(429).send({ status: 'rate_limited' });
      }

      if (!isAnthropicConfigured()) {
        await writeLog({
          from_address: fromEmail,
          to_address: toEmail,
          subject: payload.subject,
          status: 'parse_error',
          error_message: 'anthropic_not_configured',
          raw_payload: payload,
        });
        return reply.code(503).send({ error: 'anthropic_not_configured' });
      }

      // Build transcript + emailContext. The transcript is subject + body
      // so the parser can see the surface even without the context block;
      // the context block gives it structured metadata to key routing on.
      let bodyText = payload.text.trim() || stripHtml(payload.html);
      let rawMimeMessageId: string | undefined;

      // Raw-MIME fallback: when SendGrid's "POST the raw, full MIME message"
      // mode is on, it sends a single `email` field and NO text/html. Parse
      // that MIME to recover the body (and the Message-ID for dedup) so the
      // endpoint works regardless of that SendGrid setting.
      if (!bodyText && payload.email) {
        try {
          const parsedMime = await simpleParser(payload.email);
          bodyText =
            (parsedMime.text ?? '').trim() ||
            stripHtml(typeof parsedMime.html === 'string' ? parsedMime.html : '');
          rawMimeMessageId = parsedMime.messageId ?? undefined;
        } catch (err) {
          req.log.warn({ err }, 'inbound-email raw-MIME parse failed');
        }
      }

      const transcript = [
        `Subject: ${payload.subject}`,
        '',
        bodyText,
      ].join('\n');

      req.log.info(
        {
          from: fromEmail,
          subject: payload.subject,
          text_bytes: payload.text.length,
          html_bytes: payload.html.length,
          body_chars: bodyText.length,
          used_html_fallback: !payload.text.trim(),
        },
        'inbound-email dispatching to parser',
      );

      // Resolve the RFC-822 Message-ID (for the Gmail deep-link + dedup).
      // Sources in priority order: a top-level message_id field (rare),
      // the id recovered from raw MIME (raw-MIME mode), or — the common
      // parsed-mode case — grepped out of the raw `headers` blob.
      const messageId =
        payload.message_id ??
        rawMimeMessageId ??
        extractMessageIdFromHeaders(payload.headers);

      const emailContext: EmailContext = {
        from: fromEmail,
        to: toEmail,
        subject: payload.subject,
        received_at: new Date().toISOString(),
        message_id: messageId,
        spf: payload.spf,
        dkim: payload.dkim,
      };

      const sb = supabaseAdmin();

      // Parse.
      let parseResult;
      try {
        parseResult = await parseTranscript(transcript, sb, emailContext);
      } catch (err) {
        req.log.error({ err }, 'inbound-email parser failed');
        await writeLog({
          from_address: fromEmail,
          to_address: toEmail,
          subject: payload.subject,
          status: 'parse_error',
          error_message: err instanceof Error ? err.message : 'unknown_parser_error',
          raw_payload: payload,
        });
        return reply.code(200).send({ status: 'logged' });
      }

      // Parser said no. Store as needs-review note.
      if (parseResult.kind === 'error') {
        // Fallback: create a note so the content isn't lost.
        const fallbackActions = [
          {
            action: 'create_note',
            body: transcript,
            source_type: 'other',
            source_reference: payload.subject,
            needs_review: true,
          },
        ];
        const fallbackResults = await executeActions(sb, fallbackActions, {
          emailForward: true,
        });
        await writeLog({
          from_address: fromEmail,
          to_address: toEmail,
          subject: payload.subject,
          status: 'parse_error',
          actions_created: fallbackResults,
          error_message: parseResult.error,
          raw_payload: payload,
        });
        return reply.code(200).send({ status: 'logged_fallback' });
      }

      // Disambiguation from email — no interactive path. Fallback to note.
      if (parseResult.kind === 'disambiguation') {
        const fallbackActions = [
          {
            action: 'create_note',
            body: transcript,
            source_type: 'other',
            source_reference: payload.subject,
            needs_review: true,
          },
        ];
        const fallbackResults = await executeActions(sb, fallbackActions, {
          emailForward: true,
        });
        await writeLog({
          from_address: fromEmail,
          to_address: toEmail,
          subject: payload.subject,
          status: 'parse_error',
          actions_created: fallbackResults,
          error_message: `needs_disambiguation:${parseResult.field}`,
          raw_payload: payload,
        });
        return reply.code(200).send({ status: 'logged_fallback' });
      }

      // Structured AI summary (Phase 3, Addendum 05 §8). One Sonnet call →
      // concise summary + follow-up flags + Gmail deep-link. Best-effort: on
      // any failure emailSummary is null and the conversation falls back to
      // the parser's verbatim-body summary, so a summarizer hiccup never
      // drops the capture.
      // Only summarize when the parser actually produced a conversation —
      // a Task:/Note: email doesn't use the summary, so skip the Sonnet call
      // (and its cost) in that case.
      const hasConversation = parseResult.actions.some((a) => a.action === 'create_conversation');
      const emailSummary = hasConversation
        ? await (async () => {
            const tz = await getAppTz();
            const todayIso = new Intl.DateTimeFormat('en-CA', {
              timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
            }).format(new Date());
            return summarizeEmail(payload.subject, bodyText, todayIso);
          })()
        : null;
      const deepLink = gmailDeepLink(messageId);

      // Execute actions. Email metadata rides through opts so the
      // create_conversation the parser emitted gets stamped with the real
      // message id / from / to, the Gmail deep-link, and — when the
      // summarizer ran — the AI summary + follow-up flags (which override
      // the parser's verbatim summary).
      const results = await executeActions(sb, parseResult.actions, {
        emailForward: true,
        emailMeta: {
          email_message_id: messageId ?? null,
          from_address: fromEmail,
          to_addresses: [toEmail],
          email_deep_link: deepLink,
          summary: emailSummary?.summary ?? null,
          // Keep a raw excerpt of the body so the original text isn't lost
          // when summary becomes the AI version.
          body_excerpt: emailSummary ? bodyText.slice(0, 1000) : null,
          requires_followup: emailSummary?.requires_followup ?? false,
          followup_by: emailSummary?.followup_by ?? null,
        },
      });

      // Safety net: if nothing landed (e.g. the parser emitted a
      // create_conversation but the person/company couldn't be resolved, so
      // it was skipped), don't silently drop the email — create a
      // needs-review note so the content is never lost.
      if (!results.some((r) => r.status === 'success')) {
        const noteResults = await executeActions(
          sb,
          [{
            action: 'create_note',
            body: emailSummary?.summary
              ? `${emailSummary.summary}\n\n---\nSubject: ${payload.subject}`
              : transcript,
            source_type: 'other',
            source_reference: payload.subject,
            needs_review: true,
          }],
          { emailForward: true },
        );
        results.push(...noteResults);
      }

      await writeLog({
        from_address: fromEmail,
        to_address: toEmail,
        subject: payload.subject,
        status: 'processed',
        actions_created: results,
        raw_payload: {
          ...payload,
          _attachment_count: attachmentCount,
        },
      });

      // Auto-reply (best-effort; never blocks 200 to SendGrid).
      try {
        const canReply = await shouldAutoReply(fromEmail);
        if (canReply) {
          const replyBody = buildReplyBody(
            payload.subject,
            results,
            env.WEB_PUBLIC_URL,
          );
          await sendEmail({
            to: fromEmail,
            subject: payload.subject.startsWith('Re:')
              ? payload.subject
              : `Re: ${payload.subject}`,
            text: replyBody,
            inReplyTo: payload.message_id ? `<${payload.message_id}>` : undefined,
          });
        }
      } catch (err) {
        req.log.warn({ err }, 'inbound-email auto-reply failed (non-fatal)');
      }

      return reply.code(200).send({
        status: 'processed',
        action_count: results.length,
      });
    },
  );
};

// ─── Settings endpoints (authenticated) ─────────────────────────────────
//
// Everything under /api/settings/email-capture is user-facing config for
// the Settings → Integrations → Email Capture page. Uses the standard
// Bearer-JWT auth like the rest of the /api routes.

function generateSlug(): string {
  // 5 bytes hex = 10 lowercase-hex chars. Unguessable enough for a
  // secret-part of an email address; short enough to be pastable.
  return randomBytes(5).toString('hex');
}

export const inboundEmailSettingsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  // GET /api/settings/email-capture — everything the settings page needs in one call.
  app.get('/api/settings/email-capture', async (req, reply) => {
    if (!isSupabaseConfigured()) {
      return reply.code(503).send({ error: 'supabase_not_configured' });
    }
    const sb = req.supabase!;
    const [addrRes, listRes, logRes] = await Promise.all([
      sb.from('capture_email_addresses')
        .select('id, address, slug, label, active, rate_limit_per_hour, created_at, revoked_at')
        .eq('active', true)
        .maybeSingle(),
      sb.from('capture_sender_allowlist')
        .select('id, email_address, label, active, created_at')
        .eq('active', true)
        .order('created_at', { ascending: false }),
      sb.from('email_capture_log')
        .select('id, received_at, from_address, to_address, subject, status, actions_created, error_message')
        .order('received_at', { ascending: false })
        .limit(20),
    ]);
    return {
      active_address: addrRes.data ?? null,
      allowlist: listRes.data ?? [],
      recent_log: logRes.data ?? [],
      capture_domain: env.CAPTURE_DOMAIN ?? null,
      sendgrid_configured: Boolean(env.SENDGRID_API_KEY && env.SENDGRID_FROM_EMAIL),
      inbound_configured: Boolean(env.INBOUND_WEBHOOK_SECRET && env.CAPTURE_DOMAIN),
    };
  });

  // POST /api/settings/email-capture/address/rotate — mint a new active address.
  // Revokes any existing active row atomically. Uses CAPTURE_DOMAIN from env
  // to build the full email address.
  app.post('/api/settings/email-capture/address/rotate', async (req, reply) => {
    if (!env.CAPTURE_DOMAIN) {
      return reply.code(503).send({ error: 'capture_domain_not_configured' });
    }
    const sb = req.supabase!;
    // Revoke everything currently active before inserting the new row so the
    // partial-unique-active index doesn't collide.
    const revokeAt = new Date().toISOString();
    await sb
      .from('capture_email_addresses')
      .update({ active: false, revoked_at: revokeAt })
      .eq('active', true);

    const slug = generateSlug();
    const address = `capture-${slug}@${env.CAPTURE_DOMAIN}`;
    const { data, error } = await sb
      .from('capture_email_addresses')
      .insert({ address, slug, label: 'Primary Capture', active: true })
      .select('id, address, slug, label, active, rate_limit_per_hour, created_at')
      .single();
    if (error) return reply.code(500).send({ error: 'insert_failed', message: error.message });
    return reply.code(201).send(data);
  });

  // PATCH /api/settings/email-capture/address — update label / rate limit.
  app.patch('/api/settings/email-capture/address', async (req, reply) => {
    const parsed = UpdateCaptureEmailAddressSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_payload',
        details: parsed.error.flatten().fieldErrors,
      });
    }
    if (Object.keys(parsed.data).length === 0) {
      return reply.code(400).send({ error: 'no_fields_to_update' });
    }
    const sb = req.supabase!;
    const { data, error } = await sb
      .from('capture_email_addresses')
      .update(parsed.data)
      .eq('active', true)
      .select('id, address, slug, label, active, rate_limit_per_hour, created_at')
      .single();
    if (error) return reply.code(500).send({ error: 'update_failed', message: error.message });
    return data;
  });

  // POST /api/settings/email-capture/allowlist — add a sender.
  app.post('/api/settings/email-capture/allowlist', async (req, reply) => {
    const parsed = CreateCaptureSenderAllowlistEntrySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_payload',
        details: parsed.error.flatten().fieldErrors,
      });
    }
    const sb = req.supabase!;
    const emailLower = parsed.data.email_address.trim().toLowerCase();
    // Upsert semantics via a check-and-insert so duplicates return an idempotent 200.
    const { data: existing } = await sb
      .from('capture_sender_allowlist')
      .select('id, email_address, label, active, created_at')
      .ilike('email_address', emailLower)
      .maybeSingle();
    if (existing) {
      if (!existing.active) {
        await sb.from('capture_sender_allowlist').update({ active: true }).eq('id', existing.id);
      }
      return { ...existing, active: true };
    }
    const { data, error } = await sb
      .from('capture_sender_allowlist')
      .insert({ email_address: emailLower, label: parsed.data.label ?? null })
      .select('id, email_address, label, active, created_at')
      .single();
    if (error) return reply.code(500).send({ error: 'insert_failed', message: error.message });
    return reply.code(201).send(data);
  });

  // DELETE /api/settings/email-capture/allowlist/:id — remove a sender.
  // Blocks removal if it would leave zero active senders (prevents lockout).
  app.delete<{ Params: { id: string } }>(
    '/api/settings/email-capture/allowlist/:id',
    async (req, reply) => {
      const sb = req.supabase!;
      const { count } = await sb
        .from('capture_sender_allowlist')
        .select('id', { count: 'exact', head: true })
        .eq('active', true);
      if ((count ?? 0) <= 1) {
        return reply.code(409).send({
          error: 'would_leave_empty_allowlist',
          message: 'At least one active sender must remain.',
        });
      }
      const { error } = await sb
        .from('capture_sender_allowlist')
        .delete()
        .eq('id', req.params.id);
      if (error) return reply.code(500).send({ error: 'delete_failed', message: error.message });
      return reply.code(204).send();
    },
  );

  // GET /api/settings/email-capture/log — paginated (default 50).
  app.get<{ Querystring: { limit?: string; offset?: string; status?: string } }>(
    '/api/settings/email-capture/log',
    async (req, reply) => {
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit ?? '50', 10) || 50));
      const offset = Math.max(0, parseInt(req.query.offset ?? '0', 10) || 0);
      const sb = req.supabase!;
      let q = sb
        .from('email_capture_log')
        .select('id, received_at, from_address, to_address, subject, status, actions_created, error_message', { count: 'exact' })
        .order('received_at', { ascending: false })
        .range(offset, offset + limit - 1);
      if (req.query.status) q = q.eq('status', req.query.status);
      const { data, count, error } = await q;
      if (error) return reply.code(500).send({ error: 'query_failed', message: error.message });
      return { entries: data ?? [], total: count ?? 0, limit, offset };
    },
  );
};

// Minimal HTML → text stripper for the payload.html fallback path
// (used only when payload.text is empty, which is rare but happens
// with some clients). Not perfect — good enough for the parser to see
// the shape of the message.
function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
