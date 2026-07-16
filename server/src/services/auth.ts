/**
 * Auth: username/password login with scrypt hashes, DB-backed session tokens
 * in an HttpOnly cookie, and three roles per Joe's Blueprint:
 *   owner — everything (Joe)
 *   sales — the CRM front-end: leads, outreach, estimates. No payments/subs/build ops.
 *   pm    — the CRM build side: stages, subs, files, payments. No estimator, no deletes.
 * Non-CRM pages (Jarvis, Paulie, Lauren, Integrations, …) are owner-only.
 *
 * Bootstraps a default owner account ("joe") on first boot when no users
 * exist — password via OWNER_DEFAULT_PASSWORD or randomly generated.
 */

import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { getDb } from '../db/schema';

export type Role = 'owner' | 'sales' | 'pm';
export const ROLES: Role[] = ['owner', 'sales', 'pm'];

export interface AuthUser { id: number; username: string; name: string | null; role: Role }

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const SESSION_COOKIE = 'arlo_session';

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

/** Create the default owner account on first boot so Joe can log in at all.
 *  Password comes from OWNER_DEFAULT_PASSWORD (set it as a Fly secret before
 *  first boot); otherwise a random one is generated and printed ONCE at boot —
 *  change it in Team settings immediately either way. */
export function seedDefaultOwner(): void {
  const db = getDb();
  const count = (db.prepare('SELECT COUNT(*) c FROM users').get() as { c: number }).c;
  if (count > 0) return;
  const envPassword = (process.env.OWNER_DEFAULT_PASSWORD || '').trim();
  const password = envPassword || crypto.randomBytes(12).toString('base64url');
  db.prepare('INSERT INTO users (username, name, role, password_hash) VALUES (?, ?, ?, ?)')
    .run('joe', 'Joe', 'owner', hashPassword(password));
  if (envPassword) {
    console.log('[Auth] Seeded default owner account "joe" with OWNER_DEFAULT_PASSWORD — change it in Team settings.');
  } else {
    console.log(`[Auth] Seeded default owner account: joe / ${password} — this is shown ONCE; change it in Team settings now.`);
  }
}

export function createSession(userId: number): string {
  const token = crypto.randomBytes(32).toString('hex');
  const db = getDb();
  db.prepare("INSERT INTO auth_sessions (token, user_id, expires_at) VALUES (?, ?, datetime(?, 'unixepoch'))")
    .run(token, userId, Math.floor((Date.now() + SESSION_TTL_MS) / 1000));
  // Opportunistic cleanup of expired sessions.
  db.prepare("DELETE FROM auth_sessions WHERE expires_at < datetime('now')").run();
  return token;
}

export function destroySession(token: string): void {
  try { getDb().prepare('DELETE FROM auth_sessions WHERE token = ?').run(token); } catch { /* best effort */ }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function userForToken(token: string | undefined): AuthUser | null {
  if (!token) return null;
  try {
    const row = getDb().prepare(`
      SELECT u.id, u.username, u.name, u.role FROM auth_sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND s.expires_at > datetime('now')
    `).get(token) as AuthUser | undefined;
    return row || null;
  } catch {
    return null;
  }
}

// Login is OFF by default — the dashboard opens straight up,
// no sign-in. Set AUTH_ENABLED=1 (Fly secret) to turn the login wall + role
// system on once the team actually grows; everything below stays wired.
export function authEnabled(): boolean {
  return process.env.AUTH_ENABLED === '1';
}

const OPEN_MODE_OWNER: AuthUser = { id: 0, username: 'joe', name: 'Joe', role: 'owner' };

export function userFromRequest(req: Request): AuthUser | null {
  if (!authEnabled()) return OPEN_MODE_OWNER;
  return userForToken(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
}

// ── Route policy ──

/** API paths that stay public: webhooks, health, the external lead form, and
 *  media that Zernio fetches by URL at publish time. */
function isPublicApi(req: Request): boolean {
  const p = req.path;
  if (p.startsWith('/api/webhooks/')) return true;
  if (p.startsWith('/api/health')) return true;
  if (p === '/api/leads' && req.method === 'POST') return true; // website form + Sofia intake
  if (p.startsWith('/api/seo/img/')) return true;               // Zernio downloads post images
  if (p.startsWith('/api/ralph/video/')) return true;           // Zernio downloads reel video
  if (p.startsWith('/api/auth/login')) return true;
  return false;
}

/** CRM API surface (shared by all roles, with per-role carve-outs below). */
function isCrmApi(p: string): boolean {
  return p.startsWith('/api/leads') || p.startsWith('/api/crm/');
}

/** Per-role carve-outs inside the CRM, per the Blueprint. */
function crmAllowedForRole(req: Request, role: Role): boolean {
  if (role === 'owner') return true;
  const p = req.path;
  if (role === 'sales') {
    // Sales runs the front-of-funnel — no payments/milestones/Stripe, no subs, no build ops.
    if (/\/payments|\/milestones/.test(p)) return false;
    if (p.startsWith('/api/crm/subs') || /\/leads\/\d+\/subs/.test(p)) return false;
    return true;
  }
  // pm: runs the build — no estimator, no lead deletion.
  if (/\/estimate/.test(p)) return false;
  if (req.method === 'DELETE' && /^\/api\/leads\/\d+$/.test(p)) return false;
  return true;
}

/** Express middleware guarding the API. Mount after the webhook routers. */
export function apiAuthGuard(req: Request, res: Response, next: NextFunction): void {
  if (!authEnabled()) { next(); return; }
  if (!req.path.startsWith('/api/')) { next(); return; }
  if (isPublicApi(req)) { next(); return; }
  const user = userFromRequest(req);
  if (!user) { res.status(401).json({ error: 'not signed in' }); return; }
  (req as Request & { authUser?: AuthUser }).authUser = user;
  if (req.path.startsWith('/api/auth/')) { next(); return; }
  if (isCrmApi(req.path)) {
    if (!crmAllowedForRole(req, user.role)) { res.status(403).json({ error: 'not allowed for your role' }); return; }
    next(); return;
  }
  // Everything else (Jarvis brain/voice, Paulie, Lauren, integrations, memory…) is owner-only.
  if (user.role !== 'owner') { res.status(403).json({ error: 'owner only' }); return; }
  next();
}

/** Pages each role may open. Everything else redirects to /crm (or /login). */
const ROLE_PAGES: Record<Role, string[] | 'all'> = {
  owner: 'all',
  sales: ['/crm', '/crm.html', '/login', '/login.html'],
  pm: ['/crm', '/crm.html', '/login', '/login.html'],
};

/** Middleware gating the HTML pages (static assets stay open — they're inert without the API). */
export function pageAuthGuard(req: Request, res: Response, next: NextFunction): void {
  if (!authEnabled()) { next(); return; }
  if (req.method !== 'GET') { next(); return; }
  const p = req.path;
  const isPage = p === '/' || /^\/[a-z-]+$/.test(p) || p.endsWith('.html');
  if (!isPage) { next(); return; }
  if (p === '/login' || p === '/login.html') { next(); return; }
  const user = userFromRequest(req);
  if (!user) { res.redirect('/login'); return; }
  const allowed = ROLE_PAGES[user.role];
  if (allowed !== 'all' && !allowed.includes(p)) { res.redirect('/crm'); return; }
  next();
}
