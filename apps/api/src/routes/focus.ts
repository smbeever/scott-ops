import type { FastifyPluginAsync } from 'fastify';
import type { SupabaseClient } from '@supabase/supabase-js';
import { SetFocusSchema, type ResolvedFocus } from '@scott-ops/shared/schemas';
import { getAppTz } from '../lib/app-settings.js';
import { todayInTz, addDays } from '../lib/tz.js';

// /api/focus — Tomorrow's Focus (Addendum 09). Three endpoints, no ceremony:
// read one day's focus, upsert it, clear it. This is deliberately the whole
// feature: a pointer, not a flow. Nothing here counts, scores, or reports on
// whether a focus was ever set — see the schema comment.
//
// The target lives in one of two tables, so target_id carries no FK. We
// validate it against the typed table on write and resolve its title on read;
// a target that has since been deleted reads as null (the day renders no line)
// rather than 500ing.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Confirm the target exists and return its display title, or null.
async function resolveTarget(
  sb: SupabaseClient,
  targetType: 'project' | 'content_item',
  targetId: string,
): Promise<string | null> {
  if (targetType === 'project') {
    const { data } = await sb.from('projects').select('name').eq('id', targetId).maybeSingle();
    return (data?.name as string | undefined) ?? null;
  }
  const { data } = await sb.from('content_items').select('title').eq('id', targetId).maybeSingle();
  return (data?.title as string | undefined) ?? null;
}

export const focusRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  // GET /api/focus?date=YYYY-MM-DD (defaults to today in app tz).
  // Returns { focus: ResolvedFocus | null }.
  app.get<{ Querystring: { date?: string } }>('/api/focus', async (req, reply) => {
    const tz = await getAppTz();
    const date = req.query.date && DATE_RE.test(req.query.date)
      ? req.query.date
      : todayInTz(tz);

    const { data, error } = await req.supabase!
      .from('daily_focus')
      .select('*')
      .eq('date', date)
      .maybeSingle();
    if (error) throw app.httpErrors.internalServerError(error.message);
    if (!data) return { focus: null };

    const title = await resolveTarget(
      req.supabase!,
      data.target_type as 'project' | 'content_item',
      data.target_id as string,
    );
    // Target deleted since it was set — treat the day as unfocused rather than
    // rendering a dangling pointer.
    if (!title) return { focus: null };

    return reply.send({ focus: { ...data, title } as ResolvedFocus });
  });

  // PUT /api/focus — upsert the focus for a date (defaults to TOMORROW, the
  // common case: you set it in the evening for the day ahead).
  app.put('/api/focus', async (req, reply) => {
    const parsed = SetFocusSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_payload',
        details: parsed.error.flatten().fieldErrors,
      });
    }
    const tz = await getAppTz();
    const date = parsed.data.date ?? addDays(todayInTz(tz), 1);

    // The target must exist — a focus pointing at nothing is worse than none.
    const title = await resolveTarget(req.supabase!, parsed.data.target_type, parsed.data.target_id);
    if (!title) return reply.code(400).send({ error: 'target_not_found' });

    // `note` is patch-style: only written when the caller actually sent the
    // key. The Work picker doesn't collect a note, so without this every tap
    // there would wipe a note set by voice ("tomorrow's focus is X, note ...").
    // Sending an explicit null still clears it.
    const row: Record<string, unknown> = {
      date,
      target_type: parsed.data.target_type,
      target_id: parsed.data.target_id,
    };
    if (req.body && typeof req.body === 'object' && 'note' in req.body) {
      row.note = parsed.data.note ?? null;
    }

    const { data, error } = await req.supabase!
      .from('daily_focus')
      .upsert(row, { onConflict: 'date' })
      .select('*')
      .single();
    if (error) throw app.httpErrors.internalServerError(error.message);

    return reply.send({ focus: { ...data, title } as ResolvedFocus });
  });

  // DELETE /api/focus?date=YYYY-MM-DD — clear it. Unset is a first-class
  // state, not a failure.
  app.delete<{ Querystring: { date?: string } }>('/api/focus', async (req, reply) => {
    const tz = await getAppTz();
    const date = req.query.date && DATE_RE.test(req.query.date)
      ? req.query.date
      : addDays(todayInTz(tz), 1);
    const { error } = await req.supabase!.from('daily_focus').delete().eq('date', date);
    if (error) throw app.httpErrors.internalServerError(error.message);
    return reply.code(204).send();
  });
};
