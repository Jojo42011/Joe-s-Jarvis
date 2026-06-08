# JARVIS — AI Operator for Joe Stewart / Totally Outdoors LLC

**Production:** https://joes-jarvis.fly.dev/  
**Handoff for agents:** [LAST_LEFT_OFF.md](./LAST_LEFT_OFF.md) — **read this first** (updated June 1, 2026, end of voice overhaul session).

JARVIS is a **custom autonomous AI intelligence operator** for a multimillion-dollar landscaping business in Holmes County, Ohio—not a chatbot. It runs a background brain every five minutes, executes routine work (email, queue, logging), answers Joe through a **Claude tool-use chat loop**, stores durable memory and notes, ingests documents, and speaks via **Google Gemini** (Live for mic, TTS API for one-shot speech).

---

## What is built (June 1, 2026 snapshot)

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

Claude is the **router and executor** for typed commands and structured responses. Pattern-matching handlers were removed from the main path except activation and upload-session follow-ups.

| Step | Behavior |
|------|----------|
| `__JARVIS_ACTIVATE__` | Activation briefing JSON → client speaks via **Gemini TTS** |
| Session uploads | Image gen / store-it / analyze follow-ups when files attached |
| **`runChatLoop()`** | Claude + 19 tools → execute → answer JSON `speech` → client **`speak()`** |

**Tools** (`server/src/chat/tools.ts`): web search, email read/send/body, calls, queue dismiss/snooze, calendar, notes, memory, weather, documents, execution log, entity/full picture, etc.

**Lean context** (`server/src/chat/context.ts`): Ohio time, queue count, last execution, 8 turns—not full inbox dumps.

**Jahan detection:** Developer identity when Joe says “this is Jahan” or dev session ids.

**Truth:** `enforceTruthfulSpeech()` on final response.

### Voice — Gemini only (June 1, 2026)

**Legacy stack removed:** Deepgram STT, Deepgram Aura TTS, ElevenLabs, `POST /api/voice`, three-hop mic (STT → Claude → TTS).

#### Real-time mic — Gemini Live

| Piece | Location |
|-------|----------|
| Token + config | `POST /api/gemini-live/token` |
| WebSocket session | Client `startGeminiLiveSession()` in `client/index.html` |
| Tool execution | `POST /api/gemini-live/tool` → `executeChatTool()` |
| Lean Live prompt | `server/src/chat/geminiSystemPrompt.ts` — **≤4000 chars**, top 3 memories |
| Live tools (8) | `server/src/chat/geminiTools.ts` — subset of Claude tools |
| Config | `server/src/config/gemini.ts` |

**Mic flow:** tap → token → WebSocket setup → PCM uplink 16 kHz → model audio downlink 24 kHz → optional tool round-trips.

**No fallback** to Deepgram or `/api/voice` on failure.

#### One-shot speech — Gemini TTS API

| Piece | Location |
|-------|----------|
| Endpoint | `POST /api/gemini-live/speak` `{ text }` |
| Model | `GEMINI_TTS_MODEL` (default `gemini-2.5-flash-preview-tts`) |
| Voice | `GEMINI_LIVE_VOICE` (default `Charon`) |
| Client | `speak()` / `playQuickTts()` in `client/index.html` |

**Used for:** activation briefing, TRANSMIT replies, intel alerts, upload acks, stop-listening confirm, image-gen ack—not for Live mic turns (Live generates its own audio).

#### Phone calls (separate)

`server/src/services/vapi.ts` uses Vapi’s **`elevenlabs` provider** on **their platform** for inbound call voice. This is **not** the deleted local ElevenLabs service.

### Notes system

- Voice (“remember this…”) via Gemini Live `save_note` or text chat tool
- Manual (≡ MENU → NOTES)
- SQLite `notes` table; promotes to `jarvis_memory`
- API: `GET/POST /api/notes`, search
- Surfaces in rundown/briefing

### Memory system (`jarvis_memory`)

Nine unified categories, contradiction checks, decay, audit queue, HUD memory panel. Writes via `rememberMemory()`.

### Document intelligence + Nano Banana

- Upload → chunk → search → cite (`search_documents` tool on **text** chat)
- Nano Banana image finish when `GEMINI_API_KEY` / image pipeline configured

### REC / transcripts

- **Server:** `POST /api/transcripts/summarize` still exists
- **Client:** REC button **stubbed** — Deepgram STT removed; speaks “Long-form recording is unavailable…” until a Gemini-based REC is built

### HUD (`client/index.html`)

- **≡ MENU | MIC | RUNDOWN** bottom bar (mobile-first)
- Panels: emails, calls, rundown/queue, notes, weather, documents, memory, photo
- Wake lock on Gemini Live conversation mode
- Mobile header: **STANDBY top-right**
- STOP LISTENING stops Gemini Live session

### Persistence (SQLite on Fly)

Key tables: `execution_log`, `jarvis_memory`, `notes`, `world_intel`, `priority_queue`, `documents`/`document_chunks`, `transcripts`, `conversations`, `system_state`.

Fly: `DB_PATH=/data/jarvis.sqlite`, volume `jarvis_data` → `/data`.

---

## Architecture diagram

```
┌─────────────────────────────────────────────────────────────┐
│  client/index.html                                          │
│  • Mic → Gemini Live WebSocket (startGeminiLiveSession)     │
│  • Text → POST /api/chat → speak() → /api/gemini-live/speak│
└────────────────────────────┬────────────────────────────────┘
                             │ HTTP
┌────────────────────────────▼────────────────────────────────┐
│  Express (server/src/index.ts) — brainCycle() every 5 min   │
│  geminiLiveRouter: /token /tool /speak /client-log          │
└────────────┬───────────────────────────────┬────────────────┘
             │                               │
     ┌───────▼────────┐              ┌───────▼────────┐
     │ brain/         │              │ POST /api/chat │
     │ P→J→E→C       │              │ runChatLoop()  │
     │ (autonomous)   │              │ (Claude text)  │
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
| POST | `/api/gemini-live/token` | Gemini Live session token + config |
| POST | `/api/gemini-live/tool` | Execute Live tool calls |
| POST | `/api/gemini-live/speak` | **Gemini TTS** for activation, TRANSMIT, alerts |
| POST | `/api/gemini-live/client-log` | Browser diagnostics → Fly logs |
| GET | `/api/notes` | List notes |
| POST | `/api/notes` | Save note |
| GET | `/api/rundown` | Ops snapshot (15 min cache) |
| GET/PATCH/DELETE | `/api/memory/*` | Memory CRUD + audit |
| POST | `/api/documents/upload` | Ingest + spoken ack (Gemini TTS) |
| POST | `/api/transcripts/summarize` | REC summary (client REC stubbed) |

**Removed (June 1, 2026):** `/api/voice`, `/api/deepgram/token`, WS `/api/deepgram/listen`

Full detail: [LAST_LEFT_OFF.md](./LAST_LEFT_OFF.md).

---

## Tech stack

| Layer | Choice |
|-------|--------|
| Reasoning (text) | Anthropic Claude (`server/src/chat/runChatLoop.ts`) |
| Voice (mic) | **Google Gemini Live API** (`@google/genai`) |
| Voice (one-shot TTS) | **Gemini TTS model** via `/api/gemini-live/speak` |
| Runtime | Node 22, TypeScript, Express |
| Database | better-sqlite3 (WAL), migrations in `schema.ts` |
| Search | Brave Search API |
| Email | Gmail API |
| Phone | Vapi (external ElevenLabs voice on Vapi side) |
| Host | Fly.io `joes-jarvis`, region `ord` |

---

## Project layout

```
JOES-JARIS/
├── client/index.html           # All UI + Gemini Live + speak()
├── server/src/
│   ├── index.ts
│   ├── config/gemini.ts
│   ├── chat/                   # Claude tool loop + geminiSystemPrompt + geminiTools
│   ├── routes/geminiLive.ts    # Live + speak endpoints
│   ├── brain/                  # Autonomous cycle
│   ├── routes/chat/processChat.ts
│   ├── routes/notes.ts
│   ├── services/notes.ts, gmail.ts, memory.ts, vapi.ts, ...
│   └── db/schema.ts, queries.ts
├── LAST_LEFT_OFF.md            # Agent handoff — start here
├── README.md
├── Dockerfile, fly.toml
└── data/                       # Local SQLite (gitignored)
```

**Deleted in June 2026 voice overhaul:**  
`routes/voice.ts`, `routes/deepgram.ts`, `services/deepgram.ts`, `services/deepgramSttProxy.ts`, `services/elevenlabs.ts`

---

## Local development

```bash
npm install
npm run build
npm run dev
```

Open http://localhost:3000

Requires `GEMINI_API_KEY` in `.env` for voice. See `.env.example`.

---

## Deploy

```bash
npm run build
fly deploy -a joes-jarvis
```

**Latest deploys (June 1, 2026):**

| Deploy ID | Summary |
|-----------|---------|
| `deployment-01KTAA0G2BJCEP63VWDBMZRXN8` | Gemini-only mic; lean Live prompt; 8 Live tools |
| `deployment-01KTAAQJBF45ERK84A5WJZJ5V6` | Full Deepgram/ElevenLabs/`/api/voice` removal; `/api/gemini-live/speak` |

**Do not deploy unless Joe asks.**

---

## Environment variables

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Claude text chat + brain (required) |
| `GEMINI_API_KEY` | Gemini Live mic + Gemini TTS speak (required for voice) |
| `GEMINI_LIVE_MODEL` | Live WS model (optional; see `config/gemini.ts`) |
| `GEMINI_LIVE_VOICE` | Voice name (default `Charon`) |
| `GEMINI_TTS_MODEL` | One-shot TTS model (default `gemini-2.5-flash-preview-tts`) |
| `BRAVE_API_KEY` | Web search + world intel |
| `GMAIL_*` | Email brain + tools |
| `NANO_BANANA_API_KEY` / image keys | Image gen (optional) |
| `VAPI_*` | Phone agent (separate from app TTS) |
| `DB_PATH` | `./data/jarvis.sqlite` local; `/data/jarvis.sqlite` Fly |

**Removed / obsolete:** `DEEPGRAM_API_KEY`, `DEEPGRAM_VOICE`, `TTS_PROVIDER`, `ELEVENLABS_*`

---

## Design rules

- **Execute first. Inform after.**
- Claude **uses tools immediately** on text chat — no “I’ll look into that” without searching
- Never claim email sent without `execution_log` proof
- Briefing: 24h elapsed or genuinely new; session dedup where implemented
- UI: maroon, red, white, black only
- **Voice is Gemini-only** — do not reintroduce Deepgram/ElevenLabs app TTS without Joe
- **No commit / no deploy** unless Joe says so

Operator prompt (text): `server/src/config/systemPrompt.ts`  
Live prompt (voice): `server/src/chat/geminiSystemPrompt.ts`

---

## Build history (high level)

1. Backend + HUD + SQLite + voice  
2. Four-system brain + execution-log truth  
3. World intel + Brave + live ReAct (later superseded in chat by tool loop)  
4. Memory overhaul + documents + 24h briefing  
5. Temporal awareness, upload ack, Nano Banana, REC/transcripts  
6. Latency, circuit breakers, cinematic HUD, chat modularization  
7. Email safety, session dedup, rundown cache, business hours  
8. Notes system + Claude tool-loop chat refactor + mobile menu  
9. Mobile header fix + listening stop  
10. **Gemini Live mic** — removed three-hop Deepgram/Claude/ElevenLabs mic path  
11. **Full Gemini voice** — deleted `/api/voice` and all Deepgram/ElevenLabs server code; `/api/gemini-live/speak` for all client TTS; REC stubbed  

Session detail: [LAST_LEFT_OFF.md](./LAST_LEFT_OFF.md).

---

## License / ownership

Custom build for Joe Stewart. Joe owns code and infrastructure.
