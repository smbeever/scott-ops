'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { updateRateLimitAction } from './actions';

function Save() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="px-3 py-2 border border-line text-ink hover:border-ink-2 font-sans font-semibold text-[12px] uppercase tracking-wider transition-colors disabled:opacity-50"
    >
      {pending ? 'Saving…' : 'Save'}
    </button>
  );
}

export function RateLimitForm({ current }: { current: number }) {
  const [state, formAction] = useActionState(updateRateLimitAction, null);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <div className="flex items-end gap-2">
        <label>
          <span className="block font-mono text-[10px] uppercase tracking-wider text-ink-3 mb-1">
            Emails per hour
          </span>
          <input
            type="number"
            name="rate_limit_per_hour"
            required
            min={1}
            max={10000}
            defaultValue={current}
            className="w-32 bg-transparent border border-line px-3 py-2 font-mono text-[13px] text-ink focus:border-ink outline-none transition-colors"
          />
        </label>
        <Save />
      </div>
      {state?.error && (
        <p className="font-sans text-[12px] text-accent">{state.error}</p>
      )}
    </form>
  );
}
