-- GAS Studio — Neon Postgres schema (Phase 1).
-- Source of truth for the relational + RAG data model. Compiled from the pivot
-- specs: architecture.md, brains.md, cost-controls.md, compliance.md,
-- production-pipeline.md. Apply once Neon is provisioned (see scripts/migrate).
--
-- Principles: client_id is the tenancy/brain key on everything that holds a
-- client's data; prices live in rate_card (never in code); embeddings are
-- vector(1024) to match Voyage voyage-3.5.

create extension if not exists vector;

-- ── People ───────────────────────────────────────────────────────────────────
create table if not exists users (
  id          uuid primary key default gen_random_uuid(),
  email       text unique not null,
  name        text,
  role        text not null default 'producer',  -- 'super_admin' | 'admin' | 'producer'
  display_currency text default 'ZAR',
  show_both   boolean default true,
  created_at  timestamptz not null default now()
);

-- ── Clients (a.k.a. "brains") ─────────────────────────────────────────────────
create table if not exists clients (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  slug               text unique not null,
  status             text not null default 'active',
  brand              jsonb default '{}'::jsonb,          -- logo_url, colors, fonts, lower_third
  sonic_identity     jsonb default '{}'::jsonb,          -- music style descriptor / finetune id
  voice_id           text,                               -- ElevenLabs
  heygen_avatar_id   text,                               -- HeyGen
  higgsfield_soul_id text,                               -- Higgsfield Soul 2.0
  default_currency   text default 'ZAR',
  website            text,                                -- the client's OWN official site; the ground-truth anchor the intel desks stay inside
  created_at         timestamptz not null default now()
);
alter table clients add column if not exists website text;
alter table clients add column if not exists websites jsonb;   -- additional official sites (some clients run several)
alter table clients add column if not exists socials jsonb not null default '[]'::jsonb;   -- the client's official social accounts (FB/IG/TikTok/LinkedIn/YouTube/X), mined by the Researcher
alter table clients add column if not exists research_weekly boolean not null default false;   -- weekly auto-run of the Researcher (Mon 08:30 SAST); OFF by default so no spend happens without opting in
alter table clients add column if not exists owner_context text;   -- when the subject is a product/brand owned by a parent (e.g. egifts24 owned by StellR): the Researcher researches the parent for context but attributes its people/numbers to the parent
alter table clients add column if not exists brand_palette jsonb;   -- the client's CI palette {primary,dark} read intelligently from their website (a homepage screenshot -> vision), cached so the proposal wears the same real brand colours every render; refreshed if empty. A manual accent override still wins per render.
alter table clients add column if not exists channels text[];   -- the media channels the team selects on the Strategist (Facebook/Instagram/TikTok/Google Display/LinkedIn); steers the strategy AND locks the proposal's channel plan + audience targeting to these. NULL/empty = no restriction (model uses judgement).

create table if not exists client_profiles (
  id                  uuid primary key default gen_random_uuid(),
  client_id           uuid not null references clients(id) on delete cascade,
  version             int not null default 1,
  positioning         text,
  audience            jsonb default '{}'::jsonb,
  banned_words        text[] default '{}',
  tone_rules          text,
  proof_points        jsonb default '[]'::jsonb,
  outcome_definitions text,
  exemplars           jsonb default '[]'::jsonb,
  is_live             boolean not null default false,    -- human-approved before use
  created_at          timestamptz not null default now()
);
create index if not exists idx_client_profiles_client on client_profiles(client_id);

-- ── Knowledge / RAG ───────────────────────────────────────────────────────────
create table if not exists knowledge_sources (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid not null references clients(id) on delete cascade,
  type           text not null,                          -- 'website' | 'gsheet'
  uri            text not null,                          -- url, or Google Sheet id
  status         text not null default 'pending',        -- pending | indexed | failed
  last_synced_at timestamptz
);
create index if not exists idx_knowledge_sources_client on knowledge_sources(client_id);

create table if not exists knowledge_chunks (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references clients(id) on delete cascade,
  source_id  uuid references knowledge_sources(id) on delete cascade,
  content    text not null,
  embedding  vector(1024),                               -- Voyage voyage-3.5
  metadata   jsonb default '{}'::jsonb,                  -- { title, url, tags[] }
  created_at timestamptz not null default now()
);
create index if not exists idx_knowledge_chunks_client on knowledge_chunks(client_id);
create index if not exists idx_knowledge_chunks_embedding
  on knowledge_chunks using hnsw (embedding vector_cosine_ops);

-- ── Productions (the video runs) ──────────────────────────────────────────────
create table if not exists productions (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references clients(id) on delete cascade,
  created_by      uuid references users(id),
  title           text,
  brief           jsonb default '{}'::jsonb,             -- topic, segment, toggles, tier, voice mode, aspect_ratio
  plan            jsonb default '{}'::jsonb,             -- script, scenes, captions, popups, audio_map
  duration_target int not null default 45,               -- 15 | 30 | 45 | 60
  status          text not null default 'draft',
  -- draft | estimating | awaiting_approval | rendering_draft | draft_ready
  -- | awaiting_final_approval | rendering_final | qa_review | complete | failed | cancelled
  estimate_cents  int,
  actual_cents    int,
  fx_rate_snapshot numeric,
  display_currency text,
  draft_video_url text,
  final_video_url text,
  created_at      timestamptz not null default now()
);
create index if not exists idx_productions_client on productions(client_id);

create table if not exists production_steps (
  id            uuid primary key default gen_random_uuid(),
  production_id uuid not null references productions(id) on delete cascade,
  stage         text not null,   -- tts|music|ambient|aroll|broll|assemble_draft|assemble_final|script|...
  provider      text,
  model         text,
  units         numeric,
  cost_cents    int,
  output_ref    text,
  status        text not null default 'pending',
  started_at    timestamptz,
  finished_at   timestamptz
);
create index if not exists idx_production_steps_prod on production_steps(production_id);

-- ── Cost controls ─────────────────────────────────────────────────────────────
-- Prices live HERE, never in code. Versioned via effective_from.
create table if not exists rate_card (
  id                  uuid primary key default gen_random_uuid(),
  provider            text not null,
  model               text,
  unit                text not null,   -- char | second | clip | render_minute | minute | token | image
  resolution          text,
  price_cents_per_unit numeric not null,
  effective_from      timestamptz not null default now(),
  active              boolean not null default true
);

create table if not exists budgets (
  id          uuid primary key default gen_random_uuid(),
  scope       text not null,           -- 'user' | 'client' | 'team'
  scope_id    text,
  period      text not null default 'monthly',
  limit_cents int not null,
  spent_cents int not null default 0,
  hard_gate   boolean not null default true,
  currency    text default 'ZAR',
  created_at  timestamptz not null default now()
);

create table if not exists fx_rates (
  base       text not null,
  quote      text not null,
  rate       numeric not null,
  fetched_at timestamptz not null default now(),
  primary key (base, quote, fetched_at)
);

-- ── Learning loop (Iteration 2 — schema seams now) ────────────────────────────
create table if not exists published_assets (
  id            uuid primary key default gen_random_uuid(),
  production_id uuid references productions(id) on delete set null,
  client_id     uuid not null references clients(id) on delete cascade,
  platform      text,                  -- facebook | tiktok | x | linkedin
  url           text,
  segment       text,
  posted_at     timestamptz
);
create index if not exists idx_published_assets_client on published_assets(client_id);

create table if not exists performance_metrics (
  id          uuid primary key default gen_random_uuid(),
  asset_id    uuid not null references published_assets(id) on delete cascade,
  platform    text,
  metric      text,                    -- retention | ctr | engagement | conversions
  value       numeric,
  captured_at timestamptz not null default now()
);

-- ── Compliance: consent (POPIA / GDPR) ────────────────────────────────────────
create table if not exists consent_texts (
  id             uuid primary key default gen_random_uuid(),
  version        int not null,
  body           text not null,
  effective_from timestamptz not null default now(),
  active         boolean not null default true
);

create table if not exists consents (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid references clients(id) on delete set null,
  influencer_ref  text,
  subject_name    text not null,
  subject_email   text,
  data_type       text not null,        -- 'image' | 'voice'
  scope           text not null,
  lawful_basis    text not null default 'consent',
  consent_text_id uuid not null references consent_texts(id),
  granted_by      uuid not null references users(id),
  granted_at      timestamptz not null default now(),  -- date + time + tz (audit requirement)
  status          text not null default 'active',      -- 'active' | 'withdrawn'
  withdrawn_at    timestamptz
);
create index if not exists idx_consents_client on consents(client_id);

-- ── Connect Tools: per-tenant credential vault ────────────────────────────────
-- v1 has one tenant ('gas'); tenant column is the multi-tenant seam (Iteration 2).
-- Secrets are AES-256-GCM encrypted at rest (lib/crypto). Never returned to the client.
create table if not exists connections (
  id               uuid primary key default gen_random_uuid(),
  tenant           text not null default 'gas',
  provider         text not null,   -- anthropic | voyage | firecrawl | elevenlabs | heygen | higgsfield | magnific | shotstack
  secret_encrypted text,
  status           text not null default 'connected',
  metadata         jsonb default '{}'::jsonb,
  updated_at       timestamptz not null default now(),
  unique (tenant, provider)
);

-- ── Influencers (reusable identities; built once, reused across productions) ──
-- Optionally scoped to a client/brain (nullable in v1). Soul/voice/avatar IDs are
-- populated by the generation steps in Phase 3b once vendor tools are connected.
create table if not exists influencers (
  id                 uuid primary key default gen_random_uuid(),
  client_id          uuid references clients(id) on delete set null,
  name               text not null,
  mode               text not null default 'synthetic',  -- 'synthetic' | 'twin'
  status             text not null default 'draft',       -- 'draft' | 'ready'
  persona            jsonb default '{}'::jsonb,            -- age_range, gender, vibe, niche, audience, wardrobe, setting, backstory
  higgsfield_soul_id text,
  voice_id           text,        -- ElevenLabs
  heygen_avatar_id   text,        -- HeyGen (twin a-roll)
  look_refs          jsonb default '[]'::jsonb,            -- chosen reference frames [{url}]
  locked_seed        bigint,
  consent_id         uuid references consents(id) on delete set null,
  created_by         uuid references users(id),
  created_at         timestamptz not null default now()
);
create index if not exists idx_influencers_client on influencers(client_id);

-- Seed the canonical consent wording (v1) once. POPIA/GDPR — see compliance.md.
insert into consent_texts (version, body)
select 1, 'I confirm I have the right to use this person''s image / voice. '
       || 'I consent to creating an AI likeness / voice clone from this material. '
       || 'I understand the purpose: producing marketing video content. '
       || 'I understand consent can be withdrawn and the data deleted at any time.'
where not exists (select 1 from consent_texts where version = 1);

-- ── Cost tracking (Phase 6) ───────────────────────────────────────────────────
-- Higgsfield works in CREDITS (9,000/mo Ultra pool); we also store a ZAR estimate.
alter table rate_card add column if not exists credits_per_unit numeric not null default 0;
create unique index if not exists uq_rate_card_pmu on rate_card(provider, model, unit);

-- Every paid generation appends one row here (per influencer / brain / member).
create table if not exists usage_events (
  id            uuid primary key default gen_random_uuid(),
  influencer_id uuid references influencers(id) on delete set null,
  client_id     uuid references clients(id) on delete set null,
  user_email    text,
  provider      text not null,                 -- higgsfield | heygen | magnific | voyage | anthropic
  model         text,
  action        text,                          -- casting | photoshoot | soul | presenter | humaniser
  credits       numeric not null default 0,    -- Higgsfield credit pool burn
  cents         int not null default 0,        -- ZAR cents estimate
  count         int not null default 1,
  created_at    timestamptz not null default now()
);
create index if not exists idx_usage_events_created on usage_events(created_at);
create index if not exists idx_usage_events_influencer on usage_events(influencer_id);

-- Daily cost audit: snapshot the live Higgsfield credit balance vs our ledger so
-- the Cost Control view can prove it stays 100% accurate over time.
create table if not exists balance_snapshots (
  id              uuid primary key default gen_random_uuid(),
  taken_at        timestamptz not null default now(),
  remaining       numeric,                       -- live Higgsfield credits remaining (null if unreadable)
  ledger_credits  numeric not null default 0,    -- total credits our ledger has recorded to date
  ledger_cents    int not null default 0,        -- total ZAR cents our ledger has recorded to date
  note            text
);
create index if not exists idx_balance_snapshots_taken on balance_snapshots(taken_at);

-- Firecrawl scrape rate (Voyage embeddings already seeded at 0). Nominal ZAR estimate
-- so brain ingestion shows up in Cost Control with real counts.
insert into rate_card (provider, model, unit, credits_per_unit, price_cents_per_unit, active)
values ('firecrawl','scrape','page', 0, 3, true)
on conflict (provider, model, unit) do nothing;

-- ── Team access (Phase 1b): invited members + passwords ──────────────────────
-- super_admin (env Gary) can invite/remove; invited users set a password via an
-- emailed link, then sign in. All signed-in users can see Cost Control.
alter table users add column if not exists password_hash  text;
alter table users add column if not exists status         text not null default 'active'; -- 'invited' | 'active'
alter table users add column if not exists invite_token   text;
alter table users add column if not exists invite_expires timestamptz;
create index if not exists idx_users_invite_token on users(invite_token);

-- Soul (trained-identity) image generation rates. Estimates — tune against get_cost.
insert into rate_card (provider, model, unit, credits_per_unit, price_cents_per_unit, active)
values ('higgsfield','soul_2','image', 2, 128, true)
on conflict (provider, model, unit) do nothing;
insert into rate_card (provider, model, unit, credits_per_unit, price_cents_per_unit, active)
values ('higgsfield','soul_cinematic','image', 4, 256, true)
on conflict (provider, model, unit) do nothing;

-- Angles 2.0: 12 camera angles from one hero frame (60-80% cost reduction vs multi-prompt).
insert into rate_card (provider, model, unit, credits_per_unit, price_cents_per_unit, active)
values ('higgsfield','angles_2_0','image', 1, 77, true)
on conflict (provider, model, unit) do nothing;

-- Supercomputer: adaptive model routing (image-only allowlist, best-cost inference).
insert into rate_card (provider, model, unit, credits_per_unit, price_cents_per_unit, active)
values ('higgsfield','supercomputer','image', 3, 231, true)
on conflict (provider, model, unit) do nothing;

-- Supercomputer for video b-roll (Kling 3.0 / Seedance 2.0, adaptive routing, 500 credit session cap).
insert into rate_card (provider, model, unit, credits_per_unit, price_cents_per_unit, active)
values ('higgsfield','supercomputer','video', 8, 615, true)
on conflict (provider, model, unit) do nothing;

-- Native Higgsfield 4K upscale (bytedance) — replaces the external Magnific upscaler.
insert into rate_card (provider, model, unit, credits_per_unit, price_cents_per_unit, active)
values ('higgsfield','upscale_image','image', 2, 128, true)
on conflict (provider, model, unit) do nothing;

-- GPT Image 2 (creatives identity engine: reference-image + identity-lock, ~4 credits/image).
insert into rate_card (provider, model, unit, credits_per_unit, price_cents_per_unit, active)
values ('higgsfield','gpt_image_2','image', 4, 308, true)
on conflict (provider, model, unit) do nothing;

-- ── Showcase: a public brag wall of finished influencer videos ────────────────
-- Producers flag a complete production into the showcase; a single unguessable
-- public token serves the wall to prospects without a login.
alter table productions add column if not exists showcased boolean not null default false;
-- Manually-uploaded external showreels (brag work not produced on the platform) are tagged external.
alter table productions add column if not exists external boolean not null default false;
-- Custom drag-and-drop order on the showcase wall, and a captured poster still (so tiles never show black).
alter table productions add column if not exists showcase_order int;
alter table productions add column if not exists poster_url text;

create table if not exists app_settings (
  key        text primary key,
  value      text,
  updated_at timestamptz not null default now()
);

-- Daily "Higgsfield expert" research call (Claude + web search). Nominal ZAR estimate
-- per run so the daily research shows in Cost Control.
insert into rate_card (provider, model, unit, credits_per_unit, price_cents_per_unit, active)
values ('anthropic','claude-sonnet-4-6','request', 0, 200, true)
on conflict (provider, model, unit) do nothing;

-- Models the live pipeline actually uses (kept in sync with the live rate_card).
-- Nano Banana Pro is the primary image engine and is UNLIMITED on our Higgsfield Ultra plan
-- (0 cost). nano_banana_2 is the billable casting/photoshoot fallback. Scene-writer + Haiku
-- vision QA are metered too. Firecrawl corrected to ~R0.03/page; Voyage on voyage-4-lite.
insert into rate_card (provider, model, unit, credits_per_unit, price_cents_per_unit, active) values
  ('higgsfield','nano_banana_pro','image', 0, 0, true),
  ('higgsfield','nano_banana_2','image', 1, 77, true),
  ('higgsfield','nano-banana','image', 1, 77, true),      -- FAST first-party REST keyframe lane (~22s vs ~10min MCP) - ESTIMATE, Recalibrate trues up
  ('anthropic','claude-sonnet-4-6','scene', 0, 30, true),
  ('anthropic','claude-opus-4-8','request', 0, 500, true),
  ('anthropic','claude-haiku-4-5','image', 0, 5, true),
  ('voyage','voyage-4-lite','embed', 0, 0, true),
  -- B-ROLL motion (Producer): Kling 3.0 image->video ~5s std, from the 9,000-credit Ultra POOL.
  -- ~6 credits/clip (2026 sourced; Higgsfield publishes no per-model table) × ~R0.77/credit.
  ('higgsfield','kling3','video', 6, 462, true),
  ('higgsfield','kling3_0','video', 6, 462, true),            -- b-roll engine id used in metering (alias of kling3)
  ('higgsfield','kling-v2-1','video', 5, 385, true),          -- FAST first-party REST Kling 2.1 (Phase 1) - ESTIMATE, Recalibrate trues it up
  ('higgsfield','kling-v2-1-master','video', 6, 462, true),   -- REST Kling 2.1 master (higher quality) - ESTIMATE
  ('higgsfield','seedance_2_0','video', 6, 462, true),        -- a-roll fallback, from the Ultra credit pool
  ('higgsfield','seedance1_5','video', 5, 385, true),         -- Seedance 1.5 Pro b-roll (producer-selectable engine) - ESTIMATE, Recalibrate trues it up
  ('higgsfield','veo3_1','video', 40, 3080, true),            -- Veo 3.1 HERO b-roll (4K + native audio) - pricey; recalibrate
  -- PRIMARY b-roll engine on the Producer path (DoP-turbo, fast first-party). Draws from the Ultra
  -- credit POOL. ESTIMATE below - "Recalibrate costs" trues this up from Higgsfield get_cost.
  ('higgsfield','dop_turbo','video', 4, 308, true),
  -- PRIMARY a-roll engine (HeyGen Avatar IV, default AROLL_ENGINE). Within the HeyGen PRO $99/mo plan
  -- (~121 video min/mo included), so $0 marginal per clip within quota (overage $0.18/min). The $99/mo
  -- is a FIXED cost shown separately on the Cost Control page, not a per-clip charge.
  ('heygen','avatar_iv','video', 0, 0, true),
  ('heygen','talking_photo','video', 0, 0, true),             -- legacy build/twin presenter path (same HeyGen plan)
  ('heygen','talking_photo','avatar', 0, 0, true),
  -- fal OmniHuman 1.5 a-roll (opt-in AROLL_ENGINE=omnihuman): fal PAYG ~$0.16/s metered per second.
  ('fal','omnihuman_1_5','second', 0, 296, true),
  -- ElevenLabs voice/STT: within the ElevenLabs SUBSCRIPTION quota, so $0 marginal (like the music bed).
  -- Metered for usage visibility.
  ('elevenlabs','eleven_multilingual_v2','tts', 0, 0, true),
  ('elevenlabs','clone','voice', 0, 0, true),
  ('elevenlabs','scribe_v1','stt', 0, 0, true),
  -- ElevenLabs Music bed: drawn from the ElevenLabs SUBSCRIPTION credit pool, so $0 marginal
  -- within quota (like Higgsfield images). Metered for usage visibility.
  ('elevenlabs','music','music', 0, 0, true),
  -- Claude 'bible' unit (Character Casting + creative refine) and voyage-3.5 brief retrieval.
  ('anthropic','claude-sonnet-4-6','bible', 0, 200, true),
  ('voyage','voyage-3.5','embedding', 0, 0, true),
  -- Shotstack render: PAY-AS-YOU-GO (not a subscription) ~$0.30/rendered min => ~$0.24 per 45s cut.
  ('shotstack','edit','render', 0, 450, true),
  -- TOKEN-ACCURATE Anthropic rates. credits_per_unit holds the USD price (the fixed truth): per MILLION tokens
  -- (mtok_in / mtok_out) and per web search. recordTokens() converts to Rand at the LIVE USD/ZAR rate on every
  -- call, so nothing drifts on a stale exchange rate. price_cents_per_unit is only an indicative ZAR snapshot
  -- (~R18.5/$ here) for the rate-card display. Published USD: Opus 4.8 $5/$25, Sonnet 4.6 $3/$15, Haiku 4.5
  -- $1/$5, web search $0.01. The flat 'request' rows above stay for sections not yet moved to token metering.
  ('anthropic','claude-opus-4-8','mtok_in', 5, 9250, true),
  ('anthropic','claude-opus-4-8','mtok_out', 25, 46250, true),
  ('anthropic','claude-sonnet-4-6','mtok_in', 3, 5550, true),
  ('anthropic','claude-sonnet-4-6','mtok_out', 15, 27750, true),
  ('anthropic','claude-haiku-4-5','mtok_in', 1, 1850, true),
  ('anthropic','claude-haiku-4-5','mtok_out', 5, 9250, true),
  -- Insurance for a future model upgrade (current-gen prices) so nothing ever silently meters $0.
  ('anthropic','claude-opus-5','mtok_in', 5, 9250, true),
  ('anthropic','claude-opus-5','mtok_out', 25, 46250, true),
  ('anthropic','claude-sonnet-5','mtok_in', 3, 5550, true),
  ('anthropic','claude-sonnet-5','mtok_out', 15, 27750, true),
  ('anthropic','claude-fable-5','mtok_in', 10, 18500, true),
  ('anthropic','claude-fable-5','mtok_out', 50, 92500, true),
  ('anthropic','web_search','search', 0.01, 18.5, true)
on conflict (provider, model, unit) do nothing;

-- ============================================================================
-- GAS STUDIO (the template creative factory). Net-new, `studio_`-prefixed, additive only:
-- nothing here touches the influencer video pipeline. See docs STUDIO_BUILD_INSTRUCTION.
--
-- Design lock: templates are RECREATED from the client's own reference creatives and then
-- frozen. The reference file stays attached to the template record forever as the design
-- contract with the client - that is the audit trail proving the design never drifted.
-- ============================================================================

-- Brand kit: the client's locked visual identity (colours, licensed fonts, approved logos).
create table if not exists studio_brand_kits (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references clients(id) on delete cascade,
  name        text not null,
  colors      jsonb not null default '{}'::jsonb,   -- token map: primary, secondary, bg, text, accent
  fonts       jsonb not null default '[]'::jsonb,   -- [{family, weight, style, url}] - licensed files we render with
  logos       jsonb not null default '[]'::jsonb,   -- [{variant: light|dark|icon|primary, url}]
  tone_notes  text,                                 -- feeds the copy engine
  locked      boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists idx_studio_brand_kits_client on studio_brand_kits(client_id);

-- Template: ONE locked layout per placement/size, recreated from a reference creative.
create table if not exists studio_templates (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references clients(id) on delete cascade,
  brand_kit_id  uuid references studio_brand_kits(id) on delete set null,
  name          text not null,
  block         text not null default 'funnel',      -- 'funnel' | 'social' - the production set it belongs to
  placement     text not null,                       -- funnel_banner | funnel_section1 | funnel_section2 | meta_feed_4x5 | ...
  width         int  not null,                       -- READ from the uploaded reference, never typed by hand
  height        int  not null,
  engine        text not null default 'playwright' check (engine in ('playwright','shotstack','image')),
  component_key text,                                -- maps to the React template component once recreated
  slot_schema   jsonb not null default '{}'::jsonb,  -- editable slots + maxChars + image requirements
  reference_url text,                                -- THE DESIGN CONTRACT: the original file, kept forever
  analysis      jsonb not null default '{}'::jsonb,  -- what vision read off the reference (layout, slots, colours)
  version       int  not null default 1,
  status        text not null default 'draft' check (status in ('draft','locked','archived')),
  created_at    timestamptz not null default now()
);
create index if not exists idx_studio_templates_client on studio_templates(client_id, block);

-- Client asset library: reference creatives, logos, product shots, generated images.
create table if not exists studio_assets (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references clients(id) on delete cascade,
  kind       text not null,
  name       text,
  url        text not null,
  meta       jsonb not null default '{}'::jsonb,     -- width, height, bytes, mime, tags
  created_at timestamptz not null default now()
);
create index if not exists idx_studio_assets_client on studio_assets(client_id, kind);


-- Client compliance line (e.g. MTN's "Ts&Cs Apply · Queries? 083135 · MTN JR AUTH FSP 46094"). It is
-- client-level, not per-template, and must be reproducible VERBATIM on any creative that needs it - a
-- financial-services disclosure can never be paraphrased or half-remembered by a copy engine.
alter table studio_brand_kits add column if not exists compliance_text text;

-- The client's DESIGN SYSTEM, reverse-engineered from their best-performing creatives: the rules their
-- designers actually follow (panel hierarchy ratios, the disc/glow layer build, what is never broken, the
-- allowed degrees of freedom). This is the locked grammar the Creative Director composes WITHIN - it is
-- derived from proven work, never invented, and it is what stops a generated creative drifting out of the
-- family. Client-level, because it spans every placement.
alter table studio_brand_kits add column if not exists design_system text;

-- THE "WORTH REVIEWING" QUEUE. The Journalist and Strategist research daily and PROPOSE findings here; a human
-- accepts or bins each one. They never silently write to the client brain - otherwise a bad source quietly
-- becomes "fact" and every future article and strategy inherits it. `material` marks the ones that actually
-- change something, which is what gets emailed. Every row carries its source and a confidence grade.
create table if not exists studio_intel (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid not null references clients(id) on delete cascade,
  role           text not null check (role in ('journalist','strategist')),
  headline       text not null,
  why_it_matters text not null,
  detail         text,
  source_url     text,
  source_name    text,
  confidence     text not null default 'medium' check (confidence in ('high','medium','low')),
  material       boolean not null default false,
  status         text not null default 'new' check (status in ('new','accepted','binned')),
  found_at       timestamptz not null default now()
);
create index if not exists idx_studio_intel_client on studio_intel(client_id, status, found_at desc);

-- Findings routinely rest on SEVERAL sources ("TechCentral / ITWeb", "BioCatch via IOL / TransUnion via eNCA").
-- A single source_url threw the rest away, so an item could not be fully checked. Store them all.
alter table studio_intel add column if not exists sources jsonb not null default '[]'::jsonb;

-- TWO dates matter on a finding, and conflating them is how stale information becomes "current":
--   found_at     - when WE researched it (already present)
--   published_at - when the SOURCE was published / the thing actually happened
-- A 2019 article discovered today is not news. `period` carries what the data actually covers (e.g. "FY2025",
-- "calendar 2024"), because a report published this month can describe a year that is already old.
alter table studio_intel add column if not exists published_at date;
alter table studio_intel add column if not exists period text;

-- A finding that stops at "this happened" makes the reader do the work. Two INTERNAL columns carry it through
-- to a decision (Gary: "assess deeply the possible impact/risk for MoMo SA, then make a campaign recommendation
-- as a defensive and pro-active move"):
--   impact_risk       - what this could actually do TO MoMo SA, sized and reasoned, including the downside
--   campaign_response - the recommended campaign move for GAS: defensive, proactive, or both
-- INTERNAL ONLY. These never go near the CEO's public LinkedIn voice - the Journalist's public material is
-- FAIS-bound (no competitor comparison, no product promotion), and a campaign recommendation is neither.
-- The CEO newsletter drafted off a finding, kept so it SURVIVES a logout (Gary: the article and photos
-- disappear when I log back in). A draft that vanishes cannot be taken to the CEO for approval.
--   newsletter          - the drafted piece
--   newsletter_art      - the chosen creative
--   newsletter_options  - the other renders, so the choice can be revisited
alter table studio_intel add column if not exists newsletter text;
alter table studio_intel add column if not exists newsletter_art text;
alter table studio_intel add column if not exists newsletter_options jsonb not null default '[]'::jsonb;

alter table studio_intel add column if not exists impact_risk text;
alter table studio_intel add column if not exists campaign_response text;

-- The Researcher's machine-verification verdict on the cited source: 'verified' (page reached and it supports
-- the claim), 'partial' (reached, support not graded), 'unverified' (page could not be fetched). A 'refuted'
-- finding is dropped at file time and never stored. NULL for older rows and for the daily desks.
alter table studio_intel add column if not exists verification text;

-- ── PER-CLIENT INTEL BRIEFS ─────────────────────────────────────────────────
-- WHAT EACH CLIENT'S RESEARCHERS ARE ALLOWED TO RESEARCH. This table exists to stop CROSS-CLIENT CONTAMINATION
-- (Gary, on adding GAS Marketing's own research alongside MTN MoMo's: "I do not want to contaminate MoMo - how
-- do we prevent this").
--
-- The scope lock and the role briefs used to be hardcoded constants pointing at MTN MoMo, so a second client
-- would have been researched under MoMo's scope lock. Now every client carries its OWN:
--   scope       - the absolute in/out-of-scope lock for THIS client (the ringfence)
--   journalist  - the public-voice brief. NULL means this client has no Journalist: the role does not run.
--   strategist  - the internal-intelligence brief. NULL means it does not run.
--   window_days - recency gate for this client (30 by default, Gary's maximum)
--
-- THE SAFETY PROPERTY: no row here means the research REFUSES to run for that client. There is deliberately no
-- default and no fallback, because a fallback would silently hand one client another client's scope - which is
-- exactly the contamination we are preventing. Findings are already stored and retrieved by client_id, so the
-- brains stay separate; this closes the last door, which was the prompt itself.
create table if not exists intel_briefs (
  client_id   uuid primary key references clients(id) on delete cascade,
  scope       text not null,
  journalist  text,
  strategist  text,
  window_days int not null default 30,
  updated_at  timestamptz not null default now()
);
-- The "what this is" paragraph at the top of that brain's daily email. It was hardcoded to MoMo ("GAS is MTN
-- MoMo's performance marketing agency..."), which would have been simply untrue on GAS's own briefing.
alter table intel_briefs add column if not exists email_intro text;

-- ── GAS Studio: final production ────────────────────────────────────────────
-- Background removal for the masthead / section-1 cut-outs. fal bills per COMPUTE SECOND, not per image,
-- and will not quote the GPU rate without a logged-in dashboard - so this row is seeded UNPRICED on purpose
-- rather than with an invented number. The usage event still lands with the right (provider, model, unit),
-- so the call is visible in Cost Control the moment it happens; only the rand figure needs calibrating from
-- fal's own billing page. A wrong price is worse than a missing one.
insert into rate_card (provider, model, unit, credits_per_unit, price_cents_per_unit, active)
values ('fal','fal-ai/birefnet/v2','image', 0, 0, true)
on conflict (provider, model, unit) do nothing;

-- ── The two legal slots are NOT the same slot ────────────────────────────────
-- Gary, locked: "we can keep African Bank on the compliance copy but not in any suggested copy done by the
-- producer and not on any creatives."
--
-- So there are two distinct things, and the code was treating them as one:
--   compliance_text        the full legal copy. MAY name the bank. Lives on the funnel page, the SMS footer,
--                          anywhere legal text is required in HTML.
--   creative_legal_text    what is BAKED INTO A CREATIVE. The bank is never named here. Keeps the FSP number,
--                          which is the cheapest anti-scam signal we have - a scammer never carries a real
--                          licence number - without putting the bank's name in the brand's shop window.
alter table studio_brand_kits add column if not exists creative_legal_text text;

-- ── The deal library ────────────────────────────────────────────────────────
-- Gary: "the deal list is in fact with you already ... we would type in the deal then select a card design".
--
-- It was - baked into the 68 deal-card PNGs the team uploaded. 61 of those 68 are the SAME design; they differ
-- only by the DEAL printed on them. So the reference set is not a library of designs, it is a library of deals
-- wearing one design. We read the deals out of the artwork once, store them here, and rebuild the card as code
-- with slots - which is the whole point of the studio: the design is locked, the deal is the variable.
create table if not exists studio_deals (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references clients(id) on delete cascade,
  label         text not null,          -- "Night Express", "Social Pass", "WhatsApp Deal"
  amount        text not null,          -- "1GB", "Unlimited", "30"
  amount_suffix text,                   -- "Min", "MB" - set smaller, inline
  amount_sub    text,                   -- the smaller line under the big word
  price         text not null,          -- "R10"
  validity      text not null,          -- "*Valid for 3 Days"
  footnote      text,
  source_asset  uuid references studio_assets(id) on delete set null,
  created_at    timestamptz not null default now(),
  unique (client_id, label, amount, price)
);
create index if not exists studio_deals_client on studio_deals (client_id);

-- ── Campaign runs ───────────────────────────────────────────────────────────
-- A production run SPENDS MONEY (5 generated images + 2 cut-outs) and takes minutes. Until now its output
-- existed only in the browser tab that started it: navigate away, hit a stale chunk after a deploy, or close
-- the laptop, and the creatives were gone while the invoice was not. That is indefensible.
--
-- Every run is now written here the moment it completes, so the work is recoverable from any tab, and the
-- plan that produced it is kept alongside so a re-shoot knows what it was re-shooting.
create table if not exists studio_campaigns (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references clients(id) on delete cascade,
  brief      text,
  plan       jsonb not null,
  creatives  jsonb not null default '[]'::jsonb,
  warnings   jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists studio_campaigns_client on studio_campaigns (client_id, created_at desc);

-- studio_assets.kind - ONE authoritative constraint (consolidated 2026-08-11). This used to be redefined three
-- times with growing lists; run top-to-bottom the first, narrow re-add failed on existing ceo_cutout rows, so
-- migrate died before the full list and the live table ended up with NO constraint. Kinds, for reference:
--   reference/deal_card/phone_screen - real funnel artwork creatives forensically match to
--   logo/font/brand_icon              - brand kit assets (the mark, the type, the icon bubbles)
--   ceo_photo/ceo_cutout/team_photo   - people: source portrait, matted cut-out, team pics
--   image/video/ci_doc                - general upload, footage, CI document
alter table studio_assets drop constraint if exists studio_assets_kind_check;
alter table studio_assets add constraint studio_assets_kind_check
  check (kind in ('reference','image','logo','font','video','ci_doc','deal_card','phone_screen','brand_icon','ceo_photo','ceo_cutout','team_photo'));

-- ── Subscriptions: the FIXED monthly exposure ────────────────────────────────
-- Metered usage only ever answered "what did this job cost us at the margin?". For a platform built on
-- subscriptions that badly understates the business (Gary): the Higgsfield Ultra plan is $375 whether we
-- render one image or a thousand, so a desk running 204 jobs on unlimited models was reporting R0 - true at
-- the margin, and wrong about what the company actually spends.
--
-- These rows are the standing cost of the tech stack. They are ALLOCATED across the desks by each desk's
-- share of that provider's jobs, so fixed cost lands where the work happened instead of sitting in a
-- footnote. Amounts live here, never in code, exactly like rate_card.
create table if not exists subscriptions (
  id          uuid primary key default gen_random_uuid(),
  provider    text not null,                         -- matches usage_events.provider where one exists
  name        text not null,                         -- 'Higgsfield Ultra', 'Claude Max', ...
  monthly_usd numeric not null default 0,            -- list price per month, USD
  active      boolean not null default true,
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists idx_subscriptions_provider_name on subscriptions(provider, name);

-- ── Team access: suspension + login throttling ───────────────────────────────
-- SUSPEND, don't only delete. Removing a teammate used to be a hard delete: the row went, so there was no way
-- to re-enable them and no record they had ever been there. Suspension keeps the person and their history and
-- is reversible; delete stays for genuine removals.
alter table users add column if not exists suspended_at timestamptz;
-- status: 'invited' | 'active' | 'suspended'

-- LOGIN THROTTLING. /login was unthrottled, so it was open to brute force - a real exposure on a public
-- endpoint, independent of any team-management work. Attempts are recorded here and counted over a rolling
-- window, per EMAIL (someone hammering one account) and per IP (someone spraying many accounts).
create table if not exists login_attempts (
  id     bigserial primary key,
  email  text,
  ip     text,
  ok     boolean not null default false,
  at     timestamptz not null default now()
);
create index if not exists idx_login_attempts_email on login_attempts(lower(email), at desc);
create index if not exists idx_login_attempts_ip on login_attempts(ip, at desc);

-- Password reset: a single-use, 1-hour token. Short-lived on purpose - an invite link can sit in an inbox for
-- a week because it grants nothing on its own, but a reset link IS the account until it is used.
alter table users add column if not exists reset_token text;
alter table users add column if not exists reset_expires timestamptz;
create index if not exists idx_users_reset_token on users(reset_token);

-- The CEO's voice, per brain. These lived in the newsletter route and the creative as MTN MoMo constants, so a
-- second brain would have inherited a fintech's writing rules and another company's CEO on the nameplate.
alter table intel_briefs add column if not exists ceo_rules text;
alter table intel_briefs add column if not exists ceo_name  text;
alter table intel_briefs add column if not exists ceo_title text;
alter table intel_briefs add column if not exists deprecated_products jsonb not null default '[]'::jsonb;  -- retired products the client has not yet scrubbed off its site; the Researcher never surfaces these (Gary: GAS Appitude/ROC/INGAiGE)

-- Why an ingest failed. Status alone said "failed" and nothing else, so a broken source could only be
-- diagnosed by guessing - which is exactly what happened to the first site crawl.
alter table knowledge_sources add column if not exists error text;

-- Restrict a crawl to one section of a site. Without it a crawl wanders: the first real one pulled a case
-- study, a solutions page and the sitemap alongside the articles it was asked for.
alter table knowledge_sources add column if not exists include_path text;

-- THE RESEARCHER (Gary, July 2026) - a third intel role beside the Journalist and the Strategist.
--
-- WHY IT IS ITS OWN ROLE AND NOT A SECOND STRATEGIST. The Strategist is a WATCHER: it runs daily on a cron and
-- is gated hard on recency, because its whole job is "what changed". The Researcher is an ANALYST: it is
-- commissioned on demand and answers "where do we actually stand", which is mostly NOT news. A structural gap,
-- an entrenched competitor position, or a global campaign worth stealing can be two years old and still be the
-- most useful thing on the page - so the Researcher deliberately does NOT inherit the daily recency gate.
alter table intel_briefs add column if not exists researcher text;

-- THE STRATEGIST EMAIL CADENCE, PER CLIENT (Gary: "I should have the ability to switch a client on/off on the
-- daily or weekly strategist email"). A paid Opus + web-search pass runs for this brain EVERY time the email
-- fires, so this switch is a cost dial as much as a delivery preference.
--   'off'    - the brain is skipped on the automated run entirely (no research spend, no email).
--   'daily'  - runs every weekday (Mon-Fri).
--   'weekly' - runs on Monday only.
-- Default 'off' (Gary): a brain sends NOTHING until the team explicitly toggles it on, picks a cadence, and adds
-- the recipient addresses. Opt-in, never opt-out - the same posture as the Researcher weekly toggle, so no brain
-- ever spends on a run or mails a client that nobody switched on.
alter table intel_briefs add column if not exists email_schedule text not null default 'weekly';
alter table intel_briefs alter column email_schedule set default 'off';
alter table intel_briefs drop constraint if exists intel_briefs_email_schedule_check;
alter table intel_briefs add constraint intel_briefs_email_schedule_check
  check (email_schedule in ('off','daily','weekly'));
-- WHO THIS BRAIN'S DIGEST GOES TO. A per-brain recipient list the team edits directly (add/remove). Empty means
-- fall back to the platform default (INTEL_EMAIL_TO, else the cost recipient + Sam) so nothing silently stops
-- mailing if a brain has never been given its own list.
alter table intel_briefs add column if not exists email_recipients jsonb not null default '[]'::jsonb;
-- WHO THE CEO THOUGHT-LEADERSHIP ARTICLE GOES TO (Gary). The client CEO's own email(s), saved per brain so the
-- send step prefills them (e.g. MoMo's Kagiso), editable at send. Separate from email_recipients (the internal
-- intel digest list); this is the client's CEO, an external recipient of a drafted LinkedIn piece.
alter table intel_briefs add column if not exists ceo_recipients jsonb not null default '[]'::jsonb;

-- Findings are filed into the same queue (so accept/bin and "publish as a CEO article" work unchanged), but a
-- Researcher finding also carries WHICH of the five sections it belongs to.
alter table studio_intel add column if not exists section text;
alter table studio_intel drop constraint if exists studio_intel_role_check;
alter table studio_intel add constraint studio_intel_role_check
  check (role in ('journalist','strategist','researcher'));

-- THE RESEARCHER'S REQUEST (Gary). Each dossier finding remembers WHAT was asked for - the focus line typed
-- when it was commissioned, or "Standing remit" when the full remit was run - so the desk can tag each finding
-- with the research it came from and you can refer back to the subject.
alter table studio_intel add column if not exists request text;

-- ─────────────────────────────────────────────────────────────────────────────────────────────────────────
-- THE RESEARCHER V3 - A FACTS-ONLY COLLECTOR (build spec V3, section 3). Corrects the earlier build where the
-- Researcher analysed: threats/opportunities/gaps/positioning/trends now belong to the Strategist. Gate 1 can
-- only work if what Gary approves is falsifiable FACT, not opinion, so this engine COLLECTS and VERIFIES facts,
-- tags each with a source and a tier, and never interprets. Research is now typed DATA (a claim store), and the
-- PDF, the Gate 1 review screen and the Strategist hand-off are all renders of it.

-- A versioned research run per client. Gate 1 approves a specific version; a rerun never overwrites.
create table if not exists research_runs (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  version int not null default 1,
  status text not null default 'collecting',   -- collecting | ready | gate1_approved | gate1_rerun | gate1_rejected
  website text,                                 -- the ground-truth anchor used
  notes text,                                   -- the rerun-with-notes that produced this version, or a reject reason
  user_email text,
  pdf_url text,                                 -- the rendered Research Document (Vercel Blob)
  drive_url text,                               -- the copy filed to Google Drive under /Research (when configured)
  notified_at timestamptz,                      -- when Gary was emailed the completion notice
  created_at timestamptz not null default now()
);
create index if not exists idx_research_runs_client on research_runs(client_id, version desc);

-- A single FACT (or signal). No analysis ever lives here. Renders to the Research Document; feeds the Strategist.
create table if not exists research_claims (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references research_runs(id) on delete cascade,
  client_id uuid not null references clients(id) on delete cascade,
  section text not null,        -- snapshot|foundations|products|market|digital|competitor|competitor_set|activity|customer_voice|unverified
  subject text,                 -- the client, or a named competitor
  claim text not null,
  source_name text,
  source_url text,
  source_date text,             -- YYYY-MM-DD published/accessed
  tier int,                     -- 1 load-bearing | 2 reliable | 3 directional
  verified boolean not null default false,
  unverified_reason text,       -- why it is signal-only (Unverified section)
  conflict text,                -- note when sources disagree (both are still recorded)
  rejected boolean not null default false,  -- a single fact Gary dropped at Gate 1 (surgical, keeps the rest)
  rejected_by text,             -- who rejected it (audit trail; a soft flag, never a hard delete)
  created_at timestamptz not null default now()
);
create index if not exists idx_research_claims_run on research_claims(run_id);

-- The competitor set for a client - auto-detected, editable at Gate 1.
create table if not exists research_competitors (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  name text not null,
  website text,
  added_by text,                -- 'auto' or a user email
  created_at timestamptz not null default now()
);
create index if not exists idx_research_competitors_client on research_competitors(client_id);

-- Columns added after the tables first shipped (create-if-not-exists above skips existing tables, so evolve here).
alter table research_runs add column if not exists pdf_url text;
alter table research_runs add column if not exists drive_url text;
alter table research_runs add column if not exists notified_at timestamptz;
alter table research_runs add column if not exists vertical text;       -- benchmark-keying category (insurance, fintech, agency...)
alter table research_runs add column if not exists word_url text;       -- editable Word (.doc) export alongside the PDF
alter table research_runs add column if not exists identity jsonb;      -- {legal_name, licence, address, markets, contact_person, contact_details} for the brief cover
alter table research_claims add column if not exists rejected boolean not null default false;
alter table research_claims add column if not exists rejected_by text;
alter table research_claims add column if not exists in_brain boolean not null default false;  -- a fact Gary kept at Gate 1 (moves to the "In the Brain" tray; carried forward so reruns show only what is new)
alter table research_claims add column if not exists in_brain_by text;
alter table research_runs add column if not exists progress jsonb;  -- live {label, sources, filed} while status='collecting', so a returning user sees progress (durable run survives navigation)
alter table research_runs add column if not exists error text;      -- failure reason if a run ends in status='failed'
alter table research_runs add column if not exists plan jsonb;      -- the AGREED research plan {summary, passes[], confirm[]}: previewed + aligned by a human before the run, and steers the gather (facts-scoping only)

-- ══════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- THE INTELLIGENCE LAYER CYCLE (Agency of NOW · Pillars I + II). Phase A: the spine + contracts.
--
-- The ecosystem is a CLOSED LOOP, so the value is in the hand-offs, not any one pillar. These objects are the
-- ecosystem's internal API: the Researcher (I) fills the brain, the Strategist (II) emits a structured strategy
-- that Pillars III-VIII execute against, and the optimisation layer feeds performance_signals back in. This phase
-- creates the tables ONLY - no behaviour change - so every later phase (Delta research, the Strategist engine,
-- Gate 2, the Optimise/Pivot cycles) has a spine to hang off, and Pillars III-VIII are cheap to add later.
--
-- PERSISTENCE HIERARCHY (what carries forward vs resets):
--   engagement/brain  persists forever, compounds, serves all 8 pillars
--     campaign         one product/range/objective push (a PIVOT = a new campaign)
--       cycle          one round through the loop (an OPTIMISE = a new cycle on the same campaign)

-- One per active client relationship. Holds the DURABLE strategy artefacts a Foundation cycle produces and a
-- quarterly refresh re-forecasts (positioning, jointly-owned KPIs, the baseline, the roadmap, sales-ready def).
create table if not exists engagements (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  status text not null default 'active',            -- active | paused | ended
  positioning jsonb,                                -- durable strategic direction (from the engagement-level strategy)
  kpis jsonb,                                        -- jointly-owned success metrics (the measurement contract)
  baseline jsonb,                                    -- documented starting position every metric is measured against
  roadmap jsonb,                                     -- sequenced acquisition/scaling plan across the horizon
  sales_ready_def text,                              -- what "sales-ready" means for this client (feeds PSI/Lead Mgmt)
  current_eng_strategy_id uuid,                      -- latest APPROVED level=engagement strategy (plain ref, no FK: created later)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_engagements_client on engagements(client_id);

-- One per product/range/objective. A client changing product is a NEW campaign under the same engagement, so the
-- brain and positioning are inherited, never re-onboarded.
create table if not exists campaigns (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references engagements(id) on delete cascade,
  name text not null,
  product text,                                      -- the product/range/offer this campaign pushes
  objective text,                                    -- the commercial objective for this push
  status text not null default 'active',             -- active | paused | archived
  current_strategy_id uuid,                          -- latest APPROVED level=campaign strategy (plain ref)
  created_at timestamptz not null default now()
);
create index if not exists idx_campaigns_engagement on campaigns(engagement_id);

-- One round through the loop. ONE machine, three modes - foundation (new client / quarterly refresh), optimise
-- (recurring, same campaign, driven by performance_signals) and pivot (new product). Differs only in trigger,
-- depth, and which inputs it pulls.
create table if not exists cycles (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references engagements(id) on delete cascade,
  campaign_id uuid references campaigns(id) on delete set null,   -- null for engagement-level foundation
  mode text not null,                                -- foundation | optimise | pivot | refresh
  trigger text not null default 'manual',            -- manual | scheduled | signal
  status text not null default 'open',               -- open | researching | strategising | awaiting_gate | approved | closed
  research_run_id uuid,                              -- the run (full or delta) this cycle commissioned (plain ref)
  strategy_id uuid,                                  -- the strategy this cycle produced (plain ref)
  opened_by text,
  opened_at timestamptz not null default now(),
  closed_at timestamptz
);
create index if not exists idx_cycles_engagement on cycles(engagement_id, opened_at desc);
create index if not exists idx_cycles_campaign on cycles(campaign_id);

-- The Strategist's output: versioned, gradeable, every point traceable to a fact. content(jsonb) carries the
-- structured brief every downstream pillar inherits (proposition, target, angle, message hierarchy, channel logic,
-- KPIs, sales-ready def, rationale->fact_id, risks, and changes_from_last for optimise mode). See lib/cycle.ts.
create table if not exists strategies (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references engagements(id) on delete cascade,
  campaign_id uuid references campaigns(id) on delete cascade,    -- null for level=engagement
  cycle_id uuid references cycles(id) on delete set null,
  level text not null default 'campaign',            -- engagement | campaign
  mode text not null default 'foundation',           -- foundation | optimise | pivot
  version int not null default 1,
  status text not null default 'draft',              -- draft | awaiting_approval | approved | superseded
  content jsonb,                                     -- the structured strategy (the inter-pillar contract)
  approved_by text,                                  -- Gate 2 (direction) - the human command point
  approved_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_strategies_engagement on strategies(engagement_id, version desc);
create index if not exists idx_strategies_campaign on strategies(campaign_id);
-- Durable strategy build (like the Researcher): status can be 'building' while the two Opus passes run as a
-- background Inngest job, and 'progress' holds {label, error} so a returning user sees it running/complete and it
-- survives navigation. Flips to 'awaiting_approval' on success, 'failed' on error.
alter table strategies add column if not exists progress jsonb;

-- Normalised feedback from the downstream pillars (PSI VI, Optimisation VIII, Lead Mgmt VII) - or entered by hand
-- now, before those pillars exist. The Strategist reads unconsumed signals at the start of an OPTIMISE cycle to
-- recommend the next month's approach. Shape is fixed now so the real pillars later auto-write the same object.
create table if not exists performance_signals (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references engagements(id) on delete cascade,
  campaign_id uuid references campaigns(id) on delete cascade,
  source text not null default 'manual',             -- psi | media | lead_mgmt | manual
  metric text not null,                              -- what was measured (e.g. CPL, conversion rate, lead quality)
  direction text,                                    -- up | down | flat
  magnitude text,                                    -- free-form for now (e.g. "-32%", "R48 -> R31")
  confidence text,                                   -- high | med | low
  lever text,                                        -- audience | creative | channel | offer | message
  note text,                                         -- the human-readable observation
  observed_at timestamptz,                           -- when it happened (may differ from logged-at)
  consumed_by_cycle_id uuid references cycles(id) on delete set null,   -- which optimise cycle acted on it
  created_at timestamptz not null default now()
);
create index if not exists idx_signals_campaign on performance_signals(campaign_id, created_at desc);
create index if not exists idx_signals_unconsumed on performance_signals(engagement_id) where consumed_by_cycle_id is null;

-- Extend the Researcher's existing tables so a run belongs to a cycle and facts are tagged for their consumers.
alter table research_runs add column if not exists cycle_id uuid;        -- the cycle this run belongs to (plain ref)
alter table research_runs add column if not exists campaign_id uuid;     -- the campaign in focus (plain ref)
alter table research_runs add column if not exists run_mode text not null default 'foundation';  -- foundation | delta
alter table research_claims add column if not exists pillar_tags jsonb not null default '[]'::jsonb;  -- which downstream pillars each fact serves (strategist/audience/creative/psi/channels)
-- The CEO newsletter drafted off a fact, kept so it SURVIVES a logout (Gary: "I clicked approve and it did
-- nothing and when I went back it was gone"). Mirrors the studio_intel newsletter columns: the piece, the chosen
-- creative, and the other renders so the choice can be revisited. Approving at the fact writes these; they reload.
-- BRAIN COVERAGE: a cached, auto-generated "what this brain can answer on" topic list, so the team sees the
-- brain's strengths and holes without querying. Regenerated when the passage count drifts or on manual refresh.
create table if not exists brain_coverage (
  client_id    uuid primary key references clients(id) on delete cascade,
  topics       jsonb not null default '[]'::jsonb,
  chunk_count  int not null default 0,
  generated_at timestamptz not null default now()
);
alter table research_claims add column if not exists newsletter text;
alter table research_claims add column if not exists newsletter_art text;
alter table research_claims add column if not exists newsletter_options jsonb not null default '[]'::jsonb;

-- THE PROPOSAL (lives in the Strategist POD). The client-facing growth proposal built on the approved strategy for
-- sign-off. Written on Fable 5, human-edited, then rendered to a client-branded PDF. objective = the Meta outcome
-- objective; tier = launch|dominate (rate card). content = the structured proposal (see lib/proposal.ts).
create table if not exists proposals (
  id uuid primary key default gen_random_uuid(),
  engagement_id uuid not null references engagements(id) on delete cascade,
  campaign_id uuid references campaigns(id) on delete set null,
  strategy_id uuid references strategies(id) on delete set null,
  objective text not null,
  tier text not null default 'dominate',
  status text not null default 'draft',              -- draft | awaiting_approval | approved
  content jsonb,
  pdf_url text,
  section_review jsonb not null default '{}'::jsonb,   -- per-section human gate: { <section_key>: 'approved' | 'draft' }
  approved_by text, approved_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_proposals_strategy on proposals(strategy_id, created_at desc);
create index if not exists idx_proposals_engagement on proposals(engagement_id, created_at desc);
alter table proposals add column if not exists section_review jsonb not null default '{}'::jsonb;
-- Keep BOTH the full and the sharpened version so the team can compare and choose (Gary). content mirrors whichever
-- is active; content_full / content_sharp hold each version; version_mode says which is live ('full' | 'sharp').
alter table proposals add column if not exists content_full jsonb;
alter table proposals add column if not exists content_sharp jsonb;
alter table proposals add column if not exists version_mode text not null default 'full';
