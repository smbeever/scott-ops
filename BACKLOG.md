# Backlog

Deferred work, with the reason and the earliest sensible date. Several addendums
say "goes to the backlog file" — this is that file.

The governing rule (Addendum 09 §2): the Daily Rule's 30-day freeze is
**dissolved**. Standard governance applies to everything now — session caps and
**felt-pain gating**: something moves off this list when its absence actually
hurts, not because it's listed here.

---

## Dated

### Daily Rule hard delete — not before 2026-08-22
**From:** Addendum 09 §3.4
**What:** Drop the retired Rule routes (`/shutdown`, `/recap`, `/hedge`), their
components and server routes (`apps/api/src/routes/daily-rule.ts`,
`apps/api/src/lib/rule-pushes.ts`, `apps/api/src/lib/daily-rule.ts`), the shared
schemas, and the four tables (`daily_scores`, `hedge_logs`, `rule_pauses`,
`rule_push_log`).
**Why deferred:** Reversibility until certainty. The module is flagged off
(`app_settings.rule_module_enabled`, default false) and every row is retained,
so it can be restored intact from Settings → Modules. 30 days of *not* missing it
is the bar. Retired 2026-07-23 → earliest delete **2026-08-22**.
**Note:** If the flag is ever flipped back on, restart this clock.

---

## Shelved (no date — waiting on a decision, not a calendar)

### Practices
**From:** Addendum 06 §16 (v1.1), formally retired as a Rule feature by Addendum 09 §2
**What:** The "Practices" reframing of Routines.
**Why shelved:** It was specified as part of the Rule's v1.1, which is retired.
It only makes sense as part of a broader **Routines rethink**, which hasn't
happened. Routines are deliberately untouched and still shipping as daily
reminders. Don't build Practices in isolation.

### Block cards / three-state Today
**From:** Addendum 06 §16 (v1.1)
**Status:** **Retired, not deferred.** These died with the Rule module
(Addendum 09 §2) — listed here only so nobody resurrects them from the old spec.

---

## Carried features

### Voice for waiting + holder flips
**From:** Addendum 08 §8 (deliberately excluded), carried by Addendum 09
**What:** `"mark the proposal as waiting on Sam"` · `"rough cut for the M6 is back"`
**Why deferred:** Waiting and holder are one-tap UI actions and the taps are
cheap. Voice grammar is only worth it if the taps start feeling like friction.
Parser currently sits at 19 schema actions / 18 documented.

### Sunday idea strip
**Status:** **Superseded — do not build.** Addendum 08 §11 specced it for the
recap page; the recap page is retired, and Addendum 09 §5 moved the job into the
`ideas_aging` attention rule + Keep/Archive on the ideas index. Listed only to
close the loop.

---

## Library v2 (Phase 4c) — capabilities dropped in the redesign

The unified `/library` facet rail matches the v2 handoff exactly
(Type / Source / Tag / Needs-review / Status / Sort). These older list controls
weren't in that spec, so they were dropped in the rebuild. Data stays reachable
on the detail pages; re-add any of these as a facet if their absence is felt.

### Resurface (boosted / excluded) filter
**What:** The old notes/quotes/journal index pages each had a resurface chip
(off → boosted → excluded) to isolate starred-for-resurfacing or hidden items.
The unified view has no such facet; excluded (weight 0) items now appear inline
in the grid (they always showed in the old *default* view too — only the
isolation control is gone). Per-item boost still works on detail pages.
**Re-add:** thread a `?resurface=` selection into the notes/quotes/journal
`.list()` calls in `library/page.tsx` and expose a Source-group cycle chip.

### Per-card metadata: "via voice", annotation count, source ref / page
**What:** Old cards surfaced journal `via <source>`, quote `N thoughts`
(annotation_count), and quote `source_reference` / `p. N`. The v2 LibCard (and
the prototype it mirrors) omits these; `LibEntry` doesn't carry them.
**Re-add:** add the fields to `buildEntries` + `LibEntry` and render on the card.

### Book-scoped quote filter
**What:** The old quotes page had a book dropdown (`book_id`) to show one book's
highlights. Now reachable only via the book detail page.
**Re-add:** a Book facet group for `type === 'quote'` derived from books with
`quote_count > 0`.

### Everything-view Source vocabulary
**What:** On `type === 'all'` the Source facet uses the note vocabulary (as the
prototype does), so quote-only sources (podcast, sermon, …) aren't filterable
there and note/quote `other` share one chip. Switch to the Quotes type to filter
by quote source.
**Re-add:** union the two vocabularies (kind-namespaced) for the `all` scope.

### Client-side faceting ceiling (2000 rows/type)
**What:** The unified page fetches up to 2000 of each type and facets
client-side. Correct for the current corpus (~1500 quotes) but if any single
type ever exceeds 2000 rows, older matches fall outside the window.
**Re-add:** true server-side filtering / pagination, or push the active tag to
the `.list()` opts as the old pages did.

---

## Known bugs (pre-existing, found during Addendum 09 preflight)

### Parser prompt omits `create_person_interaction`
**Where:** `apps/api/src/lib/parser.ts` (action list ~lines 60–130)
**What:** The Zod schema and executor both support `create_person_interaction`
(19 actions), but the LLM system prompt documents only 18 — it's missing. The
action is therefore unreachable by voice despite being fully implemented.
**Why deferred:** Fixing it *changes voice behavior* — utterances that currently
fall through would start creating person interactions. Wants a deliberate yes.

### ~~`company_silent` measures days in UTC~~ — FIXED (63e3a8c)
Fixed while adding the per-company check-in cadence: `ruleCompanySilent` now
uses `formatInTz(new Date(c.last_interaction_at), ctx.tz)` instead of a UTC
`.slice(0,10)`. **Still open — the sibling `task_waiting_aging` `waiting_since`
slice** is a plain `date` column (not a tz bug); the `last_shipped_at` slice is
display-only. Nothing left to do here.

---

## Operational

### Build memory ceiling on the deploy box
**What:** `next build` peaks ~1.2–1.5 GB. The server was OOM-killed at 1 GB
(2026-07-23) and was upgraded to 2 GB. Mitigations live in
`apps/web/next.config.mjs` (`webpackMemoryOptimizations`, `cpus: 1`) and
`apps/web/package.json` (`--max-old-space-size=1024`).
**If it recurs:** build off-box and ship `.next` as an artifact. The server runs
the app fine at this size; it just can't always compile it. Also note typecheck
and lint are NOT part of the production build — `pnpm -r typecheck` before commit
is the only gate.
