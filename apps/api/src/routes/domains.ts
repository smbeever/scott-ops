import type { FastifyPluginAsync } from 'fastify';
import { UpdateDomainSchema } from '@scott-ops/shared/schemas';
import { clearAttentionForSource } from '../lib/attention.js';

// Domain CRUD. Single-user system, so we surface every active domain on
// list. Editing happens via the /domains/[id] detail page on the web side.

export const domainRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  app.get('/api/domains', async (req) => {
    const { data, error } = await req.supabase!
      .from('stewardship_domains')
      .select('*')
      .eq('active', true)
      .order('name', { ascending: true });
    if (error) throw app.httpErrors.internalServerError(error.message);
    return { domains: data ?? [] };
  });

  app.get<{ Params: { id: string } }>('/api/domains/:id', async (req, reply) => {
    const { data, error } = await req.supabase!
      .from('stewardship_domains')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) throw app.httpErrors.internalServerError(error.message);
    if (!data) return reply.code(404).send({ error: 'not_found' });
    return data;
  });

  app.patch<{ Params: { id: string } }>('/api/domains/:id', async (req, reply) => {
    const parsed = UpdateDomainSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_payload',
        details: parsed.error.flatten().fieldErrors,
      });
    }
    if (Object.keys(parsed.data).length === 0) {
      return reply.code(400).send({ error: 'empty_payload' });
    }

    // System-domain protection (Addendum 03). Read is_system before the
    // update so we can reject identity-changing patches (name, active) on
    // Inbox and any future system domains. Description and failure_patterns
    // remain editable — those don't break the system contract.
    const { data: existing, error: readErr } = await req.supabase!
      .from('stewardship_domains')
      .select('is_system')
      .eq('id', req.params.id)
      .maybeSingle();
    if (readErr) throw app.httpErrors.internalServerError(readErr.message);
    if (!existing) return reply.code(404).send({ error: 'not_found' });
    if (existing.is_system === true) {
      const forbidden = ['name', 'active', 'is_system'] as const;
      for (const key of forbidden) {
        if (key in parsed.data) {
          return reply.code(400).send({
            error: 'system_domain_protected',
            details: { field: key, message: `Cannot change ${key} on a system domain.` },
          });
        }
      }
    }

    const { data, error } = await req.supabase!
      .from('stewardship_domains')
      .update(parsed.data)
      .eq('id', req.params.id)
      .select('*')
      .single();
    if (error) throw app.httpErrors.internalServerError(error.message);
    // Clear the live domain_stale item when the domain is either marked shipped
    // (last_shipped_at set) OR its stale watch is switched off — a disabled rule
    // must not leave a stale flag sitting on Today until the next cron. The
    // rule itself already skips stale_enabled=false domains, so it won't
    // regenerate. Best-effort.
    const clearsStale =
      ('last_shipped_at' in parsed.data && !!parsed.data.last_shipped_at) ||
      parsed.data.stale_enabled === false;
    if (clearsStale) {
      try {
        await clearAttentionForSource(req.supabase!, 'domain', req.params.id, ['domain_stale']);
      } catch { /* best-effort */ }
    }
    return data;
  });

  // DELETE is not exposed today. If it ever ships, the is_system check
  // must reject system-domain deletes here as well.
};
