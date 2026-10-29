import { all, get, run, setting } from './db.js';
import { forbidden, notFound } from './lib.js';

export const JOURNEY_TYPES = ['point_to_point', 'airport', 'return', 'event', 'corporate', 'hourly'];

export const BOOKING_STATUSES = [
  'pending', 'under_review', 'clarification_needed', 'quote_sent', 'change_requested',
  'quote_accepted', 'quote_declined', 'confirmed', 'driver_assigned', 'on_the_way', 'arrived',
  'started', 'completed', 'closed', 'rejected', 'cancelled_customer', 'cancelled_management',
  'expired', 'no_show',
];
export const TERMINAL = ['closed', 'rejected', 'cancelled_customer', 'cancelled_management', 'expired', 'no_show', 'quote_declined'];
export const PRE_CONFIRMATION = ['pending', 'under_review', 'clarification_needed', 'quote_sent', 'change_requested', 'quote_accepted'];
export const DELIVERY = ['on_the_way', 'arrived', 'started'];

export const LEG_FLOW = ['assigned', 'on_the_way', 'arrived', 'started', 'completed'];
export const LEG_TIMESTAMP = { on_the_way: 'on_the_way_at', arrived: 'arrived_at', started: 'started_at', completed: 'completed_at' };

export const PAYMENT_ARRANGEMENTS = ['pay_before', 'pay_after', 'corporate_account', 'external'];
export const PAYMENT_STATUSES = ['unpaid', 'link_sent', 'deposit_paid', 'paid', 'invoiced', 'overdue'];

export function nextRef(id) {
  return `EE-${String(10000 + id)}`;
}

// ---------- access ----------
export function canView(user, booking) {
  if (user.role === 'admin') return true;
  if (user.role === 'customer') return booking.customer_id === user.id;
  if (user.role === 'corporate') return booking.organisation_id != null && booking.organisation_id === user.organisation_id;
  if (user.role === 'driver') {
    return !!get('SELECT 1 FROM booking_legs WHERE booking_id = ? AND driver_id = ?', booking.id, user.id);
  }
  return false;
}

export function scopeClause(user, alias = 'b') {
  switch (user.role) {
    case 'admin': return { sql: '1=1', params: [] };
    case 'customer': return { sql: `${alias}.customer_id = ?`, params: [user.id] };
    case 'corporate': return { sql: `${alias}.organisation_id = ?`, params: [user.organisation_id ?? -1] };
    case 'driver': return { sql: `${alias}.id IN (SELECT booking_id FROM booking_legs WHERE driver_id = ?)`, params: [user.id] };
    default: return { sql: '0=1', params: [] };
  }
}

export function loadBookingRow(id, user) {
  const b = get('SELECT * FROM bookings WHERE id = ?', id);
  if (!b) throw notFound('Booking not found.');
  if (user && !canView(user, b)) throw forbidden();
  return b;
}

export function legsFor(bookingId) {
  return all(`
    SELECT l.*, v.registration AS vehicle_registration, v.make AS vehicle_make, v.model AS vehicle_model,
           v.colour AS vehicle_colour, v.category AS vehicle_category,
           d.name AS driver_name, d.phone AS driver_phone,
           o.name AS operator_name, o.phone AS operator_phone
    FROM booking_legs l
    LEFT JOIN vehicles v ON v.id = l.vehicle_id
    LEFT JOIN users d ON d.id = l.driver_id
    LEFT JOIN external_operators o ON o.id = l.external_operator_id
    WHERE l.booking_id = ? ORDER BY l.leg_no`, bookingId).map((l) => ({ ...l, stops: JSON.parse(l.stops || '[]') }));
}

export function quotesFor(bookingId) {
  return all('SELECT * FROM quotes WHERE booking_id = ? ORDER BY version DESC', bookingId).map((q) => ({
    ...q, extras: JSON.parse(q.extras || '[]'), customer_lines: JSON.parse(q.customer_lines || '[]'),
  }));
}

export function agreedTotal(bookingId) {
  const q = get("SELECT total FROM quotes WHERE booking_id = ? AND status = 'accepted' ORDER BY version DESC LIMIT 1", bookingId)
    || get("SELECT total FROM quotes WHERE booking_id = ? AND status = 'sent' ORDER BY version DESC LIMIT 1", bookingId);
  return q ? q.total : null;
}

/** Full booking view, filtered to what the viewer may see. */
/** Payment rule (Settings → payment_rule): pay-before bookings must be paid before assignment or the journey starts. */
export function paymentOutstanding(b) {
  return b.payment_arrangement === 'pay_before' && b.payment_status !== 'paid';
}
export function paymentBlocks(b, stage) {
  const rule = setting('payment_rule');
  if (rule === 'off' || !paymentOutstanding(b)) return false;
  if (stage === 'assignment') return rule === 'before_assignment';
  return rule === 'before_assignment' || rule === 'before_start';
}

/** Earliest time the chauffeur may press the first journey step (Settings → start_window_minutes). */
export function startAvailableAt(leg) {
  const mins = Number(setting('start_window_minutes') || 0);
  if (!mins) return null;
  return new Date(new Date(leg.pickup_at).getTime() - mins * 60000).toISOString();
}

export function bookingView(id, user) {
  const b = loadBookingRow(id, user);
  const legs = legsFor(id);
  const customer = get('SELECT id, name, email, phone, role FROM users WHERE id = ?', b.customer_id);
  const organisation = b.organisation_id ? get('SELECT id, name, payment_terms FROM organisations WHERE id = ?', b.organisation_id) : null;
  const messages = all(`SELECT m.*, u.name AS author_name, u.role AS author_role FROM messages m JOIN users u ON u.id = m.author_id WHERE booking_id = ? ORDER BY m.id`, id);

  if (user.role === 'driver') {
    const mine = legs.filter((l) => l.driver_id === user.id);
    return {
      id: b.id, ref: b.ref, journey_type: b.journey_type, status: b.status,
      lead_passenger: b.lead_passenger, contact_phone: b.contact_phone, passenger_count: b.passenger_count,
      passenger_names: b.passenger_names, luggage_large: b.luggage_large, luggage_small: b.luggage_small,
      child_seats: b.child_seats, accessibility_needs: b.accessibility_needs,
      special_instructions: b.special_instructions, sensitive_notes: b.sensitive_notes,
      flight_number: b.flight_number, duration_hours: b.duration_hours,
      cancelled: TERMINAL.includes(b.status) && b.status.startsWith('cancelled'),
      payment_hold: paymentBlocks(b, 'start'),
      legs: mine.map((l) => ({ ...driverLeg(l), start_available_at: startAvailableAt(l) })),
    };
  }

  const view = {
    ...b, legs, customer, organisation, messages,
    agreed_total: agreedTotal(id),
    can_customer_cancel: customerMayCancel(b, legs),
  };

  if (user.role === 'admin') {
    view.quotes = quotesFor(id);
    view.payments = all('SELECT p.*, u.name AS recorded_by_name FROM payments p LEFT JOIN users u ON u.id = p.recorded_by WHERE booking_id = ? ORDER BY p.id DESC', id);
    view.activity = all('SELECT a.*, u.name AS actor_name, u.role AS actor_role FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id WHERE a.booking_id = ? ORDER BY a.id DESC', id);
    view.notifications = all(`
      SELECT n.id, n.event, n.title, n.created_at, u.name AS recipient,
        (SELECT json_group_array(json_object('channel', channel, 'status', status, 'detail', detail)) FROM notification_deliveries d WHERE d.notification_id = n.id) AS deliveries
      FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.booking_id = ? ORDER BY n.id DESC`, id)
      .map((n) => ({ ...n, deliveries: JSON.parse(n.deliveries || '[]') }));
    view.payment_outstanding = paymentOutstanding(b);
    view.payment_rule = setting('payment_rule');
    view.conflicts = legs.map((l) => ({ leg_id: l.id, items: findConflicts(l) }));
    view.invoice = get('SELECT i.id, i.number, i.status FROM invoice_items it JOIN invoices i ON i.id = it.invoice_id WHERE it.booking_id = ? AND i.status != \'void\'', id) || null;
    return view;
  }

  // customer / corporate: hide internal-only information
  delete view.internal_notes;
  view.quotes = quotesFor(id)
    .filter((q) => q.status !== 'draft')
    .map(({ reference_price: _r, extras: _e, internal_notes: _i, created_by: _c, ...q }) => q);
  view.payments = all("SELECT id, amount, kind, method, outcome, reference, created_at FROM payments WHERE booking_id = ? ORDER BY id DESC", id);
  view.legs = legs.map(customerLeg);
  view.invoice = get('SELECT i.id, i.number, i.status, i.due_date FROM invoice_items it JOIN invoices i ON i.id = it.invoice_id WHERE it.booking_id = ? AND i.status != \'void\'', id) || null;
  return view;
}

function customerLeg(l) {
  const assigned = l.status !== 'unassigned';
  return {
    id: l.id, leg_no: l.leg_no, label: l.label, pickup: l.pickup, destination: l.destination, stops: l.stops,
    pickup_at: l.pickup_at, status: l.status, distance_m: l.distance_m, duration_s: l.duration_s,
    actual_distance_m: l.actual_distance_m, distance_exceeded: l.actual_distance_m != null && l.distance_m != null && l.actual_distance_m > l.distance_m,
    driver_accepted_at: assigned ? l.driver_accepted_at : null,
    vehicle: assigned ? (l.vehicle_registration
      ? { registration: l.vehicle_registration, make: l.vehicle_make, model: l.vehicle_model, colour: l.vehicle_colour }
      : l.external_vehicle_reg ? { registration: l.external_vehicle_reg } : null) : null,
    chauffeur: assigned ? (l.driver_name ? l.driver_name.split(' ')[0] : l.external_driver_name || null) : null,
    on_the_way_at: l.on_the_way_at, arrived_at: l.arrived_at, started_at: l.started_at, completed_at: l.completed_at,
  };
}

function driverLeg(l) {
  return {
    id: l.id, leg_no: l.leg_no, label: l.label, pickup: l.pickup, destination: l.destination, stops: l.stops,
    pickup_at: l.pickup_at, est_minutes: l.est_minutes, status: l.status, distance_m: l.distance_m, duration_s: l.duration_s,
    actual_distance_m: l.actual_distance_m, distance_exceeded: l.actual_distance_m != null && l.distance_m != null && l.actual_distance_m > l.distance_m,
    driver_accepted_at: l.driver_accepted_at,
    vehicle: l.vehicle_registration ? { registration: l.vehicle_registration, make: l.vehicle_make, model: l.vehicle_model, colour: l.vehicle_colour } : null,
    navigation_url: navigationUrl(l),
    on_the_way_at: l.on_the_way_at, arrived_at: l.arrived_at, started_at: l.started_at, completed_at: l.completed_at,
  };
}

export function navigationUrl(leg) {
  const stops = Array.isArray(leg.stops) ? leg.stops : JSON.parse(leg.stops || '[]');
  const p = new URLSearchParams({ api: '1', origin: leg.pickup, destination: leg.destination, travelmode: 'driving' });
  if (stops.length) p.set('waypoints', stops.join('|'));
  return `https://www.google.com/maps/dir/?${p.toString()}`;
}

export function customerMayCancel(b, legs = legsFor(b.id)) {
  if (TERMINAL.includes(b.status) || ['completed', 'closed'].includes(b.status)) return false;
  // Self-service ends once any chauffeur is en route (BRD rule 8).
  return !legs.some((l) => ['on_the_way', 'arrived', 'started', 'completed'].includes(l.status));
}

// ---------- status derivation ----------
/** After assignment or driver updates, recompute booking status from its legs. */
export function deriveDeliveryStatus(bookingId) {
  const b = get('SELECT status FROM bookings WHERE id = ?', bookingId);
  if (!['confirmed', 'driver_assigned', ...DELIVERY, 'completed'].includes(b.status)) return b.status;
  const legs = all('SELECT status FROM booking_legs WHERE booking_id = ? ORDER BY leg_no', bookingId);
  let status;
  if (legs.every((l) => l.status === 'completed')) status = 'completed';
  else {
    const active = legs.find((l) => l.status !== 'completed');
    if (DELIVERY.includes(active.status)) status = active.status;
    else if (legs.every((l) => l.status !== 'unassigned')) status = 'driver_assigned';
    else status = 'confirmed';
  }
  if (status !== b.status) run("UPDATE bookings SET status = ?, updated_at = datetime('now') WHERE id = ?", status, bookingId);
  return status;
}

// ---------- conflicts (BRD ADM-4) ----------
export function legWindow(leg) {
  const start = new Date(leg.pickup_at).getTime();
  const minutes = Number(leg.est_minutes) || Number(setting('default_job_minutes')) || 120;
  const turnaround = Number(setting('turnaround_minutes')) || 0;
  return { start, end: start + (minutes + turnaround) * 60000 };
}

/** Other active legs that overlap this leg's window for the same driver or vehicle. */
export function findConflicts(leg, driverId = leg.driver_id, vehicleId = leg.vehicle_id) {
  if (!driverId && !vehicleId) return [];
  const { start, end } = legWindow(leg);
  const candidates = all(`
    SELECT l.*, b.ref, b.status AS booking_status, d.name AS driver_name, v.registration AS vehicle_registration
    FROM booking_legs l JOIN bookings b ON b.id = l.booking_id
    LEFT JOIN users d ON d.id = l.driver_id LEFT JOIN vehicles v ON v.id = l.vehicle_id
    WHERE l.id != ? AND l.status NOT IN ('completed') AND b.status NOT IN (${TERMINAL.map(() => '?').join(',')})
      AND ((? IS NOT NULL AND l.driver_id = ?) OR (? IS NOT NULL AND l.vehicle_id = ?))`,
  leg.id ?? -1, ...TERMINAL, driverId, driverId, vehicleId, vehicleId);
  return candidates
    .filter((c) => {
      const w = legWindow(c);
      return w.start < end && start < w.end;
    })
    .map((c) => ({
      leg_id: c.id, booking_id: c.booking_id, ref: c.ref, pickup_at: c.pickup_at, label: c.label,
      reason: [c.driver_id === driverId && driverId ? `Driver ${c.driver_name} already booked` : null,
        c.vehicle_id === vehicleId && vehicleId ? `Vehicle ${c.vehicle_registration} already booked` : null].filter(Boolean).join(' · '),
    }));
}

// ---------- payment status ----------
export function recomputePaymentStatus(bookingId) {
  const b = get('SELECT payment_status, payment_link FROM bookings WHERE id = ?', bookingId);
  const total = agreedTotal(bookingId);
  const sums = get(`SELECT
      COALESCE(SUM(CASE WHEN kind IN ('payment','deposit') AND outcome='succeeded' THEN amount END),0) AS paid,
      COALESCE(SUM(CASE WHEN kind='refund' AND outcome='succeeded' THEN amount END),0) AS refunded,
      COALESCE(SUM(CASE WHEN kind='deposit' AND outcome='succeeded' THEN 1 END),0) AS deposits
    FROM payments WHERE booking_id = ?`, bookingId);
  const net = sums.paid - sums.refunded;
  const inv = get(`SELECT i.status FROM invoice_items it JOIN invoices i ON i.id = it.invoice_id WHERE it.booking_id = ? AND i.status IN ('issued','overdue','paid')`, bookingId);
  let status;
  if (total != null && net >= total - 0.005 && net > 0) status = 'paid';
  else if (inv?.status === 'paid') status = 'paid';
  else if (inv?.status === 'overdue') status = 'overdue';
  else if (inv) status = 'invoiced';
  else if (net > 0) status = 'deposit_paid';
  else if (b.payment_status === 'overdue') status = 'overdue';
  else if (b.payment_link) status = 'link_sent';
  else status = 'unpaid';
  run('UPDATE bookings SET payment_status = ? WHERE id = ?', status, bookingId);
  return status;
}
