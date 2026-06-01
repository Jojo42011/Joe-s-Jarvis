# JARVIS — AI Operator for Joe Stewart / Totally Outdoors LLC

**Production:** https://joes-jarvis.fly.dev/  
**Handoff for agents:** [LAST_LEFT_OFF.md](./LAST_LEFT_OFF.md) — **read this first** (updated June 1, 2026).

JARVIS is a **custom autonomous AI intelligence operator** for a multimillion-dollar landscaping business in Holmes County, Ohio—not a chatbot. It runs a background brain every five minutes, executes routine work (email, queue, logging), answers Joe through a **Claude tool-use chat loop**, stores durable memory and notes, ingests documents, and speaks when something matters.

---

## What is built (June 2026 snapshot)

### Autonomous brain (`server/src/brain/`)

| Component | What it does |
|-----------|----------------|
| **Perception** | Gmail, calls, texts; 7am Ohio `senseWorld()` + memory maintenance |
| **Judgment** | Triage, world intel scoring, notification email routing, empty-body guards, **queue backlog maintenance** |
| **Execution** | Gmail send/archive, `execution_log` truth, outbound email safety |
| **Communication** | IF/WHAT Joe hears; 24h smart briefing; session-aware dedup via `spokenSessionTracker` |
| **cycle.ts** | `brainCycle()` on startup + every 5 min; rundown cache prewarm |

**Do not refactor the brain loop unless Joe asks.**

### Interactive chat (`POST /api/chat`) — Claude tool loop

**Architecture (June 2026):** Claude is the **router and executor**. Pattern-matching handlers were removed from the main path except activation and upload-session follow-ups.

| Step | Behavior |
|------|----------|
| `__JARVIS_ACTIVATE__` | Activation briefing (unchanged) |
| Session uploads | Image gen / store-it / analyze follow-ups only when files attached |
| **`runChatLoop()`** | Claude + 13 tools → execute → answer in one or few turns |

**Tools** (`server/src/chat/tools.ts`): web search, email read/send, calls, queue, calendar, **notes**, memory read/write, weather, documents, execution log.

**Lean context** (`server/src/chat/context.ts`): Ohio time, queue count, last execution, 8 turns—not full inbox/memory dumps.

**Jahan detection:** Developer identity injected when Joe says “this is Jahan” or dev session ids.

**Truth:** `enforceTruthfulSpeech()` on final response.

### Notes system

- Voice (“remember this…”) and manual (≡ MENU → NOTES)
- SQLite `notes` table; promotes to `jarvis_memory` as `note_{id}`
- API: `GET/POST /api/notes`, search
- Surfaces in rundown/briefing (unacknowledged 24h notes)

### Memory system (`jarvis_memory`)

Nine unified categories, contradiction checks, decay, audit queue, HUD memory panel — see prior docs in git history. Writes via `rememberMemory()`.

### Document intelligence + Nano Banana + REC/transcripts

- Upload → chunk → search → cite in chat (`search_documents` tool)
- Nano Banana image finish when `NANO_BANANA_API_KEY` set
- Mobile REC → Deepgram → `transcripts` table → weekday query

### Voice + HUD (`client/index.html`)

- Deepgram STT proxy, 1.5s commit, continuous conversation when **listening mode** on
- **≡ MENU | MIC | RUNDOWN** bottom bar (mobile-first)
- Panels: emails, calls, rundown/queue, notes, weather, documents, memory, photo
- Wake lock, PWA meta, Deepgram retry backoff
- Mobile header: **STANDBY top-right**, no clock
- **Local (pending deploy):** STOP LISTENING button + voice “stop listening” actually stops mic

### Persistence (SQLite on Fly)

Key tables: `execution_log`, `jarvis_memory`, `notes`, `world_intel`, `priority_queue`, `documents`/`document_chunks`, `transcripts`, `conversations`, `system_state`.

Fly: `DB_PATH=/data/jarvis.sqlite`, volume `jarvis_data` → `/data`.

---

## Architecture diagram

```
┌─────────────────────────────────────────────────────────────┐
│  client/index.html — voice, ≡ menu, panels, notes, REC     │
└────────────────────────────┬────────────────────────────────┘
                             │ HTTP / WS
┌────────────────────────────▼────────────────────────────────┐
│  Express (server/src/index.ts) — brainCycle() every 5 min    │
└────────────┬───────────────────────────────┬────────────────┘
             │                               │
     ┌───────▼────────┐              ┌───────▼────────┐
     │ brain/         │              │ POST /api/chat │
     │ P→J→E→C       │              │ runChatLoop()  │
     │ (autonomous)   │              │ server/src/chat│
     └───────┬────────┘              └───────┬────────┘
             │                               │
             └───────────────┬───────────────┘
                             ▼
                    ┌─────────────────┐
                    │ SQLite WAL      │
                    │ /data Fly vol   │
                    └─────────────────┘
```

---

## API surface (selected)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/chat` | Main operator `{ message }` + `x-session-id` |
| POST | `/api/chat/state/clear` | Reset session (shutdown) |
| GET | `/api/notes` | List notes |
| POST | `/api/notes` | Save note |
| GET | `/api/rundown` | Ops snapshot (15 min cache) |
| GET/PATCH/DELETE | `/api/memory/*` | Memory CRUD + audit |
| POST | `/api/documents/upload` | Ingest + spoken ack |
| POST | `/api/transcripts/summarize` | REC → summary |
| WS | `/api/deepgram/listen` | STT proxy |
| POST | `/api/voice` | TTS |

Full list: [LAST_LEFT_OFF.md](./LAST_LEFT_OFF.md).

---

## Tech stack

| Layer | Choice |
|-------|--------|
| Reasoning | Anthropic Claude (`findWorkingModel` in `claude.ts`) |
| Chat | Tool-use loop in `server/src/chat/` |
| Runtime | Node 22, TypeScript, Express |
| Database | better-sqlite3 (WAL), migrations in `schema.ts` |
| Search | Brave Search API |
| Voice | Deepgram STT, ElevenLabs / Deepgram Aura TTS |
| Email | Gmail API |
| Host | Fly.io `joes-jarvis`, region `ord` |

---

## Project layout

```
JOES-JARIS/
├── client/index.html           # All UI
├── server/src/
│   ├── index.ts
│   ├── chat/                   # Primary chat brain (tool loop)
│   ├── brain/                  # Autonomous cycle
│   ├── routes/chat/processChat.ts
│   ├── routes/notes.ts
│   ├── services/notes.ts, gmail.ts, memory.ts, ...
│   └── db/schema.ts, queries.ts
├── LAST_LEFT_OFF.md            # Agent handoff — start here
├── README.md
├── Dockerfile, fly.toml
└── data/                       # Local SQLite (gitignored)
```

---

## Local development

```bash
npm install
npm run build
npm run dev
```

Open http://localhost:3000

---

## Deploy

```bash
npm run build
fly deploy -a joes-jarvis
```

**Latest deploys:** see [LAST_LEFT_OFF.md](./LAST_LEFT_OFF.md).  
**Do not deploy unless Joe asks.**

---

## Environment variables

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Claude (required) |
| `BRAVE_API_KEY` | Web search + world intel |
| `DEEPGRAM_API_KEY` | STT |
| `GMAIL_*` | Email brain + tools |
| `ELEVENLABS_API_KEY` | TTS (optional) |
| `NANO_BANANA_API_KEY` | Image gen (optional) |
| `DB_PATH` | `./data/jarvis.sqlite` local; `/data/jarvis.sqlite` Fly |

---

## Design rules

- **Execute first. Inform after.**
- Claude **uses tools immediately** — no “I’ll look into that” without searching
- Never claim email sent without `execution_log` proof
- Briefing: 24h elapsed or genuinely new; session dedup where implemented
- UI: maroon, red, white, black only
- **No commit / no deploy** unless Joe says so

Operator prompt: `server/src/config/systemPrompt.ts`

---

## Build history (high level)

1. Backend + HUD + SQLite + voice  
2. Four-system brain + execution-log truth  
3. World intel + Brave + live ReAct (later superseded in chat by tool loop)  
4. Memory overhaul + documents + 24h briefing  
5. Temporal awareness, upload ack, Nano Banana, REC/transcripts  
6. Latency, circuit breakers, cinematic HUD, chat modularization  
7. **Email safety, session dedup, rundown cache, business hours**  
8. **Notes system + Claude tool-loop chat refactor + mobile menu** (June 2026)  
9. Mobile header fix + listening stop (local, pending deploy)

Session detail: [LAST_LEFT_OFF.md](./LAST_LEFT_OFF.md).

---

## License / ownership

Custom build for Joe Stewart. Joe owns code and infrastructure.
