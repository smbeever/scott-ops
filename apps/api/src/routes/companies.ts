import type { FastifyPluginAsync } from 'fastify';
import { CreateCompanySchema, UpdateCompanySchema } from '@scott-ops/shared/schemas';

// /api/companies/* — CRM company records (Addendum 05 §4). People link via
// people.company_id; projects via projects.company_id. The detail response
// carries the conversation timeline (Phase 2) plus an open-task rollup across
// the company's projects (Detail Pages v2, Addendum 10 §8) — tasks reach a
// company only through projects.company_id, so the rollup joins through it.

export const companyRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  // List — each row carries contact count + active-project count + the
  // domain name, so the index can show density without an N+1.
  app.get<{ Querystring: { relationship_type?: string; active?: string } }>(
    '/api/companies',
    async (req) => {
      let q = req.supabase!
        .from('companies')
        .select('*, domain:stewardship_domains(id, name), people:people(id), projects:projects(id, status)')
        .order('name', { ascending: true });
      if (req.query.relationship_type) q = q.eq('relationship_type', req.query.relationship_type);
      if (req.query.active === 'true') q = q.eq('active', true);
      const { data, error } = await q;
      if (error) throw app.httpErrors.internalServerError(error.message);
      type Row = {
        people?: { id: string }[];
        projects?: { id: string; status: string }[];
        [k: string]: unknown;
      };
      const companies = ((data ?? []) as Row[]).map((c) => ({
        ...c,
        contact_count: c.people?.length ?? 0,
        active_project_count: (c.projects ?? []).filter((p) => p.status === 'active').length,
        people: undefined,
        projects: undefined,
      }));
      return { companies };
    },
  );

  // Detail — company + its contacts + its projects + conversation timeline +
  // an open-task rollup (every not-done task across the company's projects).
  app.get<{ Params: { id: string } }>('/api/companies/:id', async (req, reply) => {
    const id = req.params.id;
    const sb = req.supabase!;
    const [companyRes, contactsRes, projectsRes, conversationsRes, openTasksRes] = await Promise.all([
      sb.from('companies').select('*, domain:stewardship_domains(id, name)').eq('id', id).maybeSingle(),
      sb.from('people')
        .select('id, name, email, phone, role_at_company, is_primary_contact')
        .eq('company_id', id)
        .order('is_primary_contact', { ascending: false })
        .order('name', { ascending: true }),
      sb.from('projects')
        .select('id, name, status, color')
        .eq('company_id', id)
        .order('created_at', { ascending: false }),
      sb.from('conversations')
        .select('*, person:people(id, name), project:projects(id, name, color)')
        .eq('company_id', id)
        .order('occurred_at', { ascending: false })
        .limit(200),
      // Open-task rollup. Tasks have no company_id — they reach a company only
      // through projects.company_id, so filter through an INNER project embed
      // (a plain embed would left-join and leak tasks whose project is null).
      // The web page derives BOTH the grouped list and each project card's
      // per-project counts from this array, so the limit must be generous
      // enough that no project is silently truncated — 2000 mirrors the
      // content list's ceiling and is unreachable for a personal CRM.
      // count:'exact' still reports the true total for the "showing X of Y" note.
      sb.from('tasks')
        .select('id, title, due_date, status, project:projects!inner(id, name, color)', { count: 'exact' })
        .eq('project.company_id', id)
        .neq('status', 'done')
        .order('due_date', { ascending: true, nullsFirst: false })
        .limit(2000),
    ]);
    if (companyRes.error) throw app.httpErrors.internalServerError(companyRes.error.message);
    if (!companyRes.data) return reply.code(404).send({ error: 'not_found' });
    if (contactsRes.error) throw app.httpErrors.internalServerError(contactsRes.error.message);
    if (projectsRes.error) throw app.httpErrors.internalServerError(projectsRes.error.message);
    if (conversationsRes.error) throw app.httpErrors.internalServerError(conversationsRes.error.message);
    if (openTasksRes.error) throw app.httpErrors.internalServerError(openTasksRes.error.message);
    return {
      company: companyRes.data,
      contacts: contactsRes.data ?? [],
      projects: projectsRes.data ?? [],
      conversations: conversationsRes.data ?? [],
      open_tasks: openTasksRes.data ?? [],
      open_tasks_count: openTasksRes.count ?? 0,
    };
  });

  app.post('/api/companies', async (req, reply) => {
    const parsed = CreateCompanySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_payload', details: parsed.error.flatten().fieldErrors });
    }
    const { data, error } = await req.supabase!
      .from('companies')
      .insert(parsed.data)
      .select('*')
      .single();
    if (error) {
      if (error.code === '23505') return reply.code(409).send({ error: 'company_name_exists' });
      if (error.code === '23503') return reply.code(400).send({ error: 'invalid_domain_id' });
      throw app.httpErrors.internalServerError(error.message);
    }
    return reply.code(201).send(data);
  });

  app.patch<{ Params: { id: string } }>('/api/companies/:id', async (req, reply) => {
    const parsed = UpdateCompanySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_payload', details: parsed.error.flatten().fieldErrors });
    }
    if (Object.keys(parsed.data).length === 0) {
      return reply.code(400).send({ error: 'empty_payload' });
    }
    const { data, error } = await req.supabase!
      .from('companies')
      .update(parsed.data)
      .eq('id', req.params.id)
      .select('*')
      .single();
    if (error) {
      if (error.code === '23505') return reply.code(409).send({ error: 'company_name_exists' });
      if (error.code === '23503') return reply.code(400).send({ error: 'invalid_domain_id' });
      throw app.httpErrors.internalServerError(error.message);
    }
    return data;
  });

  app.delete<{ Params: { id: string } }>('/api/companies/:id', async (req, reply) => {
    // people.company_id and projects.company_id are ON DELETE SET NULL —
    // contacts and projects survive, just unlinked from the company.
    const { error } = await req.supabase!.from('companies').delete().eq('id', req.params.id);
    if (error) throw app.httpErrors.internalServerError(error.message);
    return reply.code(204).send();
  });
};
