import { z } from 'zod';

// Email-to-dashboard capture (Addendum 04). Three DB tables + one
// SendGrid Inbound Parse webhook payload shape. Schemas here mirror
// migration 0031 so DB reads round-trip cleanly and API writes
// validate before touching Supabase.

// ─── capture_email_addresses ──────────────────────────────────────────

export const CaptureEmailAddressSchema = z.object({
  id: z.string().uuid(),
  address: z.string().email(),
  slug: z.string().min(1),
  label: z.string().min(1),
  active: z.boolean(),
  rate_limit_per_hour: z.number().int().positive(),
  created_at: z.string().datetime({ offset: true }),
  revoked_at: z.string().datetime({ offset: true }).nullable().optional(),
});
export type CaptureEmailAddress = z.infer<typeof CaptureEmailAddressSchema>;

// UI-side patch — only label + rate_limit are user-editable; rotate is
// its own dedicated endpoint that mints a new row and revokes the old.
export const UpdateCaptureEmailAddressSchema = z.object({
  label: z.string().min(1).optional(),
  rate_limit_per_hour: z.number().int().positive().max(10_000).optional(),
});

// ─── capture_sender_allowlist ─────────────────────────────────────────

export const CaptureSenderAllowlistEntrySchema = z.object({
  id: z.string().uuid(),
  email_address: z.string().email(),
  label: z.string().nullable().optional(),
  active: z.boolean(),
  created_at: z.string().datetime({ offset: true }),
});
export type CaptureSenderAllowlistEntry = z.infer<typeof CaptureSenderAllowlistEntrySchema>;

export const CreateCaptureSenderAllowlistEntrySchema = z.object({
  email_address: z.string().email(),
  label: z.string().nullable().optional(),
});

// ─── email_capture_log ────────────────────────────────────────────────

export const EmailCaptureLogStatusSchema = z.enum([
  'processed',
  'rejected_sender',
  'rejected_spam',
  'rejected_no_active_address',
  'parse_error',
  'rate_limited',
]);
export type EmailCaptureLogStatus = z.infer<typeof EmailCaptureLogStatusSchema>;

// Loose action shape here — the full VoiceActionSchema is imported from
// voice.ts wherever we actually need to type-check. Log rows store
// whatever the executor returned, so we keep it as a passthrough.
export const EmailCaptureLogEntrySchema = z.object({
  id: z.string().uuid(),
  received_at: z.string().datetime({ offset: true }),
  from_address: z.string().nullable().optional(),
  to_address: z.string().nullable().optional(),
  subject: z.string().nullable().optional(),
  status: EmailCaptureLogStatusSchema,
  actions_created: z.array(z.record(z.string(), z.unknown())),
  error_message: z.string().nullable().optional(),
});
export type EmailCaptureLogEntry = z.infer<typeof EmailCaptureLogEntrySchema>;

// ─── SendGrid Inbound Parse webhook payload ───────────────────────────
//
// SendGrid POSTs multipart/form-data with these fields (plus one form
// field per attachment named attachment1..N). Field names are lowercase
// and unquoted per SendGrid's docs. We accept what we care about and
// let the rest fall through to raw_payload for debugging.

export const SendGridInboundPayloadSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  subject: z.string().default(''),
  text: z.string().default(''),
  html: z.string().default(''),
  // SendGrid's SPF verdict for the sending domain. 'pass' means the
  // envelope-from's domain authorized the sending IP; anything else
  // gets rejected before hitting the parser.
  spf: z.string().default(''),
  // DKIM verdict — pass/fail per signing domain.
  dkim: z.string().default(''),
  // JSON envelope: { to: string[], from: string }
  envelope: z.string().default('{}'),
  // Raw email headers as a single text blob (SendGrid parsed mode). This is
  // where the Message-ID lives — parsed mode has no top-level message_id
  // field — so the endpoint greps this for the Gmail deep-link + dedup id.
  headers: z.string().default(''),
  // Number of attachments; the files themselves ride separate form fields.
  attachments: z.union([z.string(), z.number()]).default(0),
  // Optional SpamAssassin-style score, present only if the setup checked
  // "Check incoming emails for spam" in SendGrid's Inbound Parse config.
  spam_score: z.union([z.string(), z.number()]).optional(),
  spam_report: z.string().optional(),
  // Comma-separated list of charsets used per field. Presence of a utf-8
  // marker here is what we key off to normalize field encoding downstream.
  charsets: z.string().optional(),
  // RFC 5322 Message-ID; used for dedup on conversations.
  message_id: z.string().optional(),
  // Present only when SendGrid's "POST the raw, full MIME message" mode is
  // enabled — the entire raw MIME message. In that mode `text`/`html` are
  // absent, so the endpoint parses this to recover the body. (Addendum 05.)
  email: z.string().optional(),
});
export type SendGridInboundPayload = z.infer<typeof SendGridInboundPayloadSchema>;
