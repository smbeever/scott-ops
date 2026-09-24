-- Migration 0031: email-to-dashboard capture (Addendum 04).
--
-- Adds inbound-email plumbing so a message forwarded to a unique
-- capture address becomes a task, note, or CRM interaction. Uses
-- SendGrid Inbound Parse for delivery; per-repo webhook secret in the
-- URL path plus SendGrid's own spf/dkim verdict fields gate what
-- reaches the parser. See addendum 04 for the full design.
--
-- Three new tables, plus five new columns on person_interactions so
-- email-captured interactions can round-trip subject/body/direction/
-- provenance without cramming everything into the existing `notes`
-- text field.
--
-- No seeds — the first capture address is created lazily by the API
-- on first settings-page visit (avoids baking the domain into SQL),
-- and the allow-list starts empty (added via settings UI). The API
-- rejects everything until at least one allowlisted sender exists.

-- ─── 1. capture_email_addresses ────────────────────────────────────────
-- Rotate-able unique email address the user forwards to. Only one row
-- with active=true at a time — enforced by a partial unique index so
-- rotating means: insert new row, flip old row's active=false + stamp
-- revoked_at.
--
-- rate_limit_per_hour lives here (not on a global config table) so a
-- future multi-address setup gets independent limits for free.

create table if not exists capture_email_addresses (
  id uuid primary key default gen_random_uuid(),
  address text not null unique,
  slug text not null,
  label text not null default 'Primary Capture',
  active boolean not null default true,
  rate_limit_per_hour integer not null default 100
    check (rate_limit_per_hour > 0),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

-- Only one active row at a time.
create unique index if not exists idx_capture_email_addresses_single_active
  on capture_email_addresses(active) where active = true;

-- ─── 2. capture_sender_allowlist ───────────────────────────────────────
-- Whitelist of sender addresses whose mail we'll actually process.
-- Everything else gets logged with status='rejected_sender' and
-- silently returns 200 to SendGrid (deliberately opaque — don't tell
-- attackers whether their probe hit an allowlisted address).
--
-- Email addresses are normalized to lowercase before insert; the
-- unique index compares against lower(email_address).

create table if not exists capture_sender_allowlist (
  id uuid primary key default gen_random_uuid(),
  email_address text not null,
  label text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create unique index if not exists idx_capture_sender_allowlist_email_unique
  on capture_sender_allowlist(lower(email_address));

create index if not exists idx_capture_sender_allowlist_active
  on capture_sender_allowlist(active) where active = true;

-- ─── 3. email_capture_log ──────────────────────────────────────────────
-- Append-only audit log. Every inbound POST — accepted, rejected, or
-- errored — gets one row. Raw payload preserved for debugging routing
-- decisions after the fact.
--
-- 90-day retention lives in a future cron job (delete where
-- received_at < now() - interval '90 days'); adding the FK-less
-- table now, will wire the cleanup separately.

create table if not exists email_capture_log (
  id uuid primary key default gen_random_uuid(),
  received_at timestamptz not null default now(),
  from_address text,
  to_address text,
  subject text,
  status text not null check (status in (
    'processed',
    'rejected_sender',
    'rejected_spam',
    'rejected_no_active_address',
    'parse_error',
    'rate_limited'
  )),
  actions_created jsonb not null default '[]'::jsonb,
  error_message text,
  raw_payload jsonb not null default '{}'::jsonb
);

create index if not exists idx_email_capture_log_received_desc
  on email_capture_log(received_at desc);
create index if not exists idx_email_capture_log_status
  on email_capture_log(status);
create index if not exists idx_email_capture_log_from
  on email_capture_log(lower(from_address));

-- ─── 4. person_interactions extensions ─────────────────────────────────
-- Adding email-context columns so a captured email interaction can
-- carry subject + body + direction without stuffing everything into
-- the existing `notes` text field.
--
-- direction is nullable — legacy voice/manual interactions may not
-- have a natural direction. New rows should always set it.
--
-- email_message_id is the RFC 5322 Message-ID header, used for dedup
-- when the same email gets forwarded multiple times. Unique across
-- the table when present.
--
-- captured_via defaults to 'manual' so existing rows get the correct
-- provenance without a backfill.

alter table person_interactions
  add column if not exists direction text
    check (direction in ('inbound', 'outbound', 'internal'));

alter table person_interactions
  add column if not exists subject text;

alter table person_interactions
  add column if not exists body text;

alter table person_interactions
  add column if not exists email_message_id text;

alter table person_interactions
  add column if not exists captured_via text not null default 'manual'
    check (captured_via in ('email_forward', 'manual', 'voice'));

create unique index if not exists idx_person_interactions_email_message_id_unique
  on person_interactions(email_message_id)
  where email_message_id is not null;

-- ─── 5. Row-Level Security ─────────────────────────────────────────────
-- Same authenticated-user-all pattern as the rest of the user tables.

do $$
declare
  t text;
  policy_tables text[] := array[
    'capture_email_addresses',
    'capture_sender_allowlist',
    'email_capture_log'
  ];
begin
  foreach t in array policy_tables loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_authenticated_all', t);
    execute format(
      'create policy %I on %I for all to authenticated using (true) with check (true)',
      t || '_authenticated_all', t
    );
  end loop;
end $$;

-- person_interactions RLS was already enabled in migration 0003 —
-- the new columns inherit the existing policy automatically.

-- ─── 6. Column comments (self-documenting) ─────────────────────────────

comment on table capture_email_addresses is
  'Rotatable unique inbound-email address (capture-{slug}@capture.{domain}). Only one active at a time.';
comment on column capture_email_addresses.address is
  'Full email address including the domain — user-visible.';
comment on column capture_email_addresses.slug is
  'The random portion of the address, for internal reference.';
comment on column capture_email_addresses.rate_limit_per_hour is
  'Max processed emails/hour before /api/inbound-email returns 429.';

comment on table capture_sender_allowlist is
  'Sender addresses whose mail /api/inbound-email will actually process. Compared case-insensitively.';

comment on table email_capture_log is
  'Audit trail for every SendGrid inbound-email POST. Retained 90 days by a future cron.';
comment on column email_capture_log.raw_payload is
  'Full SendGrid Inbound Parse payload for post-hoc debugging.';

comment on column person_interactions.email_message_id is
  'RFC 5322 Message-ID for email-captured interactions. Unique when present — dedups duplicate forwards.';
comment on column person_interactions.captured_via is
  'Provenance: email_forward | manual | voice.';
