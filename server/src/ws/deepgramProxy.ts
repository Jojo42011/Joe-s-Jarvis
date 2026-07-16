import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { IncomingMessage } from 'http';
import { Duplex } from 'stream';
import { ELEVENLABS_API_KEY, ELEVENLABS_STT_MODEL } from '../config/voice';

const TAG = '[ScribeProxy]';
const ELEVENLABS_STT_BASE = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';
const STT_PATH = '/api/voice/deepgram/listen';

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
  console.log(TAG, 'upgrade start', {
    path: pathname,
    url: request.url,
    origin: request.headers.origin || '(none)',
    remote,
    keyPresent: !!ELEVENLABS_API_KEY,
    keyLen: ELEVENLABS_API_KEY.length,
    model: ELEVENLABS_STT_MODEL,
  });

  socket.on('error', (err) => {
    console.error(TAG, 'client socket error during upgrade:', err.message);
  });

  const key = ELEVENLABS_API_KEY;
  if (!key) {
    abortUpgrade(socket, 503, 'ELEVENLABS_API_KEY not configured');
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
      let upstreamChunks = 0;
      let clientChunks = 0;

      // Reconnect state: Scribe idle-closes (code 1000) during the silence while
      // Jarvis speaks / between turns. We transparently reopen upstream and keep the
      // client WS alive so STT never drops mid-conversation.
      let upstream: WebSocket | null = null;
      let fatal = false;
      let clientClosing = false;
      let reconnects = 0;
      const MAX_RECONNECTS = 40; // high — normal idle-closes shouldn't exhaust it
      // Small buffer so audio arriving during a reconnect isn't lost (~2s cap).
      const pending: string[] = [];
      const PENDING_CAP = 200;

      // Silence keepalive: while Jarvis speaks the mic is paused (no audio), and
      // Scribe idle-closes. Feeding it periodic SILENCE (VAD ignores it — no
      // transcript) keeps the session alive so STT never drops between turns.
      let lastClientAudioAt = Date.now();
      const SILENCE_B64 = Buffer.alloc(3200).toString('base64'); // ~100ms @16kHz/16-bit

      function forward(b64: string) {
        if (upstream && upstream.readyState === WebSocket.OPEN) {
          upstream.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: b64, commit: false, sample_rate: 16000 }));
        } else if (pending.length < PENDING_CAP) {
          pending.push(b64);
        }
      }

      function connectUpstream(isReconnect: boolean) {
        if (clientClosing || fatal) return;
        const sttUrl = elevenLabsSttUrl();
        console.log(TAG, isReconnect ? `reopening upstream (reconnect ${reconnects})` : 'opening upstream', { model: ELEVENLABS_STT_MODEL });
        const ws = new WebSocket(sttUrl, { headers: { 'xi-api-key': key } });
        upstream = ws;

        ws.on('open', () => {
          console.log(TAG, 'upstream open');
          reconnects = 0;
          // Flush any audio buffered during the reconnect gap.
          if (pending.length) {
            for (const b64 of pending.splice(0)) {
              ws.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: b64, commit: false, sample_rate: 16000 }));
            }
          }
        });

        ws.on('message', (data: RawData) => {
          let msg: ScribeMessage;
          try { msg = JSON.parse(data.toString()) as ScribeMessage; }
          catch (err) { console.error(TAG, 'upstream JSON parse failed:', err); return; }

          const kind = msg.message_type || '(unknown)';
          if (kind !== 'partial_transcript' || upstreamChunks < 3) {
            console.log(TAG, 'upstream message', { type: kind, error: msg.error || undefined, textLen: msg.text?.length ?? 0 });
          }

          switch (msg.message_type) {
            case 'session_started':
              // On a reconnect the client is already listening — only announce a fresh session.
              if (!isReconnect) {
                console.log(TAG, 'session_started — sending Connected + ready to client');
                sendToClient(clientWs, { type: 'Connected', source: 'elevenlabs-scribe' });
                sendToClient(clientWs, { type: 'ready' });
              } else {
                console.log(TAG, 'session_started (reconnected) — STT resumed');
              }
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
                  fatal = true;
                  sendToClient(clientWs, { type: 'proxy_error', code: msg.message_type, message: msg.error || msg.message_type });
                  if (clientWs.readyState === WebSocket.OPEN) clientWs.close(1011, msg.message_type);
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
          console.log(TAG, 'upstream close', { code, reason: reason?.toString() || '', clientOpen, fatal, clientClosing });
          if (clientClosing || fatal) { if (clientOpen) clientWs.close(); return; }
          if (clientOpen && reconnects < MAX_RECONNECTS) {
            reconnects += 1;
            const delay = Math.min(150 * reconnects, 800);
            setTimeout(() => { if (!clientClosing && clientWs.readyState === WebSocket.OPEN) connectUpstream(true); }, delay);
          } else if (clientOpen) {
            console.warn(TAG, 'max reconnects reached — closing client');
            clientWs.close();
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
            upstream.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: SILENCE_B64, commit: false, sample_rate: 16000 }));
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
