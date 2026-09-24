'use server';

import { revalidatePath } from 'next/cache';
import { shutdownApi, ApiError, type ShutdownResult, type ShutdownSubmit } from '@/lib/api';

export type SubmitResult =
  | { ok: true; result: ShutdownResult }
  | { ok: false; error: string };

// Submit the shutdown: scores day D, plans day D+1. Returns the confirmation
// (won/lost + 7-day rate) so the client can render the confirmation moment.
export async function submitShutdownAction(input: ShutdownSubmit): Promise<SubmitResult> {
  try {
    const result = await shutdownApi.submit(input);
    // The day's score changes what Today shows (re-entry time, done state).
    revalidatePath('/today');
    revalidatePath('/shutdown');
    return { ok: true, result };
  } catch (err) {
    if (err instanceof ApiError) {
      const body = err.body as { error?: string } | null;
      return { ok: false, error: body?.error ?? `API ${err.status}` };
    }
    return { ok: false, error: (err as Error).message };
  }
}
