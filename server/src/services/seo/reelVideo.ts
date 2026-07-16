// ─── Reel video renderer ───────────────────────────────────────────────────────
// Turns a reel's still frames into an ACTUAL MP4 (not a slideshow): each frame
// gets a slow Ken-Burns zoom, frames crossfade into each other, and the whole
// thing exports as a vertical 1080x1920 H.264 clip that plays inline and can be
// downloaded/posted. Uses the system ffmpeg (installed in the Docker runner).
//
// Everything here is best-effort: if ffmpeg is missing or the encode fails, the
// caller keeps the frames and the UI falls back to the story-style frame player.

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

const TAG = '[Paulie video]';

// Kept deliberately light: the Fly VM is small (~256MB) and ffmpeg's zoompan is
// memory-hungry — encoding at 1080x1920/30fps OOM-killed the process. 720x1280
// is still crisp for Instagram (which re-compresses anyway) at ~0.44x the pixels,
// which keeps peak RAM well under the limit. Overridable via env if the VM grows.
const FPS = Number(process.env.RALPH_REEL_FPS || '24');
const W = Number(process.env.RALPH_REEL_W || '720');
const H = Number(process.env.RALPH_REEL_H || '1280');
const FRAME_SEC = Number(process.env.RALPH_REEL_FRAME_SEC || '2.6'); // hold per frame
const XFADE_SEC = 0.6;                                               // crossfade length

let ffmpegOk: boolean | undefined;

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    let stderr = '';
    let done = false;
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const timer = setTimeout(() => { if (!done) { done = true; child.kill('SIGKILL'); resolve({ code: -1, stderr: 'timeout' }); } }, timeoutMs);
    child.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 20000) stderr = stderr.slice(-20000); });
    child.on('error', (e) => { if (!done) { done = true; clearTimeout(timer); resolve({ code: -1, stderr: String(e) }); } });
    child.on('close', (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ code: code ?? -1, stderr }); } });
  });
}

async function hasFfmpeg(): Promise<boolean> {
  if (ffmpegOk !== undefined) return ffmpegOk;
  const { code } = await run('ffmpeg', ['-version'], 8000);
  ffmpegOk = code === 0;
  if (!ffmpegOk) console.warn(TAG, 'ffmpeg not available — reels will use the frame player');
  return ffmpegOk;
}

// One Ken-Burns (slow-zoom) motion clip per still frame. Each single image is
// expanded into FRAME_SEC of moving footage by zoompan's d= (do NOT feed it
// looped frames — that multiplies into thousands of frames and stalls).
function zoomClips(n: number): string[] {
  const durFrames = Math.round(FRAME_SEC * FPS);
  const clips: string[] = [];
  for (let i = 0; i < n; i++) {
    clips.push(
      `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},` +
      `zoompan=z='min(zoom+0.0016,1.14)':d=${durFrames}:s=${W}x${H}:fps=${FPS},` +
      `setsar=1,format=yuv420p[v${i}]`,
    );
  }
  return clips;
}

// Preferred graph: motion clips joined by crossfades (smoothest, most "video").
function buildXfadeFilter(n: number): { filter: string; out: string } {
  const parts = zoomClips(n);
  if (n === 1) return { filter: parts.join(';'), out: '[v0]' };
  let prev = 'v0';
  let combined = FRAME_SEC;
  for (let i = 1; i < n; i++) {
    const label = i === n - 1 ? 'vout' : `x${i}`;
    const offset = Math.max(0, combined - XFADE_SEC).toFixed(3);
    parts.push(`[${prev}][v${i}]xfade=transition=fade:duration=${XFADE_SEC}:offset=${offset}[${label}]`);
    combined = combined + FRAME_SEC - XFADE_SEC;
    prev = label;
  }
  return { filter: parts.join(';'), out: '[vout]' };
}

// Fallback graph: the same motion clips concatenated with hard cuts. Simpler and
// bulletproof across ffmpeg builds — still real video (each shot moves), just
// without crossfades. Used only if the xfade encode fails.
function buildConcatFilter(n: number): { filter: string; out: string } {
  const parts = zoomClips(n);
  if (n === 1) return { filter: parts.join(';'), out: '[v0]' };
  const labels = Array.from({ length: n }, (_, i) => `[v${i}]`).join('');
  parts.push(`${labels}concat=n=${n}:v=1:a=0[vout]`);
  return { filter: parts.join(';'), out: '[vout]' };
}

// Optional background music. Drop a licensed/royalty-free track at the path in
// ARLO_REEL_AUDIO (or client/assets/reel/music.mp3) and every reel gets it mixed
// in, looped to the clip length and gently faded. Left unset → silent reels
// (still valid; Instagram lets viewers add audio). Audio is always a *first*
// attempt: if muxing fails for any reason, we fall back to the silent encode so
// a bad/missing track can never break publishing.
async function resolveMusicPath(): Promise<string | null> {
  const candidates = [
    process.env.ARLO_REEL_AUDIO,
    path.join(process.cwd(), 'client/assets/reel/music.mp3'),
    path.join(process.cwd(), '../client/assets/reel/music.mp3'),
  ].filter(Boolean) as string[];
  for (const p of candidates) {
    try { await fs.access(p); return p; } catch { /* next */ }
  }
  return null;
}

/**
 * Render reel frames (PNG buffers, in order) into an MP4. Returns the MP4 bytes,
 * or null if ffmpeg is unavailable / the encode failed (caller falls back).
 */
export async function renderReelVideo(frames: Buffer[]): Promise<Buffer | null> {
  const usable = frames.filter((b) => b && b.length);
  if (usable.length < 2) return null; // need at least 2 frames for motion
  if (!(await hasFfmpeg())) return null;

  let dir: string | undefined;
  try {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reel-'));
    const inPaths: string[] = [];
    for (let i = 0; i < usable.length; i++) {
      const p = path.join(dir, `f${i}.png`);
      await fs.writeFile(p, usable[i]);
      inPaths.push(p);
    }
    const outPath = path.join(dir, 'out.mp4');
    const n = usable.length;
    const music = await resolveMusicPath();
    const durationSec = FRAME_SEC * n; // concat path (no crossfade overlap)

    // ONE frame per image (no -loop): zoompan's d= expands each single still into
    // FRAME_SEC of motion. Concat (hard cuts between the moving, zooming shots) is
    // the PRIMARY path — it holds only one frame in memory at a time, so it fits
    // the small VM. xfade (crossfades) needs two full frames at once and OOM-killed
    // the box, so it's only a last-ditch fallback if concat somehow fails.
    // Each graph is tried with audio first (when a track exists), then silent.
    const graphs: { name: string; graph: { filter: string; out: string } }[] = [
      { name: 'concat', graph: buildConcatFilter(n) },
      { name: 'xfade', graph: buildXfadeFilter(n) },
    ];
    const attempts: { name: string; graph: { filter: string; out: string }; audio: boolean }[] = [];
    for (const g of graphs) {
      if (music) attempts.push({ ...g, audio: true });
      attempts.push({ ...g, audio: false });
    }

    for (const attempt of attempts) {
      const args: string[] = ['-threads', '2'];
      for (const p of inPaths) args.push('-i', p);
      if (attempt.audio && music) {
        // Loop the track so short reels still get music, trim to video length, fade out.
        args.push('-stream_loop', '-1', '-i', music);
      }
      args.push('-filter_complex', attempt.graph.filter, '-map', attempt.graph.out);
      if (attempt.audio && music) {
        const fadeOut = Math.max(0, durationSec - 0.8).toFixed(2);
        args.push(
          '-map', `${n}:a`,
          '-af', `afade=t=in:d=0.6,afade=t=out:st=${fadeOut}:d=0.8,volume=0.5`,
          '-c:a', 'aac', '-b:a', '128k', '-shortest',
        );
      } else {
        args.push('-an');
      }
      args.push(
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24',
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
        '-r', String(FPS), '-threads', '2', '-y', outPath,
      );
      const { code, stderr } = await run('ffmpeg', args, 120000);
      if (code === 0) {
        const bytes = await fs.readFile(outPath);
        console.log(TAG, `rendered ${n}-frame reel via ${attempt.name}${attempt.audio ? '+music' : ''} → ${(bytes.length / 1024).toFixed(0)}KB mp4`);
        return bytes;
      }
      console.warn(TAG, `${attempt.name}${attempt.audio ? '+music' : ''} encode failed (code ${code}):`, stderr.split('\n').slice(-2).join(' | '));
    }
    return null;
  } catch (err) {
    console.warn(TAG, 'render error (frames kept):', err instanceof Error ? err.message : err);
    return null;
  } finally {
    if (dir) { try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
}
