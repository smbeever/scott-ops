import type { FastifyPluginAsync } from 'fastify';
import { buildWork } from '../lib/work.js';

// /api/work — the Work page's computed manager's map (Addendum 08 §6). One
// aggregation over projects + domains + in-flight content + attention flags,
// per domain, with the contract's ordering. Read-only.

export const workRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  app.get('/api/work', async (req) => {
    try {
      return await buildWork(req.supabase!);
    } catch (err) {
      throw app.httpErrors.internalServerError(err instanceof Error ? err.message : 'work_failed');
    }
  });
};
