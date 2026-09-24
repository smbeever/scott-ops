'use server';

import { revalidatePath } from 'next/cache';
import { recapApi, ApiError, type PlanWeekSubmit, type WeeklyReflectionSubmit } from '@/lib/api';

export type ActionResult = { ok: true } | { ok: false; error: string };

function toError(err: unknown): ActionResult {
  if (err instanceof ApiError) {
    const body = err.body as { error?: string } | null;
    return { ok: false, error: body?.error ?? `API ${err.status}` };
  }
  return { ok: false, error: (err as Error).message };
}

// Plan the coming week. Writes keystone/day_type to each date's daily_scores
// row; revalidates Today + shutdown so tomorrow's plan shows there too.
export async function planWeekAction(input: PlanWeekSubmit): Promise<ActionResult> {
  try {
    await recapApi.planWeek(input);
    revalidatePath('/recap');
    revalidatePath('/today');
    revalidatePath('/shutdown');
    return { ok: true };
  } catch (err) {
    return toError(err);
  }
}

export async function saveReflectionAction(input: WeeklyReflectionSubmit): Promise<ActionResult> {
  try {
    await recapApi.saveReflection(input);
    revalidatePath('/recap');
    return { ok: true };
  } catch (err) {
    return toError(err);
  }
}
