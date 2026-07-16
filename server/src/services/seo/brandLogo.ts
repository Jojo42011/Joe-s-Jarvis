// ─── Brand logo overlay for Paulie's social imagery ───────────────────────────
// Every post Paulie ships is a brand asset — the Totally Outdoors logo
// goes on every generated image, composited server-side with sharp so
// the mark is always pixel-perfect (never AI-redrawn or distorted).
//
// Logo source order:
//   1. RALPH_LOGO_PATH env (absolute or cwd-relative file path)
//   2. client/assets/brand/logo.png committed in this repo
//   3. Fetched once from the live marketing site (RALPH_LOGO_URL env, defaulting
//      to the known asset path) and cached in memory for the process lifetime.

import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

const TAG = '[Paulie brand]';

const DEFAULT_LOGO_URLS = [
  'https://www.totallyoutdoorsllc.com/assets/logo/logo.png',
  'https://www.totallyoutdoorsllc.com/assets/logo.png',
];

// undefined = not resolved yet; null = tried everything, unavailable this process.
let cachedLogo: Buffer | null | undefined;

async function fetchLogo(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    // Sanity: must decode as an image.
    await sharp(buf).metadata();
    return buf;
  } catch {
    return null;
  }
}

async function resolveLogo(): Promise<Buffer | null> {
  if (cachedLogo !== undefined) return cachedLogo;

  const localCandidates = [
    process.env.RALPH_LOGO_PATH,
    path.resolve(process.cwd(), 'client/assets/brand/logo.png'),
  ].filter(Boolean) as string[];
  for (const p of localCandidates) {
    try {
      if (fs.existsSync(p)) {
        cachedLogo = fs.readFileSync(p);
        console.log(TAG, `logo loaded from ${p}`);
        return cachedLogo;
      }
    } catch { /* try next */ }
  }

  const urls = process.env.RALPH_LOGO_URL ? [process.env.RALPH_LOGO_URL] : DEFAULT_LOGO_URLS;
  for (const url of urls) {
    const buf = await fetchLogo(url);
    if (buf) {
      cachedLogo = buf;
      console.log(TAG, `logo fetched from ${url} (${buf.length} bytes, cached)`);
      return cachedLogo;
    }
  }

  console.warn(TAG, 'brand logo unavailable (no local file, all fetches failed) — images ship unbranded');
  cachedLogo = null;
  return null;
}

/**
 * Composite the brand logo onto a generated post image (bottom-right, ~26% of the
 * image width, with a soft dark backing gradient so the mark stays legible
 * on bright skies and greenery). Returns the branded PNG as base64, or null if the logo is
 * unavailable or compositing fails — callers keep the original image in that case.
 */
export async function applyBrandLogo(base64Png: string): Promise<string | null> {
  const logo = await resolveLogo();
  if (!logo) return null;
  try {
    const img = sharp(Buffer.from(base64Png, 'base64'));
    const meta = await img.metadata();
    const W = meta.width || 0;
    const H = meta.height || 0;
    if (!W || !H) return null;

    const logoW = Math.max(64, Math.round(W * 0.26));
    const logoPng = await sharp(logo).resize({ width: logoW }).png().toBuffer();
    const lMeta = await sharp(logoPng).metadata();
    const logoH = lMeta.height || Math.round(logoW / 4);
    const margin = Math.round(W * 0.035);
    if (logoW + margin * 2 > W || logoH + margin * 2 > H) return null;

    const left = W - logoW - margin;
    const top = H - logoH - margin;

    // A subtle dark radial scrim behind the logo keeps it readable on any photo.
    const pad = Math.round(margin * 0.6);
    const scrim = Buffer.from(
      `<svg width="${logoW + pad * 2}" height="${logoH + pad * 2}">
         <defs><radialGradient id="g" cx="50%" cy="50%" r="60%">
           <stop offset="0%" stop-color="black" stop-opacity="0.34"/>
           <stop offset="100%" stop-color="black" stop-opacity="0"/>
         </radialGradient></defs>
         <rect width="100%" height="100%" fill="url(#g)"/>
       </svg>`,
    );

    const out = await img
      .composite([
        { input: scrim, left: left - pad, top: top - pad },
        { input: logoPng, left, top },
      ])
      .png()
      .toBuffer();
    return out.toString('base64');
  } catch (err) {
    console.warn(TAG, 'logo compositing failed (image kept unbranded):', err instanceof Error ? err.message : err);
    return null;
  }
}
