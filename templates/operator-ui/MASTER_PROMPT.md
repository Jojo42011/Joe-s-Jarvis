# Master Prompt — Drop-in "Operator" Voice UI (blue theme)

This is a **reusable, brand-neutral copy of the JARVIS operator screen** — the
full-screen animated particle orb with the hex-grid background, live clock, the
STANDBY / LISTENING / PROCESSING / RESPONDING state machine, and the complete
tap-to-talk voice pipeline (mic → speech-to-text → brain → text-to-speech).

It was cloned from Joe's production UI and **retinted BLUE** for the next
client. It is fully working out of the box; the only things to fill in per
client are a couple of name placeholders (and, if that client isn't blue, the
theme tokens).

> **Paste this whole file to a fresh Claude Code session working in the target
> client's repo.** It tells you exactly what to copy, what to change, and the
> backend contract the UI depends on.

---

## What's in this folder

| File | What it is |
|------|-----------|
| `operator.html` | The operator screen — HTML + inline CSS + the inline Three.js orb/hex-grid renderer + the STANDBY/LISTENING/PROCESSING/RESPONDING state machine. |
| `voice.js` | The voice pipeline (`window.OperatorVoice`): mic capture + WebSocket STT, the brain SSE stream, and ordered TTS playback. No UI of its own — it drives the orb via hooks. |
| `MASTER_PROMPT.md` | This file. |

Three.js is loaded from a CDN (`cdnjs … three.min.js r128`) via a `<script>` tag
in `operator.html`. Nothing else is bundled.

---

## Integration steps (do these in the target client's repo)

1. **Copy the two files** into the client's static/client directory:
   - `operator.html` → served as the operator page (e.g. at route `/` or `/operator`)
   - `voice.js` → served at the path referenced by the `<script src="/js/voice.js">`
     tag near the bottom of `operator.html`. Either keep that path (`client/js/voice.js`)
     or update the tag to wherever you place it.

2. **Fill the placeholders** (they appear in both files). Global find/replace:
   - `{{OPERATOR_DISPLAY}}` → the operator's display name, e.g. `J.A.R.V.I.S`,
     `A.T.L.A.S`, `N.O.V.A` (spaced-caps reads well in the mono brand font).
     Appears in: `operator.html` `<title>` + `#brand`, and `voice.js` mobile
     "Tap to activate …" overlay.
   - `{{OPERATOR_USER}}` → the human the operator works for, shown top-right
     (e.g. the client's first name). `operator.html` only.

3. **Serve it behind the same backend** (see the contract below). If the target
   client is another instance of this Aethon platform, every endpoint already
   exists — you're done after steps 1–2. If not, implement the five endpoints.

4. **Theme** — it's blue already. To recolor for a different client, see
   "Retheming" below. It's two small edits.

That's the whole job. The orb, animation, state machine, mic/STT/TTS pipeline,
mobile audio unlock, image/doc attach hook, and activation greeting all come
across unchanged.

---

## Retheming (one accent color, two places)

All color lives in **two token blocks that must agree**. To change the accent
from blue to anything else, edit both:

1. **CSS** — the `:root` block at the top of `operator.html`:
   ```css
   --accent:        #1C6DD0;          /* primary accent */
   --accent-bright: #39B4FF;          /* bright accent (glow / active states) */
   --accent-rgb:        28, 109, 208; /* the SAME color as --accent, as r,g,b */
   --accent-bright-rgb: 57, 180, 255; /* the SAME color as --accent-bright, r,g,b */
   ```
   The `-rgb` triples must describe the same colors as the hex values — they
   feed `rgba(var(--accent-rgb), …)` for translucent borders/glows. Everything
   downstream (status pill, highlights, scrollbars, top border) reads these.

2. **Canvas/WebGL** — the `THEME` object inside the orb `<script>` in
   `operator.html` (the hex-grid background and the orb's inner glow are drawn
   on a canvas and can't read CSS variables):
   ```js
   const THEME = {
     hexGrid:   "rgba(28, 109, 208, 0.10)",   // faint background grid
     glowInner: "rgba(57, 180, 255, 0.90)",   // orb core (bright accent)
     glowMid:   "rgba(28, 109, 208, 0.50)",   // mid (accent)
     glowOuter: "rgba(12, 44, 96, 0.15)"      // outer falloff (dark accent)
   };
   ```
   Match these to the same accent. `glowOuter` is a darker shade of the accent.

The orb particles themselves are intentionally **white/grey** (they read as
"chrome" against any accent) — leave them. Only the glow behind them and the UI
chrome carry the accent. `--silver` is a neutral secondary (top-right nav links)
and normally stays as-is regardless of theme.

**Blue values used here** (for reference): accent `#1C6DD0`, bright `#39B4FF`,
dark falloff ~`#0C2C60`.

---

## Backend contract (what `voice.js` calls)

The pipeline is transport-agnostic about your brain/voice providers — it only
speaks these five endpoints. Any backend that implements them drives this UI.

| # | Endpoint | Method | Purpose |
|---|----------|--------|---------|
| 1 | `/api/brain/activate` | `GET` | Returns `{ speech }` — the greeting spoken once when the operator comes online. |
| 2 | `/api/brain/stream` | `POST` (SSE) | Body `{ message }`. Streams the reply as Server-Sent Events (see event types below). |
| 3 | `/api/voice/speak` | `POST` | Body `{ text }`. Returns audio (PCM/`audio/*`) for one-shot TTS (the greeting, etc.). |
| 4 | `/api/voice/deepgram/listen` | `WebSocket` | Bidirectional mic stream: client sends 16 kHz PCM chunks; server returns JSON transcript messages (`partial_transcript` / `committed_transcript`). (Path is legacy-named; any realtime STT can sit behind it.) |
| 5 | `/api/memory/extract-voice` | `POST` | Body `{ transcript }`. Fire-and-forget memory write after a turn; may 204. |

### SSE events on `/api/brain/stream`
The client handles these `data.type` values (send `data: {json}\n\n` frames):

- `sentence` — `{ type:"sentence", text }` — one spoken sentence; the client
  fetches TTS for it and plays them in order. (Primary path.)
- `speech_chunk` / `speech_complete` — alternate streamed-audio path if you push
  audio chunks directly.
- `navigate` — `{ type:"navigate", tab }` — ask the shell to open a dashboard tab
  (forwarded via `postMessage` `{type:"arlo-navigate"}` to a parent frame).
- `curiosity` — `{ type:"curiosity", question }` — an extra spoken line.
- `done` — `{ type:"done", text }` — end of turn; the client drains TTS and
  returns the orb to LISTENING.

If the client is embedded in a shell/iframe, the `navigate` event posts
`{ type: "arlo-navigate", tab }` to `window.parent`. Rename that string if your
shell listens for something else (it's the one internal identifier kept from the
original wiring).

---

## The `OperatorVoice` ↔ orb interface

`operator.html` owns the orb + state machine and hands `voice.js` a small hook
object. If you ever swap the visual for a different orb, keep this shape:

```js
OperatorVoice.init({
  setState,                       // (stateKey) => void; one of STANDBY|LISTENING|PROCESSING|RESPONDING
  clearTimers,                    // () => void
  getCurrentState: () => string,  // current state key
  orbLabelEl,                     // the element under the orb (label text)
  voiceNoteEl                     // the small error/status line element
});
// user taps the orb:
canvas.addEventListener("click", () => OperatorVoice.onOrbClick());
```

`voice.js` calls `setState("LISTENING"|"PROCESSING"|"RESPONDING"|"STANDBY")` as
the turn progresses; the orb animates itself off those state transitions.

---

## Notes / gotchas carried over from production

- **Mobile audio unlock**: browsers block autoplay until a user gesture, so on
  touch devices `voice.js` shows a one-time "Tap to activate …" overlay that
  unlocks the Web Audio context. Keep it — without it the first greeting is
  silent on phones.
- **Ordered TTS with a concurrency gate**: each sentence is a separate TTS call;
  they're played strictly in order and capped in flight. Don't "optimize" it into
  parallel unordered playback — that's how you get overlapping audio.
- **Activation greeting runs in parallel with mic warm-up**, not after it, so the
  greeting isn't gated behind the STT handshake. Preserve that ordering.
- Particle count (4200) and orb size (~40% of viewport height) are tuned for a
  small VM / mid GPU; safe to leave.
```
