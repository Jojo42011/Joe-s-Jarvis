# LAST LEFT OFF — JARVIS (Joe Stewart)

**Date:** May 18, 2026  
**Production URL:** https://joes-jarvis.fly.dev/  
**Fly app name:** `joes-jarvis`  
**Region:** `ord`  
**Last Fly deploy:** May 18, 2026 — `deployment-01KSBJRZTA511P5MZJX3J47FKY` (temporal awareness, upload ack, Nano Banana image gen, job-site REC/transcripts, plus prior mobile UI/TTS/briefing fixes).  
**Production:** https://joes-jarvis.fly.dev/

---

## For the next agent — read this first

This project is **not** a chatbot. It is:

1. **Four-system brain** (Perception → Judgment → Execution → Communication) on a 5-minute loop  
2. **Session-aware chat** with execution-log truth, multi-turn Claude, immediate Gmail send  
3. **Live-data ReAct** — Brave runs *before* JARVIS speaks on weather/news/lookup questions  
4. **World intelligence** — daily 7am Ohio `senseWorld()`, `world_intel` cache, promotion to durable memory  
5. **Smart 24-hour briefing** — full brief only when 24h elapsed since `last_briefing_delivered`  
6. **Document intelligence** — upload PDF/txt/md/csv/html/images, chunk, search, cite in chat  
7. **Memory system overhaul** — unified categories, contradiction checks, decay, audit queue, HUD memory panel  
8. **Temporal awareness** — Ohio Eastern time in every Claude prompt; relative ages on memory + execution log; natural briefing phrasing  
9. **Upload acknowledgment** — immediate spoken ack on any upload (single or batch); session-scoped upload context for follow-ups  
10. **Nano Banana image generation** — upload image + generation intent → finished preview in photo panel; `store it` saves to documents  
11. **Job-site recording mode** — mobile-only REC toggle; Deepgram capture → summarize → `transcripts` table; query by weekday  

**Do not** re-introduce:

- Auto-briefing on every page load  
- `send_ready` / draft approval loops  
- `pendingAction` confirmation flows  
- Blue/cyan UI accents (palette: white / black / maroon / brighter reds only)  

**Do not deploy** unless Joe explicitly asks.

**Do not touch** unless asked: email brain internals, Brave search service, ReAct loop core, document intelligence ingest/search core, Vapi.

**Replication template:** [README.md](./README.md) → “Replication template”.

---

## Current system state — complete inventory (read before any work)

This section is the **single checklist** of everything built in the May 15–18 arc. A fresh Cursor chat should treat this as ground truth.

### 1. World intelligence + Brave Search wired

| Piece | Where | Behavior |
|-------|--------|----------|
| **Brave API** | `server/src/services/braveSearch.ts` | `searchWeather`, `searchNews`, `searchWeb`; used by chat ReAct + brain |
| **Daily pipeline** | `perception.ts` → `senseWorld()` | ~**7:00am Ohio**; Claude generates queries across domains; results → `world_intel` table |
| **Judgment** | `judgment.ts` | Claude scores each item HIGH \| MEDIUM \| LOW |
| **Promotion** | `judgment.ts` → `promoteWorldIntelToMemory()` | Up to 3 HIGH durable facts/cycle → `jarvis_memory` via `rememberMemory()` |
| **Cache** | `world_intel` table | ~48h; injected in `buildDynamicSystemPrompt()` + `worldIntelCache` in chat state |
| **On-demand APIs** | `routes/intelligence` (or brain exports) | `GET /api/intelligence/world`, `POST .../world/search`, `POST .../world/run` |
| **Secret** | `BRAVE_API_KEY` on Fly | Required for world intel + live chat |

### 2. ReAct loop — replaces two-turn “let me check” chat

**Old failure mode:** Joe asks “what’s the weather?” → JARVIS says “checking…” → Joe asks again → answer.

**Current behavior (one exchange):**

1. `POST /api/chat` hits `runReactLiveDataRoute()` **before** normal Claude intent when `messageNeedsLiveDataSearch(message)` matches (weather, news, prices, Ohio/Holmes, “what’s going on”, etc.).
2. `decideSearchNeeds()` → Brave executes (`executeBraveSearchForChat`) — weather \| news \| web.
3. If Claude says `needs_search: false` but patterns match → **forced override** to search anyway (logged).
4. `synthesizeLiveDataAnswer()` — one complete `speech` + `intent: world.intel` returned in **same HTTP response**.
5. `stripCheckingLanguage()` removes any residual “stand by / checking” phrasing.
6. Optional async `promoteReActMemory()` for durable facts from search results.

**Key file:** `server/src/routes/chat.ts` — `runReactLiveDataRoute`, `decideSearchNeeds`, `messageNeedsLiveDataSearch`.

**Do not refactor ReAct** unless Joe asks — it is production-critical path.

### 3. Weather panel + GO / CAUTION / NO-GO

- ReAct weather path returns `ui.panel: "weather"`, `ui.action: "show"` (or `"open"`).
- Panel data includes: location, temperature, conditions, wind, **`crew_impact`**: `GO` \| `CAUTION` \| `NO-GO`, `crew_note`.
- **Client:** `client/index.html` — `openDynamicPanel('weather')`, `renderWeatherPanel()`; dynamic panel layer on right.
- Prompt contract in `systemPrompt.ts` — crew impact mandatory for field-relevant weather.

### 4. Seven domain expertise + self-directed research

Encoded in **`JARVIS_BASE_PROMPT`** (`systemPrompt.ts`):

1. Weather & field conditions (Ohio)  
2. Materials & supply chain  
3. Local Ohio business environment  
4. US & world events  
5. Landscaping & hardscaping industry  
6. FAA & drone regulations (Part 107, pressure-washing drones)  
7. Crew & labor conditions  

**Self-directed research rules** (same prompt): don’t re-search fresh cache; connect cross-domain (freeze + active job, tariff + hardscape quote); assess what’s worth remembering; quality over quantity.

**Brain guidance:** `WORLD_INTEL_SENSE_QUERY_DOMAIN_GUIDANCE` in `judgment.ts` appended to `senseWorld()` query generation.

### 5. Memory system overhaul

| Feature | Implementation |
|---------|----------------|
| **Unified categories** | `config/memoryCategories.ts` — 9 categories; no raw category strings on writes |
| **Contradiction detection** | `memory.ts` → `checkForContradiction()` before every `rememberMemory()` |
| **Confidence decay** | `queries.ts` → `applyMemoryConfidenceDecay()`; 7am Ohio; 90-day stale; prefs/clients never decay |
| **Smart corrections** | `preference_{topic}` keys via Claude; not `correction_{hash}` |
| **Extraction** | Expanded intents + `turnHasMemorySignals()` on `general.chat` |
| **Weekly audit** | `auditMemory()` Sundays 7am; delete \| merge \| flag |
| **Viewer panel** | Brain button in HUD → `/api/memory`, stats, edit, delete, Run Audit |
| **API** | `routes/memory.ts` |

Full step-by-step detail in section **“MEMORY SYSTEM OVERHAUL”** below.

### 6. Document intelligence — upload, chunk, cite

| Piece | Where |
|-------|--------|
| Schema | `notebooks`, `documents`, `document_chunks` |
| Service | `services/documentIntelligence.ts` — ingest, chunk 600 / overlap 100, search, answer |
| Routes | `routes/documents.ts` — upload, list, delete, search |
| Chat | `tryDocumentChatRoute()` runs **before** ReAct; `intent: document.search`; must cite document title |
| HUD | Upload button, count badge, library (Shift+click), delete |

### 7. 24-hour briefing system — time-elapsed, not clock-based

- **Rule:** Full brief when **≥24 hours** since `last_briefing_delivered` (also mirrored to `last_briefing_time` for legacy reads).
- **Not** tied to 6:30am, noon, or midnight — Joe can activate at any hour.
- **Functions:** `shouldDeliverBriefing()`, `compileBriefingData()`, `generateBriefing()`, `deliverBriefingIfDue()` in `communication.ts`.
- **Trigger:** `__JARVIS_ACTIVATE__` → `communication.decide(..., 'joe_activated')` → if due, `intent: morning_brief` + rundown panel with queue/world intel summary.
- **Between briefs:** “All clear sir. What do you need?” when nothing new; no repeat of last full brief in same session.
- **State keys:** `system_state.last_briefing_delivered`, `last_briefing_summary`, `last_briefing_time`.

### 8. Morning brief logs to `execution_log`

On every delivered full brief:

```typescript
logExecution({
  type: "morning_brief",
  action: "briefing_delivered",
  summary: `Brief delivered. Emails handled: …, Queue: …, Intel: …`,
  result: "success"
});
```

**File:** `server/src/brain/communication.ts` → `deliverBriefingIfDue()`.

Chat activation path surfaces `intent: "morning_brief"` so memory extraction can run on that turn.

---

## Known issues & architectural debt (Cursor review — do not ignore)

These are **intentionally documented** so the next agent does not mistake gaps for bugs to “fix” without a plan.

| Issue | Severity | Detail |
|-------|----------|--------|
| **`chat.ts` monolith** | Maintainability | Split into `routes/chat/*` (`processChat.ts`, `liveData.ts`, `uploadOrchestrator.ts`, etc.). Further splits optional. |
| **Dumb memory reads** | Product | **Partially fixed:** `getMemoriesForMessage()` by intent/keywords. No embeddings yet. |
| **Circuit breakers** | Ops | **Implemented** for Gmail, Brave, Claude — still no global budget caps. |
| **No automated tests** | Quality | Decay, contradiction, audit, briefing 24h rule, ReAct override — **untested**. Golden-path tests recommended before large refactors. |
| **Audit auto-deletes** | Safety | Weekly `auditMemory()` can **delete/merge** via Claude without human approval. HUD + `execution_log` are the safety net — watch first production audits. |
| **Gmail OAuth dead on prod** | Blocker | `GMAIL_REFRESH_TOKEN` expired/revoked → brain email perception off, rundown noise. Joe must re-OAuth + `fly secrets set`. |
| **Prod lag** | Deploy | Latest feature deploy: `deployment-01KSBJRZTA511P5MZJX3J47FKY`. Run `git status` — repo may be ahead of last commit. |
| **`NANO_BANANA_API_KEY` missing** | Feature | Image gen speaks “unavailable” until Fly secret set. |
| **Two “world” layers** | Conceptual | `world_intel` (cache) vs `jarvis_memory.world_intel` (durable) vs live Brave — prompt explains; easy to confuse in code. |
| **`intelligence.ts` legacy** | Cleanup | Old 5-min loop replaced by `brainCycle()`; file mostly dead. |
| **Gmail archive scope** | Minor | May lack `gmail.modify`; archive warn-fails. |

---

## What we just did (May 18, 2026) — MEMORY SYSTEM OVERHAUL

Full rebuild of `jarvis_memory` — memory is treated as the operator’s long-term business knowledge, not ad-hoc prompt stuffing.

### Step 1 — Unified category system

- **`server/src/config/memoryCategories.ts`** — single source of truth:
  - `MEMORY_CATEGORIES`: `business_context`, `client_relations`, `operator_preferences`, `world_intel`, `crew_labor`, `vendor_supplier`, `drone_faa`, `industry`, `document_facts`
  - `REACT_DOMAIN_TO_CATEGORY` — maps legacy ReAct domains → unified categories  
  - `normalizeMemoryCategory()` — used on every write  
- Re-exported from **`server/src/services/memory.ts`** as `MEMORY_CATEGORIES`  
- **`systemPrompt.ts`** — MEMORY SYSTEM block documents all categories for Claude  

### Step 2 — Contradiction detection before every write

- **`checkForContradiction()`** + **`rememberMemory()`** in `memory.ts`  
- Claude compares existing vs proposed value → `update` | `keep_existing` | `merge`  
- Fail-open: if Claude fails, write proceeds  
- Logs to `execution_log` on keep/merge  
- All durable writes go through **`rememberMemory()`**, not raw `saveMemory()` (internal to `queries.ts`)

### Step 3 — Confidence decay

- **`applyMemoryConfidenceDecay()`** in `queries.ts`  
- Daily at **7am Ohio** via **`runMemoryMaintenance()`** hooked in `perception.ts` (same window as world intel)  
- Facts with `last_seen` older than 90 days: `-0.05` confidence per run (floor 0.1)  
- **Never decay:** `operator_preferences`, `client_relations`  
- Auto-delete rows with confidence < 0.1 (logged)  
- `system_state.last_memory_decay_run`

### Step 4 — Smart correction keys

- **`savePreferenceFromCorrection()`** — Claude generates stable `preference_{topic}` keys (e.g. `preference_email_tone`)  
- Replaces `correction_{hash}` sprawl  
- Category always `operator_preferences`  
- Wired from **`chat.ts`** `applyMemoryFeedbackToSpeech()` on correction signals  

### Step 5 — Expanded memory extraction

- **`shouldExtractMemories()`** intents: `gmail.send_reply`, `intelligence.handled`, `execution.log`, `world.intel`, `document.search`, `general.chat`, `morning_brief`  
- **`turnHasMemorySignals()`** guard on `general.chat` — only extract when client/price/preference/business fact/decision signals present  
- **`document.search`** → forces `document_facts` category; key pattern `fact_{slug}_{topic}`  
- **`claude.ts`** `MEMORY_EXTRACTION_SYSTEM` updated to unified categories (+ legacy alias map)  

### Step 6 — Weekly memory self-audit

- **`auditMemory()`** — batches of 50 rows to Claude → delete | merge | flag  
- Sundays at 7am Ohio (same `runMemoryMaintenance()`; skips if already ran today)  
- Schema: **`flagged`**, **`flag_reason`** on `jarvis_memory` (migration in `schema.ts`)  
- Summary logged to `execution_log`; `system_state.last_memory_audit_run`  

### Step 7 — Memory API

- **`server/src/routes/memory.ts`** (registered in `index.ts`):
  - `GET /api/memory` — all memories grouped by category  
  - `GET /api/memory/stats` — totals, avg confidence, stale (<0.3), flagged, decay/audit timestamps  
  - `DELETE /api/memory/:id`  
  - `PATCH /api/memory/:id` — value, confidence, clear flag  
  - `POST /api/memory/audit` — manual audit trigger  

### Step 8 — Memory viewer HUD

- **`client/index.html`** — brain icon button next to document upload  
- Right-sliding **JARVIS MEMORY** panel: stats bar, category tabs, cards with confidence bars  
- Stale (<0.3) red, flagged amber, high conf (>0.8) green dot  
- Edit / Delete / Run Audit with toast summary  
- Empty state: *"No memories in this category yet, sir."*

### Call sites updated to `rememberMemory()` + categories

- `chat.ts` — ReAct promotion (`REACT_DOMAIN_TO_CATEGORY`), corrections, preferences  
- `judgment.ts` — `promoteWorldIntelToMemory()` → `MEMORY_CATEGORIES.WORLD_INTEL`  
- `memory.ts` — `extractAndSaveMemory()`  
- Removed duplicate `extractAndSaveMemory` from **`intelligence.ts`** (dead path)

### Build status

- [x] **`npm run build` passes** (May 18, 2026)  
- [x] **Fly deploy** — `deployment-01KRYSXM5S77HVFRHXRVKDA7V5` (May 18, 2026)  
- [ ] Production smoke test: memory panel, doc upload, weather ReAct, activation brief  

---

## Earlier work in this arc (May 15–18, still in codebase)

### Live data + weather HUD (`chat.ts`, `client/index.html`)

- Broadened live-data detection; force Brave when Claude says no search but message needs live data  
- Weather panel: `ui.panel: "weather"`, `action: "show"`, GO/CAUTION/NO-GO crew impact  

### Operator wiring (`systemPrompt.ts`, `chat.ts`)

- `OPERATOR_SYSTEMS_WIRING` injected into chat state each turn  
- Brain, ReAct, memory layers, HUD panels documented in base prompt  

### Smart 24-hour briefing (`communication.ts`, `queries.ts`, `schema` comments)

- `last_briefing_delivered`, `last_briefing_summary` in `system_state`  
- `shouldDeliverBriefing()`, `compileBriefingData()`, `generateBriefing()`, `deliverBriefingIfDue()`  
- `__JARVIS_ACTIVATE__` → `intent: morning_brief` when 24h elapsed  

### Document intelligence

- Tables: `notebooks`, `documents`, `document_chunks`  
- **`server/src/services/documentIntelligence.ts`** — ingest, chunk 600/100 overlap, search, answer  
- **`server/src/routes/documents.ts`** — upload, list, delete, search  
- **`chat.ts`** — `tryDocumentChatRoute()` before ReAct; `intent: document.search`  
- HUD: doc upload button, count badge, library panel (Shift+click), delete  

### World intelligence (existing + integrated with memory)

- `world_intel` table, `senseWorld()` 7am scheduler in `perception.ts`  
- `judgment.ts` promotes HIGH items → `jarvis_memory` via `rememberMemory()`  
- On-demand: `POST /api/intelligence/world/search`, `/world/run`  

---

## Where we are leaving off (next chat should start here)

### Shipped and deployed (`deployment-01KSBJRZTA511P5MZJX3J47FKY`)

**Four additive features (May 18, 2026 — one deploy, no brain/Gmail architecture changes):**

| # | Feature | Key files | How it works |
|---|---------|-----------|--------------|
| 1 | **Temporal awareness** | `server/src/utils/temporal.ts`, `systemPrompt.ts`, `memoryOrchestrator.ts`, `communication.ts`, `utils.ts` | `Current time: Saturday May 23 2026 3:47 PM EDT` prepended to every dynamic system prompt. Memory lines: `Remembered 3 days ago: …`. Execution log in operator state uses `formatExecutionLogLine()` — relative time + human summary, no raw timestamps/hex IDs. Briefings told to say “this morning you had 3 emails handled”, etc. **Today** = since midnight **Ohio Eastern**, not rolling 24h. |
| 2 | **Upload acknowledgment** | `server/src/services/uploadSession.ts`, `routes/documents.ts`, `client/index.html` | On upload complete, API returns `speech` immediately (before chat). Single/batch wording per spec. `POST /api/documents/upload-batch` (multipart `files`, max 12). Session uploads keyed by `x-session-id`; `pendingUploads` in `buildChatStateForClaude()`. Failures: “Upload failed sir, please try again.” Session context is **in-memory only** — cleared on page reload. |
| 3 | **Nano Banana image gen** | `server/src/services/nanoBanana.ts`, `routes/chat/uploadOrchestrator.ts`, client photo panel | Intent: generate / finish this / make this look done, etc. Uses `NANO_BANANA_API_KEY` + optional `NANO_BANANA_API_BASE` (default `https://nanobanana.aikit.club`). `POST /v1/images/edits` with reference image from session buffer. Multiple images → ask which one. Client speaks “Generating now sir, one moment.” before long wait. UI: `ui.panel: "photo"`. `store it` → ingest PNG to documents; `send it` → “Send isn’t wired yet sir.” Graceful if key missing. |
| 4 | **REC / transcripts** | `server/src/db/transcriptQueries.ts`, `routes/transcripts.ts`, `schema.ts` migration, mobile REC in `client/index.html` | Mobile-only **REC** button (desktop hidden). Continuous Deepgram, no Claude during record. Stop → `POST /api/transcripts/summarize` → Claude JSON summary → SQLite `transcripts`. Mic disabled while recording. Wake lock when available; 3h auto-save; reconnect gaps logged as `[connection gap ~Xmin]`. Chat: “What did we decide on Tuesday?” → `tryTranscriptQueryRoute()`. |

**Also in this deploy (earlier same arc, same codebase):**

- Briefing death-spiral fix: mutex watchdog, operational brief route before Brave, rundown cache 5 min, circuit logging only on state change  
- Mobile TTS: `unlockAudioFromUserGesture()` + Web Audio API playback (iOS autoplay)  
- Mobile immersive UI (≤767px): radar + bottom bar only; desktop unchanged  
- Chat modularized under `server/src/routes/chat/` (`processChat.ts`, `liveData.ts`, `operationalBrief.ts`, `truthGuard.ts`, etc.)

### Chat route order (`processChat.ts`)

Use this order when debugging — **do not reorder casually**:

1. `__JARVIS_ACTIVATE__`  
2. `tryFetchEmailsRoute` / `tryEmailConnectionRoute`  
3. `tryOperationalBriefRoute` (before Brave-heavy paths)  
4. `tryOperatorStatusRoute`  
5. `tryOpenEndedBriefingRoute`  
6. **`tryTranscriptQueryRoute`** (new)  
7. **`tryUploadFollowUpRoute`** (store/send/analyze uploaded files)  
8. **`tryImageGenerationRoute`** (new)  
9. `tryDocumentChatRoute`  
10. `runReactLiveDataRoute`  
11. Normal Claude intent path + truth guard + memory extraction  

### Done locally / in prod tree

- [x] All four features above implemented  
- [x] `npm run build` passes  
- [x] `fly deploy -a joes-jarvis` — `deployment-01KSBJRZTA511P5MZJX3J47FKY`  
- [x] Memory overhaul, documents, ReAct, briefing, circuit breakers, chat split, cinematic HUD (prior passes)  

### Not done / next priorities for Joe or next agent

1. **`NANO_BANANA_API_KEY` on Fly** — image generation returns “unavailable” until set:  
   `fly secrets set NANO_BANANA_API_KEY=... -a joes-jarvis`  
2. **Production smoke test** (phone + desktop):  
   - Upload single + multi file → immediate spoken ack  
   - Upload lawn photo → “finish this” → photo panel + store to documents  
   - REC on mobile → stop → summary spoken + row in `transcripts`  
   - Ask “what did we decide on [weekday]?” after a recording  
   - Briefing/status uses natural time phrases  
3. **Gmail OAuth** — `GMAIL_REFRESH_TOKEN` may still be expired on prod → brain email perception off; Joe re-OAuth + `fly secrets set`  
4. **Git commit / PR** — large uncommitted set; Joe did not ask for commit in feature pass — run `git status` before assuming prod = HEAD  
5. **Automated tests** — still none for temporal, upload session, image gen, transcripts  
6. **`send it` for generated images** — explicitly not built; ack only  
7. **Desktop Execution Feed** — may still be hidden by `hud-fold` CSS on desktop (reported earlier, not fixed in REC pass)  

### Files the next agent will touch most often

| Path | Purpose |
|------|---------|
| `server/src/utils/temporal.ts` | Ohio-relative time for prompts, memory, execution log |
| `server/src/services/uploadSession.ts` | In-memory session uploads + generated image buffer |
| `server/src/services/nanoBanana.ts` | Image-to-image API client |
| `server/src/routes/chat/uploadOrchestrator.ts` | Image gen, upload follow-up, transcript query routes |
| `server/src/routes/chat/processChat.ts` | Main chat pipeline + route order |
| `server/src/routes/documents.ts` | Upload + upload-batch + speech in response |
| `server/src/routes/transcripts.ts` | Summarize + search transcripts |
| `server/src/db/transcriptQueries.ts` | `transcripts` CRUD + Claude summarize |
| `server/src/config/systemPrompt.ts` | Base prompt + temporal memory lines |
| `server/src/routes/chat/memoryOrchestrator.ts` | `buildChatStateForClaude()` |
| `client/index.html` | Mobile REC, upload batch, photo panel, TTS, immersive CSS |
| `LAST_LEFT_OFF.md` | This handoff doc |

---

## What we just did (May 18, 2026) — FOUR ADDITIVE FEATURES (DEPLOYED)

Single PR scope: temporal + upload ack + Nano Banana + REC/transcripts. **Zero changes** to core brain loop, Gmail send logic, or ReAct decision core.

### 1. Temporal awareness

- **`server/src/utils/temporal.ts`**
  - `formatCurrentTimeForPrompt()` — `Current time: {weekday} {month} {day} {year} {time} {TZ}`
  - `formatRelativeAge()` — Ohio calendar day logic (“this morning”, “2 hours ago”, “two days ago”)
  - `formatMemoryLine()`, `formatExecutionLogLine()`, `formatBriefingTimePhrase()`
- **`buildDynamicSystemPrompt()`** — prepends current time to every cached dynamic prompt
- **Memory in prompt** — `Remembered {age}: {category} — {key} = {value}` (not raw `last_seen`)
- **`buildChatStateForClaude()`** — `executionLogToday[].line` / `.when`; grouped summary uses relative times; `pendingUploads` list
- **Briefings** — fallback + Claude user prompt instruct natural time references

### 2. Upload acknowledgment (all file types)

- **`uploadSession.ts`** — `Map<sessionId, SessionUpload[]>` + in-memory image buffers for generation
- **`POST /api/documents/upload`** — returns `{ speech, files, ... }`; header `x-session-id`
- **`POST /api/documents/upload-batch`** — multipart `files[]`, one ack for whole batch
- **Client** — `multiple` on file input; `uploadDocumentFiles()`; speaks server `speech` on success (not old “added to knowledge base” only)
- **MIME expanded** — docx, gif, etc.

### 3. Nano Banana image generation

- **Env:** `NANO_BANANA_API_KEY` (required), `NANO_BANANA_API_BASE` (optional)
- **`nanoBanana.ts`** — `generateFromReferenceImage()` → `POST {base}/v1/images/edits`, `response_format: b64_json`
- **`uploadOrchestrator.ts`** — `tryImageGenerationRoute`, `tryUploadFollowUpRoute`, `tryTranscriptQueryRoute`
- **Client** — `IMAGE_GEN_INTENT` → immediate “Generating now sir, one moment.”; `renderPhotoPanel()` for `ui.panel === 'photo'`

### 4. Meeting / job site recording

- **Schema migration** — `transcripts` table: `id`, `title`, `date`, `duration_seconds`, `raw_transcript`, `summary`, `action_items`, `created_at`
- **`POST /api/transcripts/summarize`** — body: `rawTranscript`, `durationSeconds`, `date`; always saves raw even if summarize fails
- **`GET /api/transcripts/search?q=...`** — weekday hint matching (Ohio)
- **Client (mobile ≤767px only)** — `#recButton`, `#recordingTimer`, `recordingModeActive`, mutual exclusion with mic, wake lock, 3h cap, Deepgram reconnect gaps

### Verification

- [x] `npm run build` passes  
- [x] `fly deploy -a joes-jarvis` succeeded  
- [ ] Joe smoke test on iPhone (upload ack, REC, image gen with API key)  

---

## Earlier “where we left off” (May 18 pre-feature-pass) — superseded by section above

<details>
<summary>Archived: foundation hardening checklist (still true in codebase)</summary>

1. Memory overhaul (all 9 steps) — done  
2. Document intelligence — done  
3. Smart briefing + live ReAct + weather panel — done  
4. Foundation hardening: chat split, smart memory reads, circuit breakers, audit queue, Gmail token refresh — done  
5. Latency/UI/circuit/cinematic HUD passes — done  
</details>

---

## Current architecture (May 18, 2026)

```
┌──────────────────────────────────────────────────────────────────┐
│  client/index.html                                                │
│  Voice (Deepgram WS) | REC (mobile) | HUD panels | docs upload (batch) | MEMORY panel   │
│  POST /api/chat  |  POST /api/documents/upload-batch  |  POST /api/transcripts/summarize │
└────────────────────────────┬─────────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────────┐
│  server/src/index.ts                                              │
│  brainCycle() every 5 min | 7am: world intel + memory maintenance │
└────────────────────────────┬─────────────────────────────────────┘
                             │
     ┌───────────────────────┼───────────────────────┐
     ▼                       ▼                       ▼
┌─────────┐           ┌─────────────┐         ┌──────────────┐
│ brain/  │           │ routes/     │         │ SQLite       │
│ cycle   │           │ chat, docs, │         │ /data Fly    │
│         │           │ memory, ... │         │ jarvis.sqlite│
└─────────┘           └─────────────┘         └──────────────┘
```

**Memory write path:** any feature → `rememberMemory()` → `checkForContradiction()` → `saveMemory()`  
**Memory read path (chat):** `buildDynamicSystemPrompt(message)` → `getMemoriesForMessage(message, 20)` (intent/category/keyword relevance; excludes flagged + confidence `<0.3`) + world_intel 48h block  
**Truth path:** `execution_log` + `enforceTruthfulSpeech()` in chat  

---

## Database tables (SQLite)

| Table | Purpose |
|-------|---------|
| `conversations` | Chat per `session_id` |
| `conversation_state` | UI + `operator_context` |
| `execution_log` | **Truth** for actions taken |
| `jarvis_memory` | Durable memory: category, key, value, confidence, occurrence_count, **flagged**, **flag_reason** |
| `memory_audit_queue` | Pending audit delete/merge/flag candidates requiring human approval |
| `world_intel` | Brave cache ~48h, relevance, briefed |
| `priority_queue` | Brain triage |
| `system_state` | Cursors, briefing, `last_memory_decay_run`, `last_memory_audit_run`, alerts |
| `notebooks`, `documents`, `document_chunks` | Document intelligence |
| `transcripts` | Job-site / meeting recordings (raw + summary + action_items) |
| `calls`, `texts`, `priority_contacts`, `contacts`, ... | Ops data |

---

## API surface (added since May 15)

| Method | Path | Notes |
|--------|------|--------|
| GET | `/api/memory` | Grouped memories + `lastAudit` |
| GET | `/api/memory/stats` | Totals, stale, flagged, timestamps |
| PATCH | `/api/memory/:id` | Edit value / confidence / clear flag |
| DELETE | `/api/memory/:id` | Manual delete + log |
| POST | `/api/memory/audit` | Run `auditMemory()` and queue candidates only |
| GET | `/api/memory/audit-queue` | Pending audit candidates |
| POST | `/api/memory/audit-approve` | Execute approved delete/merge/flag actions |
| POST | `/api/documents/upload` | Single file; returns `speech` + ingest metadata |
| POST | `/api/documents/upload-batch` | Multipart `files[]`; one batch ack |
| GET | `/api/documents` | List documents |
| DELETE | `/api/documents/:id` | Remove doc + chunks |
| POST | `/api/documents/search` | RAG search + answer |
| POST | `/api/transcripts/summarize` | End recording → summarize → save `transcripts` |
| GET | `/api/transcripts/search?q=` | Find transcripts (weekday hints) |

(Plus existing: `/api/chat`, `/api/intelligence/*`, `/api/rundown`, voice, calls, health.)

---

## Environment / secrets (Fly)

```
ANTHROPIC_API_KEY
BRAVE_API_KEY          # world intel + live ReAct
DEEPGRAM_API_KEY
ELEVENLABS_API_KEY
NANO_BANANA_API_KEY    # image finish generation (uploadOrchestrator) — set on Fly for prod
NANO_BANANA_API_BASE   # optional; default https://nanobanana.aikit.club
GMAIL_CLIENT_ID
GMAIL_CLIENT_SECRET
GMAIL_REFRESH_TOKEN    # ⚠️ may be expired on prod
VAPI_*
PORT=3000
DB_PATH=/data/jarvis.sqlite
```

---

## Commands

```bash
npm install
npm run build
npm run dev          # local

fly deploy -a joes-jarvis
fly logs -a joes-jarvis
fly secrets list -a joes-jarvis
```

---

## Known issues (quick list)

See table **“Known issues & architectural debt (Cursor review)”** above for full context. Summary:

1. Gmail refresh token revoked (prod blocker)  
2. Prod may lag repo — deploy when Joe asks  
3. Memory reads are now intent-based, but not embedding/semantic retrieval  
4. Chat route is modularized, but still needs focused tests before deeper refactors  
5. Circuit breakers exist, but no full budget/rate-limit policy yet  
6. No automated tests  
7. Audit actions are gated by queue approval, but need prod smoke test  
8. `intelligence.ts` legacy + Gmail archive scope  

---

## What we just did (May 18, 2026) — LATENCY / UI SYNC / CIRCUIT COMPLETION

**No deploy. No commit.** This pass stayed local and focused on delivery speed, HUD sync, and circuit-breaker coverage.

### Part 1 — Latency optimization

- `server/src/routes/chat/memoryOrchestrator.ts`
  - `buildChatStateForClaude()` now injects only the last 3 raw `execution_log` rows.
  - Older same-day execution rows become `executionLogSummary`, grouped by action with count and most recent timestamp.
  - Truth guard still has recent raw actions, but the Claude state block is much smaller.
- `server/src/routes/chat/index.ts`
  - Replaced `getRecentConversation(sessionId, 30)` with smart history selection:
    - last 8 turns always kept verbatim
    - turns 9-20 kept only when business-critical keywords appear
    - anything older than 20 dropped
  - Added a fast path for simple non-business chat (greetings, confirmations, capability/status chatter) using minimal Claude context.
  - Added structured timing log:
    - `[Chat] prompt_build: Xms | claude: Xms | tools: Xms | total: Xms`
- `server/src/services/claude.ts`
  - Added `generateFastJarvisResponse()` capped at 100 tokens with no state/history/memory block.
- `client/index.html`
  - Reduced `UTTERANCE_COMMIT_MS` from `3000` to `1500` for faster perceived voice response.

### Part 2 — UI/backend sync

- `client/index.html`
  - Rundown panel now renders both `queueItems` and grouped `priorityQueue` payload shapes.
  - Removed dead `pendingActionBadge` DOM/CSS/JS references.
  - Added visible Operations metrics wired to `/api/rundown`: priority calls, messages, flagged emails, active crews.
  - `/api/rundown` polling now updates visible HUD elements instead of fetching unused data.
- `server/src/routes/chat/liveData.ts`
  - Fixed weather/live-data mojibake artifacts (`Â°F`, `â€”`) so voice/UI output is clean.

### Part 3 — Circuit breaker completion

- `server/src/brain/judgment.ts`
  - Wrapped remaining direct Claude calls for world-intel judgment and memory promotion in `claudeCircuit.execute()`.
- `server/src/services/documentIntelligence.ts`
  - Wrapped document search and document answer Claude calls in `claudeCircuit.execute()`.
  - Logic unchanged; only the external Claude call boundary is protected.

### Verification

- `npm run build` passed after Part 1.
- `npm run build` passed after Part 2.
- `npm run build` passed after Part 3.
- `ReadLints` found no linter errors on edited files.

---

## What we just did (May 18, 2026) — CINEMATIC HUD / CONVERSATIONAL UX

**No deploy. No commit.** Frontend-first pass to match production-grade backend — visual polish, conversational rhythm, alert discipline, real execution truth in HUD.

### Part 1 — Alert & error session suppression

- `client/index.html`
  - Dismissed alert types stored in `sessionStorage` (`jarvis_alert_session_v1`).
  - Poll checks suppression before surfacing Gmail / circuit / queue alerts.
  - Alert re-shows only after condition heals (`hasAlert: false`) then fails again.
  - Dismiss no longer clears global backend alert (brain can keep logging; UI stays quiet for session).
- `server/src/db/queries.ts`
  - `getActiveAlertPayload()` now passes through alert `type` (e.g. `gmail_auth`) for reliable frontend suppression keys.

### Part 2 — Conversational UX flow

- STT websocket stays warm between turns — mic/socket persist; only audio streaming pauses during processing/TTS.
- Non-trivial commands get immediate varied acknowledgment TTS (`On it sir.`, `Checking now.`, etc.).
- Maroon processing indicator pulses on hologram during work.
- Full result auto-delivers via TTS when API completes; mic resumes without reconnect churn.

### Part 3 — Cinematic HUD & ambient effects

- Ambient animated grid + center glow layer (maroon/black palette).
- Brain cycle pulse on `/api/rundown` data change (5-min brain signal proxy).
- Breathing system status dots: BRAIN / GMAIL / CLAUDE / BRAVE via new `GET /api/system/status`.
- Panel slide/fade open + close transitions.
- Voice waveform reacts to speaking, listening, and processing states.

### Part 4 — Panel visual upgrades

- Weather panel: dominant GO / CAUTION / NO-GO hero badge (white/crimson palette only).
- Execution Feed panel: premium terminal styling wired to real `GET /api/execution/log`.
- Memory panel: confidence bars with high/mid/low visual weight + loading state.
- Rundown: sequential stagger animations + crimson priority accent.
- Activation sequence ripple on wake / `__JARVIS_ACTIVATE__`.

### Part 5 — Panel data sync

- New read-only APIs in `server/src/routes/health.ts`:
  - `GET /api/execution/log` — last 24h backend truth
  - `GET /api/system/status` — service health for HUD indicators
- Memory, rundown, weather, execution feed all show loading/empty states instead of blank panels.

### Verification

- `npm run build` passes with zero errors.
- No brain internals, ReAct core, document intelligence logic, or Vapi changes.

---

## User preferences (remember)

- JARVIS = **operator**, not chatbot — execute first, inform after  
- **No deploy** unless he says so  
- UI: maroon/red/white/black only  
- Voice: 1.5s silence commit, continuous mic after TTS  
- Briefing: 24h rule or “All clear sir”; never repeat same brief  
- Memory: should make Joe smarter about his business over time — panel is for trust/debug  

---

## Git note

**Do not commit unless Joe asks.** Large uncommitted set likely includes memory overhaul + documents + briefing. Run `git status` before assuming prod matches HEAD.

**Docs updated:** May 18, 2026 — four-feature deploy handoff + prior memory/doc/ReAct/mobile passes.

---

## Acceptance when we stopped (May 18, 2026)

- [x] Memory overhaul implemented per spec  
- [x] Four additive features: temporal, upload ack, Nano Banana, REC/transcripts  
- [x] `npm run build` passes  
- [x] `fly deploy` — `deployment-01KSBJRZTA511P5MZJX3J47FKY`  
- [x] Foundation hardening + latency/UI/circuit/cinematic passes in tree  
- [ ] Set `NANO_BANANA_API_KEY` on Fly and smoke-test image generation  
- [ ] Prod test: upload ack (single + batch), REC summarize, transcript query by weekday  
- [ ] Gmail re-auth on Fly  
- [ ] Git commit/PR if Joe wants repo synced to prod  
