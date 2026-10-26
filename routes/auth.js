import crypto from 'node:crypto';
import { Router } from 'express';
import { get, insert, run, setting, tx, update, all } from '../db.js';
import {
  ACCESS_EXPIRED, HttpError, accessExpired, accountStatusMessage, audit, authenticate, bad, checkPassword, conflict, h, hashPassword, notifyAdmins,
  publicUser, randomToken, signToken,
} from '../lib.js';

const r = Router();

const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || ''));
const passwordOk = (p) => typeof p === 'string' && p.length >= 8;

// Simple in-memory throttle for sign-in attempts.
const attempts = new Map();
function throttle(key) {
  const now = Date.now();
  const rec = attempts.get(key) || { n: 0, at: now };
  if (now - rec.at > 15 * 60000) { rec.n = 0; rec.at = now; }
  rec.n++;
  attempts.set(key, rec);
  if (rec.n > 10) throw new HttpError(429, 'Too many sign-in attempts. Please wait 15 minutes and try again.');
}

r.get('/public-settings', h((_req, res) => {
  res.json({
    company_name: setting('company_name'),
    dispatcher_name: setting('dispatcher_name'),
    dispatcher_phone: setting('dispatcher_phone'),
    dispatcher_whatsapp: setting('dispatcher_whatsapp'),
    admission_mode: setting('admission_mode'),
    cancellation_policy: setting('cancellation_policy'),
    vehicle_categories: JSON.parse(setting('vehicle_categories') || '[]'),
    min_notice_hours: Number(setting('min_notice_hours') || 0),
    hourly_min_hours: Number(setting('hourly_min_hours') || 0),
    flight_number_required: setting('flight_number_required') === 'on',
    booking_fields: JSON.parse(setting('booking_fields') || '{}'),
    guest_booking: setting('guest_booking') === 'on',
    otp_login: setting('otp_login') === 'on',
  });
}));

// ---------- mobile number + one-time code (OTP) sign-in ----------
// Delivery uses the configured SMS / WhatsApp provider. Until one is connected (no OTP_PROVIDER env),
// the API runs in demo mode and returns the code in the response so the flow can be tested.
const OTP_TTL_MIN = 10;
const OTP_DEMO = !process.env.OTP_PROVIDER;
export const phoneKey = (p) => {
  let d = String(p || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0')) d = `44${d.slice(1)}`;
  return d;
};
const hashCode = (phone, code) => crypto.createHash('sha256').update(`${phone}:${code}:${process.env.JWT_SECRET || 'encore'}`).digest('hex');
const findByPhone = (key) => all("SELECT * FROM users WHERE phone IS NOT NULL AND role != 'admin'").find((u) => phoneKey(u.phone) === key);

r.post('/otp/request', h((req, res) => {
  if (setting('otp_login') !== 'on') throw new HttpError(403, 'Mobile sign-in is not available. Please use your email and password.');
  const key = phoneKey(req.body?.phone);
  if (key.length < 10 || key.length > 15) throw bad('Enter a valid mobile number.', { fields: { phone: 'Enter a valid mobile number.' } });
  throttle(`otp:${req.ip}`);
  const recent = get("SELECT COUNT(*) AS n FROM otp_codes WHERE phone = ? AND created_at > datetime('now','-15 minutes')", key).n;
  if (recent >= 5) throw new HttpError(429, 'Too many codes requested. Please wait 15 minutes.');
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  insert('otp_codes', { phone: key, code_hash: hashCode(key, code), expires_at: new Date(Date.now() + OTP_TTL_MIN * 60000).toISOString() });
  const channel = setting('otp_channel');
  if (OTP_DEMO) console.log(`[otp] demo code for +${key} via ${channel}: ${code}`);
  res.json({ sent: true, channel, expires_in_minutes: OTP_TTL_MIN, ...(OTP_DEMO ? { demo_code: code } : {}) });
}));

r.post('/otp/verify', h((req, res) => {
  const key = phoneKey(req.body?.phone);
  const code = String(req.body?.code || '').trim();
  throttle(`otpv:${req.ip}:${key}`);
  const row = get('SELECT * FROM otp_codes WHERE phone = ? AND used_at IS NULL ORDER BY id DESC LIMIT 1', key);
  if (!row || new Date(row.expires_at) < new Date()) throw bad('This code has expired. Please request a new one.', { code: 'otp_expired' });
  if (row.attempts >= 5) throw new HttpError(429, 'Too many wrong attempts. Please request a new code.');
  if (row.code_hash !== hashCode(key, code)) {
    run('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?', row.id);
    throw bad('That code is not correct.', { fields: { code: 'That code is not correct.' } });
  }

  let user = findByPhone(key);
  if (!user) {
    if (setting('admission_mode') === 'invitation') throw new HttpError(403, 'Encore Executive admits customers by invitation only. Please contact us.');
    const name = String(req.body?.name || '').trim();
    // Code stays valid so the customer can add their name and verify again.
    if (!name) throw bad('Tell us your name to finish.', { code: 'needs_name', fields: { name: 'Your name is required.' } });
    const email = String(req.body?.email || '').trim();
    if (email && (!emailOk(email) || get('SELECT 1 FROM users WHERE email = ?', email))) throw bad('Use a different email address.', { fields: { email: emailOk(email) ? 'That email already has an account — sign in with it instead.' : 'Enter a valid email address.' } });
    const id = insert('users', {
      name, email: email || `${key}@phone.encore.invalid`, phone: `+${key}`, password_hash: hashPassword(randomToken()),
      role: 'customer', status: 'active',
    });
    audit({ entity: 'user', entityId: id, action: 'registered_by_mobile', detail: { phone: `+${key}` }, actorId: id });
    notifyAdmins({ event: 'new_customer', title: `New customer · ${name}`, body: `Signed up with mobile +${key}.` });
    user = get('SELECT * FROM users WHERE id = ?', id);
  }
  if (user.status !== 'active') throw new HttpError(403, accountStatusMessage(user.status));
  if (accessExpired(user)) throw new HttpError(403, ACCESS_EXPIRED);
  run("UPDATE otp_codes SET used_at = datetime('now') WHERE id = ?", row.id);
  audit({ entity: 'user', entityId: user.id, action: 'signed_in', detail: { method: 'mobile_otp' }, actorId: user.id });
  res.json({ token: signToken(user), user: publicUser(user) });
}));

r.post('/login', h((req, res) => {
  const { email, password } = req.body || {};
  throttle(`${req.ip}:${String(email).toLowerCase()}`);
  const user = get('SELECT * FROM users WHERE email = ?', String(email || '').trim());
  if (!user || !checkPassword(String(password || ''), user.password_hash)) throw new HttpError(401, 'Email or password is incorrect.');
  if (user.status !== 'active') throw new HttpError(403, accountStatusMessage(user.status));
  if (accessExpired(user)) throw new HttpError(403, ACCESS_EXPIRED);
  // Management uses the separate Command Center web app; customers and chauffeurs use the Encore app.
  const portal = req.body?.portal;
  if (portal === 'management' && user.role !== 'admin') throw new HttpError(403, 'This portal is for Encore management only. Customers and chauffeurs please use the Encore app.');
  if (portal === 'app' && user.role === 'admin') throw new HttpError(403, 'Management accounts sign in at the Encore Command Center, not the app.');
  audit({ entity: 'user', entityId: user.id, action: 'signed_in', detail: portal ? { portal } : null, actorId: user.id });
  res.json({ token: signToken(user), user: publicUser(user) });
}));

// Registration that management must approve (BRD ADM-9, admission mode "approval" or "both").
r.post('/register', h((req, res) => {
  const mode = setting('admission_mode');
  if (!['approval', 'both'].includes(mode)) throw new HttpError(403, 'Encore Executive admits customers by invitation only. Please contact us to request an invitation.');
  const { name, email, phone, password, company_name } = req.body || {};
  const fields = {};
  if (!name?.trim()) fields.name = 'Your name is required.';
  if (!emailOk(email)) fields.email = 'Enter a valid email address.';
  if (!phone?.trim()) fields.phone = 'A phone number is required.';
  if (!passwordOk(password)) fields.password = 'Use at least 8 characters.';
  if (Object.keys(fields).length) throw bad('Please complete the highlighted fields.', { fields });
  if (get('SELECT 1 FROM users WHERE email = ?', email.trim())) throw conflict('An account with this email already exists.');
  const id = insert('users', {
    email: email.trim(), password_hash: hashPassword(password), name: name.trim(), phone: phone.trim(),
    role: 'customer', status: 'pending', notes: company_name ? `Registered for company: ${company_name}` : null,
  });
  audit({ entity: 'user', entityId: id, action: 'registration_requested', detail: { company_name: company_name || null }, actorId: id });
  notifyAdmins({ event: 'registration', title: 'New access request', body: `${name} (${email})${company_name ? ` · ${company_name}` : ''} is waiting for approval.` });
  res.status(201).json({ ok: true, message: 'Thank you. Encore Executive will review your request and let you know once your account is approved.' });
}));

r.get('/invitations/:token', h((req, res) => {
  const inv = get('SELECT i.*, o.name AS organisation_name FROM invitations i LEFT JOIN organisations o ON o.id = i.organisation_id WHERE token = ?', req.params.token);
  if (!inv || inv.used_at || (inv.expires_at && new Date(inv.expires_at) < new Date())) throw new HttpError(404, 'This invitation is invalid or has expired. Please contact Encore Executive.');
  res.json({ email: inv.email, name: inv.name, role: inv.role, organisation_name: inv.organisation_name });
}));

r.post('/invitations/:token/accept', h((req, res) => {
  const { name, phone, password } = req.body || {};
  const fields = {};
  if (!name?.trim()) fields.name = 'Your name is required.';
  if (!phone?.trim()) fields.phone = 'A phone number is required.';
  if (!passwordOk(password)) fields.password = 'Use at least 8 characters.';
  if (Object.keys(fields).length) throw bad('Please complete the highlighted fields.', { fields });
  const user = tx(() => {
    const inv = get('SELECT * FROM invitations WHERE token = ?', req.params.token);
    if (!inv || inv.used_at || (inv.expires_at && new Date(inv.expires_at) < new Date())) throw new HttpError(404, 'This invitation is invalid or has expired.');
    if (get('SELECT 1 FROM users WHERE email = ?', inv.email)) throw conflict('An account with this email already exists. Please sign in.');
    const id = insert('users', {
      email: inv.email, password_hash: hashPassword(password), name: name.trim(), phone: phone.trim(),
      role: inv.role, organisation_id: inv.organisation_id, status: 'active',
    });
    run("UPDATE invitations SET used_at = datetime('now') WHERE id = ?", inv.id);
    audit({ entity: 'user', entityId: id, action: 'invitation_accepted', detail: { invitation_id: inv.id }, actorId: id });
    return get('SELECT * FROM users WHERE id = ?', id);
  });
  res.status(201).json({ token: signToken(user), user: publicUser(user) });
}));

r.get('/me', authenticate, h((req, res) => res.json(publicUser(req.user))));

r.patch('/me', authenticate, h((req, res) => {
  const patch = {};
  if (req.body.phone !== undefined) patch.phone = String(req.body.phone).trim();
  if (req.body.whatsapp_opt_in !== undefined) patch.whatsapp_opt_in = !!req.body.whatsapp_opt_in;
  if (req.body.new_password) {
    if (!checkPassword(String(req.body.current_password || ''), req.user.password_hash)) throw bad('Current password is incorrect.', { fields: { current_password: 'Incorrect password.' } });
    if (!passwordOk(req.body.new_password)) throw bad('Use at least 8 characters.', { fields: { new_password: 'Use at least 8 characters.' } });
    patch.password_hash = hashPassword(req.body.new_password);
  }
  update('users', req.user.id, patch);
  audit({ entity: 'user', entityId: req.user.id, action: 'account_updated', detail: Object.keys(patch).filter((k) => k !== 'password_hash').concat(patch.password_hash ? ['password'] : []), actorId: req.user.id });
  res.json(publicUser(get('SELECT * FROM users WHERE id = ?', req.user.id)));
}));

// ---------- notifications & invoices for signed-in users ----------
export const account = Router();

account.get('/notifications', h((req, res) => {
  res.json(all('SELECT n.*, b.ref FROM notifications n LEFT JOIN bookings b ON b.id = n.booking_id WHERE n.user_id = ? ORDER BY n.id DESC LIMIT 100', req.user.id));
}));
account.post('/notifications/read-all', h((req, res) => {
  run("UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL", req.user.id);
  res.json({ ok: true });
}));
account.post('/notifications/:id/read', h((req, res) => {
  run("UPDATE notifications SET read_at = datetime('now') WHERE id = ? AND user_id = ?", req.params.id, req.user.id);
  res.json({ ok: true });
}));

account.get('/invoices', h((req, res) => {
  const u = req.user;
  if (u.role === 'corporate') return res.json(all("SELECT i.*, o.name AS organisation_name FROM invoices i JOIN organisations o ON o.id = i.organisation_id WHERE i.organisation_id = ? AND i.status != 'draft' ORDER BY i.id DESC", u.organisation_id ?? -1));
  if (u.role === 'admin') return res.json(all('SELECT i.*, o.name AS organisation_name FROM invoices i JOIN organisations o ON o.id = i.organisation_id ORDER BY i.id DESC'));
  res.json([]);
}));

account.get('/invoices/:id', h((req, res) => {
  const u = req.user;
  const inv = get('SELECT i.*, o.name AS organisation_name, o.billing_address, o.billing_email, o.payment_terms FROM invoices i JOIN organisations o ON o.id = i.organisation_id WHERE i.id = ?', req.params.id);
  if (!inv) throw new HttpError(404, 'Invoice not found.');
  if (!(u.role === 'admin' || (u.role === 'corporate' && u.organisation_id === inv.organisation_id && inv.status !== 'draft'))) throw new HttpError(403, 'You do not have access to this invoice.');
  inv.items = all(`SELECT it.*, b.ref, b.lead_passenger, (SELECT MIN(pickup_at) FROM booking_legs WHERE booking_id = b.id) AS pickup_at
    FROM invoice_items it JOIN bookings b ON b.id = it.booking_id WHERE it.invoice_id = ? ORDER BY pickup_at`, inv.id);
  inv.company = { name: setting('company_name'), base: setting('base_location'), phone: setting('dispatcher_phone') };
  res.json(inv);
}));

export default r;
