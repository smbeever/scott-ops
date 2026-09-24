'use server';

import { revalidatePath } from 'next/cache';
import { hedgesApi, ApiError, type HedgeLog } from '@/lib/api';

export type HedgeResult = { ok: true; hedge: HedgeLog } | { ok: false; error: string };

// Log a hedge. On success the client shows the Pivot Protocol card; the
// returned id lets it flip pivot_taken afterward. Revalidates Today +
// /shutdown so the "N logged · M pivoted" strip reflects it.
export async function createHedgeAction(input: {
  description: string;
  commitment_avoided: string | null;
}): Promise<HedgeResult> {
  const description = input.description.trim();
  if (!description) return { ok: false, error: 'Describe the hedge in a few words.' };
  try {
    const hedge = await hedgesApi.create({
      description,
      commitment_avoided: input.commitment_avoided?.trim() || null,
      created_via: 'ui',
    });
    revalidatePath('/today');
    revalidatePath('/shutdown');
    return { ok: true, hedge };
  } catch (err) {
    if (err instanceof ApiError) {
      const body = err.body as { error?: string } | null;
      return { ok: false, error: body?.error ?? `API ${err.status}` };
    }
    return { ok: false, error: (err as Error).message };
  }
}

export async function setPivotTakenAction(id: string, pivotTaken: boolean): Promise<HedgeResult> {
  try {
    const hedge = await hedgesApi.update(id, { pivot_taken: pivotTaken });
    revalidatePath('/today');
    revalidatePath('/shutdown');
    return { ok: true, hedge };
  } catch (err) {
    if (err instanceof ApiError) {
      const body = err.body as { error?: string } | null;
      return { ok: false, error: body?.error ?? `API ${err.status}` };
    }
    return { ok: false, error: (err as Error).message };
  }
}
