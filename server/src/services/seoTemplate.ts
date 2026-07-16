const TAG = '[SEO Agent]';

const OH_CITIES = [
  'Millersburg', 'Berlin', 'Walnut Creek', 'Sugarcreek', 'Mount Hope', 'Charm', 'Winesburg',
  'Killbuck', 'Fredericksburg', 'Apple Creek', 'Wooster', 'Dover', 'New Philadelphia', 'Loudonville', 'Holmesville',
];

export function extractCitySlug(keyword?: string, task?: string): string {
  const hay = `${task || ''} ${keyword || ''}`;
  const sorted = [...OH_CITIES].sort((a, b) => b.length - a.length);
  for (const city of sorted) {
    if (hay.toLowerCase().includes(city.toLowerCase())) {
      return city.toLowerCase().replace(/\s+/g, '-');
    }
  }
  return 'millersburg';
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, '&#39;');
}

export interface PageContentPayload {
  pageTitle: string;
  metaDescription: string;
  h1: string;
  mainContentHtml: string;
}

export function buildPageFromTemplate(template: string, payload: PageContentPayload): string {
  let html = template;

  html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escapeHtml(payload.pageTitle)}</title>`);

  const metaTag = `<meta name="description" content="${escapeAttr(payload.metaDescription)}">`;
  const metaRe = /<meta\s+[^>]*name\s*=\s*["']description["'][^>]*>/i;
  if (metaRe.test(html)) {
    html = html.replace(metaRe, metaTag);
  } else {
    html = html.replace(/<head([^>]*)>/i, `<head$1>\n  ${metaTag}`);
  }

  if (/<main[\s\S]*?<\/main>/i.test(html)) {
    html = html.replace(
      /<main[^>]*>[\s\S]*?<\/main>/i,
      `<main>\n${payload.mainContentHtml}\n</main>`,
    );
  } else {
    const headerEnd = html.search(/<\/header>/i);
    const footerStart = html.search(/<footer/i);
    const block = `\n<!-- SEO Agent content -->\n<section class="page-content">\n  <h1>${escapeHtml(payload.h1)}</h1>\n${payload.mainContentHtml}\n</section>\n`;
    if (headerEnd >= 0 && footerStart > headerEnd) {
      html = html.slice(0, headerEnd + 10) + block + html.slice(footerStart);
    } else {
      html = html.replace(/<body([^>]*)>/i, `<body$1>${block}`);
    }
  }

  return html;
}

function githubContentsUrl(repo: string, filePath: string, branch: string): string {
  const encoded = filePath.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  return `https://api.github.com/repos/${repo}/contents/${encoded}?ref=${encodeURIComponent(branch)}`;
}

export async function fetchGithubFile(
  repo: string,
  filePath: string,
  branch: string,
  token: string,
): Promise<string | null> {
  try {
    const res = await fetch(githubContentsUrl(repo, filePath, branch), {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'TotallyOutdoorsSEOAgent/1.0',
      },
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) {
      console.warn(TAG, `GitHub file ${filePath}: HTTP ${res.status}`);
      return null;
    }
    const data = (await res.json()) as { content?: string; encoding?: string };
    if (data.encoding === 'base64' && data.content) {
      return Buffer.from(data.content, 'base64').toString('utf-8');
    }
    return null;
  } catch (err) {
    console.warn(TAG, `GitHub file ${filePath} error:`, err);
    return null;
  }
}

export async function listRepoHtmlFiles(repo: string, branch: string, token: string): Promise<string[]> {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'TotallyOutdoorsSEOAgent/1.0',
  };
  const found: string[] = [];
  const skip = new Set(['node_modules', '.git', 'dist', '.next', 'vendor', '.github']);

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 6 || found.length >= 60) return;
    const url = githubContentsUrl(repo, dir, branch);
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(25000) });
    if (!res.ok) {
      if (!dir) console.warn(TAG, `GitHub repo root listing failed: HTTP ${res.status} for ${repo}`);
      return;
    }
    const items = (await res.json()) as { name: string; path: string; type: string }[];
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (item.type === 'file' && /\.html?$/i.test(item.name)) found.push(item.path);
      else if (item.type === 'dir' && !skip.has(item.name)) await walk(item.path, depth + 1);
    }
  }

  await walk('', 0);
  return found;
}

export async function fetchLiveRepoTemplate(): Promise<{ html: string; path: string } | null> {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.SEO_GITHUB_REPO;
  const branch = process.env.SEO_GITHUB_BRANCH || 'main';
  if (!token || !repo) {
    console.warn(TAG, 'GITHUB_TOKEN or SEO_GITHUB_REPO not set — cannot load template');
    return null;
  }

  const htmlFiles = await listRepoHtmlFiles(repo, branch, token);
  console.log(TAG, `Repo ${repo}: found ${htmlFiles.length} HTML file(s)`, htmlFiles.slice(0, 8).join(', '));

  const pick =
    htmlFiles.find((f) => /(^|\/)index\.html$/i.test(f)) ||
    htmlFiles.find((f) => /city|location|service|about/i.test(f)) ||
    htmlFiles[0];

  if (!pick) return null;

  const html = await fetchGithubFile(repo, pick, branch, token);
  if (!html || html.length < 200) return null;

  console.log(TAG, `Using repo template: ${pick} (${html.length} chars)`);
  return { html, path: pick };
}
