const DEFAULT_SEO_MODEL = process.env.SEO_GEMINI_MODEL || 'gemini-2.5-flash';
const FALLBACK_SEO_MODEL = process.env.SEO_GEMINI_FALLBACK_MODEL || 'gemini-2.5-flash-lite';
const GEMINI_TIMEOUT_MS = 120_000;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callGemini(
  model: string,
  apiKey: string,
  body: Record<string, unknown>,
): Promise<GeminiResponse> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
  });
  return (await res.json()) as GeminiResponse & { error?: { message?: string } };
}

interface GeminiPart {
  text?: string;
}

interface GeminiCandidate {
  content?: { parts?: GeminiPart[] };
  groundingMetadata?: {
    groundingChunks?: { web?: { uri?: string; title?: string } }[];
    webSearchQueries?: string[];
  };
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  error?: { message?: string };
}

export interface GeminiSeoResult {
  text: string;
  domains: string[];
  searchQueries: string[];
}

function extractDomains(candidate?: GeminiCandidate): string[] {
  const domains = new Set<string>();
  const chunks = candidate?.groundingMetadata?.groundingChunks ?? [];
  for (const chunk of chunks) {
    const title = chunk.web?.title?.trim();
    if (title && /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(title)) {
      domains.add(title.replace(/^www\./i, '').toLowerCase());
      continue;
    }
    const uri = chunk.web?.uri;
    if (!uri) continue;
    try {
      const host = new URL(uri).hostname.replace(/^www\./i, '').toLowerCase();
      if (!host.includes('google.com') && !host.includes('vertexaisearch')) {
        domains.add(host);
      }
    } catch {
      // skip invalid URLs
    }
  }
  return Array.from(domains);
}

export function hasGeminiKey(): boolean {
  return !!process.env.GEMINI_API_KEY;
}

export function stripMarkdownFences(text: string): string {
  return text
    .replace(/^```(?:json|html|htm|xml|javascript|js|css)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
}

/** Truncate text for LLM prompts while preserving whole-line boundaries when possible */
export function truncatePromptText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastNewline = cut.lastIndexOf('\n');
  return lastNewline > maxChars * 0.8 ? cut.slice(0, lastNewline) : cut;
}

/** Resolve a stylesheet href from HTML to a repo-relative path */
export function resolveRepoCssPath(href: string): string | null {
  const trimmed = href.trim();
  if (!trimmed || /^https?:\/\//i.test(trimmed) || trimmed.startsWith('//') || trimmed.startsWith('data:')) {
    return null;
  }
  if (trimmed.startsWith('/')) return trimmed.slice(1);
  return trimmed.replace(/^\.\//, '').replace(/^(\.\.\/)+/, '');
}

/** Parse .css link hrefs from a <head> HTML fragment */
export function parseCssHrefsFromHead(headHtml: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const linkRe = /<link\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = linkRe.exec(headHtml)) !== null) {
    const tag = match[0];
    if (!/rel\s*=\s*["']stylesheet["']/i.test(tag)) continue;
    const hrefMatch = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (!hrefMatch) continue;
    const href = hrefMatch[1];
    if (!/\.css(\?|$|#)/i.test(href) && !href.endsWith('.css')) continue;
    const path = resolveRepoCssPath(href.split(/[?#]/)[0]);
    if (path && !seen.has(path)) {
      seen.add(path);
      paths.push(path);
    }
  }
  return paths;
}

export interface StylesheetBlock {
  path: string;
  content: string;
}

/** Format fetched CSS blocks for the generation prompt */
export function formatStylesheetPromptSection(blocks: StylesheetBlock[]): string {
  if (!blocks.length) return '';
  const body = blocks
    .map((b) => `/* ${b.path} */\n${b.content}`)
    .join('\n\n');
  return `STYLESHEET (use these exact CSS classes, colors, fonts, and spacing):
${body}`;
}

/** Pull usable HTML out of LLM output (fences, prose wrappers, etc.) */
export function getSeoWebsiteUrl(): string {
  return (process.env.SEO_WEBSITE_URL || 'https://aquaticpoolaz.com').replace(/\/$/, '');
}

function resolveAssetUrl(path: string, siteBase: string): string {
  const trimmed = path.trim();
  if (!trimmed || /^https?:\/\//i.test(trimmed) || /^data:/i.test(trimmed) || /^mailto:/i.test(trimmed) || /^tel:/i.test(trimmed) || trimmed.startsWith('#')) {
    return path;
  }
  // Keep Lauren's own preview-image endpoint same-origin (don't point it at the live site).
  if (/^\/api\/seo\//i.test(trimmed)) return path;
  if (trimmed.startsWith('/')) {
    return `${siteBase}${trimmed}`;
  }
  const normalized = trimmed.replace(/^\.\//, '').replace(/^(\.\.\/)+/, '');
  return `${siteBase}/${normalized}`;
}

/** Rewrite link/img/script asset paths to live site URL for iframe preview */
export function rewriteAssetPaths(html: string, siteUrl?: string): string {
  const base = (siteUrl || getSeoWebsiteUrl()).replace(/\/$/, '');
  let out = html.replace(/<base[^>]*>/gi, '');

  out = out.replace(
    /(<(?:link|a|img|script|source|video|audio|embed|iframe)\b[^>]*\b(?:href|src)=["'])([^"']+)(["'])/gi,
    (_m, pre: string, url: string, post: string) => pre + resolveAssetUrl(url, base) + post,
  );

  out = out.replace(
    /url\(\s*["']?([^"')]+)["']?\s*\)/gi,
    (match, url: string) => {
      if (/^https?:\/\//i.test(url) || /^data:/i.test(url)) return match;
      return `url("${resolveAssetUrl(url, base)}")`;
    },
  );

  return out;
}

export function preparePreviewHtml(content: string, type: string): string {
  const beforeLen = content.length;
  let html = extractHtmlContent(content);
  const afterLen = html.length;
  console.log('[SEO Preview] content length before extractHtmlContent:', beforeLen, 'after extractHtmlContent:', afterLen);
  html = html.trim();
  if (!/<!doctype|<html/i.test(html)) {
    if (type === 'city_page' || type === 'blog') {
      html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Preview</title></head><body>${html}</body></html>`;
    } else {
      return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:system-ui;padding:24px;background:#111;color:#eee;}pre{white-space:pre-wrap;}</style></head><body><pre>${html.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre></body></html>`;
    }
  }
  html = rewriteAssetPaths(html);

  const override = `
<style>
  *, *::before, *::after {
    opacity: 1 !important;
    transform: none !important;
    visibility: visible !important;
    transition: none !important;
    animation: none !important;
    animation-duration: 0s !important;
  }
  [data-aos] {
    opacity: 1 !important;
    transform: none !important;
  }
</style>
<script>
  document.addEventListener('DOMContentLoaded', function() {
    document.querySelectorAll('*').forEach(function(el) {
      el.style.opacity = '1';
      el.style.transform = 'none';
      el.style.visibility = 'visible';
    });
  });
</script>`;

  html = html.replace('</head>', override + '</head>');

  return html;
}

export function extractHtmlContent(text: string): string {
  if (!text) return '';

  if (/<!DOCTYPE/i.test(text) || /<html\b/i.test(text)) {
    return text;
  }

  const trimmed = text.trim();

  const htmlFence = trimmed.match(/```(?:html|htm)\s*([\s\S]*?)```/i);
  if (htmlFence?.[1]?.trim()) return extractHtmlContent(htmlFence[1]);

  const anyFence = trimmed.match(/```\w*\s*([\s\S]*?)```/);
  if (anyFence?.[1] && /<(?:!doctype|html|head|body)/i.test(anyFence[1])) {
    return extractHtmlContent(anyFence[1]);
  }

  const docMatch =
    trimmed.match(/(<!DOCTYPE[\s\S]*?<\/html>)/i) ||
    trimmed.match(/(<html[\s\S]*?<\/html>)/i);
  if (docMatch?.[1]) return docMatch[1];

  const cleaned = stripMarkdownFences(trimmed);
  if (cleaned.toLowerCase() === 'html' || (cleaned.length < 30 && !/</.test(cleaned))) {
    return text;
  }
  return cleaned;
}

export async function geminiSeoGenerate(
  prompt: string,
  options?: { system?: string; maxTokens?: number; useGoogleSearch?: boolean },
): Promise<GeminiSeoResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: options?.maxTokens ?? 4096 },
  };

  if (options?.system) {
    body.systemInstruction = { parts: [{ text: options.system }] };
  }

  if (options?.useGoogleSearch) {
    body.tools = [{ google_search: {} }];
  }

  const models = [DEFAULT_SEO_MODEL, FALLBACK_SEO_MODEL].filter((m, i, arr) => arr.indexOf(m) === i);
  let lastError = 'Gemini request failed';

  for (const model of models) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const data = await callGemini(model, apiKey, body);
      if (!data.error) {
        const candidate = data.candidates?.[0];
        const text = (candidate?.content?.parts ?? [])
          .map((p) => p.text ?? '')
          .join('')
          .trim();

        return {
          text,
          domains: extractDomains(candidate),
          searchQueries: candidate?.groundingMetadata?.webSearchQueries ?? [],
        };
      }

      lastError = data.error.message || lastError;
      const retryable = /high demand|rate|quota|429|503|overloaded/i.test(lastError);
      if (retryable && attempt < 2) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      break;
    }
  }

  throw new Error(lastError);
}
