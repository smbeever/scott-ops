-- ─────────────────────────────────────────────────────────────────────────
-- Scott Dashboard — consolidated Supabase schema
-- ─────────────────────────────────────────────────────────────────────────
--
-- Snapshot of the schema after migrations 0001..0045. Safe to run ONCE
-- against a fresh Supabase project (Project → SQL Editor → paste → Run).
--
-- If your project already stepped through the numbered migrations in
-- infrastructure/migrations/, do NOT run this file — you already have
-- the same schema.
--
-- What this file does:
--   1. Creates all tables (final column shape post-alters).
--   2. Creates indexes.
--   3. Installs the set_updated_at() trigger + attaches it.
--   4. Enables RLS + writes the authenticated-user-all policies.
--   5. Seeds stewardship_domains (9 domains + Inbox system domain),
--      app_settings (America/Chicago), and health_history (singleton).
--
-- What it does NOT do:
--   - Anything auth-related (Supabase handles auth.users itself).
--   - Storage buckets (you make those in the Supabase Storage UI).
--   - Google OAuth tokens (populated at runtime after /api/google/connect).
--
-- ─────────────────────────────────────────────────────────────────────────

-- Required extensions ─────────────────────────────────────────────────────
create extension if not exists pgcrypto;

-- set_updated_at trigger function ─────────────────────────────────────────
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;


-- ─────────────────────────────────────────────────────────────────────────
-- Core: stewardship domains
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists stewardship_domains (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text,
  fruit_definition text,
  failure_patterns jsonb not null default '[]'::jsonb,
  expected_cadence text,
  active boolean not null default true,
  is_system boolean not null default false,
  last_shipped_at timestamptz,
  -- Attention domain_stale config (Addendum 06). Auto-skipped when the domain
  -- has an Observations cadence rule. stale_days null → default 21.
  stale_enabled boolean not null default true,
  stale_days integer,
  -- Parked channel (Addendum 08): muted/collapsed on Work, distinct from
  -- active=false (which hides entirely).
  parked boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_stewardship_domains_updated_at on stewardship_domains;
create trigger trg_stewardship_domains_updated_at
  before update on stewardship_domains
  for each row execute function set_updated_at();


-- ─────────────────────────────────────────────────────────────────────────
-- Companies (Addendum 05) — created before people/projects which FK to it
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  domain_id uuid references stewardship_domains(id) on delete set null,
  relationship_type text check (relationship_type in
    ('active_client','past_client','prospect','vendor','partner','brand_deal','other')),
  website text,
  primary_email text,
  primary_phone text,
  notes text,
  first_engagement_at date,
  last_interaction_at timestamptz,
  next_review_at date,
  active boolean not null default true,
  -- Silent-client check-in cadence (migration 0045). Null → rule default 30.
  -- Only consulted for active_client companies by the company_silent rule.
  checkin_interval_days integer check (checkin_interval_days is null or checkin_interval_days > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_companies_domain on companies(domain_id);
create index if not exists idx_companies_active on companies(active) where active = true;
create index if not exists idx_companies_last_interaction
  on companies(last_interaction_at desc nulls last);
create unique index if not exists idx_companies_name_lower on companies(lower(name));

drop trigger if exists trg_companies_updated_at on companies;
create trigger trg_companies_updated_at
  before update on companies
  for each row execute function set_updated_at();


-- ─────────────────────────────────────────────────────────────────────────
-- People & relationships
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists people (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  relationship_type text check (relationship_type in
    ('client','family','church','friend','team','vendor','other')),
  email text,
  phone text,
  -- Legacy freeform company text (0001). Superseded by company_id; kept as a
  -- display fallback, to be dropped in a later cleanup migration.
  company text,
  company_id uuid references companies(id) on delete set null,
  role_at_company text,
  is_primary_contact boolean not null default false,
  birthday date,
  anniversary date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_people_name_lower on people (lower(name));
create index if not exists idx_people_company on people(company_id);
create unique index if not exists idx_people_one_primary_per_company
  on people(company_id) where is_primary_contact = true and company_id is not null;

drop trigger if exists trg_people_updated_at on people;
create trigger trg_people_updated_at
  before update on people
  for each row execute function set_updated_at();

create table if not exists person_facts (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people(id) on delete cascade,
  fact_type text not null check (fact_type in
    ('anniversary','birthday','kid_name','shared','follow_up','other')),
  fact_value text not null,
  source_ref text,
  date_relevant date,
  recurring boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_person_facts_person on person_facts(person_id);
create index if not exists idx_person_facts_type on person_facts(fact_type);
create index if not exists idx_person_facts_date on person_facts(date_relevant)
  where date_relevant is not null;

create table if not exists person_interactions (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people(id) on delete cascade,
  interaction_type text not null check (interaction_type in
    ('email','call','in_person','text','meeting','other')),
  direction text check (direction in ('inbound','outbound','internal')),
  subject text,
  body text,
  email_message_id text,
  captured_via text not null default 'manual' check (captured_via in
    ('email_forward','manual','voice')),
  notes text,
  occurred_at timestamptz not null default now()
);

create index if not exists idx_person_interactions_person_time
  on person_interactions(person_id, occurred_at desc);
create unique index if not exists idx_person_interactions_email_message_id_unique
  on person_interactions(email_message_id) where email_message_id is not null;


-- ─────────────────────────────────────────────────────────────────────────
-- Projects, milestones, activity
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  domain_id uuid references stewardship_domains(id) on delete set null,
  status text not null default 'active' check (status in
    ('active','paused','done','archived')),
  type text check (type in ('client','internal','content')),
  primary_contact_id uuid references people(id) on delete set null,
  company_id uuid references companies(id) on delete set null,
  quoted_hours numeric(8,2),
  hours_logged numeric(8,2) not null default 0,
  start_date date,
  target_date date,
  completed_at timestamptz,
  color text,
  engagement_type text not null default 'project' check (engagement_type in
    ('project','retainer')),
  kind text not null default 'project' check (kind in ('project','area')),
  -- Retainer cycle anchor (Addendum 08) — day-of-month the cycle resets.
  retainer_anchor_day int check (retainer_anchor_day between 1 and 31),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_projects_status on projects(status);
create index if not exists idx_projects_domain on projects(domain_id);
create index if not exists idx_projects_kind_status on projects(kind, status);
create index if not exists idx_projects_company on projects(company_id);

drop trigger if exists trg_projects_updated_at on projects;
create trigger trg_projects_updated_at
  before update on projects
  for each row execute function set_updated_at();

create table if not exists milestones (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  title text not null,
  status text not null default 'open' check (status in ('open','done')),
  weight integer not null default 1 check (weight > 0),
  position integer not null default 0,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_milestones_project_position
  on milestones(project_id, position);

create table if not exists activity_log (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references projects(id) on delete cascade,
  entry text not null,
  hours_logged numeric(6,2),
  logged_at timestamptz not null default now(),
  source text not null default 'manual' check (source in
    ('manual','voice','email','observation','import')),
  kind text not null default 'work' check (kind in ('work','update'))
);

create index if not exists idx_activity_log_project_time
  on activity_log(project_id, logged_at desc);

create table if not exists project_checklist_items (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  position integer not null default 0,
  title text not null,
  done boolean not null default false,
  done_at timestamptz,
  recurrence_rule text check (recurrence_rule in
    ('daily','weekdays','weekly','biweekly','monthly','yearly')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_project_checklist_items_project_position
  on project_checklist_items(project_id, position);

drop trigger if exists trg_project_checklist_items_updated_at on project_checklist_items;
create trigger trg_project_checklist_items_updated_at
  before update on project_checklist_items
  for each row execute function set_updated_at();

-- Additional project contacts beyond primary_contact_id (Addendum 05).
create table if not exists project_contacts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  person_id uuid not null references people(id) on delete cascade,
  role text,
  created_at timestamptz not null default now(),
  unique (project_id, person_id)
);

create index if not exists idx_project_contacts_project on project_contacts(project_id);
create index if not exists idx_project_contacts_person on project_contacts(person_id);


-- ─────────────────────────────────────────────────────────────────────────
-- Content pipeline (created before tasks so tasks.content_item_id resolves)
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists content_items (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  domain_id uuid references stewardship_domains(id) on delete set null,
  type text not null check (type in
    ('video','article','short_clip','podcast_episode','newsletter','course')),
  status text not null default 'idea' check (status in
    ('idea','outline','filming','editing','published','derivatives_pending','done')),
  outline_md text,
  video_url text,
  article_url text,
  published_at timestamptz,
  parent_id uuid references content_items(id) on delete set null,
  derivative_type text,
  -- Content Manager v2 (Addendum 07).
  meta jsonb not null default '{}'::jsonb,
  produced_on date,
  target_publish_date date,
  canonical_url text,
  platforms text[],
  body_rich text,
  -- Work Page (Addendum 08): holder + idea lifecycle.
  holder text not null default 'me' check (holder in ('me','editor')),
  holder_since timestamptz,
  archived_at timestamptz,
  idea_reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_content_items_domain_status
  on content_items(domain_id, status);
create index if not exists idx_content_items_parent on content_items(parent_id);

drop trigger if exists trg_content_items_updated_at on content_items;
create trigger trg_content_items_updated_at
  before update on content_items
  for each row execute function set_updated_at();

create table if not exists content_checklist_items (
  id uuid primary key default gen_random_uuid(),
  content_item_id uuid not null references content_items(id) on delete cascade,
  position integer not null default 0,
  title text not null,
  done boolean not null default false,
  done_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_content_checklist_items_content_position
  on content_checklist_items(content_item_id, position);

drop trigger if exists trg_content_checklist_items_updated_at on content_checklist_items;
create trigger trg_content_checklist_items_updated_at
  before update on content_checklist_items
  for each row execute function set_updated_at();

create table if not exists content_templates (
  id uuid primary key default gen_random_uuid(),
  channel text not null,
  trigger_status text not null,
  derivative_type text not null,
  title_template text not null,
  default_due_offset_days integer not null default 7,
  active boolean not null default true,
  created_at timestamptz not null default now()
);


-- ─────────────────────────────────────────────────────────────────────────
-- Tasks
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  notes text,
  status text not null default 'open' check (status in ('open','waiting','done')),
  -- Waiting state (Addendum 08): blocked on someone else. waiting_since drives
  -- the aging day-count.
  waiting_on text,
  waiting_since date,
  due_date date,
  due_time time,
  priority integer not null default 4 check (priority between 1 and 4),
  project_id uuid references projects(id) on delete set null,
  parent_task_id uuid references tasks(id) on delete cascade,
  content_item_id uuid references content_items(id) on delete set null,
  domain_id uuid not null references stewardship_domains(id),
  -- Optional link to one of the project's milestones (Addendum 08 drill-in).
  -- Null = "General". ON DELETE SET NULL parks tasks back under General when a
  -- milestone is removed. App enforces same-project ownership.
  milestone_id uuid references milestones(id) on delete set null,
  recurrence_rule text,
  reminder_offsets jsonb not null default '[]'::jsonb,
  reminders_sent jsonb not null default '{}'::jsonb,
  source text not null default 'manual' check (source in
    ('manual','voice','email','observation','import')),
  top3_for_date date,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists idx_tasks_status_due on tasks(status, due_date);
create index if not exists idx_tasks_project on tasks(project_id);
create index if not exists idx_tasks_parent on tasks(parent_task_id);
create index if not exists idx_tasks_domain on tasks(domain_id);
create index if not exists idx_tasks_top3 on tasks(top3_for_date)
  where top3_for_date is not null;
create index if not exists idx_tasks_content_item on tasks(content_item_id)
  where content_item_id is not null;
create index if not exists tasks_milestone_id_idx on tasks(milestone_id);

drop trigger if exists trg_tasks_updated_at on tasks;
create trigger trg_tasks_updated_at
  before update on tasks
  for each row execute function set_updated_at();


-- ─────────────────────────────────────────────────────────────────────────
-- Conversations (Addendum 05) — FKs company/person/project/task, so defined
-- after all four. Supersedes person_interactions (kept as read-only archive).
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id) on delete set null,
  person_id uuid references people(id) on delete set null,
  project_id uuid references projects(id) on delete set null,
  task_id uuid references tasks(id) on delete set null,
  interaction_type text not null check (interaction_type in
    ('email','call','text_message','social_dm','in_person','meeting','video_call','other')),
  direction text not null check (direction in ('inbound','outbound','internal')),
  subject text,
  summary text not null,
  body_excerpt text,
  email_message_id text,
  email_thread_id text,
  email_deep_link text,
  from_address text,
  to_addresses text[] not null default '{}',
  cc_addresses text[] not null default '{}',
  captured_via text not null default 'manual' check (captured_via in
    ('email_forward','manual','voice','import')),
  requires_followup boolean not null default false,
  followup_by date,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint conversations_has_association check (
    company_id is not null or person_id is not null
    or project_id is not null or task_id is not null
  )
);

create index if not exists idx_conversations_company on conversations(company_id);
create index if not exists idx_conversations_person on conversations(person_id);
create index if not exists idx_conversations_project on conversations(project_id);
create index if not exists idx_conversations_task on conversations(task_id);
create index if not exists idx_conversations_occurred_at on conversations(occurred_at desc);
create index if not exists idx_conversations_followup
  on conversations(requires_followup, followup_by) where requires_followup = true;
create unique index if not exists idx_conversations_email_message_id
  on conversations(email_message_id) where email_message_id is not null;

create or replace function conversations_touch_associations() returns trigger as $$
begin
  if new.company_id is not null then
    update companies
       set last_interaction_at = greatest(coalesce(last_interaction_at, new.occurred_at), new.occurred_at)
     where id = new.company_id;
  end if;
  if new.person_id is not null then
    update people set updated_at = now() where id = new.person_id;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_conversations_touch on conversations;
create trigger trg_conversations_touch
  after insert on conversations
  for each row execute function conversations_touch_associations();


-- ─────────────────────────────────────────────────────────────────────────
-- Calendar
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists calendar_events (
  id uuid primary key default gen_random_uuid(),
  google_event_id text unique,
  title text not null,
  description text,
  start_at timestamptz not null,
  end_at timestamptz not null,
  all_day boolean not null default false,
  location text,
  attendees jsonb not null default '[]'::jsonb,
  source text not null default 'google' check (source in ('google','created_here')),
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_calendar_events_start on calendar_events(start_at);

drop trigger if exists trg_calendar_events_updated_at on calendar_events;
create trigger trg_calendar_events_updated_at
  before update on calendar_events
  for each row execute function set_updated_at();


-- ─────────────────────────────────────────────────────────────────────────
-- Checklists (generic, template-based)
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists checklist_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  domain_id uuid references stewardship_domains(id) on delete set null,
  description text,
  items jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists checklist_instances (
  id uuid primary key default gen_random_uuid(),
  template_id uuid references checklist_templates(id) on delete set null,
  name text not null,
  linked_to_type text check (linked_to_type in ('project','event','standalone')),
  linked_to_id uuid,
  items jsonb not null default '[]'::jsonb,
  due_date date,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_checklist_instances_linked
  on checklist_instances(linked_to_type, linked_to_id);


-- ─────────────────────────────────────────────────────────────────────────
-- Books, quotes, quote annotations
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists books (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  author text,
  isbn text,
  cover_image_url text,
  status text not null default 'want_to_read' check (status in
    ('reading','finished','abandoned','want_to_read')),
  format text check (format in ('physical','kindle','audiobook')),
  started_at date,
  finished_at date,
  rating integer check (rating between 1 and 5),
  my_summary text,
  created_at timestamptz not null default now()
);

create table if not exists quotes (
  id uuid primary key default gen_random_uuid(),
  book_id uuid references books(id) on delete set null,
  text text not null,
  page_number integer,
  chapter text,
  source_type text check (source_type in
    ('book','article','podcast','sermon','video','conversation','other')),
  source_reference text,
  source_url text,
  source_author text,
  tags text[] not null default '{}',
  added_via text not null default 'manual' check (added_via in
    ('voice','readwise_import','manual','journal_extraction')),
  last_surfaced_at timestamptz,
  resurface_weight numeric not null default 1.0 check (resurface_weight >= 0),
  created_at timestamptz not null default now()
);

create index if not exists idx_quotes_tags on quotes using gin(tags);
create index if not exists idx_quotes_last_surfaced
  on quotes(last_surfaced_at nulls first);

create table if not exists quote_annotations (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references quotes(id) on delete cascade,
  body text not null,
  annotated_at timestamptz not null default now(),
  context text default 'unspecified' check (context in
    ('on_capture','on_revisit','on_surface','unspecified')),
  tags text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_quote_annotations_quote_time
  on quote_annotations(quote_id, annotated_at desc);
create index if not exists idx_quote_annotations_tags
  on quote_annotations using gin(tags);

drop trigger if exists trg_quote_annotations_updated_at on quote_annotations;
create trigger trg_quote_annotations_updated_at
  before update on quote_annotations
  for each row execute function set_updated_at();


-- ─────────────────────────────────────────────────────────────────────────
-- Journal
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists journal_books (
  id uuid primary key default gen_random_uuid(),
  book_number integer not null unique,
  start_date date,
  end_date date,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists journal_entries (
  id uuid primary key default gen_random_uuid(),
  book_id uuid references journal_books(id) on delete set null,
  entry_date date not null,
  image_path text,
  transcription_text text,
  source text not null default 'typed' check (source in
    ('handwritten_photo','voice','typed')),
  tags text[] not null default '{}',
  extracted_facts jsonb not null default '{}'::jsonb,
  attachments jsonb not null default '[]'::jsonb,
  resurface_weight numeric not null default 1.0 check (resurface_weight >= 0),
  created_at timestamptz not null default now()
);

create index if not exists idx_journal_entries_date
  on journal_entries(entry_date desc);
create index if not exists idx_journal_entries_tags
  on journal_entries using gin(tags);
create index if not exists idx_journal_entries_attachments
  on journal_entries using gin(attachments);


-- ─────────────────────────────────────────────────────────────────────────
-- Notes (references quotes for related_quote_id)
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists notes (
  id uuid primary key default gen_random_uuid(),
  body text not null,
  title text,
  source_type text not null default 'own_thought' check (source_type in
    ('own_thought','reading_response','meeting_note','brainstorm','observation','other')),
  source_reference text,
  related_quote_id uuid references quotes(id) on delete set null,
  needs_review boolean not null default false,
  tags text[] not null default '{}',
  related_project_id uuid references projects(id) on delete set null,
  related_person_id uuid references people(id) on delete set null,
  attachments jsonb not null default '[]'::jsonb,
  resurface_weight numeric not null default 1.0 check (resurface_weight >= 0),
  created_at timestamptz not null default now()
);

create index if not exists idx_notes_tags on notes using gin(tags);
create index if not exists idx_notes_title on notes(title) where title is not null;
create index if not exists idx_notes_source_type on notes(source_type);
create index if not exists idx_notes_needs_review on notes(needs_review) where needs_review = true;
create index if not exists idx_notes_related_quote on notes(related_quote_id)
  where related_quote_id is not null;
create index if not exists idx_notes_attachments on notes using gin(attachments);


-- ─────────────────────────────────────────────────────────────────────────
-- Inventory
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists inventory_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  default_depreciation_rate numeric(5,4),
  insurance_relevant boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists inventory_items (
  id uuid primary key default gen_random_uuid(),
  category text not null,
  brand text,
  model text,
  serial_number text,
  purchase_date date,
  purchase_price numeric(12,2),
  purchase_source text,
  current_value_estimate numeric(12,2),
  value_updated_at timestamptz,
  status text not null default 'owned' check (status in
    ('owned','sold','lost','damaged','loaned')),
  sold_date date,
  sold_price numeric(12,2),
  sold_to text,
  photos jsonb not null default '[]'::jsonb,
  receipts jsonb not null default '[]'::jsonb,
  location text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_inventory_items_category on inventory_items(category);
create index if not exists idx_inventory_items_status on inventory_items(status);

drop trigger if exists trg_inventory_items_updated_at on inventory_items;
create trigger trg_inventory_items_updated_at
  before update on inventory_items
  for each row execute function set_updated_at();


-- ─────────────────────────────────────────────────────────────────────────
-- Notifications, observations, action log, email rules, resurfacing seen
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  title text not null,
  body text,
  source_ref text,
  source_url text,
  status text not null default 'unread' check (status in
    ('unread','read','dismissed')),
  undo_payload jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_notifications_status_time
  on notifications(status, created_at desc);

create table if not exists observations (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  severity text not null default 'info' check (severity in
    ('info','notable','concerning')),
  title text not null,
  body text,
  supporting_data jsonb not null default '{}'::jsonb,
  domain_id uuid references stewardship_domains(id) on delete set null,
  project_id uuid references projects(id) on delete set null,
  surfaced_at timestamptz not null default now(),
  dismissed_at timestamptz,
  acted_on boolean not null default false
);

create index if not exists idx_observations_active
  on observations(surfaced_at desc)
  where dismissed_at is null;

-- Attention Engine items (Addendum 05) — no FKs; source_id points at
-- whichever table source_type names. Regenerated daily by the attention cron.
create table if not exists attention_items (
  id uuid primary key default gen_random_uuid(),
  rule_type text not null,
  source_type text not null check (source_type in
    ('person','company','domain','project','conversation','task','content')),
  source_id uuid not null,
  title text not null,
  detail text,
  suggested_action text,
  score numeric not null default 0,
  urgency text not null check (urgency in ('low','normal','high')),
  first_surfaced_at timestamptz not null default now(),
  last_surfaced_at timestamptz not null default now(),
  surface_count integer not null default 1,
  status text not null default 'active' check (status in
    ('active','dismissed','snoozed','acted_on','expired')),
  snoozed_until date,
  dismissed_at timestamptz,
  acted_on_at timestamptz,
  acted_on_action text,
  dedup_key text not null unique,
  created_at timestamptz not null default now()
);

create index if not exists idx_attention_active
  on attention_items(status, score desc) where status = 'active';
create index if not exists idx_attention_snoozed
  on attention_items(status, snoozed_until) where status = 'snoozed';
create index if not exists idx_attention_source
  on attention_items(source_type, source_id);

create table if not exists action_log (
  id uuid primary key default gen_random_uuid(),
  action_type text not null,
  target_system text not null check (target_system in
    ('drive','gmail','calendar','internal','anthropic')),
  description text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'success' check (status in
    ('success','failed','pending','undone')),
  triggered_by text not null,
  executed_at timestamptz not null default now()
);

create index if not exists idx_action_log_time on action_log(executed_at desc);

create table if not exists email_rules (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  match_criteria jsonb not null default '{}'::jsonb,
  action_type text not null check (action_type in
    ('move_attachments_to_drive','create_task','notify_only','extract_to_inbox','tag')),
  action_params jsonb not null default '{}'::jsonb,
  confidence_state text not null default 'draft' check (confidence_state in
    ('draft','learning','auto')),
  confirmation_count integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists resurfacing_seen (
  id uuid primary key default gen_random_uuid(),
  item_type text not null check (item_type in
    ('journal','quote','verse','win','note','project_milestone')),
  item_id uuid not null,
  surfaced_on date not null default current_date,
  user_response text check (user_response in ('viewed','dismissed','saved')),
  unique (item_type, item_id, surfaced_on)
);


-- ─────────────────────────────────────────────────────────────────────────
-- Captured data (webhook/voice/watch ingest firehose)
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists captured_data (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in
    ('zapier','cowork','n8n','manual','webhook','smart_glasses','watch','other')),
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  tags text[] not null default '{}',
  display_hint text not null default 'log' check (display_hint in
    ('card','log','hidden')),
  processed_status text not null default 'raw' check (processed_status in
    ('raw','parsed','displayed','archived')),
  source_ref text,
  created_at timestamptz not null default now()
);

create index if not exists idx_captured_data_type_time
  on captured_data(type, created_at desc);
create index if not exists idx_captured_data_tags
  on captured_data using gin(tags);


-- ─────────────────────────────────────────────────────────────────────────
-- Email capture (SendGrid Inbound Parse — Addendum 04)
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists capture_email_addresses (
  id uuid primary key default gen_random_uuid(),
  address text not null unique,
  slug text not null,
  label text not null default 'Primary Capture',
  active boolean not null default true,
  rate_limit_per_hour integer not null default 100
    check (rate_limit_per_hour > 0),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create unique index if not exists idx_capture_email_addresses_single_active
  on capture_email_addresses(active) where active = true;

create table if not exists capture_sender_allowlist (
  id uuid primary key default gen_random_uuid(),
  email_address text not null,
  label text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create unique index if not exists idx_capture_sender_allowlist_email_unique
  on capture_sender_allowlist(lower(email_address));
create index if not exists idx_capture_sender_allowlist_active
  on capture_sender_allowlist(active) where active = true;

create table if not exists email_capture_log (
  id uuid primary key default gen_random_uuid(),
  received_at timestamptz not null default now(),
  from_address text,
  to_address text,
  subject text,
  status text not null check (status in (
    'processed','rejected_sender','rejected_spam',
    'rejected_no_active_address','parse_error','rate_limited'
  )),
  actions_created jsonb not null default '[]'::jsonb,
  error_message text,
  raw_payload jsonb not null default '{}'::jsonb
);

create index if not exists idx_email_capture_log_received_desc
  on email_capture_log(received_at desc);
create index if not exists idx_email_capture_log_status
  on email_capture_log(status);
create index if not exists idx_email_capture_log_from
  on email_capture_log(lower(from_address));


-- ─────────────────────────────────────────────────────────────────────────
-- Google OAuth (service-role only; RLS enabled without policies)
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists google_oauth_tokens (
  id uuid primary key default gen_random_uuid(),
  access_token text not null,
  refresh_token text,
  expires_at timestamptz not null,
  scope text not null,
  token_type text not null default 'Bearer',
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_google_oauth_tokens_updated_at on google_oauth_tokens;
create trigger trg_google_oauth_tokens_updated_at
  before update on google_oauth_tokens
  for each row execute function set_updated_at();


-- ─────────────────────────────────────────────────────────────────────────
-- App settings (singleton)
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists app_settings (
  id boolean primary key default true check (id),
  timezone text not null default 'America/Chicago',
  -- Feature flags (Addendum 05) — one typed boolean column per flag.
  health_module_enabled boolean not null default false,
  -- Routines module (Addendum 06). Default true; toggle off once Practices
  -- (v1.1) replaces it. Data retained when off.
  routines_module_enabled boolean not null default true,
  -- Daily Rule module (Addendum 06), RETIRED by Addendum 09. Default false —
  -- born off. Gates /shutdown, /recap, /hedge, the Rule API, the 4pm/8:30pm
  -- pushes, the Today re-entry strip and the keystone badge. Data retained.
  rule_module_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_app_settings_updated_at on app_settings;
create trigger trg_app_settings_updated_at
  before update on app_settings
  for each row execute function set_updated_at();


-- ─────────────────────────────────────────────────────────────────────────
-- Routines
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists routines (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  position integer not null default 0,
  active boolean not null default true,
  time_of_day text not null default 'anytime' check (time_of_day in
    ('morning','afternoon','evening','anytime')),
  specific_time time,
  reminder_enabled boolean not null default false,
  last_reminder_sent_date date,
  last_missed_sent_date date,
  goal_days integer check (goal_days is null or goal_days > 0),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_routines_active_position
  on routines(active, position) where active = true;
create index if not exists idx_routines_reminder_time
  on routines(specific_time)
  where active = true and reminder_enabled = true and specific_time is not null;
create index if not exists idx_routines_archived
  on routines(archived_at desc) where archived_at is not null;

drop trigger if exists trg_routines_updated_at on routines;
create trigger trg_routines_updated_at
  before update on routines
  for each row execute function set_updated_at();

create table if not exists routine_completions (
  id uuid primary key default gen_random_uuid(),
  routine_id uuid not null references routines(id) on delete cascade,
  completed_date date not null,
  created_at timestamptz not null default now(),
  unique (routine_id, completed_date)
);

create index if not exists idx_routine_completions_routine_date
  on routine_completions(routine_id, completed_date desc);
create index if not exists idx_routine_completions_date
  on routine_completions(completed_date);


-- ─────────────────────────────────────────────────────────────────────────
-- Health subsystem
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists health_visits (
  id uuid primary key default gen_random_uuid(),
  visit_date date not null,
  provider_name text,
  provider_specialty text,
  visit_type text check (visit_type in
    ('annual','sick','specialist','follow_up','lab','imaging',
     'urgent_care','emergency','telehealth','other')),
  reason text,
  assessment text,
  plan text,
  notes text,
  follow_up_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_health_visits_date on health_visits(visit_date desc);

drop trigger if exists trg_health_visits_updated_at on health_visits;
create trigger trg_health_visits_updated_at
  before update on health_visits
  for each row execute function set_updated_at();

create table if not exists health_metrics (
  id uuid primary key default gen_random_uuid(),
  measured_at timestamptz not null,
  metric text not null,
  value numeric,
  value_secondary numeric,
  unit text,
  source text not null default 'manual' check (source in
    ('manual','garmin','apple_health','google_health','whoop','oura','other')),
  visit_id uuid references health_visits(id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_health_metrics_metric_time
  on health_metrics(metric, measured_at desc);
create index if not exists idx_health_metrics_source on health_metrics(source);
create index if not exists idx_health_metrics_visit on health_metrics(visit_id)
  where visit_id is not null;

drop trigger if exists trg_health_metrics_updated_at on health_metrics;
create trigger trg_health_metrics_updated_at
  before update on health_metrics
  for each row execute function set_updated_at();

create table if not exists lab_panels (
  id uuid primary key default gen_random_uuid(),
  drawn_date date not null,
  panel_name text not null,
  ordering_provider text,
  lab_facility text,
  notes text,
  visit_id uuid references health_visits(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_lab_panels_date on lab_panels(drawn_date desc);
create index if not exists idx_lab_panels_visit on lab_panels(visit_id)
  where visit_id is not null;

drop trigger if exists trg_lab_panels_updated_at on lab_panels;
create trigger trg_lab_panels_updated_at
  before update on lab_panels
  for each row execute function set_updated_at();

create table if not exists lab_results (
  id uuid primary key default gen_random_uuid(),
  panel_id uuid not null references lab_panels(id) on delete cascade,
  analyte text not null,
  value numeric,
  value_text text,
  unit text,
  reference_range_low numeric,
  reference_range_high numeric,
  reference_text text,
  flag text check (flag in ('low','high','critical_low','critical_high','abnormal')),
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists idx_lab_results_panel on lab_results(panel_id);
create index if not exists idx_lab_results_analyte on lab_results(analyte);

create table if not exists wellbeing_check_ins (
  id uuid primary key default gen_random_uuid(),
  checked_in_at timestamptz not null default now(),
  mood smallint check (mood between 1 and 5),
  energy smallint check (energy between 1 and 5),
  sleep_quality smallint check (sleep_quality between 1 and 5),
  pain smallint check (pain between 0 and 10),
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists idx_wellbeing_check_ins_time
  on wellbeing_check_ins(checked_in_at desc);

create table if not exists medications (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kind text not null default 'prescription' check (kind in
    ('prescription','supplement','vitamin','otc')),
  dosage text,
  frequency text,
  prescribing_provider text,
  reason text,
  start_date date,
  stop_date date,
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_medications_kind_active
  on medications(kind, active) where active = true;

drop trigger if exists trg_medications_updated_at on medications;
create trigger trg_medications_updated_at
  before update on medications
  for each row execute function set_updated_at();

create table if not exists health_documents (
  id uuid primary key default gen_random_uuid(),
  storage_path text not null,
  filename text not null,
  mime_type text not null,
  size_bytes bigint,
  document_type text check (document_type in
    ('lab_report','imaging_report','visit_summary','discharge_summary',
     'prescription','vaccination_record','insurance','other')),
  document_date date,
  visit_id uuid references health_visits(id) on delete set null,
  panel_id uuid references lab_panels(id) on delete set null,
  notes text,
  ocr_status text check (ocr_status in ('pending','parsed','reviewed','skipped')),
  ocr_extracted jsonb,
  uploaded_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_health_documents_visit on health_documents(visit_id)
  where visit_id is not null;
create index if not exists idx_health_documents_panel on health_documents(panel_id)
  where panel_id is not null;
create index if not exists idx_health_documents_uploaded
  on health_documents(uploaded_at desc);

drop trigger if exists trg_health_documents_updated_at on health_documents;
create trigger trg_health_documents_updated_at
  before update on health_documents
  for each row execute function set_updated_at();

create table if not exists workouts (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null,
  ended_at timestamptz,
  duration_min numeric,
  activity_type text,
  distance_m numeric,
  avg_hr smallint,
  max_hr smallint,
  calories integer,
  elevation_gain_m numeric,
  pace_sec_per_km numeric,
  power_avg_watts numeric,
  source text not null default 'manual' check (source in
    ('manual','garmin','apple_health','google_health','whoop','strava','other')),
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists idx_workouts_started on workouts(started_at desc);
create index if not exists idx_workouts_type_time
  on workouts(activity_type, started_at desc);

create table if not exists health_history (
  id boolean primary key default true check (id),
  narrative text,
  conditions jsonb not null default '[]'::jsonb,
  surgeries jsonb not null default '[]'::jsonb,
  allergies jsonb not null default '[]'::jsonb,
  immunizations jsonb not null default '[]'::jsonb,
  family_history jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_health_history_updated_at on health_history;
create trigger trg_health_history_updated_at
  before update on health_history
  for each row execute function set_updated_at();


-- ─────────────────────────────────────────────────────────────────────────
-- The Daily Rule Module (Addendum 06)
-- ─────────────────────────────────────────────────────────────────────────

-- One row per day, scored at that evening's shutdown. Win RATE only, never a
-- streak. The Attention Engine never reads these tables.
create table if not exists daily_scores (
  date date primary key,
  night_held boolean,
  morning_block boolean,
  keystone_done boolean,
  lines_held boolean,
  present_home boolean,
  keystone_task_id uuid references tasks(id) on delete set null,
  keystone_done_means text,
  reentry_time time not null default '17:00',
  day_type text check (day_type in ('client','content')),
  note text,
  submitted_at timestamptz,
  -- Keyed off keystone_done_means (never nulled) so deleting the keystone
  -- task later can't retroactively flip a lost day to won. See migration 0036.
  won boolean generated always as (
    case
      when keystone_done_means is null then
        ((night_held::int + morning_block::int + lines_held::int + present_home::int) >= 3)
      else
        ((night_held::int + morning_block::int + keystone_done::int + lines_held::int + present_home::int) >= 4)
    end
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_daily_scores_updated_at on daily_scores;
create trigger trg_daily_scores_updated_at
  before update on daily_scores
  for each row execute function set_updated_at();

create table if not exists hedge_logs (
  id uuid primary key default gen_random_uuid(),
  ts timestamptz not null default now(),
  description text not null,
  commitment_avoided text,
  pivot_taken boolean not null default false,
  created_via text not null check (created_via in ('voice','ui')) default 'ui',
  created_at timestamptz not null default now()
);

create table if not exists rule_pauses (
  id uuid primary key default gen_random_uuid(),
  start_date date not null,
  end_date date not null,
  reason text not null,
  declared_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists idx_hedge_logs_ts on hedge_logs(ts desc);
create index if not exists idx_rule_pauses_range on rule_pauses(start_date, end_date);

-- Once-per-day claim rows for the sanctioned pushes (4 PM / 8:30 PM).
create table if not exists rule_push_log (
  push_type text not null,
  local_date date not null,
  sent_at timestamptz not null default now(),
  primary key (push_type, local_date)
);

-- One free-text reflection per week, keyed by the week's Monday (Addendum 06).
create table if not exists weekly_reflections (
  week_start date primary key,
  reflection text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_weekly_reflections_updated_at on weekly_reflections;
create trigger trg_weekly_reflections_updated_at
  before update on weekly_reflections
  for each row execute function set_updated_at();

-- Tomorrow's Focus (Addendum 09) — one optional pointer per day at a project or
-- content item. Replaces the retired task-level keystone. No status column, no
-- completion column: nothing counts, scores, or displays adherence to it, ever.
-- target_id has no FK because it spans two tables (see target_type); the app
-- validates it on write and reads tolerate a vanished target.
create table if not exists daily_focus (
  date date primary key,
  target_type text not null check (target_type in ('project','content_item')),
  target_id uuid not null,
  note text,
  created_at timestamptz not null default now()
);


-- ─────────────────────────────────────────────────────────────────────────
-- Row-Level Security
-- ─────────────────────────────────────────────────────────────────────────
--
-- Every user table gets an "authenticated users can do everything" policy.
-- google_oauth_tokens has RLS enabled with NO policy — so only the API
-- server (using the service-role key) can touch it.
-- ─────────────────────────────────────────────────────────────────────────

do $$
declare
  t text;
  policy_tables text[] := array[
    'stewardship_domains','companies','people','person_facts','person_interactions',
    'projects','project_contacts','milestones','activity_log','project_checklist_items',
    'tasks','calendar_events','checklist_templates','checklist_instances',
    'content_items','content_checklist_items','content_templates',
    'journal_books','journal_entries','notes',
    'books','quotes','quote_annotations',
    'inventory_categories','inventory_items',
    'notifications','observations','attention_items','action_log','email_rules',
    'resurfacing_seen','captured_data','conversations',
    'capture_email_addresses','capture_sender_allowlist','email_capture_log',
    'app_settings','routines','routine_completions',
    'health_visits','health_metrics','lab_panels','lab_results',
    'wellbeing_check_ins','medications','health_documents','workouts',
    'health_history',
    'daily_scores','hedge_logs','rule_pauses','rule_push_log','weekly_reflections',
    'daily_focus'
  ];
begin
  foreach t in array policy_tables loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_authenticated_all', t);
    execute format(
      'create policy %I on %I for all to authenticated using (true) with check (true)',
      t || '_authenticated_all', t
    );
  end loop;

  -- Service-role only: RLS on, no policies.
  execute 'alter table google_oauth_tokens enable row level security';
end $$;


-- ─────────────────────────────────────────────────────────────────────────
-- Seed data
-- ─────────────────────────────────────────────────────────────────────────

-- No starter stewardship domains are seeded here on purpose — Jerad's
-- original seed rows named his own businesses and YouTube channels
-- (Hill Media Group, Site Nitro, Tech With Jerad, etc.), which don't
-- carry over to a new install. Add your own domains from Settings once
-- you're signed in, or insert rows here before running this file.

-- Inbox: system domain used when a task has no natural home
-- (added in migration 0026). UUID is hardcoded — packages/shared/src/
-- constants/domains.ts and several API paths reference it directly.
-- Do not change this UUID.
insert into stewardship_domains (id, name, description, fruit_definition, failure_patterns, expected_cadence, is_system)
values (
  'acf035ee-b247-4c96-a07e-5946bc2b2e91',
  'Inbox',
  'Unsorted tasks awaiting a real home',
  null,
  '[]'::jsonb,
  null,
  true
) on conflict (name) do nothing;

-- App settings singleton (from migration 0022).
insert into app_settings (id, timezone) values (true, 'America/Chicago')
on conflict (id) do nothing;

-- Health history singleton (from migration 0024).
insert into health_history (id) values (true) on conflict (id) do nothing;


-- ─────────────────────────────────────────────────────────────────────────
-- Done.
-- ─────────────────────────────────────────────────────────────────────────
