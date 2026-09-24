import type { FastifyPluginAsync } from 'fastify';
import {
  CreatePersonSchema, UpdatePersonSchema,
  CreatePersonFactSchema, UpdatePersonFactSchema,
} from '@scott-ops/shared/schemas';

// People CRM. people + person_facts share the same auth scope; facts are
// nested under /api/people/:id so the FK stays in the URL path.
//
// Interactions moved to the unified conversations table (Addendum 05) —
// see /api/conversations. The person detail read joins conversations; there
// are no longer person-scoped interaction write endpoints here.
//
// RLS handled by the request-scoped supabase client (single-user system,
// authenticated-only policy).

export const peopleRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  // ─── People ──────────────────────────────────────────────────────────

  app.get<{ Querystring: { relationship_type?: string; limit?: string } }>(
    '/api/people',
    async (req) => {
      const limit = Math.min(parseInt(req.query.limit ?? '500', 10) || 500, 2000);
      // Eager-counts of interactions + facts so the list view can show
      // density at a glance without an N+1. Same trick we use on books
      // for quote_count.
      // Join aliased company_ref (not company) — the people table already
      // has a legacy `company` TEXT column that `*` selects, and reusing the
      // name would clobber it in the JSON response. interaction_count now
      // comes from conversations (person_interactions is archived).
      let q = req.supabase!
        .from('people')
        .select('*, conversations:conversations(id, occurred_at), facts:person_facts(id), company_ref:companies(id, name)')
        .order('name', { ascending: true })
        .limit(limit);
      if (req.query.relationship_type) {
        q = q.eq('relationship_type', req.query.relationship_type);
      }
      const { data, error } = await q;
      if (error) throw app.httpErrors.internalServerError(error.message);
      type Row = {
        conversations?: { id: string; occurred_at: string | null }[];
        facts?: { id: string }[];
        [k: string]: unknown;
      };
      const people = ((data ?? []) as Row[]).map((p) => {
        // Synthesise last-contact from conversations (people has no
        // last_interaction_at column, unlike companies) so the v2 silence pill
        // has a real basis. Max occurred_at across the person's conversations.
        const lastInteraction = (p.conversations ?? [])
          .map((c) => c.occurred_at)
          .filter((d): d is string => !!d)
          .reduce<string | null>((max, d) => (max == null || d > max ? d : max), null);
        return {
          ...p,
          interaction_count: p.conversations?.length ?? 0,
          fact_count: p.facts?.length ?? 0,
          last_interaction_at: lastInteraction,
          conversations: undefined,
          facts: undefined,
        };
      });
      return { people };
    },
  );

  app.get<{ Params: { id: string } }>('/api/people/:id', async (req, reply) => {
    const id = req.params.id;
    const sb = req.supabase!;
    // Person + facts + conversations + related notes/projects.
    // Projects link via projects.primary_contact_id (renamed from client_id
    // in 0033). The person's company is joined for the detail header.
    // Interactions now come from the conversations table (Addendum 05).
    const [personRes, factsRes, conversationsRes, notesRes, projectsRes] = await Promise.all([
      sb.from('people').select('*, company_ref:companies(id, name, relationship_type)').eq('id', id).maybeSingle(),
      sb.from('person_facts').select('*').eq('person_id', id).order('date_relevant', { ascending: true, nullsFirst: false }),
      sb.from('conversations')
        .select('*, company:companies(id, name), project:projects(id, name, color)')
        .eq('person_id', id)
        .order('occurred_at', { ascending: false })
        .limit(200),
      sb.from('notes').select('id, title, body, source_type, created_at').eq('related_person_id', id).order('created_at', { ascending: false }).limit(50),
      sb.from('projects').select('id, name, status, color').eq('primary_contact_id', id).order('created_at', { ascending: false }),
    ]);
    if (personRes.error) throw app.httpErrors.internalServerError(personRes.error.message);
    if (!personRes.data) return reply.code(404).send({ error: 'not_found' });
    if (factsRes.error) throw app.httpErrors.internalServerError(factsRes.error.message);
    if (conversationsRes.error) throw app.httpErrors.internalServerError(conversationsRes.error.message);
    if (notesRes.error) throw app.httpErrors.internalServerError(notesRes.error.message);
    if (projectsRes.error) throw app.httpErrors.internalServerError(projectsRes.error.message);
    return {
      person: personRes.data,
      facts: factsRes.data ?? [],
      conversations: conversationsRes.data ?? [],
      notes: notesRes.data ?? [],
      projects: projectsRes.data ?? [],
    };
  });

  app.post('/api/people', async (req, reply) => {
    const parsed = CreatePersonSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_payload', details: parsed.error.flatten().fieldErrors });
    }
    const { data, error } = await req.supabase!.from('people').insert(parsed.data).select('*').single();
    if (error) {
      // 23505 on the partial unique index = this company already has a
      // primary contact. 23503 = bad company_id FK.
      if (error.code === '23505') return reply.code(409).send({ error: 'company_already_has_primary' });
      if (error.code === '23503') return reply.code(400).send({ error: 'invalid_company_id' });
      throw app.httpErrors.internalServerError(error.message);
    }
    return reply.code(201).send(data);
  });

  app.patch<{ Params: { id: string } }>('/api/people/:id', async (req, reply) => {
    const parsed = UpdatePersonSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_payload', details: parsed.error.flatten().fieldErrors });
    }
    if (Object.keys(parsed.data).length === 0) {
      return reply.code(400).send({ error: 'empty_payload' });
    }
    const { data, error } = await req.supabase!
      .from('people')
      .update({ ...parsed.data, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select('*')
      .single();
    if (error) {
      if (error.code === '23505') return reply.code(409).send({ error: 'company_already_has_primary' });
      if (error.code === '23503') return reply.code(400).send({ error: 'invalid_company_id' });
      throw app.httpErrors.internalServerError(error.message);
    }
    return data;
  });

  app.delete<{ Params: { id: string } }>('/api/people/:id', async (req, reply) => {
    // facts + interactions cascade-delete via their FKs.
    // notes.related_person_id is ON DELETE SET NULL (preserves notes).
    // projects.primary_contact_id is also ON DELETE SET NULL.
    // project_contacts rows cascade-delete via their person FK.
    const { error } = await req.supabase!.from('people').delete().eq('id', req.params.id);
    if (error) throw app.httpErrors.internalServerError(error.message);
    return reply.code(204).send();
  });

  // ─── Facts ──────────────────────────────────────────────────────────

  app.post<{ Params: { id: string } }>('/api/people/:id/facts', async (req, reply) => {
    const parsed = CreatePersonFactSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_payload', details: parsed.error.flatten().fieldErrors });
    }
    const { data, error } = await req.supabase!
      .from('person_facts')
      .insert({ ...parsed.data, person_id: req.params.id })
      .select('*')
      .single();
    if (error) throw app.httpErrors.internalServerError(error.message);
    return reply.code(201).send(data);
  });

  app.patch<{ Params: { id: string; factId: string } }>(
    '/api/people/:id/facts/:factId',
    async (req, reply) => {
      const parsed = UpdatePersonFactSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_payload', details: parsed.error.flatten().fieldErrors });
      }
      const { data, error } = await req.supabase!
        .from('person_facts')
        .update(parsed.data)
        .eq('id', req.params.factId)
        .eq('person_id', req.params.id)
        .select('*')
        .single();
      if (error) throw app.httpErrors.internalServerError(error.message);
      return data;
    },
  );

  app.delete<{ Params: { id: string; factId: string } }>(
    '/api/people/:id/facts/:factId',
    async (req, reply) => {
      const { error } = await req.supabase!
        .from('person_facts')
        .delete()
        .eq('id', req.params.factId)
        .eq('person_id', req.params.id);
      if (error) throw app.httpErrors.internalServerError(error.message);
      return reply.code(204).send();
    },
  );

  // Interactions moved to /api/conversations (Addendum 05). The person
  // detail read above joins conversations; writes go through the conversations
  // route with person_id in the body.
};
