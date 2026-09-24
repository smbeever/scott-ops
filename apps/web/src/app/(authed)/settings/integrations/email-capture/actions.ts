'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { emailCaptureApi, ApiError } from '@/lib/api';

const PATH = '/settings/integrations/email-capture';

// Void return so this can be used directly as a `<form action={}>` — errors
// get logged server-side; the UI just re-renders with unchanged state.
export async function rotateCaptureAddressAction(): Promise<void> {
  try {
    await emailCaptureApi.rotateAddress();
  } catch (err) {
    if (err instanceof ApiError && err.status === 503) {
      // eslint-disable-next-line no-console
      console.error('rotateCaptureAddressAction: CAPTURE_DOMAIN not configured');
    } else {
      // eslint-disable-next-line no-console
      console.error('rotateCaptureAddressAction failed:', err);
    }
  }
  revalidatePath(PATH);
}

const AddAllowlistSchema = z.object({
  email_address: z.string().email(),
  label: z.string().max(80).optional(),
});

export async function addAllowlistAction(
  _prev: { error?: string } | null,
  formData: FormData,
): Promise<{ error?: string }> {
  const parsed = AddAllowlistSchema.safeParse({
    email_address: formData.get('email_address'),
    label: formData.get('label') || undefined,
  });
  if (!parsed.success) {
    return { error: 'Please enter a valid email address.' };
  }
  try {
    await emailCaptureApi.addAllowlist({
      email_address: parsed.data.email_address,
      label: parsed.data.label ?? null,
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'add_failed' };
  }
  revalidatePath(PATH);
  return {};
}

export async function removeAllowlistAction(formData: FormData): Promise<void> {
  const id = String(formData.get('id') ?? '');
  if (!id) return;
  try {
    await emailCaptureApi.removeAllowlist(id);
  } catch {
    // Best-effort — revalidate to resync UI even on failure.
  }
  revalidatePath(PATH);
}

const UpdateAddressSchema = z.object({
  rate_limit_per_hour: z.coerce.number().int().positive().max(10_000),
});

export async function updateRateLimitAction(
  _prev: { error?: string } | null,
  formData: FormData,
): Promise<{ error?: string }> {
  const parsed = UpdateAddressSchema.safeParse({
    rate_limit_per_hour: formData.get('rate_limit_per_hour'),
  });
  if (!parsed.success) {
    return { error: 'Rate limit must be a positive integer.' };
  }
  try {
    await emailCaptureApi.updateAddress({ rate_limit_per_hour: parsed.data.rate_limit_per_hour });
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'update_failed' };
  }
  revalidatePath(PATH);
  return {};
}
