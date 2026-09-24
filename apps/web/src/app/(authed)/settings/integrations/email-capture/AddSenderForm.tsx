'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { addAllowlistAction } from './actions';

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="bg-ink hover:bg-ink-2 disabled:opacity-50 text-bg font-sans font-semibold text-[12px] uppercase tracking-wider px-3 py-2 transition-colors"
    >
      {pending ? 'Adding…' : 'Add sender'}
    </button>
  );
}

export function AddSenderForm() {
  const [state, formAction] = useActionState(addAllowlistAction, null);
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2 items-end">
        <label className="flex-1 min-w-[240px]">
          <span className="block font-mono text-[10px] uppercase tracking-wider text-ink-3 mb-1">
            Email address
          </span>
          <input
            type="email"
            name="email_address"
            required
            placeholder="you@example.com"
            className="w-full bg-transparent border border-line px-3 py-2 font-mono text-[13px] text-ink focus:border-ink outline-none transition-colors"
          />
        </label>
        <label className="flex-1 min-w-[180px]">
          <span className="block font-mono text-[10px] uppercase tracking-wider text-ink-3 mb-1">
            Label (optional)
          </span>
          <input
            type="text"
            name="label"
            placeholder="e.g. iCloud email"
            className="w-full bg-transparent border border-line px-3 py-2 font-sans text-[13px] text-ink focus:border-ink outline-none transition-colors"
          />
        </label>
        <Submit />
      </div>
      {state?.error && (
        <p className="font-sans text-[12px] text-accent">{state.error}</p>
      )}
    </form>
  );
}
