/**
 * Aethon Voice Pipeline — ElevenLabs Scribe STT → Claude SSE → ElevenLabs TTS
 */
(function () {
  "use strict";

  const PCM_SAMPLE_RATE = 24000;
  const STT_SAMPLE_RATE = 16000;
  const COMMIT_DEBOUNCE_MS = 120;

  let api = null;
  let listening = false;
  let voiceActive = false;
  let sessionReady = false;
  let micSending = true;
  let micCaptureActive = false;
  let activationPlayed = false;

  let currentTurnIndex = -1;
  let latestTurnTranscript = "";
  let pendingCommitTimer = null;

  let processor = null;
  let lpFilter = null;
  let captureCtx = null;
  let micStream = null;
  let sttWs = null;

  let playbackCtx = null;
  // Ordered TTS pipeline: fetch sentences in PARALLEL (fast) but play them in
  // strict submission order (no scrambled words). Each sentence gets a seq; the
  // player consumes seqs in order and waits if the next one hasn't arrived yet.
  let ttsResults = {};      // seq -> ArrayBuffer | null (null = failed, skip)
  let ttsEnqueued = 0;      // sentences submitted this response
  let ttsPlayIndex = 0;     // next seq to play
  let ttsTotal = Infinity;  // final sentence count (set on stream 'done')
  let ttsIsDraining = false;
  let ttsIsPlaying = false;
  let activeSources = [];  // scheduled/playing AudioBufferSourceNodes, oldest first
  let nextStartTime = 0;   // ctx.currentTime this response's audio queue is booked through
  let lastTtsText = "";    // previous sentence's text — sent as ElevenLabs previous_text
                           // context so prosody carries across the join, not restart cold

  let sessionTranscript = [];
  let sessionStartTime = null;
  let brainBusy = false;

  // ── Barge-in ────────────────────────────────────────────────────────────
  // Joe talking over Jarvis should stop him dead, the way it would with a
  // person. The risk is the opposite failure: Jarvis's own voice leaking into
  // the mic and interrupting himself in a loop. Guards against that:
  //   • getUserMedia runs with echoCancellation, so playback is largely
  //     subtracted from the captured signal already;
  //   • a barge must clear a word/'length bar, so a stray syllable of bleed or a
  //     cough cannot trigger it;
  //   • a short grace period after audio starts, covering the moment when the
  //     canceller is still adapting and bleed is most likely.
  let brainAbort = null;          // AbortController for the in-flight response
  let ttsStartedAt = 0;           // when the current response began speaking
  let bargedThisResponse = false; // one barge per response — no thrashing
  const BARGE_GRACE_MS = 700;     // ignore the first moments of playback
  const BARGE_MIN_WORDS = 2;      // "uh" or a click must not stop him
  const BARGE_MIN_CHARS = 7;

  function isBargeWorthy(text) {
    const t = (text || "").trim();
    if (!t) return false;
    return wordCount(t) >= BARGE_MIN_WORDS || t.length >= BARGE_MIN_CHARS;
  }

  // Cut Jarvis off: silence playback, drop queued audio, abandon the response.
  function bargeIn(reason) {
    if (bargedThisResponse) return false;
    bargedThisResponse = true;
    console.log("[Jarvis] barge-in —", reason);

    stopTtsPlayback();
    if (brainAbort) {
      try { brainAbort.abort(); } catch (_) {}
      brainAbort = null;
    }
    brainBusy = false;
    // Straight back to listening so the interrupting sentence lands as a turn.
    micCaptureActive = true;
    micSending = true;
    api.setState("LISTENING");
    return true;
  }

  function wsOrigin() {
    const p = window.location.protocol === "https:" ? "wss:" : "ws:";
    return p + "//" + window.location.host;
  }

  function wordCount(text) {
    return text.trim().split(/\s+/).filter(Boolean).length;
  }

  function shouldCommitTranscript(text, event) {
    const t = text.trim();
    if (!t) return false;
    if (!micCaptureActive) return false;
    if (brainBusy || ttsIsPlaying) return false;
    if (event !== "EndOfTurn") return false;
    if (wordCount(t) < 2 && t.length < 12) return false;
    return true;
  }

  function scheduleCommit(text, event) {
    if (!shouldCommitTranscript(text, event)) return;
    if (pendingCommitTimer) clearTimeout(pendingCommitTimer);
    pendingCommitTimer = setTimeout(function () {
      pendingCommitTimer = null;
      if (shouldCommitTranscript(text, event)) {
        void commitTranscript(text.trim());
      }
    }, COMMIT_DEBOUNCE_MS);
  }

  function waitForSessionReady(timeoutMs) {
    return new Promise(function (resolve) {
      if (sessionReady) {
        resolve();
        return;
      }
      const deadline = Date.now() + (timeoutMs || 10000);
      const tick = setInterval(function () {
        if (sessionReady) {
          clearInterval(tick);
          resolve();
          return;
        }
        if (Date.now() >= deadline) {
          clearInterval(tick);
          console.warn("[Jarvis] STT ready timeout — continuing anyway");
          sessionReady = true;
          resolve();
        }
      }, 50);
    });
  }

  function downsampleBuffer(buffer, inputRate, outputRate) {
    if (outputRate === inputRate) return buffer;
    const ratio = inputRate / outputRate;
    const newLen = Math.round(buffer.length / ratio);
    const result = new Float32Array(newLen);
    for (let i = 0; i < newLen; i++) {
      const pos = i * ratio;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const a = buffer[idx] || 0;
      const b = buffer[Math.min(idx + 1, buffer.length - 1)] || 0;
      result[i] = a + frac * (b - a);
    }
    return result;
  }

  function floatTo16BitPCM(float32) {
    const out = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  function getPlaybackCtx() {
    if (!playbackCtx) {
      playbackCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: PCM_SAMPLE_RATE });
    }
    return playbackCtx;
  }

  function unlockAudioFromUserGesture() {
    const ctx = getPlaybackCtx();
    if (ctx.state === "suspended") ctx.resume();
    const buf = ctx.createBuffer(1, 1, PCM_SAMPLE_RATE);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(0);
  }

  function stopCapture() {
    if (processor) {
      try { processor.disconnect(); processor.onaudioprocess = null; } catch (_) {}
      processor = null;
    }
    if (lpFilter) {
      try { lpFilter.disconnect(); } catch (_) {}
      lpFilter = null;
    }
    if (captureCtx) {
      try { captureCtx.close(); } catch (_) {}
      captureCtx = null;
    }
  }

  function stopMicStream() {
    stopCapture();
    micCaptureActive = false;
    if (micStream) {
      micStream.getTracks().forEach(function (t) { t.stop(); });
      micStream = null;
    }
  }

  // Stop treating mic audio as a turn — but KEEP streaming it to STT so Joe can
  // cut in. Barge-in is impossible if the microphone goes deaf the moment Jarvis
  // opens his mouth, which is what `micSending = false` used to do here.
  function pauseMicCapture() {
    micCaptureActive = false;
    micSending = true;
  }

  // Genuinely stop sending audio (session teardown, not a turn boundary).
  function muteMic() {
    micCaptureActive = false;
    micSending = false;
  }

  function resumeMicCapture() {
    if (!voiceActive || !listening) return;
    micCaptureActive = true;
    micSending = true;
  }

  async function startCapture() {
    stopCapture();

    if (!micStream) {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
      });
    }

    captureCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: STT_SAMPLE_RATE });
    if (captureCtx.state === "suspended") await captureCtx.resume();

    const source = captureCtx.createMediaStreamSource(micStream);
    const inputRate = captureCtx.sampleRate;

    lpFilter = captureCtx.createBiquadFilter();
    lpFilter.type = "lowpass";
    lpFilter.frequency.value = 7500;
    lpFilter.Q.value = 0.707;

    processor = captureCtx.createScriptProcessor(2048, 1, 1);
    processor.onaudioprocess = function (e) {
      if (!listening || !sessionReady) return;
      const input = e.inputBuffer.getChannelData(0);

      if (micSending) {
        if (!sttWs || sttWs.readyState !== WebSocket.OPEN) return;
        const down = downsampleBuffer(input, inputRate, STT_SAMPLE_RATE);
        const pcm = floatTo16BitPCM(down);
        sttWs.send(pcm.buffer);
      }
    };

    source.connect(lpFilter);
    lpFilter.connect(processor);
    processor.connect(captureCtx.destination);
    micSending = true;
    micCaptureActive = true;
  }

  function onSttReady() {
    sessionReady = true;
    if (api && api.voiceNoteEl) {
      api.voiceNoteEl.style.display = "none";
    }
    if (listening) api.setState("LISTENING");
  }

  function handleDeepgramMessage(raw) {
    let msg;
    try {
      msg = typeof raw === "string" ? JSON.parse(raw) : JSON.parse(new TextDecoder().decode(raw));
    } catch (_) { return; }

    if (msg.type === "ready" || msg.type === "Connected") {
      console.log("[Jarvis] STT ready signal:", msg.type, msg.source || "");
      onSttReady();
      return;
    }

    if (msg.type === "proxy_error") {
      console.error("[Jarvis] STT proxy error:", msg.code, msg.message || "");
      if (api.voiceNoteEl) {
        api.voiceNoteEl.textContent = "STT ERROR: " + (msg.message || msg.code || "proxy_error");
        api.voiceNoteEl.style.display = "block";
      }
      return;
    }

    if (msg.type === "TurnInfo") {
      const transcript = (msg.transcript || "").trim();
      const turnIndex = typeof msg.turn_index === "number" ? msg.turn_index : 0;
      const event = msg.event || "";

      if (event === "StartOfTurn" || event === "Update") {
        // Joe speaking while Jarvis is talking (or while the brain is still
        // composing) means stop and listen. Checked on the partial, not the
        // committed turn, so he is cut off mid-word rather than a sentence later.
        if ((ttsIsPlaying || brainBusy) && isBargeWorthy(transcript)) {
          const settled = !ttsIsPlaying || (Date.now() - ttsStartedAt) > BARGE_GRACE_MS;
          if (settled) bargeIn('"' + transcript.slice(0, 40) + '"');
        }

        if (turnIndex !== currentTurnIndex) {
          currentTurnIndex = turnIndex;
          latestTurnTranscript = transcript;
        } else if (transcript) {
          latestTurnTranscript = transcript;
        }
        if (transcript && micCaptureActive && !brainBusy && !ttsIsPlaying) {
          api.setState("LISTENING");
          api.orbLabelEl.textContent = '"' + transcript + '"';
        }
        return;
      }

      if (event === "TurnResumed") {
        if (pendingCommitTimer) {
          clearTimeout(pendingCommitTimer);
          pendingCommitTimer = null;
        }
        if (transcript) latestTurnTranscript = transcript;
        return;
      }

      if (event === "EagerEndOfTurn") {
        if (transcript) latestTurnTranscript = transcript;
        return;
      }

      if (event === "EndOfTurn") {
        const finalText = transcript || latestTurnTranscript;
        latestTurnTranscript = finalText;
        if (finalText) {
          api.orbLabelEl.textContent = '"' + finalText + '"';
        }
        scheduleCommit(finalText, event);
      }
      return;
    }

    if (msg.type === "Results" || msg.type === "Metadata") return;
  }

  async function commitTranscript(text) {
    if (!text || brainBusy) return;
    brainBusy = true;
    pauseMicCapture();

    sessionTranscript.push({ role: "user", content: text, ts: Date.now() });
    await runProcessingThenRespond(text);
  }

  // Stop and forget every currently scheduled/playing buffer.
  function stopAllSources() {
    activeSources.forEach(function (s) { try { s.stop(0); } catch (_) {} });
    activeSources = [];
  }

  // Reset the TTS pipeline at the start of each response.
  function resetTts() {
    ttsResults = {};
    ttsEnqueued = 0;
    ttsPlayIndex = 0;
    ttsTotal = Infinity;
    ttsIsDraining = false;
    ttsIsPlaying = false;
    lastTtsText = "";
    nextStartTime = 0;
    ttsStartedAt = 0;
    bargedThisResponse = false;  // a new response earns a fresh barge
    stopAllSources();
  }

  // Barge-in / stop: kill current playback and drop any pending slots.
  function stopTtsPlayback() {
    ttsTotal = 0;
    ttsResults = {};
    ttsPlayIndex = 0;
    ttsEnqueued = 0;
    ttsIsDraining = false;
    ttsIsPlaying = false;
    lastTtsText = "";
    nextStartTime = 0;
    stopAllSources();
  }

  // Schedule a chunk sample-accurately right after whatever's already queued —
  // no waiting for the previous chunk's onended before booking the next start
  // time, which is what left an audible gap/click at every sentence boundary.
  function scheduleBuffer(item) {
    const ctx = getPlaybackCtx();
    // Guard: 16-bit PCM must have an even byte count — a truncated/odd body
    // would make the Int16Array constructor throw and silently drop the
    // whole sentence. Trim the dangling byte instead.
    if (item.byteLength % 2 !== 0) item = item.slice(0, item.byteLength - 1);
    const int16 = new Int16Array(item);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;
    const buf = ctx.createBuffer(1, float32.length, PCM_SAMPLE_RATE);
    buf.copyToChannel(float32, 0);
    const source = ctx.createBufferSource();
    source.buffer = buf;
    source.connect(ctx.destination);

    const startAt = Math.max(ctx.currentTime, nextStartTime);
    nextStartTime = startAt + buf.duration;
    activeSources.push(source);
    source.onended = function () {
      const idx = activeSources.indexOf(source);
      if (idx !== -1) activeSources.splice(idx, 1);
      if (activeSources.length === 0) {
        ttsIsPlaying = false;
        if (ttsPlayIndex >= ttsTotal) finishTts();
      }
    };
    source.start(startAt);
  }

  // Schedule every consecutive ready slot immediately, back-to-back, so
  // playback stays gapless; wait (do nothing) if the next one isn't ready —
  // its fetch will call pumpTts() again when it lands.
  function pumpTts() {
    while (ttsPlayIndex in ttsResults) {
      const buf = ttsResults[ttsPlayIndex];
      delete ttsResults[ttsPlayIndex];
      ttsPlayIndex += 1;
      if (buf === null) continue; // failed fetch → skip in order, no gap inserted
      if (!ttsIsDraining) {
        ttsIsDraining = true;
        pauseMicCapture();
        api.setState("RESPONDING");
      }
      if (!ttsIsPlaying) ttsStartedAt = Date.now();  // starts the barge grace window
      ttsIsPlaying = true;
      scheduleBuffer(buf);
    }
    if (ttsPlayIndex >= ttsTotal && activeSources.length === 0) finishTts();
  }

  function finishTts() {
    ttsIsDraining = false;
    ttsIsPlaying = false;
    onTtsQueueDrained();
  }

  // Called when the stream signals it has sent every sentence.
  function markTtsComplete() {
    ttsTotal = ttsEnqueued;
    pumpTts();
  }

  function onTtsQueueDrained() {
    if (!brainBusy && voiceActive) {
      resumeMicCapture();
      if (listening) api.setState("LISTENING");
    }
  }

  async function fetchTtsAudio(text, previousText) {
    const res = await fetch("/api/voice/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text, previousText: previousText })
    });
    if (!res.ok) throw new Error("TTS failed: " + res.status);
    return res.arrayBuffer();
  }

  // Fetch a sentence's audio in parallel; store it in its ordered slot; then pump.
  // previous_text (the prior sentence) rides along so ElevenLabs can carry
  // prosody across the join instead of every chunk synthesizing cold/isolated.
  async function enqueueTts(text) {
    const seq = ttsEnqueued++;
    const previousText = lastTtsText;
    lastTtsText = text;
    try {
      ttsResults[seq] = await fetchTtsAudio(text, previousText);
    } catch (e) {
      console.error("[Jarvis] TTS fetch error, retrying once:", e);
      try {
        ttsResults[seq] = await fetchTtsAudio(text, previousText);
      } catch (e2) {
        console.error("[Jarvis] TTS retry failed:", e2);
        ttsResults[seq] = null; // mark failed so the player skips it in order
      }
    }
    pumpTts();
  }

  // Fire-and-forget: never block the next turn on memory extraction. We capture and
  // clear the batch synchronously (no race with the next turn's pushes), then let
  // the extraction run in the background while Jarvis is already listening again.
  function flushTranscriptToMemory() {
    if (sessionTranscript.length < 2) {
      sessionTranscript = [];
      sessionStartTime = null;
      return;
    }
    const batch = sessionTranscript;
    const start = sessionStartTime;
    sessionTranscript = [];
    sessionStartTime = null;
    fetch("/api/memory/extract-voice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript: batch, sessionStart: start, sessionEnd: new Date().toISOString() })
    }).catch(function (e) { console.error("[Jarvis] memory flush failed:", e); });
  }

  async function runProcessingThenRespond(userText) {
    api.clearTimers();
    api.setState("PROCESSING");
    pauseMicCapture();
    resetTts(); // fresh ordered pipeline for this response

    let fullText = "";
    const abort = new AbortController();
    brainAbort = abort;

    try {
      const res = await fetch("/api/brain/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: userText, sessionId: "arlo-session" }),
        signal: abort.signal
      });

      if (!res.ok || !res.body) throw new Error("Brain stream failed");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let sseBuf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // Joe cut in — stop consuming this response's sentences immediately so
        // no further audio is queued behind the interruption.
        if (abort.signal.aborted) break;
        sseBuf += decoder.decode(value, { stream: true });

        const parts = sseBuf.split("\n\n");
        sseBuf = parts.pop() || "";

        for (let i = 0; i < parts.length; i++) {
          const line = parts[i].trim();
          if (!line.startsWith("data: ")) continue;
          let data;
          try { data = JSON.parse(line.slice(6)); } catch (_) { continue; }

          if ((data.type === "sentence" || data.type === "speech_chunk") && data.text) {
            fullText += (fullText ? " " : "") + data.text;
            enqueueTts(data.text).catch(function (e) {
              console.error("[Jarvis] TTS enqueue error:", e);
            });
          }
          if (data.type === "navigate" && data.tab) {
            // Jarvis pulls up an agent's dashboard in the shell (he keeps speaking over it).
            try { window.parent.postMessage({ type: "arlo-navigate", tab: data.tab }, "*"); } catch (_) {}
          }
          if (data.type === "curiosity" && data.question) {
            sessionTranscript.push({ role: "assistant", content: data.question, ts: Date.now() });
            enqueueTts(data.question).catch(function (e) {
              console.error("[Jarvis] Curiosity TTS error:", e);
            });
          }
          if (data.type === "done" || data.type === "speech_complete") {
            if (data.text || data.speech) fullText = data.text || data.speech || fullText;
            // All sentences submitted — let the ordered player finish + resume mic.
            markTtsComplete();
          }
          if (data.type === "speech_complete" && data.speech) {
            fullText = data.speech;
          }
        }
      }

      if (fullText) {
        sessionTranscript.push({ role: "assistant", content: fullText, ts: Date.now() });
      }

      // Background — do NOT block the next turn / mic resume on extraction.
      flushTranscriptToMemory();
    } catch (err) {
      // An abort is Joe interrupting on purpose, not a failure — saying
      // "BRAIN UNAVAILABLE" over a deliberate interruption would be a lie.
      if (err && err.name === "AbortError") {
        console.log("[Jarvis] response aborted by barge-in");
        if (fullText) sessionTranscript.push({ role: "assistant", content: fullText + " …(interrupted)", ts: Date.now() });
      } else {
        console.error("[Jarvis] Brain pipeline error:", err);
        api.voiceNoteEl.textContent = "BRAIN UNAVAILABLE";
        api.voiceNoteEl.style.display = "block";
      }
    } finally {
      if (brainAbort === abort) brainAbort = null;
      // A barge already flipped these and started a new turn; don't stomp it.
      if (!abort.signal.aborted) {
        brainBusy = false;
        if (!ttsIsPlaying && voiceActive) {
          resumeMicCapture();
          api.setState("LISTENING");
        }
      }
    }
  }

  // The opener, pre-rendered server-side and served from memory. Playing this
  // first is what removes the five-or-six seconds of silence after a tap: the
  // brain call and the synthesis call for the real briefing now happen while
  // Joe is already hearing something. Returns true if audio actually played.
  async function playCachedOpener() {
    try {
      const res = await fetch("/api/voice/opener");
      if (!res.ok) return false;              // fall back to the normal path
      const buf = await res.arrayBuffer();
      if (!buf || buf.byteLength < 2) return false;
      const text = res.headers.get("X-Opener-Text");
      if (text) api.orbLabelEl.textContent = text;
      api.setState("RESPONDING");
      // Seq 0 of this response's ordered pipeline; the briefing appends after it.
      ttsResults[ttsEnqueued++] = buf;
      pumpTts();
      return true;
    } catch (_) {
      return false;
    }
  }

  async function playActivationGreeting() {
    if (activationPlayed) return;
    activationPlayed = true;

    // Fresh pipeline, then opener first and briefing second — in that submission
    // order, so the ordered player keeps them in sequence.
    resetTts();
    const openerPlayed = await playCachedOpener();

    try {
      const res = await fetch("/api/brain/activate" + (openerPlayed ? "?opener=1" : ""));
      const data = await res.json();
      const speech = (data.speech || "").trim();

      if (!speech) {
        // Nothing further to say. Seal the pipeline so it drains and hands back
        // to listening rather than hanging in RESPONDING.
        if (openerPlayed) markTtsComplete();
        else { api.setState("LISTENING"); }
        return;
      }

      api.orbLabelEl.textContent = speech.slice(0, 80);
      if (openerPlayed) {
        enqueueTts(speech).catch(function (e) { console.error("[Jarvis] briefing TTS error:", e); });
        markTtsComplete();
        return;
      }
      // Opener unavailable — speak the whole greeting through the normal path.
      // SEAL the pipeline so it drains and hands control back to listening
      // instead of sticking on RESPONDING.
      enqueueTts(speech).catch(function (e) { console.error("[Jarvis] greeting TTS error:", e); });
      markTtsComplete();
    } catch (err) {
      console.error("[Jarvis] activation error:", err);
      // If the opener is mid-flight, let it finish and return to listening.
      if (ttsEnqueued > 0) markTtsComplete();
    }
  }

  async function startListening() {
    if (listening || brainBusy) return;

    unlockAudioFromUserGesture();
    voiceActive = true;
    listening = true;
    sessionReady = false;
    sessionStartTime = new Date().toISOString();
    currentTurnIndex = -1;
    latestTurnTranscript = "";
    api.setState("LISTENING");
    api.orbLabelEl.textContent = "CONNECTING…";

    // Fire the activation greeting immediately — it's just an LLM+TTS round
    // trip and doesn't depend on the mic/STT pipeline at all. Previously this
    // waited behind the STT WebSocket handshake, getUserMedia, AND
    // waitForSessionReady before even starting, stacking 1-3s of dead air in
    // front of every greeting. Run it in parallel instead.
    const greetingPromise = playActivationGreeting();

    return new Promise(function (resolve, reject) {
      const wsUrl = wsOrigin() + "/api/voice/deepgram/listen";
      console.log("[Jarvis] STT connecting:", wsUrl);
      sttWs = new WebSocket(wsUrl);
      sttWs.binaryType = "arraybuffer";

      sttWs.onmessage = function (event) {
        handleDeepgramMessage(event.data);
      };

      sttWs.onerror = function (ev) {
        console.error("[Jarvis] STT WebSocket onerror", {
          readyState: sttWs ? sttWs.readyState : "null",
          url: wsUrl,
          event: ev,
        });
        reject(new Error("STT WebSocket error — check Fly logs for [ScribeProxy]"));
      };

      sttWs.onclose = function (ev) {
        sessionReady = false;
        console.warn("[Jarvis] STT WebSocket closed", {
          code: ev.code,
          reason: ev.reason || "(none)",
          wasClean: ev.wasClean,
        });
        if (voiceActive && listening && !brainBusy) {
          api.voiceNoteEl.textContent = "STT DISCONNECTED (" + ev.code + ")";
          api.voiceNoteEl.style.display = "block";
        }
      };

      sttWs.onopen = async function () {
        console.log("[Jarvis] STT WebSocket open — starting mic");
        try {
          await startCapture();
          await waitForSessionReady(10000);
          api.orbLabelEl.textContent = "LISTENING…";
          await greetingPromise;
          resolve();
        } catch (err) {
          reject(err);
        }
      };
    }).catch(function (err) {
      console.error("[Jarvis] Listen error:", err);
      api.voiceNoteEl.textContent = "MIC / STT UNAVAILABLE";
      api.voiceNoteEl.style.display = "block";
      voiceActive = false;
      listening = false;
      if (sttWs) {
        try { sttWs.close(); } catch (_) {}
        sttWs = null;
      }
      stopMicStream();
      api.setState("STANDBY");
    });
  }

  function stopListening() {
    voiceActive = false;
    listening = false;
    brainBusy = false;
    sessionReady = false;
    if (pendingCommitTimer) {
      clearTimeout(pendingCommitTimer);
      pendingCommitTimer = null;
    }
    muteMic();   // session is ending — stop sending audio entirely
    stopTtsPlayback();
    if (sttWs) {
      try { sttWs.close(); } catch (_) {}
      sttWs = null;
    }
    stopMicStream();
    api.clearTimers();
    flushTranscriptToMemory();
    api.setState("STANDBY");
  }

  function onOrbClick() {
    const state = api.getCurrentState();
    if (state === "STANDBY") {
      startListening();
    } else if (state === "LISTENING" || state === "PROCESSING" || state === "RESPONDING") {
      stopListening();
    }
  }

  function setupMobileAudioUnlock() {
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    if (!isMobile) return;

    const overlay = document.createElement("div");
    overlay.id = "audio-unlock";
    overlay.style.cssText = "position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.92);display:flex;align-items:center;justify-content:center;cursor:pointer;";
    overlay.innerHTML = '<div style="font-family:monospace;color:#F5382A;letter-spacing:0.3em;font-size:12px;text-transform:uppercase;">Tap to activate J.A.R.V.I.S</div>';
    document.body.appendChild(overlay);

    overlay.addEventListener("click", function () {
      unlockAudioFromUserGesture();
      overlay.remove();
    });
  }

  window.ArloVoice = {
    init: function (hooks) {
      api = hooks;
      setupMobileAudioUnlock();
    },
    onOrbClick: onOrbClick,
    unlockAudio: unlockAudioFromUserGesture
  };
})();
