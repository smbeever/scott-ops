import type { FastifyPluginAsync } from 'fastify';
import { CreateConversationSchema, UpdateConversationSchema } from '@scott-ops/shared/schemas';
import { clearAttentionForSource } from '../lib/attention.js';

// /api/conversations/* — the unified interaction log (Addendum 05 §7).
// Queryable by any association (company/person/project/task). Supersedes the
// old /api/people/:id/interactions endpoints. Inserts fire the DB trigger
// that stamps companies.last_interaction_at + people.updated_at.

const SELECT =
  '*, company:companies(id, name), person:people(id, name), project:projects(id, name, color)';

export const conversationRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  // List — filter by any single association. At least one filter is expected
  // for a scoped timeline; with none it returns the global recent list.
  app.get<{
    Querystring: {
      company_id?: string; person_id?: string; project_id?: string;
      task_id?: string; requires_followup?: string; limit?: string;
    };
  }>('/api/conversations', async (req) => {
    const limit = Math.min(parseInt(req.query.limit ?? '200', 10) || 200, 1000);
    let q = req.supabase!
      .from('conversations')
      .select(SELECT)
      .order('occurred_at', { ascending: false })
      .limit(limit);
    if (req.query.company_id) q = q.eq('company_id', req.query.company_id);
    if (req.query.person_id) q = q.eq('person_id', req.query.person_id);
    if (req.query.project_id) q = q.eq('project_id', req.query.project_id);
    if (req.query.task_id) q = q.eq('task_id', req.query.task_id);
    if (req.query.requires_followup === 'true') q = q.eq('requires_followup', true);
    const { data, error } = await q;
    if (error) throw app.httpErrors.internalServerError(error.message);
    return { conversations: data ?? [] };
  });

  app.post('/api/conversations', async (req, reply) => {
    const parsed = CreateConversationSchema.safeParse(req.body);
    if (!parsed.success) {
      // The at-least-one-association guard is a top-level .refine, so its
      // message lands in formErrors (not fieldErrors) — include both.
      const flat = parsed.error.flatten();
      return reply.code(400).send({
        error: 'invalid_payload',
        details: { fieldErrors: flat.fieldErrors, formErrors: flat.formErrors },
      });
    }
    // Strip nulls so omitted associations don't override DB defaults; the
    // refine already guaranteed at least one association is present.
    const insert: Record<string, unknown> = {
      interaction_type: parsed.data.interaction_type,
      direction: parsed.data.direction,
      summary: parsed.data.summary,
      requires_followup: parsed.data.requires_followup ?? false,
    };
    for (const k of ['company_id', 'person_id', 'project_id', 'task_id', 'subject', 'body_excerpt', 'followup_by', 'occurred_at'] as const) {
      const v = parsed.data[k];
      if (v !== undefined && v !== null) insert[k] = v;
    }
    const { data, error } = await req.supabase!
      .from('conversations')
      .insert(insert)
      .select(SELECT)
      .single();
    if (error) {
      if (error.code === '23503') return reply.code(400).send({ error: 'invalid_reference' });
      if (error.code === '23505') return reply.code(409).send({ error: 'duplicate_email_message_id' });
      throw app.httpErrors.internalServerError(error.message);
    }
    // Logging a conversation with a company clears its "silent client"
    // attention item live (the trigger already bumped last_interaction_at).
    if (parsed.data.company_id) {
      try {
        await clearAttentionForSource(req.supabase!, 'company', parsed.data.company_id, ['company_silent']);
      } catch { /* best-effort */ }
    }
    return reply.code(201).send(data);
  });

  app.patch<{ Params: { id: string } }>('/api/conversations/:id', async (req, reply) => {
    const parsed = UpdateConversationSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_payload', details: parsed.error.flatten().fieldErrors });
    }
    if (Object.keys(parsed.data).length === 0) {
      return reply.code(400).send({ error: 'empty_payload' });
    }
    const { data, error } = await req.supabase!
      .from('conversations')
      .update(parsed.data)
      .eq('id', req.params.id)
      .select(SELECT)
      .single();
    if (error) {
      if (error.code === '23503') return reply.code(400).send({ error: 'invalid_reference' });
      throw app.httpErrors.internalServerError(error.message);
    }
    return data;
  });

  app.delete<{ Params: { id: string } }>('/api/conversations/:id', async (req, reply) => {
    const { error } = await req.supabase!.from('conversations').delete().eq('id', req.params.id);
    if (error) throw app.httpErrors.internalServerError(error.message);
    return reply.code(204).send();
  });
};
