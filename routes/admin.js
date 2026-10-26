import { Router } from 'express';
import { DEFAULT_SETTINGS, all, get, getSettings, insert, run, setting, tx, update } from '../db.js';
import { audit, bad, conflict, gbp, h, hashPassword, notFound, notify, publicUser, randomToken } from '../lib.js';
import { TERMINAL, agreedTotal, findConflicts, recomputePaymentStatus } from '../domain.js';
import { computeRoute, mapsEnabled } from '../maps.js';

const r = Router();

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k] === '' ? null : obj[k]]));

// ---------- dashboard (ADM-8) ----------
r.get('/dashboard', h((_req, res) => {
  const counts = Object.fromEntries(all('SELECT status, COUNT(*) AS n FROM bookings GROUP BY status').map((x) => [x.status, x.n]));
  const legsSql = (where) => all(`
    SELECT l.*, b.ref, b.status AS booking_status, b.lead_passenger, b.passenger_count, d.name AS driver_name,
      COALESCE(v.registration, l.external_vehicle_reg) AS registration, o.name AS operator_name
    FROM booking_legs l JOIN bookings b ON b.id = l.booking_id
    LEFT JOIN users d ON d.id = l.driver_id LEFT JOIN vehicles v ON v.id = l.vehicle_id
    LEFT JOIN external_operators o ON o.id = l.external_operator_id
    WHERE ${where} ORDER BY l.pickup_at`);
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + 86400000);
  const today = legsSql(`l.pickup_at >= '${start.toISOString()}' AND l.pickup_at < '${end.toISOString()}' AND b.status NOT IN ('rejected','cancelled_customer','cancelled_management','expired')`);
  const unassigned = legsSql(`l.status = 'unassigned' AND b.status IN ('confirmed','driver_assigned')`);
  const active = legsSql(`l.status IN ('assigned','on_the_way','arrived','started') AND b.status NOT IN (${TERMINAL.map((s) => `'${s}'`).join(',')})`);
  const conflicts = active.map((l) => ({ ...l, conflicts: findConflicts(l) })).filter((l) => l.conflicts.length);
  const attention = all(`
    SELECT b.id, b.ref, b.status, b.lead_passenger, u.name AS customer_name, b.updated_at,
      (SELECT MIN(pickup_at) FROM booking_legs WHERE booking_id = b.id) AS first_pickup
    FROM bookings b JOIN users u ON u.id = b.customer_id
    WHERE b.status IN ('pending','under_review','change_requested','quote_accepted','clarification_needed')
    ORDER BY first_pickup`);
  const unpaid = get(`SELECT COUNT(*) AS n FROM bookings WHERE status IN ('completed','closed') AND payment_status IN ('unpaid','link_sent','deposit_paid','overdue')`).n;
  const overdueInvoices = get("SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS total FROM invoices WHERE status = 'overdue'");
  const pendingCustomers = get("SELECT COUNT(*) AS n FROM users WHERE status = 'pending'").n;
  const failedMessages = get("SELECT COUNT(*) AS n FROM notification_deliveries WHERE status IN ('failed','not_configured') AND created_at > datetime('now','-2 days')").n;
  res.json({ counts, today, unassigned, conflicts, attention, unpaid, overdueInvoices, pendingCustomers, failedMessages });
}));

// ---------- quick route lookup for quoting ----------
r.get('/route', h(async (req, res) => {
  if (!mapsEnabled()) return res.status(409).json({ error: 'Google Maps is not configured on the server.' });
  const { from, to } = req.query;
  if (!from || !to) throw bad('Enter both addresses.');
  try { res.json(await computeRoute(String(from), String(to))); } catch (e) { throw bad(e.message); }
}));

// ---------- calendar ----------
r.get('/calendar', h((req, res) => {
  const from = req.query.from || new Date().toISOString();
  const to = req.query.to || new Date(Date.now() + 7 * 86400000).toISOString();
  res.json(all(`
    SELECT l.id, l.booking_id, l.label, l.pickup, l.destination, l.pickup_at, l.est_minutes, l.status AS leg_status,
      b.ref, b.status, b.lead_passenger, d.name AS driver_name, COALESCE(v.registration, l.external_vehicle_reg) AS registration
    FROM booking_legs l JOIN bookings b ON b.id = l.booking_id
    LEFT JOIN users d ON d.id = l.driver_id LEFT JOIN vehicles v ON v.id = l.vehicle_id
    WHERE l.pickup_at >= ? AND l.pickup_at < ? ORDER BY l.pickup_at`, from, to));
}));

// ---------- vehicles (ADM-3) ----------
const VEHICLE_FIELDS = ['registration', 'make', 'model', 'colour', 'category', 'seats', 'luggage_capacity', 'child_seat_capable', 'accessible', 'status', 'notes'];
r.get('/vehicles', h((_req, res) => {
  res.json(all(`SELECT v.*, (SELECT COUNT(*) FROM booking_legs l JOIN bookings b ON b.id=l.booking_id WHERE l.vehicle_id = v.id AND l.status IN ('assigned','on_the_way','arrived','started') AND b.status NOT IN (${TERMINAL.map(() => '?').join(',')})) AS upcoming_jobs FROM vehicles v ORDER BY CASE status WHEN 'available' THEN 0 WHEN 'unavailable' THEN 1 ELSE 2 END, registration`, ...TERMINAL));
}));
function validateVehicle(v, partial = false) {
  const f = {};
  if (!partial || 'registration' in v) if (!String(v.registration || '').trim()) f.registration = 'Registration is required.';
  if (!partial || 'make' in v) if (!String(v.make || '').trim()) f.make = 'Make is required.';
  if (!partial || 'model' in v) if (!String(v.model || '').trim()) f.model = 'Model is required.';
  if (!partial || 'category' in v) if (!String(v.category || '').trim()) f.category = 'Category is required.';
  if (!partial || 'seats' in v) if (!(Number(v.seats) >= 1)) f.seats = 'Seats must be at least 1.';
  if ('status' in v && !['available', 'unavailable', 'retired'].includes(v.status)) f.status = 'Unknown status.';
  if (Object.keys(f).length) throw bad('Please check the vehicle details.', { fields: f });
}
r.post('/vehicles', h((req, res) => {
  validateVehicle(req.body);
  const data = pick(req.body, VEHICLE_FIELDS);
  data.registration = data.registration.toUpperCase().trim();
  if (get('SELECT 1 FROM vehicles WHERE registration = ?', data.registration)) throw conflict('A vehicle with this registration already exists.');
  const id = insert('vehicles', data);
  audit({ entity: 'vehicle', entityId: id, action: 'vehicle_added', detail: data, actorId: req.user.id });
  res.status(201).json(get('SELECT * FROM vehicles WHERE id = ?', id));
}));
r.patch('/vehicles/:id', h((req, res) => {
  const v = get('SELECT * FROM vehicles WHERE id = ?', req.params.id);
  if (!v) throw notFound();
  validateVehicle(req.body, true);
  const data = pick(req.body, VEHICLE_FIELDS);
  if (data.registration) data.registration = data.registration.toUpperCase().trim();
  update('vehicles', v.id, data);
  audit({ entity: 'vehicle', entityId: v.id, action: data.status && data.status !== v.status ? `vehicle_${data.status}` : 'vehicle_updated', detail: data, actorId: req.user.id });
  const upcoming = data.status && data.status !== 'available'
    ? all("SELECT b.ref, l.label, l.pickup_at FROM booking_legs l JOIN bookings b ON b.id=l.booking_id WHERE l.vehicle_id=? AND l.status='assigned'", v.id) : [];
  res.json({ ...get('SELECT * FROM vehicles WHERE id = ?', v.id), warning: upcoming.length ? `This vehicle is still assigned to ${upcoming.length} upcoming journey(s): ${upcoming.map((u) => u.ref).join(', ')}. Reassign them.` : null });
}));

// ---------- drivers (ADM-3) ----------
r.get('/drivers', h((_req, res) => {
  res.json(all(`SELECT id, name, email, phone, status, driver_availability, licence_number, notes, created_at, driver_type, access_expires_at,
    (SELECT COUNT(*) FROM booking_legs l WHERE l.driver_id = users.id AND l.status IN ('assigned','on_the_way','arrived','started')) AS upcoming_jobs
    FROM users WHERE role = 'driver' ORDER BY status, name`));
}));
r.post('/drivers', h((req, res) => {
  const { name, email, phone, password, licence_number, notes } = req.body;
  const temporary = req.body.driver_type === 'temporary';
  const f = {};
  if (temporary && (!req.body.access_expires_at || Number.isNaN(new Date(req.body.access_expires_at).getTime()) || new Date(req.body.access_expires_at) < new Date())) f.access_expires_at = 'Choose when this temporary access ends.';
  if (!name?.trim()) f.name = 'Name is required.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '')) f.email = 'Valid email is required.';
  if (!phone?.trim()) f.phone = 'Phone is required.';
  if (!password || password.length < 8) f.password = 'Temporary password of at least 8 characters.';
  if (Object.keys(f).length) throw bad('Please check the driver details.', { fields: f });
  const max = Number(setting('max_drivers') || 0);
  if (!temporary && max && get("SELECT COUNT(*) AS n FROM users WHERE role='driver' AND status='active' AND driver_type = 'regular'").n >= max) throw conflict(`Your plan allows ${max} active drivers. Suspend a driver first.`);
  if (get('SELECT 1 FROM users WHERE email = ?', email)) throw conflict('That email is already in use.');
  const id = insert('users', { name: name.trim(), email: email.trim(), phone: phone.trim(), password_hash: hashPassword(password), role: 'driver', status: 'active', licence_number: licence_number || null, notes: notes || null,
    driver_type: temporary ? 'temporary' : 'regular', access_expires_at: temporary ? new Date(req.body.access_expires_at).toISOString() : null });
  audit({ entity: 'user', entityId: id, action: temporary ? 'temporary_driver_added' : 'driver_added', detail: { name, email, ...(temporary ? { access_expires_at: req.body.access_expires_at } : {}) }, actorId: req.user.id });
  res.status(201).json(publicUser(get('SELECT * FROM users WHERE id = ?', id)));
}));
r.patch('/drivers/:id', h((req, res) => {
  const d = get("SELECT * FROM users WHERE id = ? AND role = 'driver'", req.params.id);
  if (!d) throw notFound();
  const data = pick(req.body, ['name', 'phone', 'licence_number', 'notes', 'driver_availability', 'status', 'access_expires_at']);
  if (data.access_expires_at !== undefined && d.driver_type !== 'temporary') delete data.access_expires_at;
  if (data.access_expires_at) data.access_expires_at = new Date(data.access_expires_at).toISOString();
  if (data.driver_availability && !['available', 'unavailable'].includes(data.driver_availability)) throw bad('Unknown availability.');
  if (data.status && !['active', 'suspended'].includes(data.status)) throw bad('Unknown status.');
  if (req.body.password) {
    if (req.body.password.length < 8) throw bad('Password must be at least 8 characters.');
    data.password_hash = hashPassword(req.body.password);
  }
  update('users', d.id, data);
  const { password_hash: _p, ...logged } = data;
  audit({ entity: 'user', entityId: d.id, action: 'driver_updated', detail: { ...logged, ...(data.password_hash ? { password: 'reset' } : {}) }, actorId: req.user.id });
  res.json(publicUser(get('SELECT * FROM users WHERE id = ?', d.id)));
}));

// ---------- external operators (ADM-5) ----------
r.get('/operators', h((_req, res) => res.json(all('SELECT * FROM external_operators ORDER BY active DESC, name'))));
r.post('/operators', h((req, res) => {
  if (!req.body.name?.trim()) throw bad('Operator name is required.', { fields: { name: 'Required.' } });
  const id = insert('external_operators', pick(req.body, ['name', 'contact_name', 'phone', 'email', 'notes']));
  audit({ entity: 'operator', entityId: id, action: 'operator_added', detail: req.body, actorId: req.user.id });
  res.status(201).json(get('SELECT * FROM external_operators WHERE id = ?', id));
}));
r.patch('/operators/:id', h((req, res) => {
  const o = get('SELECT * FROM external_operators WHERE id = ?', req.params.id);
  if (!o) throw notFound();
  const data = pick(req.body, ['name', 'contact_name', 'phone', 'email', 'notes', 'active']);
  update('external_operators', o.id, data);
  audit({ entity: 'operator', entityId: o.id, action: 'operator_updated', detail: data, actorId: req.user.id });
  res.json(get('SELECT * FROM external_operators WHERE id = ?', o.id));
}));

// ---------- customers & organisations (ADM-9, CUS-6) ----------
r.get('/customers', h((req, res) => {
  const params = [];
  let where = "u.role IN ('customer','corporate')";
  if (req.query.status) { where += ' AND u.status = ?'; params.push(req.query.status); }
  res.json(all(`SELECT u.id, u.name, u.email, u.phone, u.role, u.status, u.organisation_id, u.notes, u.created_at, o.name AS organisation_name,
    (SELECT COUNT(*) FROM bookings b WHERE b.customer_id = u.id) AS bookings
    FROM users u LEFT JOIN organisations o ON o.id = u.organisation_id WHERE ${where}
    ORDER BY CASE u.status WHEN 'pending' THEN 0 ELSE 1 END, u.name`, ...params));
}));
r.patch('/customers/:id', h((req, res) => {
  const c = get("SELECT * FROM users WHERE id = ? AND role IN ('customer','corporate')", req.params.id);
  if (!c) throw notFound();
  const data = pick(req.body, ['status', 'organisation_id', 'phone', 'name', 'notes']);
  if (data.status && !['active', 'rejected', 'suspended', 'pending'].includes(data.status)) throw bad('Unknown status.');
  if ('organisation_id' in data) {
    if (data.organisation_id && !get('SELECT 1 FROM organisations WHERE id = ?', data.organisation_id)) throw bad('Unknown organisation.');
    data.role = data.organisation_id ? 'corporate' : 'customer';
  }
  update('users', c.id, data);
  const action = data.status && data.status !== c.status ? { active: 'customer_approved', rejected: 'customer_rejected', suspended: 'customer_suspended', pending: 'customer_pending' }[data.status] : 'customer_updated';
  audit({ entity: 'user', entityId: c.id, action, detail: data, actorId: req.user.id });
  if (action === 'customer_approved') {
    notify(c.id, { event: 'account_approved', title: 'Welcome to Encore Executive', body: 'Your account has been approved. You can now sign in and request journeys.', email: true });
  }
  res.json(publicUser(get('SELECT * FROM users WHERE id = ?', c.id)));
}));

r.get('/organisations', h((_req, res) => {
  res.json(all(`SELECT o.*, (SELECT COUNT(*) FROM users u WHERE u.organisation_id = o.id) AS users,
    (SELECT COUNT(*) FROM bookings b WHERE b.organisation_id = o.id) AS bookings FROM organisations o ORDER BY o.name`));
}));
r.post('/organisations', h((req, res) => {
  if (!req.body.name?.trim()) throw bad('Organisation name is required.', { fields: { name: 'Required.' } });
  const id = insert('organisations', pick(req.body, ['name', 'billing_email', 'billing_address', 'payment_terms']));
  audit({ entity: 'organisation', entityId: id, action: 'organisation_added', detail: req.body, actorId: req.user.id });
  res.status(201).json(get('SELECT * FROM organisations WHERE id = ?', id));
}));
r.patch('/organisations/:id', h((req, res) => {
  const o = get('SELECT * FROM organisations WHERE id = ?', req.params.id);
  if (!o) throw notFound();
  const data = pick(req.body, ['name', 'billing_email', 'billing_address', 'payment_terms', 'status']);
  update('organisations', o.id, data);
  audit({ entity: 'organisation', entityId: o.id, action: 'organisation_updated', detail: data, actorId: req.user.id });
  res.json(get('SELECT * FROM organisations WHERE id = ?', o.id));
}));

r.get('/invitations', h((_req, res) => {
  res.json(all('SELECT i.*, o.name AS organisation_name FROM invitations i LEFT JOIN organisations o ON o.id = i.organisation_id ORDER BY i.id DESC'));
}));
r.post('/invitations', h((req, res) => {
  const { email, name, organisation_id } = req.body;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '')) throw bad('Enter a valid email.', { fields: { email: 'Valid email required.' } });
  if (get('SELECT 1 FROM users WHERE email = ?', email)) throw conflict('That person already has an account.');
  const role = organisation_id ? 'corporate' : 'customer';
  const token = randomToken();
  const id = insert('invitations', { token, email: email.trim(), name: name || null, role, organisation_id: organisation_id || null, created_by: req.user.id, expires_at: new Date(Date.now() + 14 * 86400000).toISOString() });
  audit({ entity: 'invitation', entityId: id, action: 'invitation_created', detail: { email, organisation_id: organisation_id || null }, actorId: req.user.id });
  res.status(201).json({ ...get('SELECT * FROM invitations WHERE id = ?', id), link: `/invite/${token}` });
}));
r.delete('/invitations/:id', h((req, res) => {
  run("UPDATE invitations SET expires_at = datetime('now') WHERE id = ? AND used_at IS NULL", req.params.id);
  audit({ entity: 'invitation', entityId: Number(req.params.id), action: 'invitation_revoked', actorId: req.user.id });
  res.json({ ok: true });
}));

// ---------- staff (admins) ----------
r.get('/staff', h((_req, res) => res.json(all("SELECT id, name, email, phone, status, created_at FROM users WHERE role = 'admin' ORDER BY name"))));
r.post('/staff', h((req, res) => {
  const { name, email, phone, password } = req.body;
  if (!name?.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '') || !password || password.length < 8) throw bad('Name, valid email and a password of at least 8 characters are required.');
  const max = Number(setting('max_admins') || 0);
  if (max && get("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND status='active'").n >= max) throw conflict(`Your plan allows ${max} management accounts.`);
  if (get('SELECT 1 FROM users WHERE email = ?', email)) throw conflict('That email is already in use.');
  const id = insert('users', { name: name.trim(), email: email.trim(), phone: phone || null, password_hash: hashPassword(password), role: 'admin', status: 'active' });
  audit({ entity: 'user', entityId: id, action: 'staff_added', detail: { name, email }, actorId: req.user.id });
  res.status(201).json(publicUser(get('SELECT * FROM users WHERE id = ?', id)));
}));
r.patch('/staff/:id', h((req, res) => {
  const s = get("SELECT * FROM users WHERE id = ? AND role = 'admin'", req.params.id);
  if (!s) throw notFound();
  if (s.id === req.user.id && req.body.status === 'suspended') throw conflict('You cannot suspend your own account.');
  const data = pick(req.body, ['name', 'phone', 'status']);
  update('users', s.id, data);
  audit({ entity: 'user', entityId: s.id, action: 'staff_updated', detail: data, actorId: req.user.id });
  res.json(publicUser(get('SELECT * FROM users WHERE id = ?', s.id)));
}));

// ---------- payments overview & corporate invoices (ADM-6) ----------
r.get('/payments', h((_req, res) => {
  res.json(all(`
    SELECT b.id, b.ref, b.status, b.payment_status, b.payment_arrangement, b.payment_link, b.lead_passenger,
      u.name AS customer_name, o.name AS organisation_name,
      (SELECT MIN(pickup_at) FROM booking_legs WHERE booking_id = b.id) AS first_pickup,
      (SELECT total FROM quotes q WHERE q.booking_id = b.id AND q.status = 'accepted' ORDER BY version DESC LIMIT 1) AS total,
      (SELECT COALESCE(SUM(CASE WHEN kind='refund' THEN -amount ELSE amount END),0) FROM payments p WHERE p.booking_id = b.id AND outcome='succeeded') AS received
    FROM bookings b JOIN users u ON u.id = b.customer_id LEFT JOIN organisations o ON o.id = b.organisation_id
    WHERE b.status IN ('confirmed','driver_assigned','on_the_way','arrived','started','completed','closed','no_show')
    ORDER BY CASE b.payment_status WHEN 'overdue' THEN 0 WHEN 'unpaid' THEN 1 WHEN 'link_sent' THEN 2 WHEN 'deposit_paid' THEN 3 WHEN 'invoiced' THEN 4 ELSE 5 END, first_pickup DESC`));
}));

function eligibleForInvoice(orgId, from, to) {
  return all(`
    SELECT b.id, b.ref, b.lead_passenger, b.status, (SELECT MIN(pickup_at) FROM booking_legs WHERE booking_id = b.id) AS pickup_at,
      (SELECT total FROM quotes q WHERE q.booking_id = b.id AND q.status = 'accepted' ORDER BY version DESC LIMIT 1) AS total
    FROM bookings b
    WHERE b.organisation_id = ? AND b.status IN ('completed','closed','no_show') AND b.payment_status NOT IN ('paid')
      AND NOT EXISTS (SELECT 1 FROM invoice_items it JOIN invoices i ON i.id = it.invoice_id WHERE it.booking_id = b.id AND i.status != 'void')
      AND (SELECT MIN(pickup_at) FROM booking_legs WHERE booking_id = b.id) >= ? AND (SELECT MIN(pickup_at) FROM booking_legs WHERE booking_id = b.id) < ?
    ORDER BY pickup_at`, orgId, from, to);
}

r.get('/invoices/eligible', h((req, res) => {
  const { organisation_id, from, to } = req.query;
  if (!organisation_id || !from || !to) throw bad('Choose an organisation and period.');
  res.json(eligibleForInvoice(organisation_id, new Date(from).toISOString(), new Date(new Date(to).getTime() + 86400000).toISOString()));
}));

r.post('/invoices', h((req, res) => {
  const { organisation_id, from, to, booking_ids, notes } = req.body;
  const org = get('SELECT * FROM organisations WHERE id = ?', organisation_id);
  if (!org) throw bad('Choose an organisation.');
  const fromIso = new Date(from).toISOString();
  const toIso = new Date(new Date(to).getTime() + 86400000).toISOString();
  let items = eligibleForInvoice(org.id, fromIso, toIso);
  if (Array.isArray(booking_ids)) items = items.filter((i) => booking_ids.includes(i.id));
  if (!items.length) throw bad('No completed, uninvoiced bookings in this period.');
  const missing = items.filter((i) => i.total == null);
  if (missing.length) throw conflict(`These bookings have no accepted price: ${missing.map((m) => m.ref).join(', ')}. Record a price first.`);
  const dueDays = Number(setting('invoice_due_days')) || 30;
  const invoice = tx(() => {
    const total = items.reduce((s, i) => s + i.total, 0);
    const count = get('SELECT COUNT(*) AS n FROM invoices').n + 1;
    const number = `${setting('invoice_prefix')}${new Date().getFullYear()}-${String(count).padStart(4, '0')}`;
    const id = insert('invoices', {
      number, organisation_id: org.id, period_start: fromIso, period_end: toIso, total, status: 'issued',
      issued_at: new Date().toISOString(), due_date: new Date(Date.now() + dueDays * 86400000).toISOString(), notes: notes || null, created_by: req.user.id,
    });
    for (const i of items) {
      insert('invoice_items', { invoice_id: id, booking_id: i.id, description: `${i.ref} · ${i.lead_passenger}`, amount: i.total });
      recomputePaymentStatus(i.id);
      audit({ bookingId: i.id, entity: 'invoice', entityId: id, action: 'invoiced', detail: { number, amount: i.total }, actorId: req.user.id });
    }
    audit({ entity: 'invoice', entityId: id, action: 'invoice_issued', detail: { number, total, bookings: items.length }, actorId: req.user.id });
    return get('SELECT * FROM invoices WHERE id = ?', id);
  });
  for (const u of all("SELECT id FROM users WHERE organisation_id = ? AND status = 'active'", org.id)) {
    notify(u.id, { event: 'invoice_issued', title: `Invoice ${invoice.number}`, body: `A consolidated invoice of ${gbp(invoice.total)} for ${items.length} journey(s) is available in your account.`, email: true });
  }
  res.status(201).json(invoice);
}));

r.patch('/invoices/:id', h((req, res) => {
  const inv = get('SELECT * FROM invoices WHERE id = ?', req.params.id);
  if (!inv) throw notFound();
  const status = req.body.status;
  if (!['issued', 'paid', 'overdue', 'void'].includes(status)) throw bad('Unknown invoice status.');
  tx(() => {
    update('invoices', inv.id, { status, paid_at: status === 'paid' ? new Date().toISOString() : null });
    for (const it of all('SELECT booking_id FROM invoice_items WHERE invoice_id = ?', inv.id)) recomputePaymentStatus(it.booking_id);
    audit({ entity: 'invoice', entityId: inv.id, action: `invoice_${status}`, detail: { number: inv.number, reference: req.body.reference || null }, actorId: req.user.id });
  });
  res.json(get('SELECT * FROM invoices WHERE id = ?', inv.id));
}));

// ---------- notifications log & activity ----------
r.get('/notifications', h((req, res) => {
  const where = req.query.failed ? "WHERE EXISTS (SELECT 1 FROM notification_deliveries d WHERE d.notification_id = n.id AND d.status IN ('failed','not_configured'))" : '';
  res.json(all(`SELECT n.id, n.event, n.title, n.body, n.created_at, n.read_at, u.name AS recipient, u.role AS recipient_role, b.ref, n.booking_id,
    (SELECT json_group_array(json_object('channel', channel, 'status', status, 'detail', detail, 'destination', destination)) FROM notification_deliveries d WHERE d.notification_id = n.id) AS deliveries
    FROM notifications n JOIN users u ON u.id = n.user_id LEFT JOIN bookings b ON b.id = n.booking_id ${where} ORDER BY n.id DESC LIMIT 300`)
    .map((n) => ({ ...n, deliveries: JSON.parse(n.deliveries || '[]') })));
}));

r.get('/activity', h((_req, res) => {
  res.json(all(`SELECT a.*, u.name AS actor_name, u.role AS actor_role, b.ref FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id LEFT JOIN bookings b ON b.id = a.booking_id ORDER BY a.id DESC LIMIT 500`));
}));

// ---------- settings ----------
r.get('/settings', h((_req, res) => res.json(getSettings())));
r.put('/settings', h((req, res) => {
  const allowed = new Set([...Object.keys(DEFAULT_SETTINGS), 'max_drivers', 'max_admins']);
  const changes = {};
  tx(() => {
    for (const [k, v] of Object.entries(req.body || {})) {
      if (!allowed.has(k)) continue;
      const val = typeof v === 'string' ? v : JSON.stringify(v);
      if (k === 'admission_mode' && !['invitation', 'approval', 'both'].includes(val)) throw bad('Unknown admission mode.');
      if (['default_job_minutes', 'turnaround_minutes', 'quote_validity_hours', 'reminder_minutes_before', 'invoice_due_days', 'max_drivers', 'max_admins', 'min_notice_hours', 'hourly_min_hours', 'start_window_minutes'].includes(k) && !(Number(val) >= 0)) throw bad(`${k} must be a number.`);
      if (k === 'payment_rule' && !['off', 'before_assignment', 'before_start'].includes(val)) throw bad('Unknown payment rule.');
      if (k === 'default_payment_arrangement' && !['pay_before', 'pay_after'].includes(val)) throw bad('Unknown payment arrangement.');
      if (['flight_number_required', 'guest_booking', 'otp_login'].includes(k) && !['on', 'off'].includes(val)) throw bad(`${k} must be on or off.`);
      if (k === 'otp_channel' && !['sms', 'whatsapp'].includes(val)) throw bad('Unknown OTP channel.');
      if (setting(k) !== val) changes[k] = { from: setting(k), to: val };
      run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, val);
    }
    if (Object.keys(changes).length) audit({ entity: 'settings', action: 'settings_updated', detail: changes, actorId: req.user.id });
  });
  res.json(getSettings());
}));

// Customers list for staff direct booking
r.get('/customer-options', h((_req, res) => {
  res.json(all("SELECT u.id, u.name, u.email, u.phone, u.role, o.name AS organisation_name FROM users u LEFT JOIN organisations o ON o.id = u.organisation_id WHERE u.role IN ('customer','corporate') AND u.status = 'active' ORDER BY u.name"));
}));

r.get('/bookings/:id/total', h((req, res) => res.json({ total: agreedTotal(Number(req.params.id)) })));

export default r;
