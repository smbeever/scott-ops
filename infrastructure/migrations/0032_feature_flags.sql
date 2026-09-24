-- Migration 0032: feature flags on app_settings (Addendum 05 §3).
--
-- The addendum proposed a key/value INSERT into app_settings, but that
-- table is a typed singleton (boolean PK pinned true, timezone, updated_at)
-- — there is no key/value shape and the CHECK(id) constraint forbids a
-- second row. Following the table's stated convention ("future settings
-- get added as new columns here"), a feature flag is just a typed boolean
-- column.
--
-- First flag: health_module_enabled. Defaults FALSE — the Health module
-- is hidden on fresh installs and for this deploy until the user flips it
-- on in Settings → Modules. Health tables + data (migration 0024) are
-- untouched; only the nav item, API routes, and web routes are gated.

alter table app_settings
  add column if not exists health_module_enabled boolean not null default false;

comment on column app_settings.health_module_enabled is
  'Feature flag (Addendum 05). When false: Health nav item hidden, /api/health/* returns 404, /health web routes notFound(). Data retained regardless.';
