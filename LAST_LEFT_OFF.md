# LAST LEFT OFF — JARVIS (Joe Stewart)

**Date:** June 1, 2026  
**Production URL:** https://joes-jarvis.fly.dev/  
**Fly app:** `joes-jarvis` (region `ord`)  
**DB (prod):** `/data/jarvis.sqlite` on Fly volume `jarvis_data`  
**UI:** Single file — `client/index.html`  
**Last Git commit:** `d7a7b0d` — *Save full project state* (repo is **far ahead** of this commit; most May–June work is **uncommitted**)

### Latest Fly deploys (this session arc)

| Deploy ID | What shipped |
|-----------|----------------|
| `deployment-01KT2FJ436AZTNQE4V1D32HS9J` | Notes system, **Claude tool-loop chat refactor**, expandable ≡ MENU, rundown cache prewarm, email/brain safety, session briefing dedup, business hours, queue maintenance, wake lock / PWA / Deepgram retries |
| `deployment-01KT2M1ZEDQWHXSP8G5XSG0ZRX` | Mobile header fix — hide clock, **STANDBY badge top-right** |

### Local only (NOT on prod yet)

- **Listening mode stop fix** — voice “stop listening” / “stop now” / “stand down” actually stops mic; **STOP LISTENING** on-screen button; no auto-restart after stop TTS. **Deploy when Joe asks.**

---

## For the next agent — read this first

JARVIS is Joe Stewart’s **autonomous AI operator** for Totally Outdoors LLC (Holmes County, Ohio)—not a chatbot.

**Two separate systems:**

1. **Background brain** (`server/src/brain/`) — Perception → Judgment → Execution → Communication every 5 minutes. **Do not refactor unless asked.**
2. **Interactive chat** (`POST /api/chat`) — Claude **tool-use ReAct loop** in `server/src/chat/`. Pattern-matching route handlers were **removed** from the main chat path (May–June 2026 refactor).

**Palette:** white / black / maroon / red only — no cyan/blue.

**Rules:** Do **not deploy** or **commit** unless Joe explicitly asks.

---

## Current chat architecture (June 2026 — ground truth)

### What runs on `POST /api/chat`

| Step | Handler | Notes |
|------|---------|--------|
| 1 | `__JARVIS_ACTIVATE__` | Unchanged — activation briefing via `activationBriefing.ts` / brain communication rules |
| 2 | Upload session only | If `getSessionUploads(sessionId).length` → `tryUploadFollowUpRoute`, `tryImageGenerationRoute` (Nano Banana / store-it) |
| 3 | **`runChatLoop()`** | **Everything else** — Claude decides tools, executes, synthesizes answer |

**Removed from main path** (files still exist, not wired): `tryFetchEmailsRoute`, `tryOperationalBriefRoute`, `runReactLiveDataRoute`, `generateJarvisIntentResponse`, `tryNotesRoute`, `tryDocumentChatRoute`, etc.

### Claude tool loop (`server/src/chat/`)

| File | Role |
|------|------|
| `tools.ts` | 13 Anthropic tool defs + executors |
| `runChatLoop.ts` | Up to 5 tool rounds → final speech; UI from tools used |
| `context.ts` | Lean context: Ohio time, queue count, last execution, 8 turns, **Jahan detection** |
| `systemPrompt.ts` | Tool rules + Jahan collaborator addendum |

**Tools:** `search_web`, `read_emails`, `send_email`, `get_calls`, `get_queue`, `book_calendar`, `save_note`, `get_notes`, `save_memory`, `get_memory`, `get_weather`, `search_documents`, `get_execution_log`

**Identity:** Messages like “this is Jahan” or session id containing `jahan`/`dev` → `jahan_developer` context (full access, collaborator tone).

**Truth:** `enforceTruthfulSpeech()` still runs on final speech in `runChatLoop`.

**Entry:** `server/src/routes/chat/processChat.ts` (slimmed ~250 lines).

### Old ReAct path

`server/src/routes/chat/liveData.ts` still exists but is **not** the primary chat router. Live search now happens via **`search_web`** tool inside the tool loop.

---

## Notes system (deployed)

| Piece | Location |
|-------|----------|
| Schema | `notes` table in `schema.ts` (`seen_in_rundown`, `promoted_to_memory`) |
| Queries | `saveNote`, `getRecentNotes`, `searchNotes`, `getUnacknowledgedNotes`, `markNotesSeenInRundown` |
| Service | `server/src/services/notes.ts` — entity extract (Haiku), promote to `jarvis_memory` as `note_{id}` |
| API | `GET/POST /api/notes`, `GET /api/notes/search` |
| Voice | Was `tryNotesRoute` — **now Claude `save_note` / `get_notes` tools** (notesRoute.ts orphaned) |
| Briefing | Unacknowledged notes (24h) in `compileBriefingData` + `/api/rundown` snippet |
| UI | ≡ MENU → NOTES; slide-in panel; manual save; VOICE/NOTE badges |

---

## Email & brain safety (deployed)

**Gmail (`server/src/services/gmail.ts`):**
- Notification/relay sender detection — no auto-reply to JobTread-style relays
- `resolveReplyRecipient`, `hasReadableInboundEmailContent`

**Judgment (`server/src/brain/judgment.ts`):**
- `applyNotificationEmailRouting`, `applyEmptyEmailBodyGuard`
- `maintainQueueBacklog()` — 10 items/cycle, 24h escalate, 7d auto-close stale queue

**Execution (`server/src/brain/execution.ts`):**
- Pre-send operator commentary block; empty-body guard; `blockOutboundEmail` queues for Joe

**Communication (`server/src/brain/communication.ts`):**
- Session-aware briefing via `spokenSessionTracker.ts` + `compileBriefingDataForSession`

**Gap:** Full 24h briefing still uses `briefedItemIds: []` for per-item dedup across days — open queue items can repeat across 24h briefs.

---

## Session / briefing dedup (partial)

- `spokenSessionTracker.ts` — `spokenThisSession` Map; filters activation/brief paths
- `operationalBrief.ts` — session-filtered brief + `recordBriefingKeys`
- **Not fixed:** cross-24h per-item dedup for full morning brief

---

## Latency & rundown (deployed)

- `RUNDOWN_CACHE_MS` = **15 min**; `prewarmRundownCacheIfStale()` after each brain cycle
- `buildRundownResponse()` exported from `routes/rundown.ts`

---

## Business hours (deployed)

- `googleCalendar.ts` — `enforceBusinessHours()` 8:45am–5pm weekdays Ohio
- `appointmentBooking.ts` — default 9am slot; uses enforceBusinessHours
- `book_calendar` chat tool uses same rules

---

## Mobile / voice UX (mixed deploy state)

### On production

- PWA manifest (inline data URI) + Apple web-app meta
- App **wake lock** on conversation mode; resume on `visibilitychange`
- Deepgram STT **8 retries**, exponential backoff 1s→16s; `sttIntentionalClose`
- Bottom bar: **≡ MENU | MIC | RUNDOWN** + command input
- Menu: Emails, Calls, Queue, Notes, Weather, Listening mode, Documents, Memory, Upload
- Mobile header: logo left, **STANDBY top-right**, clock hidden
- Tooltips on bar controls

### Local only — listening stop (needs deploy)

- `parseListeningControlCommand()` — “stop listening”, “stop now”, “stand down”, etc. **before** `/api/chat`
- `stopListeningMode()` — clears `conversationMode`, timers, mic; TTS with `skipRestart: true`
- **STOP LISTENING** button visible when `conversationMode` active
- Mic tap while listening → stops (toggle off)
- Fixes bug: JARVIS said “done sir” then **auto-restarted** mic via `scheduleListeningRestart()`

---

## Database tables (additions since May)

| Table | Purpose |
|-------|---------|
| `notes` | Joe’s voice/manual notes; Ohio time; memory promotion; rundown ack |
| `transcripts` | Job-site REC summaries (prior pass) |

Full inventory: see README.md + older sections in git history of this file.

---

## API additions (June 2026)

| Method | Path |
|--------|------|
| GET | `/api/notes?limit=20` |
| POST | `/api/notes` `{ content, source: 'voice' \| 'manual' }` |
| GET | `/api/notes/search?q=` |

(Plus all prior: `/api/chat`, `/api/memory/*`, `/api/documents/*`, `/api/transcripts/*`, `/api/rundown`, etc.)

---

## Project layout (key paths)

```
server/src/
├── chat/                    # NEW — Claude tool loop (primary chat brain)
│   ├── tools.ts
│   ├── runChatLoop.ts
│   ├── context.ts
│   └── systemPrompt.ts
├── brain/                   # Autonomous 5-min cycle — DO NOT TOUCH casually
├── routes/
│   ├── chat/
│   │   └── processChat.ts   # Slim entry: activate → upload → runChatLoop
│   ├── notes.ts
│   └── rundown.ts
├── services/
│   ├── notes.ts
│   ├── gmail.ts             # Email safety
│   └── ...
└── db/schema.ts, queries.ts

client/index.html            # All UI + voice + menu + notes panel
```

**Orphan / legacy chat modules** (not in main pipeline): `liveData.ts`, `truthGuard.ts` (handlers), `operationalBrief.ts`, `notesRoute.ts`, `memoryOrchestrator.ts` (partially used), old `routes/chat/tools.ts` (executeTool for intent JSON — superseded for main chat).

---

## Environment / secrets (Fly)

```
ANTHROPIC_API_KEY          # Required
BRAVE_API_KEY              # search_web tool + brain world intel
DEEPGRAM_API_KEY           # STT
GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN   # ⚠️ verify refresh token still valid
ELEVENLABS_API_KEY         # TTS (optional; Deepgram Aura fallback)
NANO_BANANA_API_KEY        # Image gen (optional)
DB_PATH=/data/jarvis.sqlite
PORT=3000
```

---

## Commands

```bash
npm install
npm run build          # Must pass clean before deploy
npm run dev            # http://localhost:3000

fly deploy -a joes-jarvis
fly logs -a joes-jarvis
fly secrets list -a joes-jarvis
```

---

## Outstanding / next priorities

| Priority | Item |
|----------|------|
| **Deploy** | Listening stop fix (`client/index.html` only) — Joe has not asked yet in last message |
| **Git** | Large uncommitted diff — `git status` before assuming prod = HEAD; commit/push only if Joe asks |
| **Smoke test prod** | Tool-loop chat (grants search, save note, get notes, weather-only, email-only), notes panel, ≡ menu, JobTread email safety |
| **Smoke test local** | Stop listening voice + STOP LISTENING button |
| **Architecture** | 24h briefing per-item dedup (`briefedItemIds` always empty on full brief) |
| **Service worker** | PWA manifest only — no SW yet |
| **Prod DB backup** | SQLite on Fly volume — not in repo |
| **`send it`** for generated images | Still not wired |
| **Tests** | None for tool loop, notes, listening stop |

---

## User preferences (remember)

- JARVIS = **operator** — execute first, inform after  
- **No deploy / no commit** unless he says so  
- UI: maroon/red/white/black only  
- Voice: continuous conversation when in listening mode — but must **stop cleanly** on command  
- Briefing: 24h rule or “All clear sir”; session dedup where implemented  
- Jahan = developer collaborator, not unknown caller  

---

## Acceptance checklist (June 1, 2026)

- [x] Notes system (DB, API, UI, briefing integration)
- [x] Chat refactor — Claude tool loop replaces pattern routing
- [x] Email/brain safety (notification senders, empty body, queue maintenance)
- [x] Session briefing dedup (partial)
- [x] Rundown cache 15 min + prewarm
- [x] Business hours enforcement
- [x] Mobile menu + header fix deployed
- [x] `npm run build` passes
- [x] Fly deploys `01KT2FJ436…` and `01KT2M1ZED…`
- [ ] Listening stop fix deployed to prod
- [ ] Git commit syncing local → GitHub
- [ ] Joe production smoke tests

---

**Docs updated:** June 1, 2026 — full session handoff for next agent.
