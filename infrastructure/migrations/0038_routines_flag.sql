-- Migration 0038: Routines module feature flag (Addendum 06 §7).
--
-- Mirrors the Health flag (Addendum 05): a boolean column on the app_settings
-- singleton. DEFAULT true — Routines stays ON for now; the Settings → Modules
-- toggle lets it be turned off (data retained) once Practices replaces it in
-- v1.1. When false, Routines is hidden from the nav + Today, its routes 404,
-- and its cron reminders + the search_routines chat tool go quiet.

alter table app_settings
  add column if not exists routines_module_enabled boolean not null default true;

comment on column app_settings.routines_module_enabled is
  'Routines module visibility (Addendum 06). Default true; toggle off in Settings once Practices (v1.1) replaces it. Data is retained when off.';
