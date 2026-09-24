import { z } from 'zod';

// The Claude-API voice parser returns an array of these. One utterance can
// produce multiple actions (e.g. complete a task AND log activity AND create
// a calendar event). Schemas here mirror the action types listed in spec §14.

const FuzzyMatchSchema = z.string().min(1); // "the Reviews plugin", "Randy"

export const VoiceActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create_task'),
    title: z.string().min(1),
    // Free-form context for the task. Voice utterances rarely bother; email
    // captures put the full body here so the task carries its own briefing.
    notes: z.string().optional(),
    due_date: z.string().date().optional(),
    due_time: z.string().optional(),
    priority: z.number().int().min(1).max(4).optional(),
    project_match: FuzzyMatchSchema.optional(),
    domain_match: FuzzyMatchSchema.optional(),
    parent_task_match: FuzzyMatchSchema.optional(),
    reminder_offsets: z.array(z.number()).optional(),
  }),
  z.object({
    action: z.literal('complete_task'),
    task_match: FuzzyMatchSchema,
  }),
  z.object({
    action: z.literal('create_project'),
    name: z.string().min(1),
    domain_match: FuzzyMatchSchema.optional(),
    target_date: z.string().date().optional(),
  }),
  z.object({
    action: z.literal('update_project_status'),
    project_match: FuzzyMatchSchema,
    status: z.enum(['active', 'paused', 'done', 'archived']),
  }),
  z.object({
    action: z.literal('log_activity'),
    project_match: FuzzyMatchSchema,
    entry: z.string().min(1),
    hours_logged: z.number().nonnegative().optional(),
  }),
  z.object({
    action: z.literal('update_milestone'),
    project_match: FuzzyMatchSchema,
    milestone_match: FuzzyMatchSchema,
    progress_pct: z.number().min(0).max(100).optional(),
    status: z.enum(['open', 'done']).optional(),
  }),
  z.object({
    action: z.literal('create_calendar_event'),
    title: z.string().min(1),
    start: z.string().datetime({ offset: true }),
    end: z.string().datetime({ offset: true }),
    location: z.string().optional(),
    attendees: z.array(z.string()).optional(),
  }),
  z.object({
    action: z.literal('create_note'),
    body: z.string().min(1),
    // Addendum 02 — finer-grained source_type replaces the old `type` enum.
    source_type: z.enum([
      'own_thought', 'reading_response', 'meeting_note',
      'brainstorm', 'observation', 'other',
    ]).optional(),
    source_reference: z.string().optional(),
    tags: z.array(z.string()).optional(),
    project_match: FuzzyMatchSchema.optional(),
    person_match: FuzzyMatchSchema.optional(),
    quote_match: FuzzyMatchSchema.optional(),  // when the note is about a quote but isn't itself an annotation
    needs_review: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('create_quote'),
    text: z.string().min(1),
    book_match: FuzzyMatchSchema.optional(),
    page_number: z.number().int().positive().optional(),
    chapter: z.string().optional(),
    source_type: z.enum(['book', 'article', 'podcast', 'conversation', 'sermon', 'other']).optional(),
    source_reference: z.string().optional(),
    source_author: z.string().optional(),
    tags: z.array(z.string()).optional(),
    // Addendum 02 §4 — if the user bundles a thought with the quote in the
    // same utterance, the parser includes annotation_body here and the
    // executor creates both the quote AND an annotation with context='on_capture'.
    annotation_body: z.string().optional(),
  }),
  z.object({
    // Addendum 02 §4 — adding a thought to an existing quote.
    action: z.literal('create_quote_annotation'),
    quote_match: FuzzyMatchSchema,
    body: z.string().min(1),
    context: z.enum(['on_capture', 'on_revisit', 'on_surface', 'unspecified']).optional(),
    tags: z.array(z.string()).optional(),
  }),
  z.object({
    action: z.literal('create_journal_entry'),
    text: z.string().min(1),
    date: z.string().date().optional(),
  }),
  z.object({
    action: z.literal('create_person_fact'),
    person_match: FuzzyMatchSchema,
    fact_type: z.enum(['anniversary', 'birthday', 'kid_name', 'shared', 'follow_up', 'other']),
    fact_value: z.string().min(1),
    date_relevant: z.string().date().optional(),
    recurring: z.boolean().optional(),
  }),
  z.object({
    // Addendum 04 — log a touchpoint with a person. Primarily driven
    // by inbound email captures (parser is given an email_context block
    // and identifies which person it's about), but also usable via voice.
    // SUPERSEDED by create_conversation (Addendum 05) — kept for back-compat
    // so the executor can still route older payloads, but the parser now
    // emits create_conversation.
    action: z.literal('create_person_interaction'),
    person_match: FuzzyMatchSchema,
    interaction_type: z.enum(['email', 'call', 'in_person', 'text', 'meeting', 'other']).optional(),
    direction: z.enum(['inbound', 'outbound', 'internal']).optional(),
    subject: z.string().optional(),
    body: z.string().min(1),
    email_message_id: z.string().optional(),
    occurred_at: z.string().datetime({ offset: true }).optional(),
  }),
  z.object({
    // Addendum 05 §13 — the unified interaction log. Attaches to any of
    // company/person/project (parser resolves the *_match phrases). At least
    // one match should be present; the executor defaults gracefully.
    action: z.literal('create_conversation'),
    company_match: FuzzyMatchSchema.optional(),
    person_match: FuzzyMatchSchema.optional(),
    project_match: FuzzyMatchSchema.optional(),
    interaction_type: z.enum([
      'email', 'call', 'text_message', 'social_dm',
      'in_person', 'meeting', 'video_call', 'other',
    ]),
    direction: z.enum(['inbound', 'outbound', 'internal']),
    subject: z.string().optional(),
    summary: z.string().min(1),
    requires_followup: z.boolean().optional(),
    followup_by: z.string().date().optional(),
    occurred_at: z.string().datetime({ offset: true }).optional(),
  }),
  z.object({
    // Addendum 05 §13 — create a company record.
    action: z.literal('create_company'),
    name: z.string().min(1),
    domain_match: FuzzyMatchSchema.optional(),
    relationship_type: z.enum([
      'active_client', 'past_client', 'prospect',
      'vendor', 'partner', 'brand_deal', 'other',
    ]).optional(),
    website: z.string().optional(),
    primary_email: z.string().optional(),
  }),
  z.object({
    // Resurface weight — present in the parser prompt + executor since the
    // resurfacing feature shipped, but was missing from this schema (a
    // pre-existing validation gap). Added while extending for Addendum 05.
    action: z.literal('set_resurface_weight'),
    target_kind: z.enum(['quote', 'note', 'journal']),
    target_match: FuzzyMatchSchema,
    weight: z.number(),
  }),
  z.object({
    action: z.literal('update_content_item'),
    item_match: FuzzyMatchSchema,
    status: z.enum([
      'idea', 'outline', 'filming', 'editing', 'published',
      'derivatives_pending', 'done',
    ]).optional(),
    // Addendum 07 — voice can change the content type (e.g. "make that a course").
    type: z.enum([
      'video', 'article', 'short_clip', 'podcast_episode', 'newsletter', 'course',
    ]).optional(),
    video_url: z.string().url().optional(),
    outline_md: z.string().optional(),
  }),
  z.object({
    action: z.literal('add_inventory_item'),
    category: z.string().min(1),
    brand: z.string().optional(),
    model: z.string().optional(),
    serial: z.string().optional(),
    purchase_date: z.string().date().optional(),
    purchase_price: z.number().optional(),
  }),
  z.object({
    // Tomorrow's Focus (Addendum 09) — one spoken sentence points a day at a
    // project or content item. Replaces the retired score_day / set_keystone /
    // log_hedge actions. target_match is fuzzy against active projects and
    // in-flight content; `date` accepts a word ("today"/"tomorrow") and
    // defaults to tomorrow.
    action: z.literal('set_focus'),
    target_match: FuzzyMatchSchema,
    date: z.enum(['today', 'tomorrow']).optional(),
    note: z.string().optional(),
  }),
]);

// What the parser returns. Either an array of actions, an error, or a
// disambiguation request.
export const ParsedActionSchema = z.union([
  z.array(VoiceActionSchema),
  z.object({
    needs_disambiguation: z.literal(true),
    field: z.string(),
    candidates: z.array(z.object({
      id: z.string(),
      label: z.string(),
    })),
  }),
  z.object({
    error: z.string(),
    transcript: z.string(),
  }),
]);

// How the transcript was produced. Drives the `source` column on every
// entity the executor creates. 'voice' = spoken into the mic (audio
// path or Web Speech). 'text' = typed in the Cmd+J palette. Default
// 'voice' for back-compat with existing clients.
//
// Named with the "Transcript" qualifier to avoid colliding with the
// older CaptureSourceSchema in captured.ts, which enumerates inbox-
// webhook origins (zapier / n8n / smart_glasses / etc) for /api/ingest.
export const CaptureTranscriptSourceSchema = z.enum(['voice', 'text']);
export type CaptureSource = z.infer<typeof CaptureTranscriptSourceSchema>;

export const VoiceCaptureRequestSchema = z.object({
  transcript: z.string().min(1),
  // Optional: what the client believes the current local time is. Server
  // falls back to its own clock if absent.
  client_time: z.string().datetime({ offset: true }).optional(),
  source: CaptureTranscriptSourceSchema.optional(),
});
