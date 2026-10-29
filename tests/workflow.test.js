// Business-rule tests against an in-memory database (BRD §13, §14).
process.env.ENCORE_DB_FILE = ':memory:';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const { seed, DEMO_PASSWORD } = await import('../seed.js');
const { createApp } = await import('../app.js');
const { runScheduledJobs } = await import('../scheduler.js');
const { get, run } = await import('../db.js');

let server; let base;
const tokens = {};

async function call(who, method, path, body) {
  const res = await fetch(`${base}/api${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(tokens[who] ? { Authorization: `Bearer ${tokens[who]}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

before(async () => {
  seed();
  server = createApp().listen(0);
  base = `http://localhost:${server.address().port}`;
  for (const [who, email] of [['admin', 'admin@encore.test'], ['cust', 'customer@encore.test'], ['corp', 'corporate@encore.test'], ['james', 'james@encore.test'], ['oliver', 'oliver@encore.test']]) {
    const r = await call(null, 'POST', '/auth/login', { email, password: DEMO_PASSWORD });
    assert.equal(r.status, 200, `login ${who}`);
    tokens[who] = r.body.token;
  }
  // Legacy workflow tests run with the new Phase-1 rules relaxed; dedicated tests below switch them on.
  await call('admin', 'PUT', '/admin/settings', { payment_rule: 'off', start_window_minutes: '0', min_notice_hours: '0' });
});
const setRules = (rules) => call('admin', 'PUT', '/admin/settings', rules);
after(() => server.close());

const future = (h) => new Date(Date.now() + h * 3600000).toISOString();
const request = (extra = {}) => ({ journey_type: 'point_to_point', pickup: 'Stafford', destination: 'Manchester', pickup_at: future(48), lead_passenger: 'Test', contact_phone: '+447700900999', passenger_count: 2, ...extra });

test('pending user cannot sign in', async () => {
  const r = await call(null, 'POST', '/auth/login', { email: 'pending@encore.test', password: DEMO_PASSWORD });
  assert.equal(r.status, 403);
});

test('full lifecycle: request → quote → accept (not confirmed) → confirm → assign → driver statuses → close', async () => {
  let r = await call('cust', 'POST', '/bookings', request({ is_return: true, return_pickup_at: future(52) }));
  assert.equal(r.status, 201);
  const id = r.body.id;
  assert.equal(r.body.status, 'pending');
  assert.equal(r.body.legs.length, 2, 'return journey is one booking with two legs');

  r = await call('admin', 'POST', `/bookings/${id}/quotes`, { reference_price: 200, extras: [{ label: 'Return leg', amount: 150 }], total: 360, internal_notes: 'margin note', send: true });
  assert.equal(r.status, 201);

  r = await call('cust', 'GET', `/bookings/${id}`);
  const quote = r.body.quotes[0];
  assert.equal(quote.total, 360);
  assert.equal(quote.reference_price, undefined, 'reference price hidden from customer');
  assert.equal(quote.internal_notes, undefined, 'internal notes hidden from customer');

  r = await call('cust', 'POST', `/bookings/${id}/quotes/${quote.id}/respond`, { action: 'accept' });
  assert.equal(r.body.status, 'quote_accepted', 'acceptance never confirms');

  r = await call('cust', 'POST', `/bookings/${id}/confirm`);
  assert.equal(r.status, 403, 'only management can confirm');

  r = await call('admin', 'POST', `/bookings/${id}/confirm`, {});
  assert.equal(r.body.status, 'confirmed');

  const [out, back] = r.body.legs;
  r = await call('admin', 'POST', `/bookings/${id}/legs/${out.id}/assign`, { driver_id: get("SELECT id FROM users WHERE email='james@encore.test'").id, vehicle_id: get("SELECT id FROM vehicles WHERE registration='EN23 EXE'").id });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'confirmed', 'still confirmed until every leg is assigned');
  r = await call('admin', 'POST', `/bookings/${id}/legs/${back.id}/assign`, { driver_id: get("SELECT id FROM users WHERE email='james@encore.test'").id, vehicle_id: get("SELECT id FROM vehicles WHERE registration='EN23 EXE'").id });
  assert.equal(r.body.status, 'driver_assigned');

  r = await call('cust', 'GET', `/bookings/${id}`);
  assert.equal(r.body.legs[0].vehicle.registration, 'EN23 EXE', 'customer sees vehicle registration');

  r = await call('oliver', 'POST', `/bookings/${id}/legs/${out.id}/status`, { status: 'on_the_way' });
  assert.equal(r.status, 403, 'other drivers cannot update the journey');

  r = await call('james', 'POST', `/bookings/${id}/legs/${out.id}/status`, { status: 'arrived' });
  assert.equal(r.status, 409, 'statuses must follow order');

  r = await call('james', 'POST', `/bookings/${id}/legs/${out.id}/status`, { status: 'on_the_way' });
  assert.equal(r.body.booking.legs[0].status, 'on_the_way');
  r = await call('james', 'POST', `/bookings/${id}/legs/${out.id}/status`, { status: 'on_the_way' });
  assert.equal(r.body.unchanged, true, 'duplicate press is a no-op');

  r = await call('cust', 'POST', `/bookings/${id}/cancel`, {});
  assert.equal(r.status, 409, 'self-service cancellation blocked once driver is en route');

  for (const leg of [out, back]) for (const s of ['on_the_way', 'arrived', 'started', 'completed']) {
    if (leg === out && s === 'on_the_way') continue;
    r = await call('james', 'POST', `/bookings/${id}/legs/${leg.id}/status`, { status: s });
    assert.equal(r.status, 200, `${leg.label} ${s}`);
  }
  r = await call('admin', 'GET', `/bookings/${id}`);
  assert.equal(r.body.status, 'completed');
  assert.equal(r.body.payment_status, 'unpaid', 'status change does not change payment');

  r = await call('admin', 'POST', `/bookings/${id}/payments`, { amount: 360, method: 'card_link', outcome: 'failed' });
  assert.equal(r.body.payment_status, 'unpaid', 'failed payment is never paid');
  r = await call('admin', 'POST', `/bookings/${id}/close`, {});
  assert.equal(r.status, 409);
  r = await call('admin', 'POST', `/bookings/${id}/payments`, { amount: 360, method: 'cash' });
  assert.equal(r.body.payment_status, 'paid');
  r = await call('admin', 'POST', `/bookings/${id}/close`, {});
  assert.equal(r.body.status, 'closed');

  const audit = get('SELECT COUNT(*) AS n FROM audit_log WHERE booking_id = ?', id).n;
  assert.ok(audit >= 12, 'activity history recorded');
});

test('drivers see only their legs and no financial data', async () => {
  const list = await call('james', 'GET', '/driver/legs');
  assert.ok(list.body.length > 0);
  assert.ok(list.body.every((l) => !('total' in l)));
  const bid = list.body[0].booking_id;
  const detail = await call('james', 'GET', `/bookings/${bid}`);
  assert.equal(detail.body.quotes, undefined);
  assert.equal(detail.body.payment_status, undefined);
  assert.equal(detail.body.internal_notes, undefined);
  const other = get("SELECT b.id FROM bookings b WHERE NOT EXISTS (SELECT 1 FROM booking_legs l WHERE l.booking_id=b.id AND l.driver_id=(SELECT id FROM users WHERE email='james@encore.test'))").id;
  assert.equal((await call('james', 'GET', `/bookings/${other}`)).status, 403);
  assert.equal((await call('james', 'GET', '/admin/dashboard')).status, 403);
});

test('organisation isolation', async () => {
  const corpBooking = get("SELECT id FROM bookings WHERE organisation_id IS NOT NULL").id;
  assert.equal((await call('cust', 'GET', `/bookings/${corpBooking}`)).status, 403);
  assert.equal((await call('corp', 'GET', `/bookings/${corpBooking}`)).status, 200);
  const list = await call('corp', 'GET', '/bookings');
  assert.ok(list.body.every((b) => b.organisation_id === get("SELECT organisation_id FROM users WHERE email='corporate@encore.test'").organisation_id));
});

test('assignment conflicts need an explicit override; unavailable vehicles are blocked', async () => {
  const mk = async (at) => {
    const r = await call('cust', 'POST', '/bookings', request({ pickup_at: at }));
    await call('admin', 'POST', `/bookings/${r.body.id}/confirm`, { override_reason: 'agreed by phone' });
    return (await call('admin', 'GET', `/bookings/${r.body.id}`)).body;
  };
  const a = await mk(future(100));
  const b = await mk(future(100.5));
  const oliver = get("SELECT id FROM users WHERE email='oliver@encore.test'").id;
  const vclass = get("SELECT id FROM vehicles WHERE registration='EN22 RRS'").id;
  let r = await call('admin', 'POST', `/bookings/${a.id}/legs/${a.legs[0].id}/assign`, { driver_id: oliver, vehicle_id: vclass });
  assert.equal(r.status, 200);
  r = await call('admin', 'POST', `/bookings/${b.id}/legs/${b.legs[0].id}/assign`, { driver_id: oliver, vehicle_id: vclass });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'assignment_conflict');
  r = await call('admin', 'POST', `/bookings/${b.id}/legs/${b.legs[0].id}/assign`, { driver_id: oliver, vehicle_id: vclass, override_reason: 'short hop' });
  assert.equal(r.status, 200);
  const unavailable = get("SELECT id FROM vehicles WHERE status='unavailable'").id;
  r = await call('admin', 'POST', `/bookings/${b.id}/legs/${b.legs[0].id}/assign`, { driver_id: oliver, vehicle_id: unavailable });
  assert.equal(r.status, 409);
});

test('confirming without an accepted quote needs a reason', async () => {
  const r0 = await call('cust', 'POST', '/bookings', request());
  const r = await call('admin', 'POST', `/bookings/${r0.body.id}/confirm`, {});
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'needs_override');
});

test('validation: flight number optional unless configured; hourly needs duration', async () => {
  let r = await call('cust', 'POST', '/bookings', request({ journey_type: 'airport' }));
  assert.equal(r.status, 201, 'flight number is optional by default');
  await setRules({ flight_number_required: 'on' });
  r = await call('cust', 'POST', '/bookings', request({ journey_type: 'airport' }));
  assert.equal(r.status, 400);
  assert.ok(r.body.fields.flight_number);
  await setRules({ flight_number_required: 'off' });
  r = await call('cust', 'POST', '/bookings', request({ journey_type: 'hourly', duration_hours: '' }));
  assert.ok(r.body.fields.duration_hours);
});

test('pickup reminder is sent once within the reminder window', async () => {
  const r0 = await call('cust', 'POST', '/bookings', request({ pickup_at: future(0.75) }));
  await call('admin', 'POST', `/bookings/${r0.body.id}/confirm`, { override_reason: 'phone' });
  runScheduledJobs();
  runScheduledJobs();
  const n = get("SELECT COUNT(*) AS n FROM notifications WHERE booking_id = ? AND event = 'pickup_reminder'", r0.body.id).n;
  assert.equal(n, 1);
  const d = get("SELECT status FROM notification_deliveries d JOIN notifications n ON n.id = d.notification_id WHERE n.booking_id = ? AND d.channel='whatsapp' LIMIT 1", r0.body.id);
  assert.equal(d.status, 'not_configured', 'undelivered WhatsApp is never recorded as delivered');
  run('SELECT 1');
});

test('management and app portals are separate', async () => {
  const mgmtAsCustomer = await call(null, 'POST', '/auth/login', { email: 'customer@encore.test', password: DEMO_PASSWORD, portal: 'management' });
  assert.equal(mgmtAsCustomer.status, 403, 'customers cannot use the Command Center');
  const mgmtAsDriver = await call(null, 'POST', '/auth/login', { email: 'james@encore.test', password: DEMO_PASSWORD, portal: 'management' });
  assert.equal(mgmtAsDriver.status, 403, 'drivers cannot use the Command Center');
  const appAsAdmin = await call(null, 'POST', '/auth/login', { email: 'admin@encore.test', password: DEMO_PASSWORD, portal: 'app' });
  assert.equal(appAsAdmin.status, 403, 'management cannot sign into the app');
  const mgmtAsAdmin = await call(null, 'POST', '/auth/login', { email: 'admin@encore.test', password: DEMO_PASSWORD, portal: 'management' });
  assert.equal(mgmtAsAdmin.status, 200);
});

test('driver accepts or declines an assignment; everyone is told', async () => {
  let r = await call('cust', 'POST', '/bookings', request({ pickup_at: future(200) }));
  const id = r.body.id;
  r = await call('admin', 'POST', `/bookings/${id}/confirm`, { override_reason: 'Agreed by phone' });
  assert.equal(r.body.status, 'confirmed');
  assert.ok(get("SELECT 1 FROM notifications WHERE booking_id = ? AND event = 'booking_confirmed'", id), 'customer told of confirmation');
  const leg = r.body.legs[0];
  const assign = { driver_id: get("SELECT id FROM users WHERE email='james@encore.test'").id, vehicle_id: get("SELECT id FROM vehicles WHERE registration='EN23 EXE'").id };

  r = await call('admin', 'POST', `/bookings/${id}/legs/${leg.id}/assign`, assign);
  assert.equal(r.status, 200);
  r = await call('oliver', 'POST', `/bookings/${id}/legs/${leg.id}/respond`, { accept: true });
  assert.equal(r.status, 403, 'only the assigned driver can respond');

  r = await call('james', 'POST', `/bookings/${id}/legs/${leg.id}/respond`, { accept: false, reason: 'Clash' });
  assert.equal(r.status, 200);
  assert.equal(get('SELECT status FROM bookings WHERE id = ?', id).status, 'confirmed', 'declined leg goes back to unassigned');
  assert.ok(get("SELECT 1 FROM notifications WHERE booking_id = ? AND event = 'driver_declined'", id), 'management told of decline');

  await call('admin', 'POST', `/bookings/${id}/legs/${leg.id}/assign`, assign);
  r = await call('james', 'POST', `/bookings/${id}/legs/${leg.id}/respond`, { accept: true });
  assert.equal(r.status, 200);
  r = await call('cust', 'GET', `/bookings/${id}`);
  assert.ok(r.body.legs[0].driver_accepted_at, 'customer sees chauffeur confirmed');
  assert.ok(get("SELECT 1 FROM notifications WHERE booking_id = ? AND event = 'driver_accepted'", id));
});

test('booking rules: minimum notice and minimum hourly hire are configurable; staff may override', async () => {
  await setRules({ min_notice_hours: '2', hourly_min_hours: '2' });
  let r = await call('cust', 'POST', '/bookings', request({ pickup_at: future(1) }));
  assert.equal(r.status, 400);
  assert.ok(r.body.fields.pickup_at);
  r = await call('cust', 'POST', '/bookings', request({ journey_type: 'hourly', duration_hours: 1, destination: '' }));
  assert.ok(r.body.fields.duration_hours, 'below minimum hire');
  r = await call('admin', 'POST', '/bookings', request({ pickup_at: future(1), customer_id: get("SELECT id FROM users WHERE email='customer@encore.test'").id }));
  assert.equal(r.status, 201, 'staff can book short notice');
  await setRules({ min_notice_hours: '0' });
});

test('payment rule blocks the journey until paid; pay-after is the management exception; start window enforced', async () => {
  await setRules({ payment_rule: 'before_start', start_window_minutes: '30' });
  let r = await call('cust', 'POST', '/bookings', request({ pickup_at: future(0.25) }));
  const id = r.body.id;
  assert.equal(r.body.payment_arrangement, 'pay_before', 'pay before is the default');
  r = await call('admin', 'POST', `/bookings/${id}/confirm`, { override_reason: 'phone' });
  const leg = r.body.legs[0];
  await call('admin', 'POST', `/bookings/${id}/legs/${leg.id}/assign`, { driver_id: get("SELECT id FROM users WHERE email='oliver@encore.test'").id, vehicle_id: get("SELECT id FROM vehicles WHERE status='available' ORDER BY id DESC LIMIT 1").id, override_reason: 'test' });
  r = await call('oliver', 'POST', `/bookings/${id}/legs/${leg.id}/status`, { status: 'on_the_way' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'payment_outstanding');
  await call('admin', 'PATCH', `/bookings/${id}`, { payment_arrangement: 'pay_after' });
  r = await call('oliver', 'POST', `/bookings/${id}/legs/${leg.id}/status`, { status: 'on_the_way' });
  assert.equal(r.status, 200, 'exception allows the journey');

  r = await call('cust', 'POST', '/bookings', request({ pickup_at: future(5) }));
  const id2 = r.body.id;
  await call('admin', 'PATCH', `/bookings/${id2}`, { payment_arrangement: 'pay_after' });
  r = await call('admin', 'POST', `/bookings/${id2}/confirm`, { override_reason: 'phone' });
  await call('admin', 'POST', `/bookings/${id2}/legs/${r.body.legs[0].id}/assign`, { driver_id: get("SELECT id FROM users WHERE email='oliver@encore.test'").id, vehicle_id: get("SELECT id FROM vehicles WHERE status='available' ORDER BY id DESC LIMIT 1").id, override_reason: 'test' });
  r = await call('oliver', 'POST', `/bookings/${id2}/legs/${r.body.legs[0].id}/status`, { status: 'on_the_way' });
  assert.equal(r.body.code, 'too_early', 'cannot start more than 30 minutes before pickup');

  await setRules({ payment_rule: 'before_assignment' });
  r = await call('cust', 'POST', '/bookings', request({ pickup_at: future(6) }));
  r = await call('admin', 'POST', `/bookings/${r.body.id}/confirm`, { override_reason: 'phone' });
  const a = await call('admin', 'POST', `/bookings/${r.body.id}/legs/${r.body.legs[0].id}/assign`, { driver_id: get("SELECT id FROM users WHERE email='james@encore.test'").id, vehicle_id: get("SELECT id FROM vehicles WHERE status='available' LIMIT 1").id });
  assert.equal(a.body.code, 'payment_outstanding');
  await setRules({ payment_rule: 'off', start_window_minutes: '0' });
});

test('mobile OTP: new customer signs up with name, returning customer signs straight in', async () => {
  let r = await call(null, 'POST', '/auth/otp/request', { phone: '07700 900555' });
  assert.equal(r.status, 200);
  const code = r.body.demo_code;
  assert.match(code, /^\d{6}$/);
  r = await call(null, 'POST', '/auth/otp/verify', { phone: '+44 7700 900555', code: '000000' === code ? '111111' : '000000' });
  assert.equal(r.status, 400, 'wrong code rejected');
  r = await call(null, 'POST', '/auth/otp/verify', { phone: '+447700900555', code });
  assert.equal(r.body.code, 'needs_name');
  r = await call(null, 'POST', '/auth/otp/verify', { phone: '+447700900555', code, name: 'Guest Booker' });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.role, 'customer');
  assert.equal(r.body.user.email, null, 'placeholder email hidden');
  r = await call(null, 'POST', '/auth/otp/verify', { phone: '+447700900555', code });
  assert.equal(r.status, 400, 'code cannot be reused');

  r = await call(null, 'POST', '/auth/otp/request', { phone: '07700900555' });
  r = await call(null, 'POST', '/auth/otp/verify', { phone: '07700900555', code: r.body.demo_code });
  assert.equal(r.body.user.name, 'Guest Booker', 'returning customer recognised by mobile');
});

test('temporary drivers: access ends on the set date and they are limited to their journeys', async () => {
  const ends = new Date(Date.now() + 3 * 86400000).toISOString();
  let r = await call('admin', 'POST', '/admin/drivers', { name: 'Temp Tom', email: 'temp@encore.test', phone: '+447700900777', password: 'TempPass123', driver_type: 'temporary', access_expires_at: ends });
  assert.equal(r.status, 201);
  assert.equal(r.body.driver_type, 'temporary');
  r = await call(null, 'POST', '/auth/login', { email: 'temp@encore.test', password: 'TempPass123', portal: 'app' });
  assert.equal(r.status, 200);
  const tok = r.body.token;
  run("UPDATE users SET access_expires_at = datetime('now','-1 hour') WHERE email = 'temp@encore.test'");
  r = await call(null, 'POST', '/auth/login', { email: 'temp@encore.test', password: 'TempPass123', portal: 'app' });
  assert.equal(r.status, 403, 'expired temporary access blocked');
  tokens.temp = tok;
  r = await call('temp', 'GET', '/driver/legs');
  assert.equal(r.status, 403, 'existing session also blocked');
});

test('journey distance exceeded: admin is alerted once when actual distance exceeds the accepted distance', async () => {
  let r = await call('cust', 'POST', '/bookings', request({ pickup_at: future(3) }));
  const id = r.body.id;
  r = await call('admin', 'POST', `/bookings/${id}/confirm`, { override_reason: 'phone' });
  const leg = r.body.legs[0];
  const assign = { driver_id: get("SELECT id FROM users WHERE email='oliver@encore.test'").id, vehicle_id: get("SELECT id FROM vehicles WHERE status='available' ORDER BY id DESC LIMIT 1").id };
  await call('admin', 'POST', `/bookings/${id}/legs/${leg.id}/assign`, { ...assign, override_reason: 'test' });
  run('UPDATE booking_legs SET distance_m = ? WHERE id = ?', 64374, leg.id); // 40 miles accepted

  for (const status of ['on_the_way', 'arrived', 'started']) {
    r = await call('oliver', 'POST', `/bookings/${id}/legs/${leg.id}/status`, { status });
    assert.equal(r.status, 200, status);
  }
  r = await call('oliver', 'POST', `/bookings/${id}/legs/${leg.id}/status`, { status: 'completed', actual_distance_mi: 43 });
  assert.equal(r.status, 200);
  assert.ok(r.body.booking.legs[0].distance_exceeded, 'customer-visible flag set');

  const alert = get("SELECT * FROM notifications WHERE booking_id = ? AND event = 'journey_distance_exceeded'", id);
  assert.ok(alert, 'admin was notified');
  assert.match(alert.title, /Journey Distance Exceeded/);
  assert.match(alert.body, /43\.0 mi/);
  assert.match(alert.body, /3\.0 mi over/);

  // Re-completing (e.g. an admin override) must not send a second alert.
  const before = get("SELECT COUNT(*) AS n FROM notifications WHERE booking_id = ? AND event = 'journey_distance_exceeded'", id).n;
  await call('admin', 'POST', `/bookings/${id}/legs/${leg.id}/status`, { status: 'arrived', reason: 'correction' });
  await call('admin', 'POST', `/bookings/${id}/legs/${leg.id}/status`, { status: 'completed', actual_distance_mi: 45 });
  const after = get("SELECT COUNT(*) AS n FROM notifications WHERE booking_id = ? AND event = 'journey_distance_exceeded'", id).n;
  assert.equal(after, before, 'alert does not repeat for the same completed journey');
});

test('journey distance within accepted distance: no alert', async () => {
  let r = await call('cust', 'POST', '/bookings', request({ pickup_at: future(3) }));
  const id = r.body.id;
  r = await call('admin', 'POST', `/bookings/${id}/confirm`, { override_reason: 'phone' });
  const leg = r.body.legs[0];
  await call('admin', 'POST', `/bookings/${id}/legs/${leg.id}/assign`, { driver_id: get("SELECT id FROM users WHERE email='james@encore.test'").id, vehicle_id: get("SELECT id FROM vehicles WHERE status='available' LIMIT 1").id, override_reason: 'test' });
  run('UPDATE booking_legs SET distance_m = ? WHERE id = ?', 64374, leg.id);
  for (const status of ['on_the_way', 'arrived', 'started']) await call('james', 'POST', `/bookings/${id}/legs/${leg.id}/status`, { status });
  r = await call('james', 'POST', `/bookings/${id}/legs/${leg.id}/status`, { status: 'completed', actual_distance_mi: 38 });
  assert.equal(r.body.booking.legs[0].distance_exceeded, false);
  assert.ok(!get("SELECT 1 FROM notifications WHERE booking_id = ? AND event = 'journey_distance_exceeded'", id));
});
