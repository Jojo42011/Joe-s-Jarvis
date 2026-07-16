import { fetchGithubFile } from './seoTemplate';

const TAG = '[SEO Agent]';

/** Map a committed repo file to the path the live (static, SiteGround-hosted)
 *  site actually serves. We KEEP the real `.html` filename — the host serves
 *  files at their true path (there is no extensionless rewrite), so stripping
 *  `.html` produced 404s. Only `index.html` collapses to its folder. */
function cleanPath(filePath: string): string {
  return filePath
    .replace(/^\/+/, '')            // drop any leading slash
    .replace(/index\.html$/i, '')   // index.html → folder root (root index → site root)
    .replace(/\/+$/, '');           // trim trailing slash
}

/** Root-relative href used inside the site navigation. */
export function liveHrefForPath(filePath: string): string {
  const p = cleanPath(filePath);
  return '/' + p;
}

/** Absolute URL on the live website for a committed file. */
export function liveUrlForPath(filePath: string | null | undefined): string | null {
  if (!filePath) return null;
  const base = (process.env.SEO_WEBSITE_URL || 'https://aquaticpoolaz.com').replace(/\/+$/, '');
  const p = cleanPath(filePath);
  return p ? `${base}/${p}` : base;
}

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'AquaticSEOAgent/1.0',
  };
}

function classAttrOf(tag: string): string {
  const m = tag.match(/class\s*=\s*"([^"]*)"/i) || tag.match(/class\s*=\s*'([^']*)'/i);
  return m ? m[1] : '';
}

const NAV_STYLE_MARKER = '<!-- lauren:navstyle -->';

// Map a content type to the nav section it belongs under.
export function sectionForType(type: string, navGroup?: string | null): string | null {
  if (navGroup && navGroup.trim()) return navGroup.trim();
  switch (type) {
    case 'city_page': return 'Locations';
    case 'service_page': case 'service': return 'Services';
    case 'blog': return 'Blog';
    default: return null;
  }
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// One-time hover CSS so injected dropdowns work regardless of the site's own CSS.
function ensureNavStyle(html: string): string {
  if (html.includes(NAV_STYLE_MARKER)) return html;
  const style = `${NAV_STYLE_MARKER}<style>
.lauren-has-sub{position:relative}
.lauren-has-sub>.lauren-submenu{
  position:absolute;left:0;top:100%;margin-top:12px;min-width:232px;z-index:2000;
  list-style:none;padding:8px;
  background:rgba(18,19,22,0.92);
  -webkit-backdrop-filter:blur(14px) saturate(140%);backdrop-filter:blur(14px) saturate(140%);
  border:1px solid rgba(255,255,255,0.09);border-radius:16px;
  box-shadow:0 24px 60px rgba(0,0,0,0.45),0 2px 8px rgba(0,0,0,0.3);
  opacity:0;visibility:hidden;transform:translateY(8px);pointer-events:none;
  transition:opacity .2s ease,transform .2s ease,visibility .2s ease;
}
.lauren-has-sub:hover>.lauren-submenu,.lauren-has-sub:focus-within>.lauren-submenu{opacity:1;visibility:visible;transform:translateY(0);pointer-events:auto}
/* invisible bridge so the menu doesn't close while crossing the gap */
.lauren-has-sub>.lauren-submenu::before{content:"";position:absolute;left:0;right:0;top:-12px;height:12px}
.lauren-submenu li{margin:0;padding:0}
.lauren-submenu a{display:block;padding:10px 15px;border-radius:10px;white-space:nowrap;color:#f2f2f2;text-decoration:none;font-size:14px;font-weight:500;letter-spacing:.2px;line-height:1.25;transition:background .16s ease,color .16s ease,padding-left .16s ease}
.lauren-submenu a:hover{background:rgba(255,140,0,0.14);color:#FF8C00;padding-left:19px}
</style>`;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${style}\n</head>`);
  return style + html;
}

// Find the <li>…</li> that encloses a given position, balancing nested <li>
// (so a top-level item that already contains a submenu is captured whole).
function enclosingLi(html: string, pos: number): { start: number; end: number; html: string } | null {
  const liStart = html.lastIndexOf('<li', pos);
  if (liStart < 0) return null;
  const re = /<li\b|<\/li\s*>/gi;
  re.lastIndex = liStart;
  let depth = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m[0].toLowerCase().startsWith('</li')) {
      depth--;
      if (depth === 0) {
        const end = m.index + m[0].length;
        return { start: liStart, end, html: html.slice(liStart, end) };
      }
    } else {
      depth++;
    }
  }
  return null;
}

// Insert `newLi` just before the BALANCED closing </ul> of the FIRST real
// top-level nav list (skipping our own submenus). Balancing the nested <ul> is
// essential: the site's own Blog dropdown is a nested <ul>, and a naive
// "first </ul>" match would drop a new top-level tab INSIDE that Blog menu —
// which is exactly the bug that put Locations under Blog.
function insertIntoTopNavUl(navHtml: string, newLi: string): string | null {
  const openRe = /<ul\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  let openEnd = -1;
  while ((m = openRe.exec(navHtml)) !== null) {
    if (/lauren-submenu/i.test(m[1])) continue; // never our own dropdown
    openEnd = m.index + m[0].length;
    break;
  }
  if (openEnd < 0) return null;

  const tokRe = /<ul\b|<\/ul\s*>/gi;
  tokRe.lastIndex = openEnd;
  let depth = 1;
  let t: RegExpExecArray | null;
  while ((t = tokRe.exec(navHtml)) !== null) {
    if (t[0].toLowerCase().startsWith('</ul')) {
      depth--;
      if (depth === 0) return navHtml.slice(0, t.index) + newLi + navHtml.slice(t.index);
    } else {
      depth++;
    }
  }
  return null;
}

// Locate a nav item (anchor) whose visible text matches the section name.
function findSectionAnchor(navHtml: string, section: string): { index: number; tag: string; text: string } | null {
  const target = section.toLowerCase();
  const re = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(navHtml)) !== null) {
    const text = stripTags(m[1]).toLowerCase();
    if (!text) continue;
    if (text === target || text.includes(target) || target.includes(text)) {
      return { index: m.index, tag: m[0], text };
    }
  }
  return null;
}

/**
 * Attach a freshly published page into the site nav under the CORRECT section.
 * - If a matching section nav item exists, convert it into a hover dropdown (or
 *   reuse its existing submenu) and add the page there.
 * - Otherwise add a new top-level nav item (a brand-new section).
 * Never throws — publish still succeeds if linking can't be matched safely.
 */
export async function linkPageIntoSiteNav(opts: {
  filePath: string;
  label: string;
  section?: string | null;
  type?: string;
}): Promise<{ linked: boolean; message: string }> {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.SEO_GITHUB_REPO;
  const branch = process.env.SEO_GITHUB_BRANCH || 'main';
  if (!token || !repo) return { linked: false, message: 'GitHub not configured' };

  const href = liveHrefForPath(opts.filePath);
  const label = opts.label.replace(/[<>]/g, '').trim() || 'New Page';
  const section = opts.section ?? sectionForType(opts.type || '', null);

  try {
    const headers = ghHeaders(token);
    const getRes = await fetch(
      `https://api.github.com/repos/${repo}/contents/index.html?ref=${branch}`,
      { headers, signal: AbortSignal.timeout(25000) },
    );
    if (!getRes.ok) return { linked: false, message: `index.html fetch failed (${getRes.status})` };
    const meta = (await getRes.json()) as { sha?: string; content?: string; encoding?: string };
    const sha = meta.sha;
    let html =
      meta.encoding === 'base64' && meta.content
        ? Buffer.from(meta.content, 'base64').toString('utf-8')
        : (await fetchGithubFile(repo, 'index.html', branch, token)) || '';
    if (!html || !sha) return { linked: false, message: 'index.html unavailable' };

    // Already linked somewhere — idempotent, nothing to do.
    if (new RegExp(`href\\s*=\\s*["']${href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']`, 'i').test(html)) {
      return { linked: true, message: 'Already linked in nav' };
    }

    const applied = applyNavLink(html, { href, label, section });
    if (!applied.html) return { linked: false, message: applied.message };
    const newHtml = applied.html;

    const putRes = await fetch(`https://api.github.com/repos/${repo}/contents/index.html`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: `Lauren: link ${label} into "${section || 'nav'}" (${applied.mode})`,
        content: Buffer.from(newHtml).toString('base64'),
        branch,
        sha,
      }),
    });
    if (!putRes.ok) {
      const err = await putRes.text();
      console.warn(TAG, `Nav link commit failed: ${putRes.status} ${err}`);
      return { linked: false, message: `Nav commit failed (${putRes.status})` };
    }

    console.log(TAG, `Linked ${href} into nav (${applied.mode}${section ? ' · ' + section : ''})`);
    return { linked: true, message: `Linked under "${section || 'nav'}" as "${label}" (${applied.mode})` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.warn(TAG, 'Nav linking error:', err);
    return { linked: false, message: msg };
  }
}

// Stable key so every page in the same section lands in the SAME dropdown.
function sectionKeyOf(section: string): string {
  return section.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'pages';
}

// If Lauren already built a dropdown for this section, append the new page to it
// (so the second/third/... page in a section stacks under the one dropdown
// instead of spawning another top-level tab). Matches our tagged submenu.
function appendToLaurenSubmenu(navHtml: string, sectionKey: string, subItem: string): string | null {
  const re = new RegExp(
    `(<ul[^>]*class="[^"]*lauren-submenu[^"]*"[^>]*data-lauren-section="${sectionKey}"[^>]*>)([\\s\\S]*?)(</ul>)`,
    'i',
  );
  if (!re.test(navHtml)) return null;
  return navHtml.replace(re, (_m, open: string, inner: string, close: string) => open + inner + subItem + close);
}

// ── Pure nav transform (testable, no network) ────────────────────────────────
// Turns the section's nav item into a hover DROPDOWN and adds `label`→`href` as a
// child link. Works whether the nav uses <ul>/<li> OR plain <a> tags (this site).
// First page in a section builds the dropdown; later pages append to it. A brand
// new section becomes a new top-level dropdown. Never leaves a section as a bare
// link to the newest page. Returns the updated full HTML + mode.
export function applyNavLink(
  html: string,
  opts: { href: string; label: string; section?: string | null },
): { html: string | null; mode: string; message: string } {
  const href = opts.href;
  const label = (opts.label || 'New Page').replace(/[<>]/g, '').trim() || 'New Page';
  const section = opts.section || null;
  const sectionKey = sectionKeyOf(section || label);

  const navMatch = html.match(/<nav\b[\s\S]*?<\/nav>/i) || html.match(/<header\b[\s\S]*?<\/header>/i);
  if (!navMatch) return { html: null, mode: 'none', message: 'No <nav> found in index.html' };
  const navHtml = navMatch[0];
  const navStart = navMatch.index ?? 0;
  const navEnd = navStart + navHtml.length;

  const sampleA = navHtml.match(/<a\b[^>]*>/i)?.[0] || '<a>';
  const aClass = classAttrOf(sampleA);
  const aOpen = aClass ? `<a class="${aClass}" href="${href}">` : `<a href="${href}">`;
  const subItem = `<li><a href="${href}">${label}</a></li>`;
  const submenuOpen = `<ul class="lauren-submenu" data-lauren-section="${sectionKey}">`;

  let newNav: string | null = null;
  let mode = '';

  // Strategy 0: a Lauren dropdown for this section already exists → append to it.
  const appended = appendToLaurenSubmenu(navHtml, sectionKey, subItem);
  if (appended) {
    newNav = appended;
    mode = 'append-dropdown';
  }

  // Strategy 1: the section tab exists → convert it into a dropdown (once).
  if (!newNav && section) {
    const anchor = findSectionAnchor(navHtml, section);
    if (anchor) {
      const li = enclosingLi(navHtml, anchor.index);
      if (li && /<ul\b/i.test(li.html)) {
        // The site already has a native dropdown here — add our page into it.
        const updatedLi = li.html.replace(/<\/ul>/i, `${subItem}</ul>`);
        newNav = navHtml.slice(0, li.start) + updatedLi + navHtml.slice(li.end);
        mode = 'native-dropdown';
      } else if (li) {
        // <li>-based nav without a submenu yet → wrap the item into a dropdown.
        const inner = li.html.replace(/^<li\b[^>]*>/i, '').replace(/<\/li>\s*$/i, '');
        const liClass = classAttrOf(li.html.match(/<li\b[^>]*>/i)?.[0] || '');
        const liOpen = `<li class="${(liClass ? liClass + ' ' : '') + 'lauren-has-sub'}">`;
        const rebuilt = `${liOpen}${inner}${submenuOpen}${subItem}</ul></li>`;
        newNav = navHtml.slice(0, li.start) + rebuilt + navHtml.slice(li.end);
        mode = 'section-dropdown';
      } else {
        // Plain-anchor nav (no <li>) → wrap just the anchor into a dropdown.
        const wrapped = `<span class="lauren-has-sub" style="position:relative;display:inline-block">${anchor.tag}${submenuOpen}${subItem}</ul></span>`;
        newNav = navHtml.slice(0, anchor.index) + wrapped + navHtml.slice(anchor.index + anchor.tag.length);
        mode = 'section-dropdown-wrap';
      }
    }
  }

  // Strategy 2: no such section tab → CREATE a new top-level dropdown for it,
  // inserted at the END of the REAL top-level nav list (balanced), so it becomes
  // its own "white" tab (Locations, Services, …) and never nests inside Blog.
  if (!newNav) {
    const topLabel = section || label;
    const sampleLi = navHtml.match(/<li\b[^>]*>/i)?.[0] || '<li>';
    const liClass = classAttrOf(sampleLi);
    const liOpen = `<li class="${(liClass ? liClass + ' ' : '') + 'lauren-has-sub'}">`;
    const newLi = `${liOpen}<a href="${href}">${topLabel}</a>${submenuOpen}${subItem}</ul></li>`;
    const inserted = insertIntoTopNavUl(navHtml, newLi);
    if (inserted) {
      newNav = inserted;
      mode = 'new-top-dropdown';
    } else {
      // Plain-anchor nav (no <ul>/<li>) → append a new top-level dropdown span
      // AFTER the last top-level anchor so it sits beside the other tabs.
      const anchors = [...navHtml.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/gi)];
      const anchor = anchors.length ? anchors[anchors.length - 1][0] : null;
      if (anchor) {
        const topA = aClass ? `<a class="${aClass}" href="${href}">${topLabel}</a>` : `<a href="${href}">${topLabel}</a>`;
        const dropdown = `<span class="lauren-has-sub" style="position:relative;display:inline-block">${topA}${submenuOpen}${subItem}</ul></span>`;
        const at = navHtml.lastIndexOf(anchor);
        newNav = navHtml.slice(0, at + anchor.length) + '\n' + dropdown + navHtml.slice(at + anchor.length);
        mode = 'new-top-dropdown-wrap';
      }
    }
  }

  if (!newNav) return { html: null, mode: 'none', message: 'Nav structure not recognized' };
  let out = html.slice(0, navStart) + newNav + html.slice(navEnd);
  out = ensureNavStyle(out); // we always build a hover dropdown now
  return { html: out, mode, message: `Linked "${label}" under "${section || 'nav'}" dropdown (${mode})` };
}

// ── Nav removal + one-time cleanup ───────────────────────────────────────────
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Unwrap any Lauren dropdown whose submenu is now empty, restoring the plain tab.
function unwrapEmptyLaurenDropdowns(navHtml: string): string {
  let out = navHtml;
  out = out.replace(
    /<span class="lauren-has-sub"[^>]*>([\s\S]*?)<ul[^>]*class="[^"]*lauren-submenu[^"]*"[^>]*>\s*<\/ul>\s*<\/span>/gi,
    '$1',
  );
  out = out.replace(
    /<li class="[^"]*lauren-has-sub[^"]*"[^>]*>([\s\S]*?)<ul[^>]*class="[^"]*lauren-submenu[^"]*"[^>]*>\s*<\/ul>\s*<\/li>/gi,
    '<li>$1</li>',
  );
  return out;
}

/** Pure transform: remove the nav entry for `href` (a submenu child link or a
 *  stray top-level link) and collapse any dropdown left empty. */
export function removeNavLink(html: string, href: string): { html: string; changed: boolean } {
  const navMatch = html.match(/<nav\b[\s\S]*?<\/nav>/i) || html.match(/<header\b[\s\S]*?<\/header>/i);
  if (!navMatch) return { html, changed: false };
  const esc = escapeRe(href);
  let nav = navMatch[0];
  // Submenu item form: <li><a href="href">Label</a></li>
  nav = nav.replace(new RegExp(`<li>\\s*<a[^>]*href=["']${esc}["'][^>]*>[\\s\\S]*?</a>\\s*</li>`, 'gi'), '');
  // Any remaining bare anchor to this href (old stray tab).
  nav = nav.replace(new RegExp(`<a[^>]*href=["']${esc}["'][^>]*>[\\s\\S]*?</a>`, 'gi'), '');
  nav = unwrapEmptyLaurenDropdowns(nav);
  const out = html.slice(0, navMatch.index) + nav + html.slice((navMatch.index ?? 0) + navMatch[0].length);
  return { html: out, changed: out !== html };
}

/** Pure transform: strip everything Lauren previously injected into the nav —
 *  her hover dropdowns (unwrapped back to the original tab) and any stray
 *  top-level tabs she added that link to generated pages (locations/, insights/,
 *  services/). Leaves the site's original nav intact. Scoped to the nav region. */
export function stripLaurenNavArtifacts(html: string): string {
  const navMatch = html.match(/<nav\b[\s\S]*?<\/nav>/i) || html.match(/<header\b[\s\S]*?<\/header>/i);
  if (!navMatch) return html;
  let nav = navMatch[0];
  // Unwrap span dropdowns: keep the leading original anchor, drop the submenu.
  nav = nav.replace(
    /<span class="lauren-has-sub"[^>]*>([\s\S]*?)<ul[^>]*class="[^"]*lauren-submenu[^"]*"[\s\S]*?<\/ul>\s*<\/span>/gi,
    '$1',
  );
  // Unwrap li dropdowns similarly.
  nav = nav.replace(
    /<li class="[^"]*lauren-has-sub[^"]*"[^>]*>([\s\S]*?)<ul[^>]*class="[^"]*lauren-submenu[^"]*"[\s\S]*?<\/ul>\s*<\/li>/gi,
    '<li>$1</li>',
  );
  // Remove stray top-level tabs pointing at generated content folders.
  nav = nav.replace(
    /<li>\s*<a[^>]*href=["'][^"']*\/(?:locations|insights|services)\/[^"']+["'][^>]*>[\s\S]*?<\/a>\s*<\/li>/gi,
    '',
  );
  nav = nav.replace(
    /<a[^>]*href=["'][^"']*\/(?:locations|insights|services)\/[^"']+["'][^>]*>[\s\S]*?<\/a>/gi,
    '',
  );
  return html.slice(0, navMatch.index) + nav + html.slice((navMatch.index ?? 0) + navMatch[0].length);
}

async function fetchIndexWithSha(
  repo: string,
  branch: string,
  headers: Record<string, string>,
): Promise<{ html: string; sha: string } | null> {
  const token = process.env.GITHUB_TOKEN || '';
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/contents/index.html?ref=${branch}`, { headers, signal: AbortSignal.timeout(25000) });
    if (!res.ok) return null;
    const meta = (await res.json()) as { sha?: string; content?: string; encoding?: string };
    if (!meta.sha) return null;
    const html = meta.encoding === 'base64' && meta.content
      ? Buffer.from(meta.content, 'base64').toString('utf-8')
      : (await fetchGithubFile(repo, 'index.html', branch, token)) || '';
    return html ? { html, sha: meta.sha } : null;
  } catch {
    return null;
  }
}

async function putIndexHtml(
  repo: string,
  branch: string,
  headers: Record<string, string>,
  html: string,
  sha: string,
  message: string,
): Promise<boolean> {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/contents/index.html`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ message, content: Buffer.from(html).toString('base64'), branch, sha }),
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) console.warn(TAG, `index.html commit failed: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
    return res.ok;
  } catch (err) {
    console.warn(TAG, 'index.html commit error:', err instanceof Error ? err.message : err);
    return false;
  }
}

/** Remove a published page's link from the site nav (called when a page is
 *  removed from the repo). Best-effort — never throws. */
export async function unlinkPageFromSiteNav(filePath: string): Promise<{ unlinked: boolean; message: string }> {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.SEO_GITHUB_REPO;
  const branch = process.env.SEO_GITHUB_BRANCH || 'main';
  if (!token || !repo) return { unlinked: false, message: 'GitHub not configured' };

  const headers = ghHeaders(token);
  const idx = await fetchIndexWithSha(repo, branch, headers);
  if (!idx) return { unlinked: false, message: 'index.html unavailable' };

  const href = liveHrefForPath(filePath);
  const { html: out, changed } = removeNavLink(idx.html, href);
  if (!changed) return { unlinked: false, message: 'No nav link found to remove' };

  const ok = await putIndexHtml(repo, branch, headers, out, idx.sha, `Lauren: remove ${href} from nav`);
  console.log(TAG, `Nav unlink for ${href}: ${ok ? 'removed' : 'commit failed'}`);
  return { unlinked: ok, message: ok ? `Removed ${href} from nav` : 'Nav commit failed' };
}

/** ONE-TIME cleanup: strip Lauren's old/broken nav artifacts, then rebuild clean
 *  dropdowns for every currently-published page. Commits index.html once. */
export async function resetAndRebuildNav(
  pages: { filePath: string; label: string; section: string | null }[],
): Promise<{ success: boolean; changed: boolean; message: string }> {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.SEO_GITHUB_REPO;
  const branch = process.env.SEO_GITHUB_BRANCH || 'main';
  if (!token || !repo) return { success: false, changed: false, message: 'GitHub not configured' };

  const headers = ghHeaders(token);
  const idx = await fetchIndexWithSha(repo, branch, headers);
  if (!idx) return { success: false, changed: false, message: 'index.html unavailable' };

  let cleaned = stripLaurenNavArtifacts(idx.html);
  let linked = 0;
  for (const p of pages) {
    if (!p.filePath) continue;
    const href = liveHrefForPath(p.filePath);
    if (new RegExp(`href\\s*=\\s*["']${escapeRe(href)}["']`, 'i').test(cleaned)) continue; // already present
    const applied = applyNavLink(cleaned, { href, label: p.label, section: p.section });
    if (applied.html) { cleaned = applied.html; linked++; }
  }

  if (cleaned === idx.html) return { success: true, changed: false, message: 'Nav already clean — nothing to rebuild' };

  const ok = await putIndexHtml(repo, branch, headers, cleaned, idx.sha, 'Lauren: one-time nav cleanup + rebuild dropdowns');
  console.log(TAG, `One-time nav rebuild: ${ok ? `cleaned + linked ${linked} page(s)` : 'commit failed'}`);
  return { success: ok, changed: true, message: ok ? `Rebuilt nav with ${linked} page(s)` : 'Nav commit failed' };
}
