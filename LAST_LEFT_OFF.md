# LAST LEFT OFF — JARVIS (Joe Stewart)

**Date:** June 1, 2026  
**Production URL:** https://joes-jarvis.fly.dev/  
**Fly app:** `joes-jarvis` (region `ord`)  
**DB (prod):** `/data/jarvis.sqlite` on Fly volume `jarvis_data`  
**UI:** Single file — `client/index.html`  
**Last Git commit:** `d7a7b0d` — *Save full project state* (repo is **far ahead** of this commit; all June 1 voice work is **uncommitted** unless Joe asks)

---

## For the next agent — read this first

JARVIS is Joe Stewart’s **autonomous AI operator** for Totally Outdoors LLC (Holmes County, Ohio)—not a chatbot.

**Three separate interactive systems (June 1, 2026 end state):**

1. **Background brain** (`server/src/brain/`) — Perception → Judgment → Execution → Communication every 5 minutes. **Do not refactor unless asked.**
2. **Text chat** (`POST /api/chat`) — Claude **tool-use ReAct loop** in `server/src/chat/`. Unchanged by voice work.
3. **Voice (Gemini only)** — **No Deepgram. No ElevenLabs. No `/api/voice`. No three-hop path.** Mic = Gemini Live WebSocket. Spoken text (activation, TRANSMIT replies, alerts, uploads) = `POST /api/gemini-live/speak`.

**Palette:** white / black / maroon / red only — no cyan/blue.

**Rules:** Do **not deploy** or **commit** unless Joe explicitly asks.

---

## Session summary — June 1, 2026 (voice overhaul)

This session replaced the entire legacy voice stack with **Gemini-only** voice. Work happened in **two deploys** (Joe approved both). **Nothing committed to git.**

### Phase A — Remove three-hop **mic** path (keep text TTS on old stack)

**Goal:** Mic conversation = Gemini Live only. No Deepgram STT → Claude → ElevenLabs fallback for mic.

**Client (`client/index.html`):**
- Removed `voiceMode` switching; mic always calls `startGeminiLiveSession()`.
- Deleted `startListening()`, `finishDeepgramTranscript()`, `scheduleListeningRestart()`, Deepgram mic fallback on Gemini failure.
- Kept Deepgram STT **only for REC recording mode** (at this stage).
- Kept `speak()` / `playQuickTts()` → `POST /api/voice` for text path.

**Server:**
- Added lean Live prompt + reduced Live tools (see below).
- `geminiLiveRouter` unchanged routes except config slimming.

**Deploy:** `deployment-01KTAA0G2BJCEP63VWDBMZRXN8`

**Known issue fixed by Phase B setup size:** Full `buildChatSystemPrompt()` in Live WS setup caused **~19k char** system prompt → Gemini WS **1011** after first audio chunk. Phase A added `buildGeminiLiveSystemPrompt()` (~1.6k chars measured locally).

---

### Phase B — Complete removal of ElevenLabs, Deepgram, three-hop, `/api/voice`

**Goal:** Gemini Live is the **only** voice system. No fallbacks. No remnants in server runtime.

#### Files **deleted entirely**

| File | Was |
|------|-----|
| `server/src/routes/voice.ts` | `GET/POST /api/voice`, `POST /api/voice/interrupt` |
| `server/src/services/elevenlabs.ts` | ElevenLabs HTTP TTS |
| `server/src/services/deepgram.ts` | Deepgram Aura `/v1/speak` TTS |
| `server/src/routes/deepgram.ts` | `GET /api/deepgram/token` |
| `server/src/services/deepgramSttProxy.ts` | WS proxy `/api/deepgram/listen` |

#### `server/src/index.ts` cleanup

**Removed:** `voiceRouter`, `deepgramRouter`, `attachDeepgramSttProxy(server)`.  
**Removed:** `createServer` + WS attachment — now plain `app.listen()`.  
**Kept:** `geminiLiveRouter` and everything else.

#### New endpoint — text / one-shot TTS

**`POST /api/gemini-live/speak`** in `server/src/routes/geminiLive.ts`

- Body: `{ text: string, sessionId?: string }`
- Uses `@google/genai` `client.models.generateContent()` with model **`GEMINI_TTS_MODEL`** (default `gemini-2.5-flash-preview-tts`, env override).
- Voice: **`GEMINI_LIVE_VOICE`** (default `Charon`).
- Returns raw audio buffer; `Content-Type` from Gemini `inlineData.mimeType` (PCM or encoded audio).
- Logs errors as `[gemini-speak]`.

#### Client TTS stack replaced

**Removed:** `playStreamingTts`, `playSessionTts`, `fallbackSpeak`, all `/api/voice` fetches, entire Deepgram STT block (~1680–3428 area), REC Deepgram pipeline.

**New:**
- `speak(text, { skipRestart })` → `POST /api/gemini-live/speak` → `playSpeakAudioBuffer()` (Web Audio; PCM fallback via `parsePcmSampleRate()`).
- `playQuickTts(text)` → `speak(..., { skipRestart: true })`.
- `haltPlayback()` stops **Gemini Live playback** (`stopGeminiPlayback()`) + legacy streaming sources.

**Still uses `speak()` / `playQuickTts()` for:**
- Page-load activation briefing (`jarvisActivateBriefing` → `__JARVIS_ACTIVATE__` → `speak(t)`)
- Text TRANSMIT (`deliverChatResponse` → `speak(t)`)
- Ack-before-Claude (`playQuickTts(ack)`)
- Stop listening confirmation (`stopListeningMode` → `speak(message)`)
- Intel alerts (`pollIntelligenceAlert` → `playQuickTts`)
- Document upload ack/errors
- Image-gen “Generating now sir” ack

**REC button:** **Stubbed.** `startRecordingMode()` speaks *“Long-form recording is unavailable sir. Use the mic or type your message.”* No STT until a Gemini-based REC path is built. `transcripts` table/API still exist server-side.

#### npm dependencies removed

From `package.json` (and lockfile via `npm install`):

- `@deepgram/sdk` (was never imported in TS source)
- `@elevenlabs/elevenlabs-js` (unused; old TTS used `fetch`)
- `ws` + `@types/ws` (only used by deleted STT proxy)

#### `.env.example` updated

**Removed:** `DEEPGRAM_*`, `TTS_PROVIDER`, `ELEVENLABS_*`  
**Added:** `GEMINI_API_KEY`, `GEMINI_LIVE_MODEL`, `GEMINI_LIVE_VOICE`, `GEMINI_TTS_MODEL`

#### Left untouched (intentionally)

- **`server/src/services/vapi.ts`** line 123 — `voice.provider: "elevenlabs"` is **Vapi’s cloud** phone agent config, not our deleted `elevenlabs.ts` service.
- **Claude text chat** — `POST /api/chat` / `runChatLoop()` unchanged.
- **Brain cycle** — unchanged.

**Deploy:** `deployment-01KTAAQJBF45ERK84A5WJZJ5V6`  
**Build:** `npm run build` passes clean after both phases.

---

## Gemini Live architecture (production ground truth)

### Mic path (real-time conversation)

```
Mic tap / HUD “Listening” / visibility restore
  → startGeminiLiveSession(sessionId)
  → POST /api/gemini-live/token
  → WebSocket (ephemeral token or api_key fallback)
  → setup JSON (lean systemPrompt + 8 Live tools + Charon voice)
  → startGeminiAudioCapture() — PCM 16kHz uplink
  → Inbound modelTurn audio → playNextGeminiChunk() @ 24kHz
  → toolCall → POST /api/gemini-live/tool → executeChatTool() → toolResponse on WS
```

**Client hardcodes** setup model `models/gemini-3.1-flash-live-preview` in WS `setup` block; server token config uses `GEMINI_LIVE_MODEL` env (default `models/gemini-2.5-flash-native-audio-preview-12-2025` in `config/gemini.ts`) — **align env on Fly if 1011 or model mismatch.**

**Logging:** Server `[gemini-live]` + client `logGeminiClient` → `POST /api/gemini-live/client-log`.

**Failure:** Gemini session failure → STANDBY + error message in chat. **No Deepgram fallback.**

**Stop:** `stopListeningMode()` / shutdown → `stopGeminiLiveSession()`. STOP LISTENING button works.

### Text / one-shot speech path

```
speak(text) or playQuickTts(text)
  → POST /api/gemini-live/speak
  → Gemini TTS model (not Live WS)
  → Web Audio playback
  → optional openMicAfterSpeak → startGeminiLiveSession()
```

Claude still **generates text** for TRANSMIT; Gemini **speaks** it.

### Gemini Live server files

| File | Role |
|------|------|
| `server/src/config/gemini.ts` | `GEMINI_API_KEY`, `GEMINI_LIVE_MODEL`, `GEMINI_LIVE_VOICE` |
| `server/src/routes/geminiLive.ts` | `/token`, `/tool`, `/client-log`, **`/speak`** |
| `server/src/chat/geminiSystemPrompt.ts` | `buildGeminiLiveSystemPrompt()` — **max 4000 chars** |
| `server/src/chat/geminiTools.ts` | `buildGeminiLiveTools()` — **8 tools only** for Live |

### Lean Live system prompt (`buildGeminiLiveSystemPrompt`)

**Includes only:**
1. JARVIS identity (2–3 sentences)
2. Joe / Ohio business context
3. Three critical tool rules
4. Ohio time + queue count (`formatLeanContextNote`)
5. **Top 3** memories from memory feed (not full 20-item feed)

**Excludes:** domain headlines, world intel summaries, self-evolution, episodic dumps, full operator preferences, document facts, full `buildChatSystemPrompt()`.

**Measured locally:** ~**1666 characters** (well under 4000 cap).

### Gemini Live tools (8 only — `GEMINI_LIVE_TOOL_NAMES`)

`search_web`, `read_emails`, `get_calls`, `get_queue`, `save_note`, `get_notes`, `get_weather`, `get_execution_log`

**Not on Live session** (still on Claude text chat): `send_email`, `book_calendar`, `save_memory`, `get_memory`, `get_full_picture`, `get_entity`, `search_documents`, `get_email_body`, `dismiss_queue_item`, `snooze_queue_item`, etc.

Tool execution for Live: same `executeChatTool()` in `server/src/chat/tools.ts`.

---

## What is **gone** (do not reintroduce without Joe)

| Removed | Notes |
|---------|--------|
| `POST /api/voice` | Deleted with `voice.ts` |
| `GET /api/voice` | Same |
| `POST /api/voice/interrupt` | No client caller existed |
| `GET /api/deepgram/token` | Deleted |
| WS `/api/deepgram/listen` | Deleted |
| Three-hop mic | Deepgram STT → `/api/chat` → `/api/voice` |
| `voiceMode='deepgram'` fallback | Removed |
| `startListening()` | Removed |
| Deepgram STT in REC | Removed; REC stubbed |
| `@deepgram/sdk`, `@elevenlabs/elevenlabs-js`, `ws` deps | Removed from package.json |

---

## Current chat architecture (text — unchanged)

### What runs on `POST /api/chat`

| Step | Handler | Notes |
|------|---------|--------|
| 1 | `__JARVIS_ACTIVATE__` | Activation briefing → JSON `speech` → client **`speak(t)`** via Gemini TTS |
| 2 | Upload session only | Image gen / store-it follow-ups |
| 3 | **`runChatLoop()`** | Claude + tools → JSON `speech` → client **`speak(t)`** via Gemini TTS |

### Claude tools (`server/src/chat/tools.ts`) — text chat

19 tools including: `search_web`, `read_emails`, `get_email_body`, `send_email`, `get_calls`, `get_queue`, `dismiss_queue_item`, `snooze_queue_item`, `book_calendar`, `save_note`, `get_notes`, `save_memory`, `get_memory`, `get_full_picture`, `get_entity`, `get_weather`, `search_documents`, `get_execution_log`.

**Entry:** `server/src/routes/chat/processChat.ts`

---

## Latest Fly deploys

| Deploy ID | What shipped |
|-----------|----------------|
| `deployment-01KT2FJ436AZTNQE4V1D32HS9J` | Notes, Claude tool-loop, menu, rundown cache, email safety, etc. |
| `deployment-01KT2M1ZEDQWHXSP8G5XSG0ZRX` | Mobile header — STANDBY top-right |
| `deployment-01KTAA0G2BJCEP63VWDBMZRXN8` | **Gemini-only mic** — removed three-hop/fallback; lean Live prompt + 8 Live tools |
| `deployment-01KTAAQJBF45ERK84A5WJZJ5V6` | **Full voice stack removal** — deleted Deepgram/ElevenLabs/`/api/voice`; added `/api/gemini-live/speak`; REC stubbed |

---

## Mobile / voice UX (production — June 1 evening)

- **Mic / hologram tap** → Gemini Live only
- **≡ MENU → Listening** → `startGeminiLiveSession()`
- **Text TRANSMIT** → Claude → **`speak()` → Gemini TTS**
- **Activation on load** → `scheduleActivationOnLoad()` → `jarvisActivateBriefing()` → Gemini TTS
- **Intel alert banner** → text visible + **`playQuickTts`** (Gemini TTS if `audioUnlocked`)
- **STOP LISTENING** button → `stopListeningMode()` → stops Gemini session + optional confirm TTS
- **REC button** → unavailable message (no transcription)
- PWA meta, wake lock on conversation mode, visibility restore reconnects Gemini Live
- Bottom bar: **≡ MENU | MIC | RUNDOWN**

---

## API surface (voice-relevant, June 2026)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/gemini-live/token` | Ephemeral WS token + session config |
| POST | `/api/gemini-live/tool` | Execute Live tool calls |
| POST | `/api/gemini-live/client-log` | Browser → Fly logs |
| POST | `/api/gemini-live/speak` | **One-shot Gemini TTS** (activation, TRANSMIT, alerts) |
| POST | `/api/chat` | Claude text brain |
| POST | `/api/transcripts/summarize` | REC summary API (REC UI stubbed client-side) |

**Removed:** `/api/voice`, `/api/deepgram/*`

---

## Project layout (key paths — updated)

```
server/src/
├── config/gemini.ts              # GEMINI_API_KEY, LIVE model/voice
├── chat/
│   ├── tools.ts                  # Claude + Live tool executors
│   ├── runChatLoop.ts            # Text chat
│   ├── geminiSystemPrompt.ts     # buildGeminiLiveSystemPrompt()
│   └── geminiTools.ts            # GEMINI_LIVE_TOOL_NAMES (8)
├── routes/
│   ├── geminiLive.ts             # token, tool, client-log, speak
│   └── chat/processChat.ts
├── brain/                        # DO NOT TOUCH casually
└── services/vapi.ts              # Phone — Vapi ElevenLabs config (external)

client/index.html                 # speak(), startGeminiLiveSession(), all UI
```

**Deleted paths (do not recreate from git without intent):**  
`routes/voice.ts`, `routes/deepgram.ts`, `services/deepgram.ts`, `services/deepgramSttProxy.ts`, `services/elevenlabs.ts`

---

## Environment / secrets (Fly)

```
ANTHROPIC_API_KEY              # Required — text chat + brain
GEMINI_API_KEY                 # Required — Live mic + Gemini TTS speak
GEMINI_LIVE_MODEL              # Optional — default models/gemini-2.5-flash-native-audio-preview-12-2025
GEMINI_LIVE_VOICE              # Optional — default Charon
GEMINI_TTS_MODEL               # Optional — default gemini-2.5-flash-preview-tts
BRAVE_API_KEY                  # search_web + world intel
GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN
NANO_BANANA_API_KEY            # Image gen (optional)
DB_PATH=/data/jarvis.sqlite
PORT=3000
VAPI_*                         # Phone agent (separate from app TTS)
```

**No longer used:** `DEEPGRAM_API_KEY`, `DEEPGRAM_VOICE`, `TTS_PROVIDER`, `ELEVENLABS_*` (remove from Fly secrets when convenient).

---

## Commands

```bash
npm install
npm run build          # Must pass before deploy
npm run dev            # http://localhost:3000

fly deploy -a joes-jarvis
fly logs -a joes-jarvis   # watch [gemini-live] and [gemini-speak]
fly secrets list -a joes-jarvis
```

---

## Smoke tests (production)

| Test | Expected |
|------|----------|
| Hard refresh → activation | Briefing text in chat + **Gemini TTS** (not silent) |
| Mic tap | `[gemini-live] session_start`; WS stays open; no Deepgram logs |
| Fly logs on token | `systemPromptChars` **< 4000**, `toolCount` **8** |
| Text TRANSMIT | Claude reply in chat + **Gemini TTS** |
| Intel alert | Banner + optional spoken alert |
| REC button | Spoken “unavailable” message; no recording |
| `curl -X POST .../api/gemini-live/speak -d '{"text":"hello"}'` | Audio bytes returned |

---

## Outstanding / next priorities

| Priority | Item |
|----------|------|
| **Git** | Large uncommitted diff — commit only if Joe asks |
| **REC mode** | Needs new STT path (Gemini Live batch, Web Speech, or other) — Deepgram removed |
| **Model alignment** | Client WS setup uses `gemini-3.1-flash-live-preview`; server default may differ — set `GEMINI_LIVE_MODEL` on Fly |
| **README/LAST_LEFT_OFF** | Updated this session |
| **Fly secrets cleanup** | Remove stale DEEPGRAM/ELEVENLABS secrets |
| **24h briefing dedup** | `briefedItemIds` still empty on full brief — open issue |
| **Live tool expansion** | Re-add send_email, book_calendar, etc. to Live after voice stable |
| **Service worker** | PWA manifest only |
| **Tests** | None for Gemini Live / speak endpoint |

---

## User preferences (remember)

- JARVIS = **operator** — execute first, inform after  
- **No deploy / no commit** unless he says so (he **did** ask for deploys this session)  
- UI: maroon/red/white/black only  
- Voice: **Gemini only** — no legacy Deepgram/ElevenLabs paths  
- Briefing: 24h rule or “All clear sir”  
- Jahan = developer collaborator  

---

## Acceptance checklist (June 1, 2026 — end of session)

- [x] Three-hop mic removed; Gemini Live only for mic
- [x] Lean Live prompt (<4000 chars) + 8 Live tools
- [x] ElevenLabs + Deepgram + `/api/voice` **fully removed** from server
- [x] `/api/gemini-live/speak` for all client TTS
- [x] Text TRANSMIT still works (Claude + Gemini TTS)
- [x] Activation briefing speaks via Gemini TTS
- [x] `npm run build` passes
- [x] Deployed `01KTAA0G2…` and `01KTAAQJ…`
- [ ] Git commit syncing local → GitHub
- [ ] REC mode reimplemented without Deepgram
- [ ] Fly secrets cleanup (DEEPGRAM/ELEVENLABS)

---

**Docs updated:** June 1, 2026 — full voice overhaul handoff for next agent.
