import { supabaseAdmin } from './supabase.js';

// App-wide settings loader with a process-lifetime cache. The settings
// table is a single row that changes essentially never, so we read it
// once per process and refresh only when an admin update succeeds.
// Falls back to a hardcoded default if the row hasn't been created
// yet (pre-migration boot) or if the read fails.

const DEFAULT_TIMEZONE = 'America/Denver';

interface AppSettings {
  timezone: string;
  // Feature flags. Health (Addendum 05) defaults false — hidden until enabled.
  health_module_enabled: boolean;
  // Routines (Addendum 06) defaults TRUE — stays on (and on read failure) until
  // explicitly turned off, so an existing module never vanishes on a DB blip.
  routines_module_enabled: boolean;
  // Daily Rule (Addendum 06) defaults FALSE — retired by Addendum 09. False on
  // read failure too: a retired module must never flicker back on.
  rule_module_enabled: boolean;
}

// The set of boolean feature-flag columns on app_settings. Adding a new
// flag: add the column (migration), add it here, add it to the select
// in load(), and to the shared UpdateAppSettingsSchema.
export type FeatureFlag =
  | 'health_module_enabled'
  | 'routines_module_enabled'
  | 'rule_module_enabled';

// In-memory cache. Reset by invalidateAppSettings() when /api/settings/app
// PATCH succeeds. Across processes (PM2 cluster, multiple pm2 reload
// instances) cache drift is possible but harmless — each process gets
// its own copy and the user-facing settings page rereads on every load.
let cache: AppSettings | null = null;
let inflight: Promise<AppSettings> | null = null;

async function load(): Promise<AppSettings> {
  try {
    const { data, error } = await supabaseAdmin()
      .from('app_settings')
      .select('timezone, health_module_enabled, routines_module_enabled, rule_module_enabled')
      .eq('id', true)
      .maybeSingle();
    if (error) throw error;
    return {
      timezone: data?.timezone ?? DEFAULT_TIMEZONE,
      health_module_enabled: data?.health_module_enabled ?? false,
      // Default on: absence (pre-migration/null) means keep Routines visible.
      routines_module_enabled: data?.routines_module_enabled ?? true,
      // Default off: absence means the Rule module stays retired.
      rule_module_enabled: data?.rule_module_enabled ?? false,
    };
  } catch {
    // Pre-migration or transient DB error — keep the app running with safe
    // defaults: Health hidden, Routines shown (it's an existing module),
    // Rule retired.
    return {
      timezone: DEFAULT_TIMEZONE,
      health_module_enabled: false,
      routines_module_enabled: true,
      rule_module_enabled: false,
    };
  }
}

export async function getAppSettings(): Promise<AppSettings> {
  if (cache) return cache;
  if (inflight) return inflight;
  inflight = load().then((s) => {
    cache = s;
    inflight = null;
    return s;
  });
  return inflight;
}

// Convenience for the most common use — getting just the TZ string.
export async function getAppTz(): Promise<string> {
  return (await getAppSettings()).timezone;
}

// Feature-flag lookup. Returns false on any read failure so a hidden
// module never leaks on a transient DB blip.
export async function getFeatureFlag(flag: FeatureFlag): Promise<boolean> {
  return (await getAppSettings())[flag] === true;
}

export function invalidateAppSettings(): void {
  cache = null;
  inflight = null;
}
