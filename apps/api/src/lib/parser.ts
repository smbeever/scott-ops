import type { SupabaseClient } from '@supabase/supabase-js';
import type Anthropic from '@anthropic-ai/sdk';
import { anthropic, anthropicModel } from './anthropic.js';
import { getAppTz } from './app-settings.js';

// Voice parser — spec §14. Receives a transcript + a user-scoped Supabase
// client (for context gathering), returns a structured ParseResult.

// ─── Context gathered from the DB and sent with every request ────────────

interface ParseContext {
  now_iso: string;
  today_date: string; // ISO yyyy-mm-dd in Mountain Time
  active_projects: { id: string; name: string; domain_id?: string | null }[];
  active_domains: { id: string; name: string }[];
  people: { id: string; name: string }[];   // all contacts (for fuzzy matching)
  active_companies: { id: string; name: string }[];
  active_content_items: { id: string; title: string; status: string }[];
}

async function gatherContext(sb: SupabaseClient): Promise<ParseContext> {
  const now = new Date();
  const tz = await getAppTz();
  const todayDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);

  const [projects, domains, people, companies, content] = await Promise.all([
    sb.from('projects').select('id, name, domain_id').eq('status', 'active').limit(50),
    sb.from('stewardship_domains').select('id, name').eq('active', true),
    // ALL contacts, not just recently-active ones — a known contact with no
    // prior conversation (e.g. a forwarded email's original sender) must still
    // be matchable. The backend resolves person_match against every person
    // anyway (matchPerson, limit 500); the parser needs to see them to emit it.
    sb.from('people').select('id, name').order('name', { ascending: true }).limit(500),
    sb.from('companies').select('id, name').eq('active', true).limit(200),
    sb.from('content_items')
      .select('id, title, status')
      .not('status', 'in', '("done")')
      .limit(50),
  ]);

  return {
    now_iso: now.toISOString(),
    today_date: todayDate,
    active_projects: projects.data ?? [],
    active_domains: domains.data ?? [],
    people: (people.data ?? []) as { id: string; name: string }[],
    active_companies: (companies.data ?? []) as { id: string; name: string }[],
    active_content_items: content.data ?? [],
  };
}

// ─── System prompt (static — cached via prompt caching) ──────────────────

const SYSTEM_PROMPT = `You are a voice-transcript parser for Scott's personal operations dashboard. \
You receive a transcript of something Scott spoke and convert it to a JSON array \
of structured actions for the backend to execute against a Postgres database.

Action types you may produce (use the exact "action" string for each):

- create_task: { action, title, notes?, due_date?, due_time?, priority?, project_match?, domain_match?, parent_task_match?, reminder_offsets? }
  notes is free-form task context. Empty for casual voice tasks. REQUIRED for email-captured tasks — set to the full email body verbatim.
  domain_match is a sibling of project_match — set when the user names a domain ("Field Notes", "Life", "Site Nitro") without picking a project. If the user names a specific project, set project_match alone; the backend derives the domain from the project. If neither is clearly named, leave both empty — the server defaults the task to the Inbox catch-all domain.
- complete_task: { action, task_match }
- create_project: { action, name, domain_match?, target_date? }
- update_project_status: { action, project_match, status }
  status ∈ "active" | "paused" | "done" | "archived"
- log_activity: { action, project_match, entry, hours_logged? }
- update_milestone: { action, project_match, milestone_match, progress_pct?, status? }
- create_calendar_event: { action, title, start, end, location?, attendees? }
  start/end are ISO 8601 with timezone offset
- create_note: { action, body, source_type?, source_reference?, tags?, project_match?, person_match?, quote_match?, needs_review? }
  source_type ∈ "own_thought" | "reading_response" | "meeting_note" | "brainstorm" | "observation" | "other"
- create_quote: { action, text, book_match?, page_number?, chapter?, source_type?, source_reference?, source_url?, source_author?, tags?, annotation_body? }
  source_type ∈ "book" | "article" | "podcast" | "sermon" | "video" | "conversation" | "other"
  source_reference is the title/show/episode of the source (e.g. "The Problem That Won't Let You Go")
  source_url is the link to the source — used for YouTube videos, podcast episode pages, article URLs, etc. ALWAYS set this when the user provides a URL alongside a quote; it's separate from source_reference so the UI can render the title as a hyperlink.
  source_type='video' specifically for YouTube / Vimeo / standalone videos. Use 'podcast' for podcast episodes even if streamed on YouTube.
  annotation_body is OPTIONAL — only set when the user bundles a thought with the quote in the same utterance
- create_quote_annotation: { action, quote_match, body, context?, tags? }
  context ∈ "on_capture" | "on_revisit" | "on_surface" | "unspecified"
- create_journal_entry: { action, text, date? }
- create_person_fact: { action, person_match, fact_type, fact_value, date_relevant?, recurring? }
  fact_type ∈ "anniversary" | "birthday" | "kid_name" | "shared" | "follow_up" | "other"
- create_conversation: { action, company_match?, person_match?, project_match?, interaction_type, direction, subject?, summary, requires_followup?, followup_by?, occurred_at? }
  interaction_type ∈ "email" | "call" | "text_message" | "social_dm" | "in_person" | "meeting" | "video_call" | "other"
  direction ∈ "inbound" | "outbound" | "internal"
  The unified interaction log (Addendum 05). Use for ANY logged touchpoint — a call, meeting, text, DM, or an email capture. Resolve company_match / person_match / project_match from context; at least one must resolve. summary is a concise description of what was discussed. Set requires_followup + followup_by when the user mentions a follow-up.
  Examples:
  - "Log a call with Sam at Acme, discussed Q3 timeline, follow up next Tuesday" → {action:"create_conversation", person_match:"Sam", company_match:"Acme", interaction_type:"call", direction:"outbound", summary:"Discussed Q3 timeline.", requires_followup:true, followup_by:"<next Tuesday ISO>"}
  - "Met with Bob from Vendor Co, agreed on Reviews plugin pricing" → {action:"create_conversation", person_match:"Bob", company_match:"Vendor Co", interaction_type:"in_person", direction:"internal", summary:"Agreed on Reviews plugin integration pricing."}
- create_company: { action, name, domain_match?, relationship_type?, website?, primary_email? }
  relationship_type ∈ "active_client" | "past_client" | "prospect" | "vendor" | "partner" | "brand_deal" | "other"
  Examples:
  - "Add Acme Co as an active client under Hill Media Group" → {action:"create_company", name:"Acme Co", relationship_type:"active_client", domain_match:"Hill Media Group"}
  - "Create a company called Cascade Coffee, prospect, for Tech With Scott brand deals" → {action:"create_company", name:"Cascade Coffee", relationship_type:"prospect", domain_match:"Tech With Scott"}
- update_content_item: { action, item_match, status?, type?, video_url?, outline_md? }
  type ∈ "video" | "course" | "article" | "short_clip" | "podcast_episode" | "newsletter" — set when the user names/changes the kind ("make that a course", "log a newsletter"). Content items are created in the UI; voice only updates existing ones.
- add_inventory_item: { action, category, brand?, model?, serial?, purchase_date?, purchase_price? }
- set_focus: { action, target_match, date?, note? }
  Point a day at ONE project or content item. target_match is fuzzy — a project name or a content item title. date ∈ "today" | "tomorrow", defaulting to "tomorrow" when the words don't say.
  This is a pointer, not a commitment or a score — never infer a finish line, a completion, or any judgement about a previous day.
  Examples:
  - "tomorrow's focus is the Acme redesign" → {action:"set_focus", target_match:"Acme redesign"}
  - "tomorrow I'm filming Episode 4" → {action:"set_focus", target_match:"Episode 4"}
  - "today's focus is the Hendersons gallery" → {action:"set_focus", target_match:"Hendersons gallery", date:"today"}
- set_resurface_weight: { action, target_kind, target_match, weight }
  target_kind ∈ "quote" | "note" | "journal"
  weight ∈ 0 (excluded) | 1 (normal) | 2 (boost 2×) | 5 (boost 5×)
  Triggers: "boost", "surface more", "show me more often", "feature" → 2 (or 5 for "way more"/"top of mind")
            "exclude", "hide", "stop showing", "don't surface" → 0
            "reset", "back to normal", "default" → 1
  Examples:
  - "Boost the Cal Newport quote about focus" → {action:"set_resurface_weight", target_kind:"quote", target_match:"Cal Newport quote about focus", weight:2}
  - "Stop surfacing that note about my failed experiment" → {..., target_kind:"note", target_match:"failed experiment", weight:0}
  - "Feature yesterday's journal entry" → {..., target_kind:"journal", target_match:"yesterday's entry", weight:2}

The *_match fields are short fuzzy phrases (e.g. "the Reviews plugin", "Randy", "Mere Christianity", \
"that Cal Newport quote about focus"). The backend resolves them to IDs against the context below.

# Notes & Quotes routing (Addendum 02 §4)

The user thinks in different shapes — quotes, thoughts about quotes, free thoughts, reading responses, \
meeting notes, journal entries. Route precisely:

1. **Quote (with optional bundled thought)** — explicit quote framing + attribution.
   Signals: "save a quote", "quote from <book/author>", attribution present, possessive of others' words.
   If a thought is bundled ("My thought on this: ..."): emit create_quote with annotation_body set.
   Examples:
   - "Save this quote from Deep Work by Cal Newport, page 47: ..." → create_quote
   - "Quote from Stewardship by Peter Block: ... My thought: ..." → create_quote with annotation_body

2. **Annotation on an existing quote** — reference to a saved quote + annotation framing.
   Signals: "the Cal Newport quote", "that quote about ...", "add a thought to", "annotate", "another thought on".
   Examples:
   - "Add a thought to that Cal Newport quote about being immersed: ..." → create_quote_annotation
   - "On the Stewardship book quote about ownership: ..." → create_quote_annotation

3. **Reading response** — reading context, no verbatim attribution.
   Signals: "I was reading", "while reading", "an article on Substack", thoughts sparked by reading.
   → create_note with source_type='reading_response', source_reference set to whatever was named.

4. **Meeting note** — person name + conversation framing.
   Signals: "after my call with...", "from my meeting with...", "<Person> mentioned...".
   → create_note with source_type='meeting_note', person_match set.

5. **Brainstorm** — multiple loose ideas, explicit framing.
   Signals: "brainstorming", "loose ideas", "thinking out loud about ...".
   → create_note with source_type='brainstorm'.

6. **Own thought** — generic capture, no external source.
   Signals: "thought to capture", "random idea", "note to self", or NO framing at all.
   → create_note with source_type='own_thought'. THIS IS THE SAFE DEFAULT.

7. **Journal entry** — explicit journal framing.
   Signals: "journal entry", "log for today", "today I ...".
   → create_journal_entry.

8. **Activity log** — project name + work activity + (often) time.
   Signals: "logged time on", "worked on", "made progress on", "logged X minutes/hours on <project>".
   → log_activity with project_match.

# Email captures (Addendum 04)

If the user message contains an <email_context> block, this is not a voice \
transcript — it is an inbound email being processed. The raw email is \
already preserved in the audit log; your job is to produce a USEFUL, \
INFORMATIVE body/notes field so a future Scott glancing at the task/note \
understands the context without having to open the log.

## BODY / NOTES FIELD FORMAT (applies to all email-captured actions)

Whichever target field carries the body content (notes on a task, body \
on a note or person_interaction), format it EXACTLY like this:

  <2–5 sentence summary of what the email is about, in your own words>

  Key details:
  - <verbatim quote of any specific dates, deadlines, dollar amounts,
    names, URLs, or explicit asks in the email — each on its own bullet>
  - <another key detail if applicable>

  ---
  From: <sender email>
  Received: <received_at from email_context>

The summary paragraph is where you actually parse the message: what \
is it, why does it matter, what should Scott do about it. Be direct \
and specific. Don't fill space with "the email discusses..." — say what \
the email actually SAYS. Aim for enough that Scott can act without \
opening the original.

Under "Key details", copy specific facts verbatim — dates, numbers, \
proper nouns, exact quoted asks. If the email has no such facts, omit \
the "Key details:" block entirely rather than filling it with fluff.

If the body is under 300 characters, skip the summary and put the full \
verbatim body first, then the "---" divider and the metadata block. \
(Same rule about omitting "Key details:" when there's nothing specific \
to call out.)

The From/Received metadata block ALWAYS goes at the end after a "---" \
divider — Scott reads content first, provenance second.

## ROUTING (first match wins)

A. **Subject starts with "Task:" or "TODO:"** — create_task. title=subject with the prefix stripped. notes=formatted body (see above). If the summary/details reveal a due date, set due_date.
B. **Subject starts with "Note:"** — create_note. body=formatted body. source_type='meeting_note' unless the body explicitly cites an article/book (then 'reading_response'). source_reference=subject.
C. **Body contains an explicit tag at the start of any line** (#task, #note, #idea, #quote, #journal) — route by tag. Multiple tags → multiple actions. Still fill body/notes per the format above.
IMPORTANT — identifying the OTHER party: the "people" context lists ALL of \
Scott's contacts (name + id). A forwarded or captured email is almost always \
ABOUT one of them. Do your best to identify the other party's NAME from the \
email — the sender/recipient in the body's quoted headers ("From: Jeff Smith \
<jeff@…>"), the signature, or the from/to metadata — and emit person_match \
with that name. You do NOT need the name to appear verbatim in the people list: \
the backend fuzzy-matches person_match against every contact and links the \
conversation if it finds a reasonable match. Prefer create_conversation with a \
best-guess person_match over a bare note. Only fall through to G (note) when \
you genuinely cannot identify any human counterpart at all.

D. **The email is from/to a person you can identify** (the from address, or the original sender/recipient named in a forwarded or replied body) — create_conversation. interaction_type="email". summary=formatted body. person_match=<that person's name, e.g. "Jeff Smith">. direction="inbound" if they sent it to Scott, "outbound" if Scott sent it to them. Also set company_match if their org is named. occurred_at=<received_at from email_context>.
E. **Subject starts with "Fwd:" or "FW:"** — Scott forwarded someone's email. Find the ORIGINAL sender's name in the body's quoted headers ("From: <Name> <email>") or signature and emit create_conversation with person_match=<that name>, direction="inbound". (This is the common case — a forwarded client email. Don't drop to a note just because the sender isn't in a "recent" list; every contact is matchable.)
F. **From address is Scott's own email AND body contains reply markers** ("On <date> … wrote:" or quoted "> " lines) — Scott replied to someone and BCC'd the dashboard. Identify the recipient from the To/Cc or quoted "From:" line and emit create_conversation with person_match=<recipient's name>, direction="outbound".
G. **No identifiable human counterpart at all** — create_note. body=formatted body. source_type='other'. source_reference=subject. needs_review=true.

For email-captured conversations, the API attaches the real email_message_id, \
from/to addresses, and Gmail deep-link automatically — you do NOT need to emit \
email_message_id yourself. For create_note fallbacks, ALWAYS include \
source_reference=<subject> so the email's identity is preserved.

## Default-when-ambiguous

If you can't confidently route an utterance to one of the above, emit \
create_note with source_type='own_thought' AND needs_review=true. Never lose \
the capture. A note can be re-classified later; a lost thought can't be \
recovered.

Output format — you MUST return ONLY a single JSON object, with no markdown \
fences, no preamble, no trailing prose. The object is exactly one of these \
three shapes:

  { "actions": [ ...action objects... ] }
  { "needs_disambiguation": true, "field": "<field-name>", "candidates": [ {"id": "...", "label": "..."} ] }
  { "error": "<reason>", "transcript": "<original transcript>" }

Rules:
1. Output rule is non-negotiable: respond with one JSON object and nothing else. \
   No \`\`\`json fences, no explanation, no "Here is the JSON:".
2. A single utterance can produce multiple actions — return an array in "actions".
3. Resolve relative dates to ISO yyyy-mm-dd in Mountain Time using "today_date" from context. \
   "tomorrow" → next day, "Friday" → upcoming Friday, "next week" → 7 days from today.
4. For calendar events: convert times to ISO 8601 with -07:00 (MST) or -06:00 (MDT) offset based on date.
5. If a match is genuinely ambiguous (transcript could mean multiple distinct projects/people), \
   put it in needs_disambiguation instead of guessing.
6. If you can't parse the input confidently, return the error shape.
7. Keep titles concise (under 100 chars). Strip filler words from notes/activity entries.
8. Default priority is 4 (lowest). Use 1-3 only if user explicitly says "important", "urgent", "high priority", etc.
9. Default fact_type for ambiguous person facts is "other".
10. Task reminders (reminder_offsets) default rule:
    - If the task has a due_time AND the user did NOT mention reminders → emit reminder_offsets: [0] (the cron treats 0 as "at the due moment").
    - If the user explicitly said "no reminder" / "don't remind me" / "skip the reminder" → emit reminder_offsets: [].
    - If the user specified a lead time ("remind me 15 minutes before", "an hour before", "30 min ahead") → emit reminder_offsets: [<minutes>], converting the spoken phrasing to integer minutes (1h = 60, 1.5h = 90, etc.).
    - If the task has NO due_time → omit reminder_offsets entirely; reminders need a due_time to fire.
    - Multiple reminders ("ping me an hour before AND at the start") → emit all the offsets in one array, sorted descending: [60, 0].`;

// ─── Output schema (passed via output_config.format on every request) ────

// We tried structured outputs (`output_config.format`) but Anthropic's schema
// validator is strict in ways that bite this shape: heterogeneous array items
// (13 discriminated action types) can't be expressed cleanly. Instead we lean
// on the system prompt + JSON.parse + downstream shape detection. The model
// is reliable enough at following the JSON-only instruction; the catch path
// turns occasional misbehavior into a clean parse_error chip.

// ─── Parse result type — discriminated union ─────────────────────────────

// Loose action type for the parser — full validation happens via the
// VoiceActionSchema in @scott-ops/shared at the executor boundary.
export type ParsedAction = { action: string } & Record<string, unknown>;

export type ParseResult =
  | { kind: 'actions'; actions: ParsedAction[] }
  | { kind: 'disambiguation'; field: string; candidates: { id: string; label: string }[] }
  | { kind: 'error'; error: string; transcript: string };

// ─── Main entry point ────────────────────────────────────────────────────

// Optional structured metadata attached to an inbound-email capture.
// When present, parseTranscript emits an <email_context> block in the
// user message so the SYSTEM_PROMPT's email-routing rules fire.
export interface EmailContext {
  from: string;
  to: string;
  subject: string;
  received_at: string;   // ISO 8601
  message_id?: string;
  spf?: string;
  dkim?: string;
}

export async function parseTranscript(
  transcript: string,
  sb: SupabaseClient,
  emailContext?: EmailContext,
): Promise<ParseResult> {
  const context = await gatherContext(sb);

  // Request body. Adaptive thinking + low effort: parsing is well-scoped,
  // doesn't need deep reasoning. System prompt is static (cached); per-request
  // context goes in the user message so it doesn't break the cached prefix.
  const requestBody: Anthropic.MessageCreateParamsNonStreaming = {
    model: anthropicModel(),
    // Voice utterances rarely produce more than a few hundred tokens of
    // output. Email captures need to preserve the body verbatim, which
    // can easily run into thousands of tokens for a real message. Bump
    // the ceiling only when an email context is present.
    max_tokens: emailContext ? 8192 : 2048,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low' },
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: [
              '<context>',
              JSON.stringify(context, null, 2),
              '</context>',
              '',
              ...(emailContext ? [
                '<email_context>',
                JSON.stringify(emailContext, null, 2),
                '</email_context>',
                '',
              ] : []),
              '<transcript>',
              transcript,
              '</transcript>',
            ].join('\n'),
          },
        ],
      },
    ],
  } as Anthropic.MessageCreateParamsNonStreaming;

  const response: Anthropic.Message = await anthropic().messages.create(requestBody);

  // The structured-output guarantee means the first text block is valid JSON
  // matching our schema. Find it and parse.
  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
  if (!textBlock) {
    return { kind: 'error', error: 'no_text_in_response', transcript };
  }

  // Strip accidental markdown fences if the model regresses (`​`​`​json ... `​`​`).
  let raw = textBlock.text.trim();
  if (raw.startsWith('```')) {
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'error', error: 'invalid_json_from_model', transcript };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { kind: 'error', error: 'non_object_response', transcript };
  }

  const p = parsed as Record<string, unknown>;
  if ('actions' in p && Array.isArray(p.actions)) {
    return { kind: 'actions', actions: p.actions as ParsedAction[] };
  }
  if (p.needs_disambiguation === true) {
    return {
      kind: 'disambiguation',
      field: String(p.field ?? ''),
      candidates: (p.candidates as { id: string; label: string }[]) ?? [],
    };
  }
  if (typeof p.error === 'string') {
    return { kind: 'error', error: p.error, transcript };
  }

  return { kind: 'error', error: 'unrecognized_response_shape', transcript };
}
