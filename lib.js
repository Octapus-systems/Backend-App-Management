import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { all, get, insert, run, setting } from './db.js';

const JWT_SECRET = process.env.JWT_SECRET || 'encore-dev-secret-change-me';
if (!process.env.JWT_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('JWT_SECRET must be set in production');
}

// ---------- errors ----------
export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
export const bad = (msg, extra) => new HttpError(400, msg, extra);
export const forbidden = (msg = 'You do not have access to this record.') => new HttpError(403, msg);
export const notFound = (msg = 'Not found.') => new HttpError(404, msg);
export const conflict = (msg, extra) => new HttpError(409, msg, extra);

/** Wrap an async/sync route handler so thrown errors reach the error middleware. */
export const h = (fn) => (req, res, next) => {
  try {
    const out = fn(req, res, next);
    if (out && typeof out.then === 'function') out.catch(next);
  } catch (err) {
    next(err);
  }
};

// ---------- auth ----------
export const hashPassword = (pw) => bcrypt.hashSync(pw, 10);
export const checkPassword = (pw, hash) => bcrypt.compareSync(pw, hash);
export const signToken = (user) => jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: '14d' });
export const randomToken = () => crypto.randomBytes(24).toString('base64url');

export function publicUser(u) {
  if (!u) return null;
  const { password_hash: _ph, ...rest } = u;
  if (rest.organisation_id) {
    rest.organisation = get('SELECT id, name, payment_terms FROM organisations WHERE id = ?', rest.organisation_id) || null;
  }
  return rest;
}

export function authenticate(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(new HttpError(401, 'Please sign in.'));
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = get('SELECT * FROM users WHERE id = ?', payload.sub);
    if (!user) return next(new HttpError(401, 'Account not found.'));
    if (user.status !== 'active') return next(new HttpError(403, accountStatusMessage(user.status)));
    req.user = user;
    next();
  } catch {
    next(new HttpError(401, 'Your session has expired. Please sign in again.'));
  }
}

export function accountStatusMessage(status) {
  return {
    pending: 'Your account is awaiting approval by Encore Executive.',
    rejected: 'Your access request was not approved. Please contact Encore Executive.',
    suspended: 'Your account is suspended. Please contact Encore Executive.',
  }[status] || 'Account unavailable.';
}

export const requireRole = (...roles) => (req, _res, next) => {
  if (!roles.includes(req.user.role)) return next(forbidden());
  next();
};
export const isAdmin = (u) => u.role === 'admin';
export const isCustomerSide = (u) => u.role === 'customer' || u.role === 'corporate';

// ---------- audit ----------
export function audit({ bookingId = null, entity, entityId = null, action, detail = null, actorId = null }) {
  insert('audit_log', {
    booking_id: bookingId,
    entity,
    entity_id: entityId,
    action,
    detail: detail == null ? null : typeof detail === 'string' ? detail : JSON.stringify(detail),
    actor_id: actorId,
  });
}

// ---------- notifications ----------
/**
 * Creates the in-app notification (always) and attempts the agreed external
 * channels. External delivery results are recorded honestly: a channel that is
 * not configured is recorded as `not_configured`, never as delivered.
 */
export function notify(userId, { bookingId = null, event, title, body, whatsapp = true, email = false }) {
  const user = get('SELECT id, email, phone, whatsapp_opt_in FROM users WHERE id = ?', userId);
  if (!user) return null;
  const nid = insert('notifications', { user_id: userId, booking_id: bookingId, event, title, body });
  record(nid, 'in_app', `user:${userId}`, 'delivered');

  if (whatsapp && setting('channel_whatsapp') === 'on') {
    if (!user.phone || !user.whatsapp_opt_in) record(nid, 'whatsapp', user.phone, 'skipped', 'No phone number or not opted in');
    else sendWhatsApp(nid, user.phone, `${title}\n${body}`);
  }
  if (email && setting('channel_email') === 'on') {
    record(nid, 'email', user.email, 'not_configured', 'Email provider not yet configured');
  }
  return nid;
}

function record(nid, channel, destination, status, detail = null) {
  insert('notification_deliveries', { notification_id: nid, channel, destination, status, detail });
}

/**
 * WhatsApp Business Cloud API hand-off. Requires WHATSAPP_TOKEN and
 * WHATSAPP_PHONE_ID. Without them the attempt is logged as not_configured so
 * management can see the message did not leave the platform.
 */
function sendWhatsApp(nid, phone, text) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  if (!token || !phoneId) {
    record(nid, 'whatsapp', phone, 'not_configured', 'WhatsApp Business API credentials not set');
    return;
  }
  const deliveryId = insert('notification_deliveries', {
    notification_id: nid, channel: 'whatsapp', destination: phone, status: 'sent', detail: 'Submitted to WhatsApp API',
  });
  fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: phone.replace(/[^\d]/g, ''), type: 'text', text: { body: text } }),
  })
    .then(async (r) => {
      if (!r.ok) run("UPDATE notification_deliveries SET status='failed', detail=? WHERE id=?", `HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`, deliveryId);
    })
    .catch((err) => run("UPDATE notification_deliveries SET status='failed', detail=? WHERE id=?", String(err.message || err), deliveryId));
}

/** Alert every active admin (proposed addition in BRD §12). */
export function notifyAdmins(payload) {
  for (const a of all("SELECT id FROM users WHERE role = 'admin' AND status = 'active'")) {
    notify(a.id, { ...payload, whatsapp: false });
  }
}

// ---------- formatting ----------
export function fmtWhen(iso) {
  const d = new Date(iso);
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' }).format(d);
}
export const gbp = (n) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(Number(n || 0));
