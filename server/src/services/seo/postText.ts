// ─── Text overlays for Paulie's post imagery ────────────────────────────────────
// The accounts that win local contractor Instagram bake bold copy
// straight onto their carousel slides, reel
// covers, and promo graphics — the image IS the hook. AI image models garble
// rendered text, so the copy is composited server-side with sharp/SVG: crisp
// headline + supporting line on a bottom scrim, plus an optional corner badge.
//
// Two modes:
//   • Standard (carousel slides / reel covers / before-after): headline + body.
//   • Offer (big=true): a full promo graphic — punchy eyebrow, HUGE headline,
//     subline, and ✓ benefit bullets, all oversized like a real contractor ad.
//
// Layout contract (shared with brandLogo.ts): the brand logo occupies the
// bottom-right ~26% of the frame, so text is left-aligned and the badge sits
// top-left. Nothing collides.

import sharp from 'sharp';

const TAG = '[Paulie copy]';
const BRAND_RED = '#e63c1e';

export interface TextOverlay {
  eyebrow?: string;      // offer: small bold attention line above the headline
  headline?: string;     // the big hook
  body?: string;         // supporting copy
  bullets?: string[];    // offer: ✓ benefit lines
  badge?: string;        // corner tag: "BEFORE", "AFTER", "3/8", "FREE CONSULT"
  big?: boolean;         // offer mode → oversized headline + eyebrow + bullets
}

function escXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c] as string));
}

// Greedy word wrap by estimated glyph width. DejaVu Sans bold caps are wide, so
// we estimate generously (0.64em bold / 0.53em regular) to avoid edge overflow.
function wrapText(text: string, fontPx: number, maxWidthPx: number, bold: boolean, maxLines: number): string[] {
  const perChar = fontPx * (bold ? 0.64 : 0.53);
  const maxChars = Math.max(6, Math.floor(maxWidthPx / perChar));
  const words = text.trim().split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const candidate = line ? line + ' ' + w : w;
    if (candidate.length > maxChars && line) {
      lines.push(line);
      line = w;
      if (lines.length === maxLines) break;
    } else {
      line = candidate;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  else if (lines.length === maxLines && line && lines[maxLines - 1] !== line) {
    lines[maxLines - 1] = lines[maxLines - 1].replace(/\.{0,3}$/, '…');
  }
  return lines;
}

interface Line { text: string; px: number; lh: number; weight: string; fill: string; gapAbove: number; }

/**
 * Composite copy (bottom-left, over a dark gradient scrim) and an optional badge
 * (top-left pill) onto a PNG. Returns branded base64, or null on any failure so
 * callers keep the original image.
 */
export async function applyTextOverlay(base64Png: string, t: TextOverlay): Promise<string | null> {
  if (!t.headline && !t.body && !t.badge && !t.eyebrow && !(t.bullets && t.bullets.length)) return null;
  try {
    const img = sharp(Buffer.from(base64Png, 'base64'));
    const meta = await img.metadata();
    const W = meta.width || 0;
    const H = meta.height || 0;
    if (!W || !H) return null;

    const marginX = Math.round(W * 0.055);
    const textMaxW = Math.round(W * (t.big ? 0.86 : 0.80));
    const headPx = Math.round(W * (t.big ? 0.090 : 0.058));
    const eyebrowPx = Math.round(W * 0.042);
    const bodyPx = Math.round(W * (t.big ? 0.041 : 0.034));
    const bulletPx = Math.round(W * 0.038);

    // Build the ordered stack of lines (top → bottom of the text block).
    const lines: Line[] = [];
    // Eyebrow (a small ALL-CAPS brand/category tag above the headline) now renders
    // on every post, not just offers — it gives standard posts a designed,
    // editorial look instead of a floating headline. Standard eyebrows are a touch
    // smaller than the oversized offer treatment.
    if (t.eyebrow) {
      const ePx = t.big ? eyebrowPx : Math.round(W * 0.034);
      for (const l of wrapText(t.eyebrow.toUpperCase(), ePx, textMaxW, true, 2)) {
        lines.push({ text: l, px: ePx, lh: Math.round(ePx * 1.25), weight: 'bold', fill: BRAND_RED, gapAbove: 0 });
      }
    }
    if (t.headline) {
      const hs = wrapText(t.headline, headPx, textMaxW, true, 3);
      hs.forEach((l, i) => lines.push({ text: l, px: headPx, lh: Math.round(headPx * 1.14), weight: 'bold', fill: '#ffffff', gapAbove: i === 0 && lines.length ? Math.round(headPx * 0.28) : 0 }));
    }
    if (t.body) {
      const bs = wrapText(t.body, bodyPx, Math.round(W * 0.80), false, 3);
      bs.forEach((l, i) => lines.push({ text: l, px: bodyPx, lh: Math.round(bodyPx * 1.34), weight: 'normal', fill: '#f2f2f2', gapAbove: i === 0 ? Math.round(bodyPx * 0.7) : 0 }));
    }
    if (t.big && t.bullets && t.bullets.length) {
      t.bullets.slice(0, 3).forEach((b, i) => {
        const l = wrapText('✓  ' + b, bulletPx, Math.round(W * 0.82), false, 1)[0] || '';
        lines.push({ text: l, px: bulletPx, lh: Math.round(bulletPx * 1.5), weight: 'bold', fill: '#ffffff', gapAbove: i === 0 ? Math.round(bulletPx * 0.6) : 0 });
      });
    }

    const parts: string[] = [];
    let blockH = 0;
    for (const l of lines) blockH += l.gapAbove + l.lh;

    if (lines.length) {
      const bottomPad = Math.round(H * 0.095); // clear the bottom-right logo zone
      const textTop = Math.max(Math.round(H * 0.06), H - bottomPad - blockH);
      const scrimTop = Math.max(0, textTop - Math.round(H * (t.big ? 0.10 : 0.16)));
      parts.push(
        `<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1">
           <stop offset="0" stop-color="black" stop-opacity="0"/>
           <stop offset="0.3" stop-color="black" stop-opacity="0.5"/>
           <stop offset="1" stop-color="black" stop-opacity="0.85"/>
         </linearGradient></defs>
         <rect x="0" y="${scrimTop}" width="${W}" height="${H - scrimTop}" fill="url(#s)"/>`,
      );
      let y = textTop;
      for (const l of lines) {
        y += l.gapAbove + l.px; // baseline
        parts.push(`<text x="${marginX}" y="${y}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${l.px}" font-weight="${l.weight}" fill="${l.fill}">${escXml(l.text)}</text>`);
        y += l.lh - l.px;
      }
    }

    if (t.badge) {
      const bPx = Math.round(W * (t.big ? 0.038 : 0.032));
      const label = t.badge.toUpperCase();
      const bw = Math.round(label.length * bPx * 0.68 + bPx * 1.8);
      const bh = Math.round(bPx * 2.1);
      const bx = Math.round(W * 0.045);
      const by = Math.round(H * 0.045);
      parts.push(
        `<rect x="${bx}" y="${by}" rx="${Math.round(bh / 2)}" width="${bw}" height="${bh}" fill="${BRAND_RED}" fill-opacity="0.96"/>
         <text x="${bx + bw / 2}" y="${by + bh / 2 + bPx * 0.36}" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="${bPx}" font-weight="bold" letter-spacing="2" fill="#ffffff">${escXml(label)}</text>`,
      );
    }

    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${parts.join('')}</svg>`);
    const out = await img.composite([{ input: svg, left: 0, top: 0 }]).png().toBuffer();
    return out.toString('base64');
  } catch (err) {
    console.warn(TAG, 'text overlay failed (image kept clean):', err instanceof Error ? err.message : err);
    return null;
  }
}
