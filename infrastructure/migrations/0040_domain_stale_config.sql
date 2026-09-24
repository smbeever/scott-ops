-- Migration 0040: per-domain staleness config for the Attention Engine
-- (Addendum 06 §7). The domain_stale rule was hardcoded to a flat 21-day
-- cutoff for every active domain, which also DOUBLE-SURFACED with the
-- Observations "Slipping" panel for content channels (they carry a
-- days_since_publish cadence rule).
--
-- Two changes work together:
--   1. These columns make attention staleness user-editable per domain
--      (on/off + threshold), from the domain detail page.
--   2. The rule itself (lib/attention.ts) now also SKIPS any domain that
--      has an Observations cadence rule in failure_patterns — Observations
--      already owns those, so Attention no longer duplicates them. That
--      reconciliation is data-driven, so no name-based seeding is needed
--      here; the JH-Personal-style thresholds live in the cadence editor.

alter table stewardship_domains
  add column if not exists stale_enabled boolean not null default true,
  -- null → fall back to the rule's default (21). Editable per domain.
  add column if not exists stale_days integer;

comment on column stewardship_domains.stale_enabled is
  'Attention domain_stale on/off for this domain (Addendum 06). Also auto-skipped when the domain has an Observations cadence rule.';
comment on column stewardship_domains.stale_days is
  'Attention domain_stale threshold in days (Addendum 06). Null → default 21.';
