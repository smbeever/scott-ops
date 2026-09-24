import { z } from 'zod';

// Attention Engine items (Addendum 05 §10). Mirrors migration 0035. The
// rule engine writes these; the API exposes list + lifecycle (snooze /
// dismiss / acted-on); the Today card + Feed render them.

export const AttentionSourceTypeSchema = z.enum([
  'person', 'company', 'domain', 'project', 'conversation', 'task', 'content',
]);
export type AttentionSourceType = z.infer<typeof AttentionSourceTypeSchema>;

export const AttentionUrgencySchema = z.enum(['low', 'normal', 'high']);
export type AttentionUrgency = z.infer<typeof AttentionUrgencySchema>;

export const AttentionStatusSchema = z.enum([
  'active', 'dismissed', 'snoozed', 'acted_on', 'expired',
]);
export type AttentionStatus = z.infer<typeof AttentionStatusSchema>;

export const AttentionItemSchema = z.object({
  id: z.string().uuid(),
  rule_type: z.string(),
  source_type: AttentionSourceTypeSchema,
  source_id: z.string().uuid(),
  title: z.string(),
  detail: z.string().nullable().optional(),
  suggested_action: z.string().nullable().optional(),
  score: z.number(),
  urgency: AttentionUrgencySchema,
  first_surfaced_at: z.string().datetime({ offset: true }),
  last_surfaced_at: z.string().datetime({ offset: true }),
  surface_count: z.number().int(),
  status: AttentionStatusSchema,
  snoozed_until: z.string().date().nullable().optional(),
  dismissed_at: z.string().datetime({ offset: true }).nullable().optional(),
  acted_on_at: z.string().datetime({ offset: true }).nullable().optional(),
  acted_on_action: z.string().nullable().optional(),
  dedup_key: z.string(),
  created_at: z.string().datetime({ offset: true }),
});
export type AttentionItem = z.infer<typeof AttentionItemSchema>;

// Lifecycle transitions the API accepts on an item.
export const AttentionActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('snooze'),
    // ISO date; defaults to +7 days server-side when omitted.
    until: z.string().date().optional(),
  }),
  z.object({ action: z.literal('dismiss') }),
  z.object({
    action: z.literal('acted_on'),
    acted_on_action: z.string().optional(), // e.g. 'created_task', 'logged_conversation'
  }),
  z.object({ action: z.literal('reactivate') }),
]);
export type AttentionAction = z.infer<typeof AttentionActionSchema>;
