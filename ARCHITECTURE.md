# Arthur-Arlo — System Architecture & Operating Guide

> Read this first. It's the map of the whole system: what it is, how every piece
> works, the conventions to follow, and the gotchas that will bite you. Written so a
> fresh session (human or AI) can pick up and work correctly without re-discovering
> everything.

---

## 1. What this is

**Arthur-Arlo** is an "Aethon Intelligence" — an AI operations platform for a single
business: **Aquatic Pool & Spa**, a custom pool builder in the Phoenix Valley, AZ,
owned by **Arthur Garcia**. It is not one chatbot; it's a set of named AI "employees"
sharing one backend and one SQLite brain:

| Persona | Role | UI tab | Engine |
|---|---|---|---|
| **Arlo** | Arthur's right-hand man / chief of staff (voice + text). The digital twin. | `/arlo` | OpenAI `gpt-4o` |
| **Lauren** ("Atlas") | Autonomous SEO agent — researches, writes & publishes landing pages | `/atlas` | Gemini (+ Claude fallback) |
| **Ralph** (was "Nova") | Content manager — generates on-brand posts + images, publishes live to IG/FB, real analytics | `/ralph` | Gemini text + image; Zernio publish + analytics |
| **Sofia** | Phone agent (inbound receptionist + outbound sales) | `/calls` | Vapi |

The whole thing runs as **one Express + better-sqlite3 app** deployed on **Fly.io**
(`arthur-arlo`, region `lax`, 512 MB / 1 shared CPU, persistent volume at
`/data/arlo.db`), Dockerized, auto-deployed by GitHub Actions on push to `main`/`master`.

Design philosophy (the "hull" + "founder layer"): a universal cognitive engine (memory,
voice, judgment, reflection) that's the same for every client, with a per-founder
identity layer loaded on top. Arlo is the founder clone; the other agents are its
"hands."

---

## 2. Tech stack

- **Backend:** Node 20, TypeScript, Express 4, `ws` for WebSockets.
- **DB:** SQLite via `better-sqlite3` (synchronous). One file, `DB_PATH` (default
  `/data/arlo.db` in prod).
- **AI:** OpenAI (`gpt-4o` chat brain + `text-embedding-3-small`), Anthropic Claude
  (Haiku for memory extraction/reflection/synthesis/triage), Google Gemini (Lauren's
  SEO research + image gen).
- **Voice:** ElevenLabs Scribe (STT, realtime WS) + ElevenLabs TTS (`eleven_flash_v2_5`).
- **Integrations:** Google (Gmail/Calendar/Search Console via `googleapis`), Vapi
  (phone), Brave Search (SEO fallback), GitHub Contents API (Lauren publishing),
  sms-gate.app (lead SMS).
- **Hosting:** Fly.io. **Build:** `npm run build` = `tsc` → `server/dist`. **Start:**
  `node server/dist/app.js`. Client is static HTML in `client/`, served by Express.

Everything degrades gracefully: **if an API key/integration is missing, that feature
no-ops with a clear log line** rather than crashing. Follow this pattern for new code.

---

## 3. Repo layout

```
server/src/
  app.ts                  Express app, static serving, route mounts, WS upgrade routing, cron scheduling
  brain/
    agentLoop.ts          The core: OpenAI call, personality + memory injection, tool-calling loop, streaming
    memoryPacket.ts       Builds the memory context injected into every brain call (async; semantic recall)
    routing.ts            needsSonnet()/isGreeting() — cheap model routing heuristics
    extractSentences.ts   Streaming → speakable phrases (first chunk fast, rest merged for smoothness)
    tools.ts              Function-tool definitions + executeTool() (open_dashboard, add_calendar_event, etc.)
  config/
    constants.ts          ARLO_SYSTEM_PROMPT (the founder layer) + service area / phrases
    personalities.ts      Selectable personalities (Jarvis/Wingman/Operator) each with its own voice
    models.ts             Model IDs (ARLO_MODEL, ANTHROPIC_MODEL, etc.)
    voice.ts              ElevenLabs voice id/model + TTS voice settings
    curiosity.ts          12 identity dimensions + question bank (engine mostly retired; see §6)
    google.ts             Google OAuth config, scopes, the 3 mailbox accounts
    integrations.ts       Integration catalog (the /integrations "hands" library)
  db/
    schema.ts             initDb() — ALL table DDL + migrations. Single source of schema truth.
    memory.ts             facts/episodes/nodes/edges/rules/syntheses + hybrid retrieval + insertFact
    queries.ts            conversations, system_state, execution_log, getRecentConversation()
    google.ts             google_accounts, email_items, calendar_events, gsc_metrics helpers
    ralph.ts              ralph_content CRUD + ralphStats() + ralphAnalytics()
  services/
    crons.ts              All schedulers + morning brief / activation greeting logic
    embeddings.ts         OpenAI embeddings + cosine + startup backfill (graceful w/o key)
    extraction.ts         Post-conversation memory extraction (Claude Haiku)
    reflection.ts         Reflection engine — self-generated higher-level insights
    personality.ts        get/set selected personality (system_state)
    tts.ts                ElevenLabs TTS → PCM (personality voice + voice settings + cache)
    vision.ts             Image analysis + document ingestion (gpt-4o multimodal)
    sms.ts                Lead SMS via sms-gate.app (Basic auth)
    google/               auth.ts, gmail.ts, calendar.ts, monitor.ts, context.ts, searchConsole.ts
    seo*.ts, seo/         Lauren — the whole SEO agent (see §9)
    websiteContext.ts     Live-site context helper for SEO
  ws/
    deepgramProxy.ts      STT proxy: client <-> ElevenLabs Scribe, reconnect + silence keepalive
    hub.ts                Generic WS broadcast hub (/ws) — pushes 'memory_updated'/'inbox_updated' to UIs
  routes/                 brain, voice, memory, leads, calls, vapiWebhook, seo, integrations, google, ralph, health
  seed/founderSeed.ts     Idempotent seeding of Arthur's facts/rules/graph into memory on boot

client/
  shell.html              THE APP SHELL (served at /). Collapsible sidebar + tabbed iframes + voice nav.
  index.html              Arlo's voice interface (served at /arlo; embedded as shell's home tab)
  js/voice.js             Voice pipeline client: mic capture, STT WS, SSE brain, ordered TTS playback
  atlas.html              Lauren / SEO dashboard        memory.html   Neural Map (memory graph)
  ralph.html              Ralph / content manager       inbox.html    Email triage panel
  calls.html              Sofia / call metrics          integrations.html  Integrations hub
  marketing.html          Marketing team overview       dashboard.html     OLD card deck (served at /deck)

templates/ui-shell/       Neutral, brand-free copy of the shell + voice-nav contract (for reuse elsewhere)
```

---

## 4. The UI shell (`client/shell.html`, served at `/`)

The landing page is a single-page **shell**: **Arlo front-and-center** with a
**collapsible left sidebar** of tabs. Each tab is an `<iframe>` of an existing page
(`/arlo`, `/atlas`, `/ralph`, `/calls`, `/inbox`, `/memory`, `/integrations`).

Key behaviors:
- **Arlo's iframe stays loaded and audible** even when another tab is shown, so he
  "speaks over" whatever you're viewing. Other tabs lazy-load on first open.
- **Collapse** (button or `Ctrl/⌘ + \`) hides the sidebar and the current tab
  **maximizes full-screen**; a floating "Menu" pill reopens. Persisted in localStorage.
- **Voice navigation:** Arlo can pull up a tab. Flow:
  `open_dashboard` tool (brain) → SSE `{type:'navigate', tab}` → `voice.js` posts
  `window.parent.postMessage({type:'arlo-navigate', tab})` → shell switches tab.
- **Visibility broadcast (performance):** on tab switch the shell posts
  `{type:'shell-visibility', active}` to every iframe. Dashboards **pause their
  polling when hidden** (they steal the single CPU otherwise). Arlo's tab ignores it
  and keeps running. If you add a new polling dashboard, add this listener too.

The old card dashboard is preserved at `/deck` (nothing references it; safe fallback).

`/marketing` lists the team; its "social" card → Ralph → `/ralph`.

---

## 5. The brain (`server/src/brain/agentLoop.ts`)

Two entry points, both used by `routes/brain.ts`:
- `runAgentLoop()` → `POST /api/brain/process` (non-streaming, returns text + navigate)
- `streamAgentLoop()` → `POST /api/brain/stream` (SSE — used by voice)

Each call:
1. `buildConversationInput(message)` — pulls the **last ~8 turns** from the
   `conversations` table (working memory) + the new message. (This is why Arlo holds
   a thread instead of re-greeting.)
2. `selectModel()` — `gpt-4o` for anything substantive; the fast model only for a
   cold-open greeting with no history.
3. `buildSystemPrompt()` (async) assembles:
   - `ARLO_SYSTEM_PROMPT` (founder layer, `config/constants.ts`)
   - `## ACTIVE PERSONALITY` (selected personality prompt)
   - `## MEMORY CONTEXT` (from `getMemoryPacket()` — semantic recall)
   - `## LIVE INBOX & CALENDAR` (from `google/context.ts`, if mailboxes connected)
   - clarification-mode note if memory confidence is low
4. **Tool-calling loop** (Responses API function tools, see `brain/tools.ts`):
   - Tools: `open_dashboard`, `get_agent_status`, `sync_seo_rankings`,
     `create_content`, `add_calendar_event` + the hosted `web_search_preview`.
   - Streaming variant: streams text; if the model calls tools, it runs them
     (emitting `navigate` for `open_dashboard`), then continues with
     `previous_response_id` to stream the final spoken answer.
   - **Guardrails:** falls back to a plain stream on any tool error; disable entirely
     with `ARLO_TOOLS_ENABLED=false`. Function tools are never attached to the fast
     greeting model.
5. Persists the exchange to `conversations`.

**Personalities** (`config/personalities.ts` + `services/personality.ts`): Jarvis
(default, dry British wit), Wingman (loose, funny, some profanity), Operator (calm,
minimal). Selection stored in `system_state` key `arlo_personality`; **the TTS voice
follows the selected personality** (each has its own ElevenLabs voice id). Switch via
`POST /api/brain/personality` or the selector in `/arlo`'s top bar.

**Conversation style** lives in `ARLO_SYSTEM_PROMPT`: right-hand-man (not client-facing
— Sofia handles clients), talk-to-Arthur not at-him, one thought at a time, react
before reporting, tasteful wit + earned profanity, ask one natural question when
needed. He also knows he has live web search + eyes (vision) + document reading + the
three mailboxes/calendars, and must never deny those.

---

## 6. Memory — the "Aethon hull" (`db/memory.ts`, `db/schema.ts`)

SQLite tables (all created in `db/schema.ts::initDb`):
- **facts** — durable facts with `strength`, `importance` (1–10), `keywords`, and an
  `embedding` BLOB. Decay daily; reinforced on retrieval.
- **episodes** — 2–3 sentence conversation summaries.
- **nodes + edges** — knowledge graph (people, projects, vendors…), fuzzy de-duped.
- **rules** — confidence-weighted business heuristics.
- **syntheses** — weekly Claude summary of patterns/risks.
- **facts w/ category `reflection`** — self-generated higher-level insights (see below).
- **conversations, system_state, execution_log, identity_questions**.

**Retrieval** (`getMemoryPacket`, async): computes a query embedding
(`services/embeddings.ts`, skipped for short messages to save latency) and ranks facts
by a hybrid score — **relevance (cosine)·0.50 + keyword·0.20 + strength·0.10 +
recency·0.05 + importance·0.15**. Falls back to keyword-only if no OpenAI key. Packet
capped at 2500 chars.

**Writing:** `services/extraction.ts` runs after each voice session
(`POST /api/memory/extract-voice`, fired **fire-and-forget** from `voice.js` so it
never blocks the next turn) — Claude Haiku extracts facts/entities/rules/episodes,
each fact embedded + importance-scored.

**Reflection engine** (`services/reflection.ts`, every 12h): reads recent
facts/episodes and writes back higher-level insights as `reflection` facts. This is
the "neurons forming" layer.

**Autonomous:** daily decay (`crons.ts`), weekly synthesis (Sun 3am), embedding
backfill on boot.

**Founder seed** (`seed/founderSeed.ts`): idempotent (guarded by `system_state`
`founder_seeded_v1`) — pre-loads Arthur's facts/rules/graph on boot so the Neural Map
(`/memory`) is alive immediately.

> **Curiosity engine** (`config/curiosity.ts`, `services/curiosity.ts`): the old random
> question pop-ups were **removed from the brain loop** (they broke conversational
> flow). Arlo now asks questions naturally in-conversation. The files/tables remain but
> aren't invoked from the loop. Don't re-enable the random pop-ups.

---

## 7. Voice pipeline (the state loop — handle with care)

The flow, and where each piece lives:

```
Mic (index.html/voice.js) → downsample 16kHz PCM
  → WS /api/voice/deepgram/listen  (ws/deepgramProxy.ts)
  → ElevenLabs Scribe (STT, realtime)  → committed transcript
  → POST /api/brain/stream  (agentLoop streamAgentLoop, SSE)
  → sentences → POST /api/voice/speak (routes/voice.ts → services/tts.ts → ElevenLabs TTS → PCM)
  → ordered playback (voice.js) → on drain, mic resumes
```

**State loop:** greeting → LISTENING → (user speaks) → PROCESSING → RESPONDING →
back to LISTENING. Critical invariants:

1. **STT proxy (`ws/deepgramProxy.ts`)** — the path is named "deepgram" for legacy
   reasons but the provider is **ElevenLabs Scribe** (Deepgram is not used).
   - While Arlo speaks, the mic is paused → no audio → Scribe would idle-close. The
     proxy sends a **silence keepalive every 2.5s when idle** (VAD ignores it → no
     phantom transcript) so the session never idle-closes. It also **auto-reconnects**
     upstream transparently (buffering audio) if it does close, keeping the client WS
     alive. Only fatal errors (auth/quota) close the client.

2. **Ordered TTS playback (`voice.js`)** — sentences are fetched in **parallel** (fast)
   but played in **strict submission order** using sequence-indexed slots
   (`ttsResults`/`ttsPlayIndex`/`ttsTotal`). **Do not** revert to pushing PCM on fetch
   resolution — that scrambles words. The producer must call `markTtsComplete()` when
   it's done submitting (the stream 'done' handler AND the greeting both do). Forgetting
   to seal = stuck on RESPONDING forever (this bit us once — the greeting path).

3. **First-word latency** — `extractSentences.ts` ships the **first** complete sentence
   immediately (`FIRST_CHUNK_CHARS=1`), then merges later sentences to ~55 chars for
   smoothness. Ordered playback keeps it clean.

4. **Latency principle:** memory extraction is fire-and-forget; embeddings skipped for
   short messages; dashboards pause polling when hidden. Don't reintroduce a blocking
   `await` between the model finishing and the mic resuming.

TTS voice/quality knobs are in `config/voice.ts` (stability/similarity/style/speed) and
the voice id follows the active personality.

---

## 8. Google integration (`services/google/*`, `routes/google.ts`)

One OAuth "Web application" credential authorizes **three mailboxes individually**:
`arthur.garcia@`, `info@`, `support@aquaticpoolaz.com`. Tokens stored per-account in
`google_accounts` (refresh token durable; access token auto-refreshed).

- **OAuth:** `/api/google/connect?account=…` → Google consent → `/api/google/callback`.
  The Integrations page (`/integrations`) has one-click Connect buttons per mailbox.
- **Scopes:** `gmail.modify`, `gmail.send`, `calendar`, `userinfo.email`,
  `webmasters.readonly` (Search Console). **Adding a scope requires re-consent** — the
  user must reconnect each account.
- **Monitor** (`google/monitor.ts`, every 15 min): pulls each inbox, triages with
  Arlo's judgment (priority/category/flag/summary + a draft reply in Arthur's voice),
  refreshes the calendar cache. Emails land in `email_items`, events in
  `calendar_events`.
- **Awareness** (`google/context.ts`): a compact live inbox/calendar snapshot is
  injected into Arlo's brain so he can answer "what's in my inbox."
- **Inbox panel** (`/inbox`): read, filter, edit drafts, **Approve & Send** (the one
  gated action), compose, Sync now. Routes in `routes/google.ts`.
- **Calendar:** Arlo can create events directly (reversible); sending email is gated to
  approval.
- **Search Console** (`google/searchConsole.ts`): pulls **real** Google rankings/clicks/
  impressions and writes them onto Lauren's tracked keywords. Daily cron +
  `/api/seo/gsc-sync`. Requires the site verified in GSC under a connected account.

Manual/testable: `GET|POST /api/google/sync` (returns real counts).

---

## 9. Lauren — SEO agent (`services/seoAgent.ts`, `services/seo/*`, `services/seoNav.ts`, `services/seoPublish.ts`)

Runs every 3 days (`crons.ts::scheduleSeoAgent`), **one page per run**. Pipeline:
brand-ingest → research (Gemini w/ Google Search grounding, or Brave+Claude fallback) →
scrape competitors → plan around content **gaps** → generate one on-brand HTML page
with AI images (Gemini flash-image) → deterministic **enrich** (meta, JSON-LD schema,
internal links) → **audit & score 0–100**. Pages sit as `pending_review` drafts.

- **Publishing** (`seoPublish.ts`): a human approves; approved+due content is committed
  **directly to the client's website GitHub repo** (`SEO_GITHUB_REPO`) — the repo *is*
  the live static site. Then the page is wired into the site nav.
- **Nav wiring** (`seoNav.ts`): location/city pages → a top-level **"Locations"** tab;
  service pages → **"Services"**; blog → **"Blog"**. `applyNavLink` inserts a new
  top-level dropdown using **balanced `<ul>` matching** (a naive regex previously nested
  new tabs under "Blog" — don't regress that). A one-time rebuild key
  (`seo_nav_rebuilt_vN` in `system_state`) triggers a strip+rebuild; bump it to re-run.
- **Business profile / NAP** (`services/seo/businessProfile.ts`): single source of truth
  for name/phone/address/service-area, all env-overridable. Phone default is
  `(623) 225-0537`.
- **Dashboard** (`/atlas`): real internal metrics + real GSC data (when connected);
  cleaner trend chart; "Sync rankings" button.
- **Approx cost:** ~$3–8/month, dominated by AI image generation.

---

## 10. Ralph — content manager (`db/ralph.ts`, `routes/ralph.ts`, `client/ralph.html`)

Content manager (was "Nova"). `ralph_content` table (idea→draft→scheduled→published
across channels). Dashboard `/ralph` has 4 views: Overview (KPIs + throughput + channel
breakdown + best-time + top posts), Calendar, Pipeline (kanban), Approvals.
`/api/ralph/analytics` returns **real** content-throughput metrics; audience/engagement
metrics (followers, engagement rate, reach, impressions) are structured but **locked
until social accounts are connected** (Layer 2).

**Layer 1 — LIVE (lead-generating content engine).** `services/ralphContent.ts` is a
social **strategist**, not a caption bot. It's grounded in what actually drives leads for
high-ticket local home services on Instagram (2025 research): build-journey reels
(~8:1 over finished-pool photos on saves/shares/DMs), reveal reels with real reactions,
educational/cost-breakdown carousels (highest-saved format), and a **keyword DM CTA** on
every post (converts 5–15% vs ~1–3% for "link in bio").
  - **Content FORMATS** (`format` column: single | carousel | reel | before_after). The
    generator is format-aware: **reels** produce a shoot-ready script (hook, 4–7-scene
    shot list with on-screen text + voiceover, audio suggestion, caption) + a cinematic
    cover frame; **carousels** produce a 6–9-slide teaching/objection plan + cover and up
    to 3 slide images; before/after + single produce one strong editorial image. `PLAYS`
    is the strategy library (build_journey, first_fill_reveal, cost_breakdown, five_things,
    myth_buster, before_after, process_step, client_story, design_trend, faq,
    local_spotlight) each tagged goal=lead/trust/reach; `PLAN_ROTATION` composes a real
    Instagram-first weekly mix.
  - The strategist **system prompt** carries the hook patterns, caption frameworks, and
    lead-gen rules (hook in 1.7s, optimize for saves/shares/DMs, transparency sells,
    end with a specific keyword DM ask). This is the "knowledge" that makes the output
    professional-grade.
  - Imagery: Gemini `gemini-2.5-flash-image` via `generateSocialImage(scene,{raw:true})`
    with a format-aware prompt (people allowed on reveals/reels — real reactions convert),
    stored in `seo_images`, served at `/api/seo/img/<id>.png`, linked via `content_id`.
    Carousels store several images; `listRalphContent`/`getRalphContent` return
    `image_urls[]` (+ `image_url` = first). Aspect: 9:16 reels, 4:5 IG, 16:9 blog.
  - Each post lands as `status='draft'` in **Approvals** — the card badges the format,
    shows the image strip + full script/slide breakdown/caption. Nothing posts externally.
  - Trigger: **"✨ Generate posts"** button → `POST /api/ralph/generate` `{count?:1–12,
    channel?}`; or voice via Arlo's `generate_content_posts` tool (background).
  - Auto-fill cron: `scheduleRalphContent()` — **OFF by default**; `RALPH_AUTOGEN_ENABLED=1`
    to daily top-up to `RALPH_AUTOGEN_TARGET` (5) in `RALPH_AUTOGEN_PER_RUN` (3) steps.

**Layer 2 — LIVE (real publishing + analytics via Zernio).** `services/zernio.ts`
wraps [Zernio](https://zernio.com) (`https://zernio.com/api/v1`, `Authorization:
Bearer $ZERNIO_API_KEY`), the connection layer to Arthur's already-linked **Instagram**
(AQUATIC POOLS) and **Facebook** (Aquatic Pool & Spa) accounts.
  - `listZernioAccounts()` → connected accounts (id, platform, followers, pageId),
    cached 5 min. `GET /api/ralph/accounts` surfaces them.
  - `publishToZernio()` → `POST /posts` with `{content, mediaItems:[{type:'image',url}],
    platforms:[{platform, accountId, platformSpecificData:{pageId,firstComment}}],
    publishNow:true}`. **The image must be a public HTTPS URL returning raw bytes** —
    `publishRalphPost()` builds `${PUBLIC_BASE_URL||req-origin||fly}/api/seo/img/<id>.png`
    (Ralph's preview endpoint already serves raw PNG). On success the row is marked
    `published` with `external_post_id` + `external_url`; failures record `publish_error`.
  - `getZernioSocial()` → `GET /analytics?limit=100`, aggregated into real followers /
    engagement rate / reach / impressions / likes / comments / top posts (with live
    permalinks), cached 5 min. Merged into `GET /api/ralph/analytics` via
    `ralphAnalytics(social)` — the Overview KPIs + Top Posts light up for real.
  - Publish route: `POST /api/ralph/content/:id/publish`. **Publishing is a deliberate
    human tap** (Approvals "🚀 Approve & Publish" / pipeline "🚀 publish") — Arlo does
    NOT auto-publish (leaves-the-building rule). Only `instagram`/`facebook` channels
    publish; blog/email/gbp/linkedin stay in-app.
  - Schema: `migrateRalph()` adds `external_post_id`, `external_url`, `publish_error`.
  - **Secrets:** `ZERNIO_API_KEY` (Fly secret — never committed). Optional
    `PUBLIC_BASE_URL` (defaults to the request origin, then `https://arthur-arlo.fly.dev`)
    so Zernio can fetch the post image. Note: IG follower count isn't exposed in Zernio
    account metadata (shows null); FB fan_count + all engagement/reach are real.

  - Carousels publish all their images (Zernio `mediaItems`, up to 10). **Reels do NOT
    auto-publish** — they're shoot-ready scripts (no rendered video); `publishRalphPost`
    blocks them with a clear "film it, then upload" message. Reels flip to published when
    Arthur produces + posts them.

**Layer 3 — LEAD CAPTURE (next, the piece that closes the loop).** Content drives people
to comment/DM a keyword; to turn that into real leads for Arthur we watch the connected
inbox and respond. Zernio exposes `/inbox/conversations`, `/comments` (reply), and
`/inbox/messages` (send DM) on the same key. Planned: a keyword listener that auto-replies
to "DESIGN/QUOTE/POOL" comments with a DM, captures the contact into `leads`, and pings
Arthur/Sofia. Also: follower-history/demographics charts and scheduled auto-posting.

---

## 11. Sofia — phone + lead SMS (`routes/vapiWebhook.ts`, `routes/leads.ts`, `services/sms.ts`)

**Vapi** handles outbound sales calls and an inbound receptionist. `POST /api/leads`
creates a lead and fires an outbound Vapi call; `POST /api/webhooks/vapi` handles
`end-of-call-report` (extracts a lead via OpenAI). Call metrics on `/calls`.

**Lead SMS** now goes **directly to sms-gate.app** (SMS Gateway for Android, cloud mode)
via HTTP Basic auth — `services/sms.ts::sendSms()`. Replaced the deleted `aethon-claw`
hook. Env: `SMS_GATE_URL`, `SMS_GATE_USERNAME`, `SMS_GATE_PASSWORD`, `SMS_NOTIFY_TO`
(defaults baked in; **rotate the password and set as Fly secrets** — it's in git
history). Works only if the sms-gate account + its Android device are online.

---

## 12. Scheduled jobs (`app.ts` → `services/crons.ts`)

| Schedule | What |
|---|---|
| every 24h | memory decay |
| Sun 3am | weekly synthesis |
| every 3 days | Lauren SEO run (one page) |
| hourly | publish approved+due SEO content |
| daily (+2min boot) | SEO live-URL check |
| ~12h (+10min boot) | reflection engine |
| every 15 min (+90s boot) | inbox/calendar monitor + triage |
| daily (+3min boot) | Search Console ranking sync |
| first-open-of-day | morning brief (else time-aware greeting) via `/api/brain/activate` |

---

## 13. Environment / secrets (`.env.example` is the reference)

Required for full function: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`,
`ELEVENLABS_API_KEY`, `VAPI_*`, `GITHUB_TOKEN` + `SEO_GITHUB_REPO`,
`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_REDIRECT_URI`, `BRAVE_API_KEY`,
`SMS_GATE_*`. Tunables: `ARLO_MODEL`, `ANTHROPIC_MODEL`, `ELEVENLABS_*` (voice), 
`ARLO_TOOLS_ENABLED`, `GOOGLE_SYNC_MS`, etc. **Every feature no-ops cleanly if its
key is absent** — preserve that.

---

## 14. Deployment & branch workflow ⚠️

- **There is NO `main` branch.** The mainline / integration branch is
  **`claude/focused-mendel-Ch67G`** (referred to as "mendel"). It is the default branch.
- Feature work happens on a working branch (e.g. `claude/explore-repo-arlo-8ixtvk`),
  then is **merged into mendel** and pushed. The user's standing instruction is
  *"mendel is all we need."*
- **Auto-deploy** (`.github/workflows/deploy.yml`) triggers only on push to
  `main`/`master` → `flyctl deploy`. **Pushing to mendel does NOT auto-deploy** —
  promote/deploy deliberately.
- Standard loop each task: edit → `npm run build` (must pass) → commit on the working
  branch → push → merge into mendel → `npm run build` on the merge → push mendel.
- Do not push directly to `main`/`master` (that deploys to production) without explicit
  intent.

Local sanity before committing: `npx tsc --noEmit` (types), `node --check` on changed
client JS, and a quick boot (`DB_PATH=/tmp/x.db PORT=39xx node server/dist/app.js`) to
confirm no runtime errors. Client HTML/JS is **not** compiled — test by boot + curl.

---

## 15. Conventions & gotchas (read before editing)

- **Graceful degradation is mandatory** — missing key/integration → warn + no-op.
- **Gated actions:** reversible/in-house things Arlo may do directly (draft, schedule an
  inspection, add a calendar event, open a tab). Anything leaving the building or
  committing money/promises (send email, pricing) is **gated to Arthur's approval**.
- **Voice:** never block the mic-resume on async work; keep ordered TTS; always seal the
  TTS pipeline (`markTtsComplete`); keep the STT silence keepalive.
- **Nav wiring (Lauren):** keep balanced-`<ul>` insertion; new sections are top-level
  tabs, not nested under Blog.
- **Dashboards:** if it polls, add the `shell-visibility` pause listener.
- **Schema changes:** add tables/columns in `db/schema.ts` (idempotent `initDb` +
  migrate helpers). Never assume a column exists without a migration.
- **Model identity:** don't put internal model IDs in commits/PRs/artifacts.
- **Secrets:** prefer env/Fly secrets; the sms-gate password is currently a baked
  default that should be rotated.

---

## 16. Known TODO / next steps

- **Ralph:** connect social APIs (Meta/IG, Facebook, LinkedIn) to light up the locked
  audience/engagement metrics; then auto-drafting into the Approvals queue.
- **Arlo tools:** expand the tool loop (send-email-with-confirmation, reschedule);
  live camera viewing; PDF ingestion is client-side via pdf.js (works, could move
  server-side).
- **Search Console / Google:** user must reconnect the 3 accounts after the
  `webmasters.readonly` scope addition, and verify the site in GSC, for real rankings.
- **Provider drift:** comments/env still reference Claude for the chat brain in places;
  the live chat brain is OpenAI `gpt-4o`. Anthropic is used for extraction/reflection/
  synthesis/triage and as Lauren's fallback.

---

## 17. Reusable template

`templates/ui-shell/` is a **neutral, brand-free** copy of the shell (collapsible
sidebar + tabbed iframes + the voice→tab `postMessage` navigation contract) with a
README, for dropping the "hull" UI into other systems. No colors, no Arlo specifics.

---

*Aquatic Pool & Spa · Arthur-Arlo. Keep this doc updated when the architecture changes.*
