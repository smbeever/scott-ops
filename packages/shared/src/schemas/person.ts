import { z } from 'zod';

// People + their facts + interactions. Lightweight CRM, scoped to the
// single user. Three tables share the same person_id FK chain:
//   - people: the contact record
//   - person_facts: low-cardinality long-lived knowledge (birthday, kids' names,
//     anniversaries, follow-ups). Each fact has a type, value, and optional date.
//   - person_interactions: append-only log of touchpoints (call, email, meeting).
//
// Schemas mirror the DB column checks so invalid inputs round-trip cleanly.

export const RelationshipTypeSchema = z.enum([
  'client', 'family', 'church', 'friend', 'team', 'vendor', 'other',
]);
export type RelationshipType = z.infer<typeof RelationshipTypeSchema>;

export const PersonSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  relationship_type: RelationshipTypeSchema.nullable().optional(),
  email: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  // Legacy freeform company text (superseded by company_id, Addendum 05).
  company: z.string().nullable().optional(),
  // Company hierarchy (Addendum 05 §5).
  company_id: z.string().uuid().nullable().optional(),
  role_at_company: z.string().nullable().optional(),
  is_primary_contact: z.boolean().optional(),
  birthday: z.string().date().nullable().optional(),
  anniversary: z.string().date().nullable().optional(),
  notes: z.string().nullable().optional(),
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }),
});

// All optional fields .nullable() so callers can clear them via PATCH
// without branching per-field. Mirrors the project/note pattern.
export const CreatePersonSchema = z.object({
  name: z.string().min(1),
  relationship_type: RelationshipTypeSchema.nullable().optional(),
  email: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  company: z.string().nullable().optional(),
  company_id: z.string().uuid().nullable().optional(),
  role_at_company: z.string().nullable().optional(),
  is_primary_contact: z.boolean().optional(),
  birthday: z.string().date().nullable().optional(),
  anniversary: z.string().date().nullable().optional(),
  notes: z.string().nullable().optional(),
});

export const UpdatePersonSchema = CreatePersonSchema.partial();

// ─── Person facts ─────────────────────────────────────────────────────

export const PersonFactTypeSchema = z.enum([
  'anniversary', 'birthday', 'kid_name', 'shared', 'follow_up', 'other',
]);
export type PersonFactType = z.infer<typeof PersonFactTypeSchema>;

export const PersonFactSchema = z.object({
  id: z.string().uuid(),
  person_id: z.string().uuid(),
  fact_type: PersonFactTypeSchema,
  fact_value: z.string().min(1),
  source_ref: z.string().nullable().optional(),
  date_relevant: z.string().date().nullable().optional(),
  recurring: z.boolean(),
  created_at: z.string().datetime({ offset: true }),
});

// person_id comes from URL path; body is just the editable fields.
export const CreatePersonFactSchema = z.object({
  fact_type: PersonFactTypeSchema,
  fact_value: z.string().min(1),
  source_ref: z.string().nullable().optional(),
  date_relevant: z.string().date().nullable().optional(),
  recurring: z.boolean().optional(),
});

export const UpdatePersonFactSchema = CreatePersonFactSchema.partial();

// ─── Person interactions ──────────────────────────────────────────────
//
// Migration 0031 (email capture) added direction / subject / body /
// email_message_id / captured_via so an inbound email can round-trip
// as a proper interaction row without cramming the raw email into
// `notes`. Voice / manual interactions can still ignore these fields.

export const PersonInteractionTypeSchema = z.enum([
  'email', 'call', 'in_person', 'text', 'meeting', 'other',
]);
export type PersonInteractionType = z.infer<typeof PersonInteractionTypeSchema>;

export const InteractionDirectionSchema = z.enum(['inbound', 'outbound', 'internal']);
export type InteractionDirection = z.infer<typeof InteractionDirectionSchema>;

export const CapturedViaSchema = z.enum(['email_forward', 'manual', 'voice']);
export type CapturedVia = z.infer<typeof CapturedViaSchema>;

export const PersonInteractionSchema = z.object({
  id: z.string().uuid(),
  person_id: z.string().uuid(),
  interaction_type: PersonInteractionTypeSchema,
  direction: InteractionDirectionSchema.nullable().optional(),
  subject: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
  email_message_id: z.string().nullable().optional(),
  captured_via: CapturedViaSchema,
  notes: z.string().nullable().optional(),
  occurred_at: z.string().datetime({ offset: true }),
});

export const CreatePersonInteractionSchema = z.object({
  interaction_type: PersonInteractionTypeSchema,
  direction: InteractionDirectionSchema.nullable().optional(),
  subject: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
  email_message_id: z.string().nullable().optional(),
  captured_via: CapturedViaSchema.optional(),
  notes: z.string().nullable().optional(),
  // Defaults to now() in the DB if omitted. Allow datetime or date so the
  // form can send a backfill ("met yesterday, log it as yesterday").
  occurred_at: z.string().nullable().optional(),
});

export const UpdatePersonInteractionSchema = CreatePersonInteractionSchema.partial();
