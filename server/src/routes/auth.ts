import { Router, Request, Response } from 'express';
import { getDb } from '../db/schema';
import {
  AuthUser, ROLES, SESSION_COOKIE, createSession, destroySession,
  hashPassword, verifyPassword, parseCookies, userFromRequest,
} from '../services/auth';

const router = Router();

function cookieFor(token: string, maxAgeSecs: number): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSecs}${secure}`;
}

router.post('/auth/login', (req: Request, res: Response) => {
  const { username, password } = (req.body || {}) as { username?: string; password?: string };
  if (!username || !password) { res.status(400).json({ ok: false, error: 'username and password required' }); return; }
  const row = getDb().prepare('SELECT id, username, name, role, password_hash FROM users WHERE username = ?')
    .get(String(username).trim().toLowerCase()) as (AuthUser & { password_hash: string }) | undefined;
  if (!row || !verifyPassword(String(password), row.password_hash)) {
    res.status(401).json({ ok: false, error: 'wrong username or password' });
    return;
  }
  const token = createSession(row.id);
  res.setHeader('Set-Cookie', cookieFor(token, 30 * 24 * 60 * 60));
  res.json({ ok: true, user: { id: row.id, username: row.username, name: row.name, role: row.role } });
});

router.post('/auth/logout', (req: Request, res: Response) => {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) destroySession(token);
  res.setHeader('Set-Cookie', cookieFor('', 0));
  res.json({ ok: true });
});

router.get('/auth/me', (req: Request, res: Response) => {
  const user = userFromRequest(req);
  if (!user) { res.status(401).json({ ok: false }); return; }
  res.json({ ok: true, user });
});

router.post('/auth/password', (req: Request, res: Response) => {
  const user = userFromRequest(req);
  if (!user) { res.status(401).json({ ok: false, error: 'not signed in' }); return; }
  const { current, next } = (req.body || {}) as { current?: string; next?: string };
  if (!next || String(next).length < 8) { res.status(400).json({ ok: false, error: 'new password must be at least 8 characters' }); return; }
  const row = getDb().prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id) as { password_hash: string };
  if (!verifyPassword(String(current || ''), row.password_hash)) {
    res.status(401).json({ ok: false, error: 'current password is wrong' });
    return;
  }
  getDb().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(String(next)), user.id);
  res.json({ ok: true });
});

// ── Team management (owner only) ──

function requireOwner(req: Request, res: Response): AuthUser | null {
  const user = userFromRequest(req);
  if (!user || user.role !== 'owner') { res.status(403).json({ ok: false, error: 'owner only' }); return null; }
  return user;
}

router.get('/auth/users', (req: Request, res: Response) => {
  if (!requireOwner(req, res)) return;
  const users = getDb().prepare('SELECT id, username, name, role, created_at FROM users ORDER BY id').all();
  res.json({ ok: true, users, roles: ROLES });
});

router.post('/auth/users', (req: Request, res: Response) => {
  if (!requireOwner(req, res)) return;
  const { username, name, role, password } = (req.body || {}) as { username?: string; name?: string; role?: string; password?: string };
  const uname = String(username || '').trim().toLowerCase();
  if (!uname || !/^[a-z0-9._-]{2,40}$/.test(uname)) { res.status(400).json({ ok: false, error: 'username: 2–40 chars, letters/numbers/._-' }); return; }
  if (!password || String(password).length < 8) { res.status(400).json({ ok: false, error: 'password must be at least 8 characters' }); return; }
  const r = (ROLES as readonly string[]).includes(String(role)) ? String(role) : 'sales';
  try {
    const info = getDb().prepare('INSERT INTO users (username, name, role, password_hash) VALUES (?, ?, ?, ?)')
      .run(uname, String(name || '').trim() || null, r, hashPassword(String(password)));
    res.json({ ok: true, id: Number(info.lastInsertRowid) });
  } catch {
    res.status(400).json({ ok: false, error: 'that username is taken' });
  }
});

router.delete('/auth/users/:uid', (req: Request, res: Response) => {
  const owner = requireOwner(req, res);
  if (!owner) return;
  const uid = Number(req.params.uid);
  if (uid === owner.id) { res.status(400).json({ ok: false, error: "you can't delete your own account" }); return; }
  const db = getDb();
  db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(uid);
  db.prepare('DELETE FROM users WHERE id = ?').run(uid);
  res.json({ ok: true });
});

export default router;
