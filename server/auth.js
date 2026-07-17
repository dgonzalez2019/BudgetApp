import crypto from 'node:crypto';

/* Password gate for cloud hosting.
   Enabled by setting APP_PASSWORD; without it the app runs open (local mode).
   Sessions are stateless signed tokens in an httpOnly cookie. */

const SESSION_DAYS = 30;
const COOKIE_NAME = 'budgetapp_session';

export const authEnabled = () => Boolean(process.env.APP_PASSWORD);

function secret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  // Derived fallback: changing the password invalidates existing sessions.
  return crypto.createHash('sha256').update(`budgetapp-session:${process.env.APP_PASSWORD}`).digest('hex');
}

function sign(payload) {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
}

function makeToken() {
  const exp = String(Date.now() + SESSION_DAYS * 86400000);
  return `${exp}.${sign(exp)}`;
}

function verifyToken(token) {
  const [exp, sig] = String(token || '').split('.');
  if (!exp || !sig) return false;
  const expected = sign(exp);
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  return Number(exp) > Date.now();
}

function getCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function setSessionCookie(req, res) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=${makeToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/* Brute-force throttle: per-IP, 5 failures per 15 minutes. */
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

function throttled(ip) {
  const rec = attempts.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > WINDOW_MS) { attempts.delete(ip); return false; }
  return rec.count >= MAX_ATTEMPTS;
}
function recordFailure(ip) {
  const rec = attempts.get(ip);
  if (!rec || Date.now() - rec.first > WINDOW_MS) attempts.set(ip, { first: Date.now(), count: 1 });
  else rec.count++;
}

export function isAuthenticated(req) {
  if (!authEnabled()) return true;
  return verifyToken(getCookie(req, COOKIE_NAME));
}

/** Everything except the login flow and health check requires a session. */
export function authGuard(req, res, next) {
  if (!authEnabled()) return next();
  if (['/healthz', '/login', '/api/login', '/privacy'].includes(req.path)) return next();
  if (isAuthenticated(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not signed in' });
  return res.redirect('/login');
}

export function registerAuthRoutes(app, loginPagePath) {
  app.get('/login', (req, res) => {
    if (!authEnabled() || isAuthenticated(req)) return res.redirect('/');
    res.sendFile(loginPagePath);
  });

  app.post('/api/login', (req, res) => {
    if (!authEnabled()) return res.json({ ok: true });
    const ip = req.ip || 'unknown';
    if (throttled(ip)) return res.status(429).json({ error: 'Too many attempts — try again in 15 minutes.' });

    const given = Buffer.from(String(req.body?.password || ''));
    const actual = Buffer.from(process.env.APP_PASSWORD);
    const ok = given.length === actual.length && crypto.timingSafeEqual(given, actual);
    if (!ok) {
      recordFailure(ip);
      return res.status(401).json({ error: 'Wrong password' });
    }
    attempts.delete(ip);
    setSessionCookie(req, res);
    res.json({ ok: true });
  });

  app.post('/api/logout', (req, res) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  });
}
