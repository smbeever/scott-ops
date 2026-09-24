import type Anthropic from '@anthropic-ai/sdk';
import { anthropic } from './anthropic.js';
import { env } from './env.js';

// Structured AI summary for inbound emails (Addendum 05 §8). One Sonnet call
// per email produces a concise summary + follow-up detection + hints. Kept
// separate from the voice parser (Opus): the parser decides ROUTING (who /
// task vs note vs conversation); this decides CONTENT (what it says, is a
// reply needed). The two compose in the inbound-email route.

export interface EmailSummary {
  summary: string;              // 2-3 sentence summary of content + intent
  requires_followup: boolean;
  followup_by: string | null;   // ISO date if a deadline is stated/implied
  suggested_task_title: string | null;
  urgency: 'low' | 'normal' | 'high';
  project_hint: string | null;  // fuzzy project name for attachment
}

const SYSTEM_PROMPT = `You summarize inbound emails for Scott's operations dashboard. \
Given an email's subject and body (which may be a forwarded or replied thread), \
produce a compact structured summary.

Return ONLY a single JSON object, no markdown fences, no prose, with exactly these keys:
{
  "summary": "2-3 sentence summary of what the email is about and what it asks or implies. Write what it SAYS, not 'this email discusses'. If it's a forwarded thread, summarize the original message, not the forward wrapper.",
  "requires_followup": true | false,   // does this need a reply or an action from Scott?
  "followup_by": "YYYY-MM-DD" | null,  // a date only if one is explicitly stated or clearly implied ("by Friday", "end of month"); else null
  "suggested_task_title": "short imperative task title" | null,  // only if a concrete action is clearly required; else null
  "urgency": "low" | "normal" | "high",  // "high" ONLY for explicit urgency signals (deadline today, "urgent", "asap")
  "project_hint": "fuzzy project or topic name" | null  // if the email clearly concerns a named project/effort; else null
}

Rules:
- Resolve relative dates against today's date, provided in the user message, to an absolute YYYY-MM-DD.
- Default urgency is "normal". Reserve "high" for genuine urgency.
- Be decisive about requires_followup: a question, a request, a "please review/respond", a deadline → true. An FYI/newsletter/receipt → false.
- Keep summary tight and specific; no filler.`;

export function isEmailSummaryConfigured(): boolean {
  return Boolean(env.ANTHROPIC_API_KEY);
}

// Returns the structured summary, or null if Anthropic isn't configured or
// the call/parse fails — callers fall back to a verbatim body summary so a
// summarizer hiccup never drops the capture.
export async function summarizeEmail(
  subject: string,
  body: string,
  todayIso: string,
): Promise<EmailSummary | null> {
  if (!isEmailSummaryConfigured()) return null;

  const requestBody: Anthropic.MessageCreateParamsNonStreaming = {
    model: env.EMAIL_SUMMARY_MODEL,
    max_tokens: 1024,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: [
              `Today's date: ${todayIso}`,
              '',
              `Subject: ${subject}`,
              '',
              '<body>',
              body.slice(0, 12000),
              '</body>',
            ].join('\n'),
          },
        ],
      },
    ],
  } as Anthropic.MessageCreateParamsNonStreaming;

  let response: Anthropic.Message;
  try {
    response = await anthropic().messages.create(requestBody);
  } catch {
    return null;
  }

  const textBlock = response.content.find(
    (b): b is Anthropic.TextBlock => b.type === 'text',
  );
  if (!textBlock) return null;

  let raw = textBlock.text.trim();
  if (raw.startsWith('```')) {
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const p = parsed as Record<string, unknown>;
  const summary = typeof p.summary === 'string' ? p.summary.trim() : '';
  if (!summary) return null;

  const urgency = p.urgency === 'low' || p.urgency === 'high' ? p.urgency : 'normal';
  const followupRaw = typeof p.followup_by === 'string' ? p.followup_by.trim() : '';
  const followup_by = /^\d{4}-\d{2}-\d{2}$/.test(followupRaw) ? followupRaw : null;

  return {
    summary,
    requires_followup: p.requires_followup === true,
    followup_by,
    suggested_task_title:
      typeof p.suggested_task_title === 'string' && p.suggested_task_title.trim()
        ? p.suggested_task_title.trim()
        : null,
    urgency,
    project_hint:
      typeof p.project_hint === 'string' && p.project_hint.trim()
        ? p.project_hint.trim()
        : null,
  };
}

// Gmail deep-link via the reliable rfc822msgid search URL (Addendum 05 §9).
// The direct #inbox/<hex> form needs Gmail's internal id; the search form
// works from the RFC-822 Message-ID we already have. Single active Gmail
// account assumed (/u/0/) — documented limitation.
export function gmailDeepLink(messageId: string | null | undefined): string | null {
  if (!messageId) return null;
  const clean = messageId.replace(/^<|>$/g, '').trim();
  if (!clean) return null;
  return `https://mail.google.com/mail/u/0/#search/rfc822msgid:${encodeURIComponent(clean)}`;
}
