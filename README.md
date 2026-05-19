# JARVIS — AI Operator for Joe Stewart / Totally Outdoors LLC

**Production:** https://joes-jarvis.fly.dev/  
**Handoff for agents:** [LAST_LEFT_OFF.md](./LAST_LEFT_OFF.md) (exact session state, what shipped May 18, do-not-touch list).

JARVIS is a **custom autonomous AI intelligence operator** for a multimillion-dollar landscaping business in Holmes County, Ohio—not a chatbot. It runs a background brain every five minutes, executes routine work (email, queue, logging), searches the live web before answering weather and news questions, stores durable business memory with audit and decay, ingests Joe’s documents, and only speaks when something genuinely matters.

---

## Exactly what is built (inventory)

### Autonomous brain (`server/src/brain/`)

| Component | What it does |
|-----------|----------------|
| **Perception** | Polls Gmail, calls, texts; tracks queue, Joe activity, briefing timestamps; **7am Ohio** runs `senseWorld()` (Brave, 7 domains) + **`runMemoryMaintenance()`** (decay daily, audit Sundays) |
| **Judgment** | Claude triage per inbound item → `execute_now` \| `queue` \| `ignore`; judges world intel relevance; promotes HIGH facts to `jarvis_memory` |
| **Execution** | Sends/archives via Gmail, writes **`execution_log`** (source of truth) |
| **Communication** | Decides IF/WHAT Joe hears; **24-hour smart briefing** on activation; avoids repeat briefs |
| **cycle.ts** | `brainCycle()` on startup + every 5 minutes |

### Interactive chat operator (`POST /api/chat`)

- Multi-turn Claude with **session-scoped** `conversations` (30 turns)
- **Operator state** each turn: execution log today, queue, world intel cache, wiring summary, `operator_context`
- **Immediate Gmail send** — no draft approval loop
- **`enforceTruthfulSpeech`** — cannot claim “sent” without `execution_log` or successful send tool
- **Status routing** — “what did you do?” / “did you send X?” from execution log only
- **Email resolution** — match contacts from conversation + inbox (reduces “which email, sir?”)
- **Live-data ReAct** — Brave (weather \| news \| web) runs **before** response; `intent: world.intel`; weather HUD panel with crew GO/CAUTION/NO-GO
- **Document route** — business questions hit uploaded docs first; `intent: document.search`; citations required
- **Activation** — `__JARVIS_ACTIVATE__` / wake word → briefing if 24h elapsed, else “All clear sir. What do you need?”
- **Memory feedback** — corrections → stable `preference_*` keys; extraction on high-signal intents

### Memory system (`jarvis_memory` + `server/src/services/memory.ts`)

| Feature | Implementation |
|---------|----------------|
| **9 unified categories** | `business_context`, `client_relations`, `operator_preferences`, `world_intel`, `crew_labor`, `vendor_supplier`, `drone_faa`, `industry`, `document_facts` |
| **Writes** | `rememberMemory()` → Claude **contradiction check** → SQLite upsert |
| **Corrections** | `preference_{topic}` keys (not random hashes) |
| **Decay** | 90+ day stale facts lose confidence; preferences/clients never decay; auto-delete below 0.1 |
| **Audit** | Weekly Sunday 7am Ohio + manual `POST /api/memory/audit` |
| **Flags** | `flagged`, `flag_reason` columns |
| **HUD** | Memory panel in client — view, edit, delete, run audit, stale/flagged styling |
| **Prompt** | Top 20 memories + MEMORY SYSTEM block in `systemPrompt.ts` |

### Document intelligence

- Upload PDF, txt, md, csv, html (10MB cap)
- Chunking (600 chars, 100 overlap), SQLite storage
- Search + Claude answer with document citation
- HUD: upload button, doc count badge, library panel (Shift+click upload)

### World intelligence

- Scheduled + on-demand Brave searches across 7 domains (weather, supply chain, local Ohio, world, industry, FAA/drones, crew/labor)
- `world_intel` table (~48h cache, HIGH/MEDIUM/LOW)
- Promotion of durable HIGH items into `jarvis_memory`
- APIs: `GET /api/intelligence/world`, `POST .../world/search`, `POST .../world/run`

### Voice + HUD (`client/index.html`)

- Deepgram WebSocket STT proxy, 3s utterance commit, VAD, continuous conversation after TTS
- ElevenLabs TTS via server proxy
- Maroon/red/black operator UI, hologram, waveform, operator log, dynamic panels (emails, rundown, **weather**, documents, etc.)
- **JARVIS Memory** panel (brain icon in bottom bar)

### Persistence (SQLite on Fly)

| Table | Role |
|-------|------|
| `execution_log` | **Truth** for what was actually done |
| `jarvis_memory` | Durable business memory (with flags + decay) |
| `world_intel` | Recent external search cache |
| `conversations` / `conversation_state` | Session chat + UI state |
| `priority_queue` | Items needing Joe |
| `documents` / `document_chunks` / `notebooks` | Document RAG |
| `system_state` | Cursors, briefing times, memory maintenance timestamps, alerts |
| `calls`, `texts`, `priority_contacts`, … | Ops data |

Fly: `DB_PATH=/data/jarvis.sqlite`, volume `jarvis_data` → `/data`.

---

## Architecture diagram

```
                    ┌─────────────────────────────────┐
                    │  client/index.html               │
                    │  Voice | HUD | Memory | Docs     │
                    └───────────────┬─────────────────┘
                                    │ HTTP / WS
                    ┌───────────────▼─────────────────┐
                    │  Express (server/src/index.ts)   │
                    │  brainCycle() + routes           │
                    └───────────────┬─────────────────┘
          ┌─────────────────────────┼─────────────────────────┐
          ▼                         ▼                         ▼
   ┌─────────────┐          ┌──────────────┐          ┌─────────────┐
   │ brain/      │          │ routes/      │          │ services/   │
   │ P→J→E→C    │          │ chat,memory, │          │ claude,gmail│
   │             │          │ documents,   │          │ memory,brave│
   │ 7am: world  │          │ intelligence │          │ documents   │
   │ + memory    │          │              │          │             │
   └─────────────┘          └──────────────┘          └─────────────┘
                                    │
                                    ▼
                           ┌─────────────┐
                           │ SQLite WAL  │
                           └─────────────┘
```

**Chat path:** status route → document route → live ReAct → Claude intent → tools → truth guard → async memory extract  
**Brain path:** sense → judge → execute → communicate (alert if critical)  
**Memory path:** `rememberMemory()` on writes; `getTopMemories(20)` on reads (retrieval upgrade planned)

---

## API surface

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health` | Liveness |
| POST | `/api/chat` | Main operator `{ message, sessionId }` |
| POST | `/api/chat/state/clear` | Reset session UI |
| GET | `/api/rundown` | Ops snapshot |
| GET | `/api/intelligence/queue` | Priority queue |
| GET | `/api/intelligence/alerts` | Active alert |
| POST | `/api/intelligence/handled/:id` | Mark handled |
| GET | `/api/intelligence/world` | World intel cache |
| POST | `/api/intelligence/world/search` | On-demand Brave |
| POST | `/api/intelligence/world/run` | Full senseWorld pipeline |
| GET | `/api/memory` | Memories grouped by category |
| GET | `/api/memory/stats` | Counts, stale, flagged, audit times |
| PATCH | `/api/memory/:id` | Edit memory / clear flag |
| DELETE | `/api/memory/:id` | Delete memory |
| POST | `/api/memory/audit` | Run memory audit |
| POST | `/api/documents/upload` | Ingest file |
| GET | `/api/documents` | List documents |
| DELETE | `/api/documents/:id` | Delete document |
| POST | `/api/documents/search` | Document Q&A |
| WS | `/api/deepgram/listen` | STT proxy |
| GET | `/api/voice?text=` | TTS proxy |

---

## Tech stack

| Layer | Choice |
|-------|--------|
| Reasoning | Anthropic Claude (model probe in `claude.ts`) |
| Runtime | Node 20+, TypeScript, Express |
| Database | better-sqlite3 (WAL), migrations in `schema.ts` |
| Search | Brave Search API (world + live chat) |
| Voice | Deepgram STT, ElevenLabs TTS (server proxies) |
| Email | Gmail API (read + send) |
| Calls | Vapi + `calls` table |
| Host | Fly.io (`joes-jarvis`, region `ord`) |

---

## Project layout

```
JOES-JARIS/
├── client/
│   └── index.html              # Full HUD, voice, memory panel, documents
├── server/src/
│   ├── index.ts                # Express, brain interval, routes
│   ├── brain/                  # Perception, Judgment, Execution, Communication, cycle
│   ├── routes/                 # chat, memory, documents, intelligence, voice, ...
│   ├── services/               # memory, claude, gmail, documentIntelligence, braveSearch, ...
│   ├── config/
│   │   ├── systemPrompt.ts     # JARVIS_BASE_PROMPT + dynamic memory
│   │   └── memoryCategories.ts # MEMORY_CATEGORIES constants
│   └── db/                     # schema.ts, queries.ts
├── data/                       # Local SQLite (gitignored)
├── Dockerfile
├── fly.toml
├── LAST_LEFT_OFF.md            # Agent handoff — read first
└── README.md
```

---

## Local development

```bash
npm install
npm run build
npm run dev    # or npm start
```

Open http://localhost:3000 — `/api/health` for liveness.

Migrations run on boot (`session_id`, `operator_context`, `flagged` on memory, document tables, etc.).

---

## Deploy (Fly.io)

```bash
npm run build
fly deploy -a joes-jarvis
```

Secrets (never commit):

```bash
fly secrets set ANTHROPIC_API_KEY=... BRAVE_API_KEY=... DEEPGRAM_API_KEY=... \
  GMAIL_CLIENT_ID=... GMAIL_CLIENT_SECRET=... GMAIL_REFRESH_TOKEN=... \
  -a joes-jarvis
```

**Note:** If Gmail refresh token is expired, brain email perception fails until re-OAuth. Latest memory + document features require a deploy after `npm run build`.

---

## Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `ANTHROPIC_API_KEY` | Yes | Claude (chat, brain, memory, docs) |
| `BRAVE_API_KEY` | Yes | World intel + live ReAct |
| `DEEPGRAM_API_KEY` | Voice | STT |
| `GMAIL_*` | Email | Read/send (brain + chat) |
| `ELEVENLABS_API_KEY` | Optional | TTS |
| `DB_PATH` | Default `./data/jarvis.sqlite`; Fly `/data/jarvis.sqlite` | SQLite |
| `PORT` | Default 3000 | HTTP |
| `DEEPGRAM_ENDPOINTING_MS` / `DEEPGRAM_UTTERANCE_END_MS` | Optional | Voice tuning |

---

## Design rules (operator contract)

- **Execute first. Inform after. Never ask twice.**
- Live weather/news/prices → Brave first, never training data
- Never claim email sent without `execution_log` or successful `gmail.send_reply`
- Briefing only when 24h elapsed or genuinely new; else *“All clear sir. What do you need?”*
- Memory categories are fixed — business vs client vs preference vs world vs document facts
- Documents: cite source; never invent contract numbers
- UI palette: maroon, red, white, black only

Full operator prompt: `server/src/config/systemPrompt.ts` → `JARVIS_BASE_PROMPT`.

---

## Build history

1. Backend + HUD + SQLite  
2. Gmail, Vapi, Deepgram, ElevenLabs  
3. Intelligence queue + alerts  
4. Session chat + `jarvis_memory` (basic)  
5. STT latency + continuous conversation  
6. **Four-system brain** + execution-log truth layer  
7. Fly production deploy  
8. **World intel** (7 domains, 7am scheduler, Brave)  
9. **Live ReAct** + weather HUD + operator wiring in prompt  
10. **Smart 24-hour briefing** on activation  
11. **Document intelligence** (upload, chunk, search, chat route)  
12. **Memory system overhaul** (categories, contradiction, decay, audit, API, HUD panel) — May 18, 2026  

Session details and handoff: [LAST_LEFT_OFF.md](./LAST_LEFT_OFF.md).

---

## Replication template — build another project at this level

### 1. Skeleton

- [ ] Express + TS serves static client; SQLite on Fly volume `/data`  
- [ ] All API keys server-side only  

### 2. Brain

- [ ] Perception / Judgment / Execution / Communication  
- [ ] `execution_log` on every external action  
- [ ] `setInterval(brainCycle, 5 * 60 * 1000)`  

### 3. Chat

- [ ] `sessionId` + `messages[]` to Claude  
- [ ] Truth guard on completion claims  
- [ ] No approval loop for routine sends  

### 4. Live data

- [ ] Server runs search **before** model speaks  
- [ ] Strip “let me check” from responses  

### 5. Memory (JARVIS-grade)

- [ ] Unified categories + single write gate (`rememberMemory`)  
- [ ] Contradiction check + decay + audit  
- [ ] Operator UI to inspect/edit memories  
- [ ] Plan semantic retrieval (not only top-N by confidence)  

### 6. Documents (optional)

- [ ] Chunk + store + cite in answers  

### 7. Ops

- [ ] `LAST_LEFT_OFF.md` every major session  
- [ ] `GET /api/health`  

---

## License / ownership

Custom build for Joe Stewart. Joe owns code and infrastructure.
