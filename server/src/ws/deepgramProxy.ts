import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { IncomingMessage } from 'http';
import { Duplex } from 'stream';
import {
  ELEVENLABS_API_KEY, ELEVENLABS_STT_MODEL,
  DEEPGRAM_API_KEY, DEEPGRAM_STT_MODEL, STT_SAMPLE_RATE,
} from '../config/voice';

const TAG = '[SttProxy]';
// Overridable so provider failover can be exercised against a local mock;
// production never sets it.
const ELEVENLABS_STT_BASE = process.env.ELEVENLABS_STT_URL?.trim() || 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';
// Overridable so the fallback can be exercised against a local mock; production
// never sets it.
const DEEPGRAM_STT_BASE = process.env.DEEPGRAM_STT_URL?.trim() || 'wss://api.deepgram.com/v1/listen';
const STT_PATH = '/api/voice/deepgram/listen';

type Provider = 'elevenlabs' | 'deepgram';

const SCRIBE_ERROR_TYPES = new Set([
  'auth_error',
  'quota_exceeded',
  'rate_limited',
  'unaccepted_terms',
  'resource_exhausted',
  'session_time_limit_exceeded',
  'transcriber_error',
  'input_error',
  'chunk_size_exceeded',
  'queue_overflow',
  'error',
]);

// Fatal errors → don't reconnect (the session can't be saved by retrying).
// Everything else (incl. idle/time-limit closes) is recoverable via reconnect.
const FATAL_ERROR_TYPES = new Set([
  'auth_error',
  'quota_exceeded',
  'unaccepted_terms',
  'resource_exhausted',
]);

type ScribeMessage = {
  message_type?: string;
  text?: string;
  error?: string;
};

type DeepgramMessage = {
  type?: string;                       // 'Results' | 'UtteranceEnd' | 'Metadata'
  speech_final?: boolean;
  is_final?: boolean;
  channel?: { alternatives?: { transcript?: string }[] };
};

function upgradePathname(request: IncomingMessage): string {
  const host = request.headers.host || 'localhost';
  try {
    return new URL(request.url || '/', `http://${host}`).pathname;
  } catch {
    return request.url?.split('?')[0] || '';
  }
}

export function elevenLabsSttUrl(): string {
  // Lower = Jarvis commits the turn and starts thinking sooner after Joe stops
  // talking. 1.0s of dead air every turn was the single biggest latency drag in
  // the whole pipeline; 0.6s still gives room for a mid-sentence breath.
  const silenceSecs = process.env.ELEVENLABS_STT_SILENCE_SECS?.trim() || '0.6';
  const params = new URLSearchParams({
    model_id: ELEVENLABS_STT_MODEL,
    audio_format: 'pcm_16000',
    commit_strategy: 'vad',
    vad_silence_threshold_secs: silenceSecs,
    no_verbatim: 'true',
  });
  return `${ELEVENLABS_STT_BASE}?${params}`;
}

export function deepgramSttUrl(): string {
  // endpointing mirrors Scribe's VAD silence window so a turn commits after the
  // same pause length on either provider — Joe should not have to change how he
  // talks depending on which transcriber is live.
  const silenceMs = String(Math.round(
    parseFloat(process.env.ELEVENLABS_STT_SILENCE_SECS?.trim() || '0.6') * 1000,
  ));
  const params = new URLSearchParams({
    model: DEEPGRAM_STT_MODEL,
    encoding: 'linear16',
    sample_rate: String(STT_SAMPLE_RATE),
    channels: '1',
    interim_results: 'true',   // drives the same live partial transcript
    smart_format: 'true',
    punctuate: 'true',
    endpointing: silenceMs,
  });
  return `${DEEPGRAM_STT_BASE}?${params}`;
}

function sendToClient(clientWs: WebSocket, payload: object): void {
  if (clientWs.readyState === WebSocket.OPEN) {
    clientWs.send(JSON.stringify(payload));
  }
}

function abortUpgrade(socket: Duplex, status: number, message: string): void {
  console.error(TAG, `abort upgrade ${status}:`, message);
  const body = message || 'Upgrade failed';
  socket.write(
    `HTTP/1.1 ${status} ${status === 503 ? 'Service Unavailable' : 'Internal Server Error'}\r\n` +
    'Content-Type: text/plain\r\n' +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    '\r\n' +
    body,
  );
  socket.destroy();
}

export function handleDeepgramUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): boolean {
  const pathname = upgradePathname(request);
  if (pathname !== STT_PATH) return false;

  const remote = request.socket.remoteAddress || 'unknown';

  // Scribe is primary; Deepgram covers the case where ElevenLabs has no key at
  // all, so voice still works instead of failing the upgrade outright.
  const startProvider: Provider = ELEVENLABS_API_KEY ? 'elevenlabs' : 'deepgram';

  console.log(TAG, 'upgrade start', {
    path: pathname,
    url: request.url,
    origin: request.headers.origin || '(none)',
    remote,
    startProvider,
    elevenLabsKey: ELEVENLABS_API_KEY ? `set (${ELEVENLABS_API_KEY.length})` : 'MISSING',
    deepgramFallback: DEEPGRAM_API_KEY ? `available (${DEEPGRAM_STT_MODEL})` : 'unavailable — no DEEPGRAM_API_KEY',
  });

  socket.on('error', (err) => {
    console.error(TAG, 'client socket error during upgrade:', err.message);
  });

  if (!ELEVENLABS_API_KEY && !DEEPGRAM_API_KEY) {
    abortUpgrade(socket, 503, 'No speech-to-text provider configured (need ELEVENLABS_API_KEY or DEEPGRAM_API_KEY)');
    return true;
  }

  const wss = new WebSocketServer({ noServer: true });

  wss.on('error', (err) => {
    console.error(TAG, 'WebSocketServer error:', err.message);
  });

  try {
    wss.handleUpgrade(request, socket, head, (clientWs) => {
      console.log(TAG, 'client connected', { remote, readyState: clientWs.readyState });

      let turnIndex = 0;
      let inTurn = false;
      // Deepgram's final Results frame can arrive with an empty transcript, so the
      // last non-empty partial is what the turn actually commits.
      let lastPartial = '';
      let upstreamChunks = 0;
      let clientChunks = 0;

      // Reconnect state: Scribe idle-closes (code 1000) during the silence while
      // Jarvis speaks / between turns. We transparently reopen upstream and keep the
      // client WS alive so STT never drops mid-conversation.
      let upstream: WebSocket | null = null;
      let fatal = false;
      let clientClosing = false;
      let reconnects = 0;
      // Which transcriber is live, and whether we have already fallen back (the
      // switch is one-way — bouncing between providers would cost a turn each time).
      let provider: Provider = startProvider;
      let usedFallback = startProvider === 'deepgram';
      let sessionAnnounced = false;
      const MAX_RECONNECTS = 40; // high — normal idle-closes shouldn't exhaust it
      // Small buffer so audio arriving during a reconnect isn't lost (~2s cap).
      const pending: string[] = [];
      const PENDING_CAP = 200;

      // Silence keepalive: while Jarvis speaks the mic is paused (no audio), and
      // Scribe idle-closes. Feeding it periodic SILENCE (VAD ignores it — no
      // transcript) keeps the session alive so STT never drops between turns.
      let lastClientAudioAt = Date.now();
      const SILENCE_B64 = Buffer.alloc(3200).toString('base64'); // ~100ms @16kHz/16-bit

      // Scribe wants base64 inside JSON; Deepgram wants the raw PCM frame. The
      // buffer stays base64 either way so a fallback can replay audio captured
      // before the switch.
      function sendAudio(ws: WebSocket, b64: string) {
        if (provider === 'elevenlabs') {
          ws.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: b64, commit: false, sample_rate: STT_SAMPLE_RATE }));
        } else {
          ws.send(Buffer.from(b64, 'base64'));
        }
      }

      function forward(b64: string) {
        if (upstream && upstream.readyState === WebSocket.OPEN) {
          sendAudio(upstream, b64);
        } else if (pending.length < PENDING_CAP) {
          pending.push(b64);
        }
      }

      /** Announce a live session to the client exactly once, whoever wins. */
      function announceReady(isReconnect: boolean) {
        if (isReconnect && sessionAnnounced) {
          console.log(TAG, `session resumed on ${provider}`);
          return;
        }
        sessionAnnounced = true;
        console.log(TAG, `session started on ${provider} — sending Connected + ready`);
        sendToClient(clientWs, { type: 'Connected', source: provider === 'elevenlabs' ? 'elevenlabs-scribe' : `deepgram-${DEEPGRAM_STT_MODEL}` });
        sendToClient(clientWs, { type: 'ready' });
      }

      /**
       * Move to Deepgram after ElevenLabs proves unusable. Returns false when
       * there is nothing to fall back to, so the caller reports the real failure
       * rather than silently going quiet — a dead mic must never look like silence.
       */
      function fallbackToDeepgram(why: string): boolean {
        if (usedFallback || provider === 'deepgram') return false;
        if (!DEEPGRAM_API_KEY) {
          console.error(TAG, `ElevenLabs unusable (${why}) and no DEEPGRAM_API_KEY — cannot fall back`);
          return false;
        }
        console.warn(TAG, `ElevenLabs unusable (${why}) — falling back to Deepgram ${DEEPGRAM_STT_MODEL}`);
        usedFallback = true;
        provider = 'deepgram';
        fatal = false;      // the fatal verdict was ElevenLabs-specific
        reconnects = 0;
        sendToClient(clientWs, { type: 'stt_provider_changed', provider: 'deepgram', reason: why });
        connectUpstream(sessionAnnounced);
        return true;
      }

      /** Deepgram → the same TurnInfo protocol the client already speaks. */
      function handleDeepgramMessage(raw: RawData) {
        let msg: DeepgramMessage;
        try { msg = JSON.parse(raw.toString()) as DeepgramMessage; }
        catch (err) { console.error(TAG, 'deepgram JSON parse failed:', err); return; }

        if (msg.type === 'Metadata') return;

        // UtteranceEnd closes a turn that ended on silence without a speech_final.
        if (msg.type === 'UtteranceEnd') {
          if (inTurn) {
            sendToClient(clientWs, { type: 'TurnInfo', event: 'EndOfTurn', transcript: lastPartial, turn_index: turnIndex });
            inTurn = false; turnIndex += 1; lastPartial = '';
          }
          return;
        }

        if (msg.type !== 'Results') return;

        const transcript = (msg.channel?.alternatives?.[0]?.transcript || '').trim();
        upstreamChunks += 1;

        // Deepgram emits empty interim results constantly during silence; they
        // carry no information and must not open a turn.
        if (!transcript && !inTurn) return;

        if (transcript) {
          lastPartial = transcript;
          if (!inTurn) {
            inTurn = true;
            sendToClient(clientWs, { type: 'TurnInfo', event: 'StartOfTurn', transcript, turn_index: turnIndex });
          }
          sendToClient(clientWs, { type: 'TurnInfo', event: 'Update', transcript, turn_index: turnIndex });
        }

        // speech_final is Deepgram's "the speaker stopped" — the commit signal.
        if (msg.speech_final && inTurn) {
          sendToClient(clientWs, { type: 'TurnInfo', event: 'EndOfTurn', transcript: lastPartial, turn_index: turnIndex });
          inTurn = false; turnIndex += 1; lastPartial = '';
        }
      }

      function connectUpstream(isReconnect: boolean) {
        if (clientClosing || fatal) return;

        const isEleven = provider === 'elevenlabs';
        const sttUrl = isEleven ? elevenLabsSttUrl() : deepgramSttUrl();
        const headers = isEleven
          ? { 'xi-api-key': ELEVENLABS_API_KEY }
          : { Authorization: `Token ${DEEPGRAM_API_KEY}` };

        console.log(TAG, isReconnect ? `reopening upstream (reconnect ${reconnects})` : 'opening upstream', {
          provider, model: isEleven ? ELEVENLABS_STT_MODEL : DEEPGRAM_STT_MODEL,
        });
        const ws = new WebSocket(sttUrl, { headers });
        upstream = ws;

        ws.on('open', () => {
          console.log(TAG, `upstream open (${provider})`);
          reconnects = 0;
          // Deepgram is live the moment the socket opens — it sends no
          // session_started, so announce here rather than waiting for a message
          // that will never arrive.
          if (!isEleven) announceReady(isReconnect);
          // Flush any audio buffered during the reconnect gap.
          if (pending.length) {
            for (const b64 of pending.splice(0)) sendAudio(ws, b64);
          }
        });

        ws.on('message', (data: RawData) => {
          if (provider === 'deepgram') { handleDeepgramMessage(data); return; }

          let msg: ScribeMessage;
          try { msg = JSON.parse(data.toString()) as ScribeMessage; }
          catch (err) { console.error(TAG, 'upstream JSON parse failed:', err); return; }

          const kind = msg.message_type || '(unknown)';
          if (kind !== 'partial_transcript' || upstreamChunks < 3) {
            console.log(TAG, 'upstream message', { type: kind, error: msg.error || undefined, textLen: msg.text?.length ?? 0 });
          }

          switch (msg.message_type) {
            case 'session_started':
              announceReady(isReconnect);
              return;

            case 'partial_transcript': {
              upstreamChunks += 1;
              const transcript = (msg.text || '').trim();
              if (!inTurn) { inTurn = true; sendToClient(clientWs, { type: 'TurnInfo', event: 'StartOfTurn', transcript, turn_index: turnIndex }); }
              sendToClient(clientWs, { type: 'TurnInfo', event: 'Update', transcript, turn_index: turnIndex });
              return;
            }

            case 'committed_transcript': {
              const transcript = (msg.text || '').trim();
              sendToClient(clientWs, { type: 'TurnInfo', event: 'EndOfTurn', transcript, turn_index: turnIndex });
              inTurn = false; turnIndex += 1;
              return;
            }

            case 'committed_transcript_with_timestamps':
              return;

            default:
              if (msg.message_type && SCRIBE_ERROR_TYPES.has(msg.message_type)) {
                console.error(TAG, `upstream ${msg.message_type}: ${msg.error || '(no detail)'}`);
                if (FATAL_ERROR_TYPES.has(msg.message_type)) {
                  // auth_error / quota_exceeded / resource_exhausted mean Scribe
                  // will not transcribe for this account — exactly what Deepgram
                  // is here for. Only give up if the fallback is unavailable.
                  fatal = true;
                  try { ws.close(); } catch { /* noop */ }
                  if (!fallbackToDeepgram(msg.message_type)) {
                    sendToClient(clientWs, { type: 'proxy_error', code: msg.message_type, message: msg.error || msg.message_type });
                    if (clientWs.readyState === WebSocket.OPEN) clientWs.close(1011, msg.message_type);
                  }
                } else {
                  // Recoverable (e.g. session_time_limit_exceeded) → let close handler reconnect.
                  try { ws.close(); } catch { /* noop */ }
                }
              } else if (msg.message_type) {
                console.log(TAG, 'upstream unhandled message_type:', msg.message_type);
              }
              return;
          }
        });

        ws.on('close', (code, reason) => {
          const clientOpen = clientWs.readyState === WebSocket.OPEN;

          // A socket we have already replaced (e.g. the ElevenLabs one we closed
          // on the way into a Deepgram fallback) closes *after* its successor is
          // live. Reconnecting on its behalf would open a second upstream and
          // split the audio stream across both, so ignore stale sockets.
          if (upstream !== ws) {
            console.log(TAG, 'stale upstream closed — ignoring', { code, provider });
            return;
          }

          console.log(TAG, 'upstream close', { code, reason: reason?.toString() || '', clientOpen, fatal, clientClosing, provider });
          if (clientClosing || fatal) { if (clientOpen) clientWs.close(); return; }

          // Never got a session at all (bad key, provider down, handshake
          // refused). Retrying 40 times would leave Joe holding a dead mic for
          // half a minute — try the other provider after a couple of attempts.
          if (clientOpen && !sessionAnnounced && provider === 'elevenlabs' && reconnects >= 2) {
            if (fallbackToDeepgram(`upstream never opened (close ${code})`)) return;
          }

          if (clientOpen && reconnects < MAX_RECONNECTS) {
            reconnects += 1;
            const delay = Math.min(150 * reconnects, 800);
            setTimeout(() => { if (!clientClosing && clientWs.readyState === WebSocket.OPEN) connectUpstream(true); }, delay);
          } else if (clientOpen) {
            // Reconnects exhausted. On ElevenLabs that is a reason to try
            // Deepgram rather than end the conversation; on Deepgram it is the end.
            if (!fallbackToDeepgram('reconnects exhausted')) {
              console.warn(TAG, `max reconnects reached on ${provider} — closing client`);
              clientWs.close();
            }
          }
        });

        ws.on('error', (err) => {
          console.error(TAG, 'upstream error:', err.message);
          // Don't tear down the client — the 'close' handler decides whether to reconnect.
        });
      }

      connectUpstream(false);

      // Keepalive every 2.5s: WS ping + a silence chunk when the mic has been idle
      // (Jarvis speaking / between turns). Silence keeps Scribe's session alive without
      // producing a transcript, so STT never idle-closes.
      const keepalive = setInterval(() => {
        try {
          if (!upstream || upstream.readyState !== WebSocket.OPEN) return;
          upstream.ping();
          if (Date.now() - lastClientAudioAt > 2000) {
            if (provider === 'elevenlabs') {
              upstream.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: SILENCE_B64, commit: false, sample_rate: STT_SAMPLE_RATE }));
            } else {
              // Deepgram has a purpose-built keepalive; feeding it silence would
              // count against the audio bill for no reason.
              upstream.send(JSON.stringify({ type: 'KeepAlive' }));
            }
          }
        } catch { /* noop */ }
      }, 2500);

      clientWs.on('message', (data: RawData, isBinary: boolean) => {
        if (!isBinary) { console.warn(TAG, 'client sent non-binary frame — ignored'); return; }
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        if (!buf.length) return;
        lastClientAudioAt = Date.now();
        clientChunks += 1;
        if (clientChunks === 1 || clientChunks % 50 === 0) {
          console.log(TAG, 'client audio chunk', { n: clientChunks, bytes: buf.length });
        }
        forward(buf.toString('base64'));
      });

      clientWs.on('close', (code, reason) => {
        clientClosing = true;
        clearInterval(keepalive);
        console.log(TAG, 'client close', { code, reason: reason?.toString() || '', clientChunks, upstreamState: upstream?.readyState });
        if (upstream && upstream.readyState === WebSocket.OPEN) upstream.close();
      });

      clientWs.on('error', (err) => {
        clientClosing = true;
        clearInterval(keepalive);
        console.error(TAG, 'client ws error:', err.message);
        if (upstream && upstream.readyState === WebSocket.OPEN) upstream.close();
      });
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(TAG, 'handleUpgrade threw:', msg);
    abortUpgrade(socket, 500, msg);
    return true;
  }

  console.log(TAG, 'upgrade handed off to WebSocketServer');
  return true;
}
