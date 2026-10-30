import { Router } from 'express';
import { all, get, insert, run, setting, tx, update } from '../db.js';
import { mapsEnabled, refreshBookingRoutes, refreshLegRoute } from '../maps.js';
import {
  audit, bad, conflict, fmtWhen, forbidden, gbp, h, isAdmin, notify, notifyAdmins, requireRole,
} from '../lib.js';
import {
  BOOKING_STATUSES, DELIVERY, JOURNEY_TYPES, LEG_FLOW, LEG_TIMESTAMP, PAYMENT_ARRANGEMENTS, PAYMENT_STATUSES,
  PRE_CONFIRMATION, TERMINAL, bookingView, customerMayCancel, deriveDeliveryStatus, findConflicts, legsFor,
  loadBookingRow, nextRef, paymentBlocks, recomputePaymentStatus, scopeClause, startAvailableAt,
} from '../domain.js';

const r = Router();
const adminOnly = requireRole('admin');

const STATUS_LABEL = Object.fromEntries(BOOKING_STATUSES.map((s) => [s, s.replace(/_/g, ' ')]));

// ---------- list ----------
r.get('/', h((req, res) => {
  const { status, q, from, to, organisation_id, vehicle_id, customer_id, sort = 'pickup', view } = req.query;
  const scope = scopeClause(req.user);
  const where = [scope.sql];
  const params = [...scope.params];
  if (status) {
    const list = String(status).split(',').filter((s) => BOOKING_STATUSES.includes(s));
    if (list.length) { where.push(`b.status IN (${list.map(() => '?').join(',')})`); params.push(...list); }
  }
  if (view === 'upcoming') { where.push(`b.status NOT IN (${[...TERMINAL, 'completed'].map(() => '?').join(',')})`); params.push(...TERMINAL, 'completed'); }
  if (view === 'past') { where.push(`b.status IN (${[...TERMINAL, 'completed'].map(() => '?').join(',')})`); params.push(...TERMINAL, 'completed'); }
  if (from) { where.push('first_pickup >= ?'); params.push(from); }
  if (to) { where.push('first_pickup <= ?'); params.push(to); }
  if (isAdmin(req.user)) {
    if (organisation_id) { where.push('b.organisation_id = ?'); params.push(organisation_id); }
    if (customer_id) { where.push('b.customer_id = ?'); params.push(customer_id); }
    if (vehicle_id) { where.push('b.id IN (SELECT booking_id FROM booking_legs WHERE vehicle_id = ?)'); params.push(vehicle_id); }
    if (req.query.payment_status) { where.push('b.payment_status = ?'); params.push(req.query.payment_status); }
  }
  if (q) {
    where.push(`(b.ref LIKE ? OR b.lead_passenger LIKE ? OR u.name LIKE ? OR o.name LIKE ? OR EXISTS (SELECT 1 FROM booking_legs x WHERE x.booking_id = b.id AND (x.pickup LIKE ? OR x.destination LIKE ?)))`);
    const like = `%${q}%`;
    params.push(like, like, like, like, like, like);
  }
  const order = {
    pickup: 'first_pickup ASC',
    pickup_desc: 'first_pickup DESC',
    created: 'b.created_at DESC',
    status: 'b.status ASC, first_pickup ASC',
    customer: 'u.name ASC',
  }[sort] || 'first_pickup ASC';

  const rows = all(`
    SELECT b.id, b.ref, b.status, b.journey_type, b.lead_passenger, b.passenger_count, b.payment_status,
      b.payment_arrangement, b.is_return, b.created_at, b.customer_id, b.organisation_id,
      u.name AS customer_name, o.name AS organisation_name,
      (SELECT MIN(pickup_at) FROM booking_legs WHERE booking_id = b.id) AS first_pickup,
      (SELECT pickup FROM booking_legs WHERE booking_id = b.id AND leg_no = 1) AS pickup,
      (SELECT destination FROM booking_legs WHERE booking_id = b.id AND leg_no = 1) AS destination,
      (SELECT total FROM quotes q WHERE q.booking_id = b.id AND q.status IN ('accepted','sent') ORDER BY CASE q.status WHEN 'accepted' THEN 0 ELSE 1 END, version DESC LIMIT 1) AS total,
      (SELECT group_concat(COALESCE(v.registration, l.external_vehicle_reg), ', ') FROM booking_legs l LEFT JOIN vehicles v ON v.id = l.vehicle_id WHERE l.booking_id = b.id) AS vehicles,
      (SELECT group_concat(d.name, ', ') FROM booking_legs l JOIN users d ON d.id = l.driver_id WHERE l.booking_id = b.id) AS drivers
    FROM bookings b
    JOIN users u ON u.id = b.customer_id
    LEFT JOIN organisations o ON o.id = b.organisation_id
    WHERE ${where.join(' AND ')}
    ORDER BY ${order}
    LIMIT 500`, ...params);

  if (req.user.role === 'driver') {
    return res.json(rows.map(({ total: _t, payment_status: _p, payment_arrangement: _a, customer_name: _c, organisation_name: _o, ...rest }) => rest));
  }
  if (!isAdmin(req.user)) {
    return res.json(rows.map(({ drivers: _d, ...rest }) => rest));
  }
  res.json(rows);
}));

r.get('/:id', h((req, res) => res.json(bookingView(Number(req.params.id), req.user))));

// ---------- create request (CUS-2) ----------
function validateRequest(body, staff = false) {
  const errors = {};
  const type = body.journey_type;
  if (!JOURNEY_TYPES.includes(type)) errors.journey_type = 'Choose a journey type.';
  if (!body.pickup?.trim()) errors.pickup = 'Pickup address is required.';
  if (type !== 'hourly' && !body.destination?.trim()) errors.destination = 'Destination is required.';
  const when = new Date(body.pickup_at);
  if (!body.pickup_at || Number.isNaN(when.getTime())) errors.pickup_at = 'Pickup date and time are required.';
  else if (when.getTime() < Date.now() - 5 * 60000) errors.pickup_at = 'Pickup time must be in the future.';
  else if (!staff) {
    // Customers must book at least N hours ahead (Settings → min_notice_hours). Staff may book short-notice exceptions.
    const notice = Number(setting('min_notice_hours') || 0);
    if (notice && when.getTime() < Date.now() + notice * 3600000) errors.pickup_at = `Please book at least ${notice} hour${notice === 1 ? '' : 's'} in advance, or call us for short-notice journeys.`;
  }
  if (!body.lead_passenger?.trim()) errors.lead_passenger = 'Lead passenger name is required.';
  if (!body.contact_phone?.trim()) errors.contact_phone = 'Contact phone is required.';
  const pax = Number(body.passenger_count);
  if (!Number.isInteger(pax) || pax < 1 || pax > 12) errors.passenger_count = 'Enter the number of passengers (up to 12 — call us for larger groups).';
  if (type === 'airport' && setting('flight_number_required') === 'on' && !body.flight_number?.trim()) errors.flight_number = 'Flight number is required for airport transfers.';
  if (type === 'hourly' && !(Number(body.duration_hours) > 0)) errors.duration_hours = 'Requested duration is required for hourly hire.';
  else if (type === 'hourly' && !staff) {
    const minHours = Number(setting('hourly_min_hours') || 0);
    if (minHours && Number(body.duration_hours) < minHours) errors.duration_hours = `The minimum hire is ${minHours} hours.`;
  }
  const isReturn = type === 'return' || !!body.is_return;
  if (isReturn) {
    const back = new Date(body.return_pickup_at);
    if (!body.return_pickup_at || Number.isNaN(back.getTime())) errors.return_pickup_at = 'Return pickup time is required.';
    else if (!errors.pickup_at && back <= when) errors.return_pickup_at = 'Return pickup must be after the outbound pickup.';
  }
  for (const k of ['luggage_large', 'luggage_small']) {
    if (body[k] != null && (!Number.isInteger(Number(body[k])) || Number(body[k]) < 0 || Number(body[k]) > 12)) errors[k] = 'Enter a number from 0 to 12.';
  }
  if (body.child_seats != null && (!Number.isInteger(Number(body.child_seats)) || Number(body.child_seats) < 0 || Number(body.child_seats) > 4)) errors.child_seats = 'Enter a valid number.';
  if (Object.keys(errors).length) throw bad('Please complete the highlighted fields.', { fields: errors });
  return isReturn;
}

r.post('/', h((req, res) => {
  const u = req.user;
  if (u.role === 'driver') throw forbidden('Drivers cannot create bookings.');
  const body = req.body || {};
  const isReturn = validateRequest(body, isAdmin(u));

  let customerId = u.id;
  let organisationId = u.role === 'corporate' ? u.organisation_id : null;
  if (isAdmin(u)) {
    // Staff booking on behalf of a customer (BRD open question 15) — recorded in history.
    const c = get("SELECT * FROM users WHERE id = ? AND role IN ('customer','corporate') AND status = 'active'", body.customer_id);
    if (!c) throw bad('Choose an active customer for this booking.', { fields: { customer_id: 'Customer is required.' } });
    customerId = c.id;
    organisationId = c.role === 'corporate' ? c.organisation_id : null;
  }

  const estMinutes = body.journey_type === 'hourly' ? Math.round(Number(body.duration_hours) * 60) : null;
  const id = tx(() => {
    const bid = insert('bookings', {
      customer_id: customerId,
      organisation_id: organisationId,
      created_by: u.id,
      journey_type: body.journey_type,
      lead_passenger: body.lead_passenger.trim(),
      contact_phone: body.contact_phone.trim(),
      passenger_count: Number(body.passenger_count),
      passenger_names: body.passenger_names || null,
      luggage_large: Number(body.luggage_large || 0),
      luggage_small: Number(body.luggage_small || 0),
      child_seats: Number(body.child_seats || 0),
      accessibility_needs: body.accessibility_needs || null,
      special_instructions: body.special_instructions || null,
      sensitive_notes: body.sensitive_notes || null,
      preferred_category: body.preferred_category || null,
      flight_number: body.flight_number || null,
      duration_hours: body.journey_type === 'hourly' ? Number(body.duration_hours) : null,
      is_return: isReturn,
      payment_arrangement: organisationId ? 'corporate_account' : (setting('default_payment_arrangement') || 'pay_before'),
      status: 'pending',
    });
    run('UPDATE bookings SET ref = ? WHERE id = ?', nextRef(bid), bid);
    const stops = Array.isArray(body.stops) ? body.stops.map((s) => String(s).trim()).filter(Boolean).slice(0, 8) : [];
    insert('booking_legs', {
      booking_id: bid, leg_no: 1, label: isReturn ? 'Outbound' : 'Journey',
      pickup: body.pickup.trim(), destination: (body.destination || 'As directed').trim(),
      stops, pickup_at: new Date(body.pickup_at).toISOString(), est_minutes: estMinutes,
    });
    if (isReturn) {
      insert('booking_legs', {
        booking_id: bid, leg_no: 2, label: 'Return',
        pickup: (body.return_pickup || body.destination || body.pickup).trim(),
        destination: (body.return_destination || body.pickup).trim(),
        stops: [], pickup_at: new Date(body.return_pickup_at).toISOString(), est_minutes: estMinutes,
      });
    }
    audit({ bookingId: bid, entity: 'booking', entityId: bid, action: isAdmin(u) ? 'created_by_staff' : 'requested', actorId: u.id, detail: { status: 'pending' } });
    return bid;
  });

  const ref = nextRef(id);
  notify(customerId, {
    bookingId: id, event: 'request_received', email: true,
    title: `Request received · ${ref}`,
    body: 'Thank you for choosing Encore! A member of our team will review your journey details and provide a personalised quotation — please allow up to 24 hours during busier periods. Your booking is not yet confirmed.',
  });
  notifyAdmins({ bookingId: id, event: 'new_request', title: `New request ${ref}`, body: `${body.lead_passenger} · ${fmtWhen(body.pickup_at)} · ${body.pickup} → ${body.destination || 'As directed'}` });
  // Distance / drive time from Google Routes (best effort, does not block the request).
  refreshBookingRoutes(id).catch(() => {});
  res.status(201).json(bookingView(id, u));
}));

// ---------- edit details (management) ----------
const EDITABLE = ['journey_type', 'lead_passenger', 'contact_phone', 'passenger_count', 'passenger_names', 'luggage_large', 'luggage_small',
  'child_seats', 'accessibility_needs', 'special_instructions', 'sensitive_notes', 'preferred_category', 'flight_number', 'duration_hours',
  'internal_notes', 'payment_arrangement'];
const LEG_EDITABLE = ['pickup', 'destination', 'pickup_at', 'est_minutes', 'stops'];

r.patch('/:id', adminOnly, h(async (req, res) => {
  const b = loadBookingRow(Number(req.params.id), req.user);
  if (['closed'].includes(b.status)) throw conflict('Closed bookings cannot be edited.');
  const patch = {};
  const changes = {};
  const routeLegs = [];
  for (const k of EDITABLE) {
    if (k in req.body && req.body[k] !== b[k]) {
      if (k === 'payment_arrangement' && !PAYMENT_ARRANGEMENTS.includes(req.body[k])) throw bad('Unknown payment arrangement.');
      patch[k] = req.body[k] === '' ? null : req.body[k];
      changes[k] = { from: b[k], to: patch[k] };
    }
  }
  tx(() => {
    if (Object.keys(patch).length) update('bookings', b.id, { ...patch, updated_at: new Date().toISOString() });
    for (const legPatch of req.body.legs || []) {
      const leg = get('SELECT * FROM booking_legs WHERE id = ? AND booking_id = ?', legPatch.id, b.id);
      if (!leg) throw bad('Unknown journey leg.');
      const lp = {};
      for (const k of LEG_EDITABLE) {
        if (k in legPatch) {
          const val = k === 'pickup_at' ? new Date(legPatch[k]).toISOString() : legPatch[k];
          if (JSON.stringify(val) !== JSON.stringify(k === 'stops' ? JSON.parse(leg.stops) : leg[k])) {
            lp[k] = val;
            changes[`${leg.label}.${k}`] = { from: leg[k], to: val };
          }
        }
      }
      if (Object.keys(lp).length) {
        update('booking_legs', leg.id, lp);
        if (lp.pickup || lp.destination || lp.stops) routeLegs.push(leg.id);
      }
    }
    if (Object.keys(changes).length) audit({ bookingId: b.id, entity: 'booking', entityId: b.id, action: 'edited', detail: changes, actorId: req.user.id });
  });
  await Promise.all(routeLegs.map((id) => refreshLegRoute(id)));
  res.json(bookingView(b.id, req.user));
}));

// ---------- route distance / drive time (Google Routes) ----------
r.post('/:id/routes', adminOnly, h(async (req, res) => {
  const b = loadBookingRow(Number(req.params.id), req.user);
  if (!mapsEnabled()) throw conflict('Google Maps is not configured on the server.');
  await refreshBookingRoutes(b.id);
  res.json(bookingView(b.id, req.user));
}));

// ---------- review & clarification (ADM-1) ----------
r.post('/:id/review', adminOnly, h((req, res) => {
  const b = loadBookingRow(Number(req.params.id), req.user);
  if (!['pending', 'clarification_needed', 'change_requested'].includes(b.status)) throw conflict(`Booking is ${STATUS_LABEL[b.status]}.`);
  setStatus(b, 'under_review', req.user.id);
  res.json(bookingView(b.id, req.user));
}));

r.post('/:id/messages', h((req, res) => {
  const b = loadBookingRow(Number(req.params.id), req.user);
  if (req.user.role === 'driver') throw forbidden('Please contact the dispatcher directly.');
  const text = String(req.body.body || '').trim();
  if (!text) throw bad('Message cannot be empty.');
  const clarify = isAdmin(req.user) && req.body.request_clarification;
  tx(() => {
    insert('messages', { booking_id: b.id, author_id: req.user.id, body: text, kind: clarify ? 'clarification_request' : 'message' });
    if (clarify) {
      if (!PRE_CONFIRMATION.includes(b.status)) throw conflict('Clarification can only be requested before confirmation.');
      setStatus(b, 'clarification_needed', req.user.id);
    } else if (!isAdmin(req.user) && b.status === 'clarification_needed') {
      setStatus(b, 'under_review', req.user.id, 'customer replied to clarification');
    }
  });
  if (isAdmin(req.user)) {
    notify(b.customer_id, {
      bookingId: b.id, event: clarify ? 'clarification_requested' : 'message',
      title: clarify ? `More detail needed · ${b.ref}` : `Message from Encore · ${b.ref}`, body: text,
    });
  } else {
    notifyAdmins({ bookingId: b.id, event: 'customer_message', title: `Customer message · ${b.ref}`, body: text });
  }
  res.status(201).json(bookingView(b.id, req.user));
}));

// ---------- quotations (ADM-2 / CUS-3) ----------
r.post('/:id/quotes', adminOnly, h((req, res) => {
  const b = loadBookingRow(Number(req.params.id), req.user);
  if (!PRE_CONFIRMATION.includes(b.status)) throw conflict('Quotations can only be issued before confirmation.');
  const extras = (req.body.extras || []).filter((e) => e && e.label).map((e) => ({ label: String(e.label), amount: Number(e.amount) || 0 }));
  const reference = req.body.reference_price === '' || req.body.reference_price == null ? null : Number(req.body.reference_price);
  const computed = (reference || 0) + extras.reduce((s, e) => s + e.amount, 0);
  const total = req.body.total === '' || req.body.total == null ? computed : Number(req.body.total);
  if (!(total > 0)) throw bad('The final price must be greater than zero.', { fields: { total: 'Enter the final price.' } });
  const lines = (req.body.customer_lines || []).filter((l) => l && l.label).map((l) => ({ label: String(l.label), amount: Number(l.amount) || 0 }));
  const hours = Number(setting('quote_validity_hours')) || 48;
  const send = !!req.body.send;
  const qid = tx(() => {
    const version = (get('SELECT MAX(version) AS v FROM quotes WHERE booking_id = ?', b.id).v || 0) + 1;
    if (send) run("UPDATE quotes SET status = 'superseded' WHERE booking_id = ? AND status IN ('draft','sent','change_requested','accepted')", b.id);
    else run("UPDATE quotes SET status = 'superseded' WHERE booking_id = ? AND status = 'draft'", b.id);
    const id = insert('quotes', {
      booking_id: b.id, version, reference_price: reference, extras, customer_lines: lines.length ? lines : [{ label: 'Chauffeur journey', amount: total }],
      total, internal_notes: req.body.internal_notes || null, message_to_customer: req.body.message_to_customer || null,
      status: send ? 'sent' : 'draft', created_by: req.user.id,
      sent_at: send ? new Date().toISOString() : null,
      valid_until: send ? new Date(Date.now() + hours * 3600000).toISOString() : null,
    });
    audit({ bookingId: b.id, entity: 'quote', entityId: id, action: send ? 'quote_sent' : 'quote_drafted', detail: { version, reference_price: reference, extras, total }, actorId: req.user.id });
    if (send) setStatus(b, 'quote_sent', req.user.id);
    return id;
  });
  if (send) {
    notify(b.customer_id, {
      bookingId: b.id, event: 'quote_sent', email: true,
      title: `Your quotation is ready · ${b.ref}`,
      body: `Your tailored quotation is ${gbp(total)}. Please review and accept, decline or request a change in the app.`,
    });
  }
  res.status(201).json({ id: qid, booking: bookingView(b.id, req.user) });
}));

r.post('/:id/quotes/:qid/send', adminOnly, h((req, res) => {
  const b = loadBookingRow(Number(req.params.id), req.user);
  const q = get("SELECT * FROM quotes WHERE id = ? AND booking_id = ? AND status = 'draft'", req.params.qid, b.id);
  if (!q) throw conflict('Only a draft quotation can be sent.');
  if (!PRE_CONFIRMATION.includes(b.status)) throw conflict('Quotations can only be issued before confirmation.');
  const hours = Number(setting('quote_validity_hours')) || 48;
  tx(() => {
    run("UPDATE quotes SET status = 'superseded' WHERE booking_id = ? AND id != ? AND status IN ('sent','change_requested','accepted')", b.id, q.id);
    run("UPDATE quotes SET status='sent', sent_at=datetime('now'), valid_until=? WHERE id=?", new Date(Date.now() + hours * 3600000).toISOString(), q.id);
    audit({ bookingId: b.id, entity: 'quote', entityId: q.id, action: 'quote_sent', detail: { version: q.version, total: q.total }, actorId: req.user.id });
    setStatus(b, 'quote_sent', req.user.id);
  });
  notify(b.customer_id, { bookingId: b.id, event: 'quote_sent', email: true, title: `Your quotation is ready · ${b.ref}`, body: `Your tailored quotation is ${gbp(q.total)}. Please review it in the app.` });
  res.json(bookingView(b.id, req.user));
}));

r.post('/:id/quotes/:qid/respond', h((req, res) => {
  const u = req.user;
  if (!['customer', 'corporate'].includes(u.role)) throw forbidden('Only the customer can respond to a quotation.');
  const b = loadBookingRow(Number(req.params.id), u);
  const q = get('SELECT * FROM quotes WHERE id = ? AND booking_id = ?', req.params.qid, b.id);
  if (!q || q.status !== 'sent') throw conflict('This quotation is no longer open for a response. Please refresh.');
  if (b.status !== 'quote_sent') throw conflict('This booking is not awaiting a quotation response.');
  const action = req.body.action;
  const map = { accept: ['accepted', 'quote_accepted'], decline: ['declined', 'quote_declined'], change: ['change_requested', 'change_requested'] };
  if (!map[action]) throw bad('Choose accept, decline or request a change.');
  const note = String(req.body.note || '').trim();
  if (action === 'change' && !note) throw bad('Please tell us what you would like to change.', { fields: { note: 'Describe the change.' } });
  const [qs, bs] = map[action];
  tx(() => {
    run("UPDATE quotes SET status=?, customer_response_note=?, responded_at=datetime('now'), responded_by=? WHERE id=?", qs, note || null, u.id, q.id);
    if (note) insert('messages', { booking_id: b.id, author_id: u.id, body: note, kind: `quote_${action}` });
    audit({ bookingId: b.id, entity: 'quote', entityId: q.id, action: `quote_${qs}`, detail: note ? { note } : null, actorId: u.id });
    setStatus(b, bs, u.id);
  });
  const verb = { accept: 'accepted', decline: 'declined', change: 'requested a change to' }[action];
  notifyAdmins({ bookingId: b.id, event: 'quote_response', title: `Quote ${verb} · ${b.ref}`, body: note || `${u.name} ${verb} the quotation of ${gbp(q.total)}.` });
  res.json(bookingView(b.id, u));
}));

// ---------- confirmation / rejection (ADM-1) ----------
r.post('/:id/confirm', adminOnly, h((req, res) => {
  const b = loadBookingRow(Number(req.params.id), req.user);
  if (!PRE_CONFIRMATION.includes(b.status)) throw conflict(`Cannot confirm a booking that is ${STATUS_LABEL[b.status]}.`);
  const accepted = get("SELECT * FROM quotes WHERE booking_id = ? AND status = 'accepted' ORDER BY version DESC LIMIT 1", b.id);
  const reason = String(req.body.override_reason || '').trim();
  if (!accepted && !reason) {
    throw conflict('The customer has not accepted a quotation. Record why you are confirming without one (for example, terms agreed by phone).', { code: 'needs_override' });
  }
  if (req.body.payment_arrangement && !PAYMENT_ARRANGEMENTS.includes(req.body.payment_arrangement)) throw bad('Unknown payment arrangement.');
  // All-or-nothing: the confirmation, its history entry and status change commit together.
  tx(() => {
    update('bookings', b.id, {
      status: 'confirmed', confirmed_by: req.user.id, confirmed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      ...(req.body.payment_arrangement ? { payment_arrangement: req.body.payment_arrangement } : {}),
    });
    audit({ bookingId: b.id, entity: 'booking', entityId: b.id, action: 'confirmed', detail: { from: b.status, quote_version: accepted?.version ?? null, override_reason: reason || null, payment_arrangement: req.body.payment_arrangement || b.payment_arrangement }, actorId: req.user.id });
  });
  const legs = legsFor(b.id);
  notify(b.customer_id, {
    bookingId: b.id, event: 'booking_confirmed', email: true,
    title: `Booking confirmed · ${b.ref}`,
    body: `Your journey on ${fmtWhen(legs[0].pickup_at)} is confirmed${accepted ? ` at ${gbp(accepted.total)}` : ''}. We will share your chauffeur and vehicle registration once assigned.`,
  });
  res.json(bookingView(b.id, req.user));
}));

r.post('/:id/reject', adminOnly, h((req, res) => {
  const b = loadBookingRow(Number(req.params.id), req.user);
  if (!PRE_CONFIRMATION.includes(b.status) && b.status !== 'quote_declined') throw conflict('Only unconfirmed requests can be rejected. Use cancel for confirmed bookings.');
  const reason = String(req.body.reason || '').trim();
  tx(() => {
    run("UPDATE quotes SET status='superseded' WHERE booking_id=? AND status IN ('draft','sent')", b.id);
    setStatus(b, 'rejected', req.user.id, reason || null);
  });
  notify(b.customer_id, { bookingId: b.id, event: 'request_rejected', title: `Request update · ${b.ref}`, body: reason || 'Unfortunately we are unable to accept this journey request. Please contact us to discuss alternatives.' });
  res.json(bookingView(b.id, req.user));
}));

// ---------- assignment (ADM-4 / ADM-5) ----------
r.get('/:id/legs/:legId/options', adminOnly, h((req, res) => {
  const b = loadBookingRow(Number(req.params.id), req.user);
  const leg = get('SELECT * FROM booking_legs WHERE id = ? AND booking_id = ?', req.params.legId, b.id);
  if (!leg) throw bad('Unknown leg.');
  const bags = b.luggage_large + Math.ceil(b.luggage_small / 2);
  const vehicles = all("SELECT * FROM vehicles WHERE status != 'retired' ORDER BY category, registration").map((v) => {
    const notes = [];
    if (v.seats < b.passenger_count) notes.push(`Only ${v.seats} seats for ${b.passenger_count} passengers`);
    if (v.luggage_capacity < bags) notes.push(`Luggage capacity ${v.luggage_capacity} for ~${bags} cases`);
    if (b.child_seats > 0 && !v.child_seat_capable) notes.push('Not fitted for child seats');
    if (b.accessibility_needs && !v.accessible) notes.push('Not marked accessible');
    if (b.preferred_category && v.category !== b.preferred_category) notes.push(`Customer preferred ${b.preferred_category}`);
    return { ...v, suitability: notes, assignable: v.status === 'available', conflicts: findConflicts(leg, null, v.id) };
  });
  const drivers = all("SELECT id, name, phone, driver_availability, driver_type, access_expires_at FROM users WHERE role = 'driver' AND status = 'active' ORDER BY driver_type, name")
    .map((d) => ({ ...d, assignable: d.driver_availability === 'available' && !(d.access_expires_at && new Date(d.access_expires_at) < new Date(leg.pickup_at)), conflicts: findConflicts(leg, d.id, null) }));
  const operators = all('SELECT * FROM external_operators WHERE active = 1 ORDER BY name');
  res.json({ vehicles, drivers, operators });
}));

r.post('/:id/legs/:legId/assign', adminOnly, h((req, res) => {
  const b = loadBookingRow(Number(req.params.id), req.user);
  if (!['confirmed', 'driver_assigned', ...DELIVERY].includes(b.status)) throw conflict('Only confirmed bookings can be assigned. Confirm the booking first.');
  const leg = get('SELECT * FROM booking_legs WHERE id = ? AND booking_id = ?', req.params.legId, b.id);
  if (!leg) throw bad('Unknown leg.');
  if (leg.status === 'completed') throw conflict('This leg is already completed.');
  if (paymentBlocks(b, 'assignment')) {
    throw conflict('Payment is outstanding for this pay-before booking. Record the payment, or change the payment arrangement to "pay after" to allow an exception.', { code: 'payment_outstanding' });
  }
  const { driver_id, vehicle_id, external_operator_id, external_vehicle_reg, external_driver_name } = req.body;
  const override = String(req.body.override_reason || '').trim();
  let patch;

  if (external_operator_id) {
    const op = get('SELECT * FROM external_operators WHERE id = ? AND active = 1', external_operator_id);
    if (!op) throw bad('Choose an active external operator.');
    patch = { driver_id: null, vehicle_id: null, external_operator_id: op.id, external_vehicle_reg: external_vehicle_reg || null, external_driver_name: external_driver_name || null };
  } else {
    const driver = get("SELECT * FROM users WHERE id = ? AND role = 'driver' AND status = 'active'", driver_id);
    const vehicle = get('SELECT * FROM vehicles WHERE id = ?', vehicle_id);
    if (!driver || !vehicle) throw bad('Choose both a driver and a vehicle.');
    if (vehicle.status !== 'available') throw conflict(`Vehicle ${vehicle.registration} is ${vehicle.status} and cannot be assigned.`);
    if (driver.driver_availability !== 'available') throw conflict(`${driver.name} is marked unavailable.`);
    if (driver.access_expires_at && new Date(driver.access_expires_at) < new Date(leg.pickup_at)) throw conflict(`${driver.name}'s temporary access ends before this pickup. Extend it first.`);
    const clashes = findConflicts(leg, driver.id, vehicle.id);
    if (clashes.length && !override) {
      throw conflict('This assignment overlaps another confirmed journey.', { code: 'assignment_conflict', conflicts: clashes });
    }
    patch = { driver_id: driver.id, vehicle_id: vehicle.id, external_operator_id: null, external_vehicle_reg: null, external_driver_name: null, conflict_override_reason: clashes.length ? override : null };
  }

  const previousDriver = leg.driver_id;
  tx(() => {
    update('booking_legs', leg.id, { ...patch, status: DELIVERY.includes(leg.status) ? leg.status : 'assigned', driver_accepted_at: patch.driver_id && patch.driver_id === previousDriver ? leg.driver_accepted_at : null });
    audit({
      bookingId: b.id, entity: 'leg', entityId: leg.id, action: leg.status === 'unassigned' ? 'assigned' : 'reassigned',
      detail: { leg: leg.label, ...patch, previous_driver_id: previousDriver, previous_vehicle_id: leg.vehicle_id }, actorId: req.user.id,
    });
    deriveDeliveryStatus(b.id);
  });

  const fresh = legsFor(b.id).find((l) => l.id === leg.id);
  const reg = fresh.vehicle_registration || fresh.external_vehicle_reg;
  notify(b.customer_id, {
    bookingId: b.id, event: 'driver_assigned',
    title: `Chauffeur assigned · ${b.ref}`,
    body: `${fresh.label} on ${fmtWhen(fresh.pickup_at)}: ${fresh.vehicle_make ? `${fresh.vehicle_colour || ''} ${fresh.vehicle_make} ${fresh.vehicle_model}`.trim() + ', ' : ''}registration ${reg || 'to be confirmed'}.`,
  });
  if (patch.driver_id) {
    notify(patch.driver_id, { bookingId: b.id, event: 'job_assigned', title: `New assignment · ${b.ref}`, body: `${fresh.label}: ${fmtWhen(fresh.pickup_at)} from ${fresh.pickup}.` });
  }
  if (previousDriver && previousDriver !== patch.driver_id) {
    notify(previousDriver, { bookingId: b.id, event: 'job_unassigned', title: `Assignment changed · ${b.ref}`, body: `You are no longer assigned to ${fresh.label} on ${fmtWhen(fresh.pickup_at)}.` });
  }
  res.json(bookingView(b.id, req.user));
}));

r.post('/:id/legs/:legId/unassign', adminOnly, h((req, res) => {
  const b = loadBookingRow(Number(req.params.id), req.user);
  const leg = get('SELECT * FROM booking_legs WHERE id = ? AND booking_id = ?', req.params.legId, b.id);
  if (!leg || leg.status !== 'assigned') throw conflict('Only an assigned leg that has not started can be unassigned.');
  tx(() => {
    update('booking_legs', leg.id, { driver_id: null, vehicle_id: null, external_operator_id: null, external_vehicle_reg: null, external_driver_name: null, status: 'unassigned', conflict_override_reason: null, driver_accepted_at: null });
    audit({ bookingId: b.id, entity: 'leg', entityId: leg.id, action: 'unassigned', detail: { leg: leg.label, driver_id: leg.driver_id, vehicle_id: leg.vehicle_id }, actorId: req.user.id });
    deriveDeliveryStatus(b.id);
  });
  if (leg.driver_id) notify(leg.driver_id, { bookingId: b.id, event: 'job_unassigned', title: `Assignment removed · ${b.ref}`, body: `${leg.label} on ${fmtWhen(leg.pickup_at)} has been removed from your schedule.` });
  res.json(bookingView(b.id, req.user));
}));

// ---------- driver accepts or declines an assignment ----------
r.post('/:id/legs/:legId/respond', h((req, res) => {
  const u = req.user;
  const b = loadBookingRow(Number(req.params.id), u);
  const leg = legsFor(b.id).find((l) => l.id === Number(req.params.legId));
  if (!leg) throw bad('Unknown leg.');
  if (u.role !== 'driver' || leg.driver_id !== u.id) throw forbidden('You can only respond to journeys assigned to you.');
  if (leg.status !== 'assigned') throw conflict('This journey is already under way.');
  const accept = req.body.accept === true;
  if (accept) {
    if (leg.driver_accepted_at) return res.json(bookingView(b.id, u));
    tx(() => {
      update('booking_legs', leg.id, { driver_accepted_at: new Date().toISOString() });
      audit({ bookingId: b.id, entity: 'leg', entityId: leg.id, action: 'driver_accepted', detail: { leg: leg.label }, actorId: u.id });
    });
    notify(b.customer_id, { bookingId: b.id, event: 'driver_accepted', title: `Your chauffeur is confirmed · ${b.ref}`, body: `${u.name.split(' ')[0]} will drive you on ${fmtWhen(leg.pickup_at)}.` });
    notifyAdmins({ bookingId: b.id, event: 'driver_accepted', title: `${u.name} accepted ${b.ref}`, body: `${leg.label} · ${fmtWhen(leg.pickup_at)}.` });
  } else {
    const reason = String(req.body.reason || '').trim();
    tx(() => {
      update('booking_legs', leg.id, { driver_id: null, vehicle_id: null, status: 'unassigned', driver_accepted_at: null, conflict_override_reason: null });
      audit({ bookingId: b.id, entity: 'leg', entityId: leg.id, action: 'driver_declined', detail: { leg: leg.label, reason: reason || null }, actorId: u.id });
      deriveDeliveryStatus(b.id);
    });
    notifyAdmins({ bookingId: b.id, event: 'driver_declined', title: `${u.name} declined ${b.ref} — reassign`, body: `${leg.label} · ${fmtWhen(leg.pickup_at)}${reason ? `. Reason: ${reason}` : ''}.` });
    return res.json({ declined: true });
  }
  res.json(bookingView(b.id, u));
}));

// ---------- journey status (DRV-2) ----------
const STATUS_MESSAGES = {
  on_the_way: ['driver_on_the_way', 'Your chauffeur is on the way', (leg) => `Your chauffeur is on the way to ${leg.pickup}.`],
  arrived: ['driver_arrived', 'Your chauffeur has arrived', (leg) => `Your chauffeur has arrived at ${leg.pickup}${leg.vehicle_registration ? ` in ${leg.vehicle_registration}` : ''}.`],
  started: ['journey_started', 'Journey started', () => 'Your journey is under way. Enjoy the ride.'],
  completed: ['journey_completed', 'Journey completed', () => 'Thank you for travelling with Encore Executive.'],
};

r.post('/:id/legs/:legId/status', h((req, res) => {
  const u = req.user;
  const b = loadBookingRow(Number(req.params.id), u);
  const leg = get('SELECT * FROM booking_legs WHERE id = ? AND booking_id = ?', req.params.legId, b.id);
  if (!leg) throw bad('Unknown leg.');
  const target = req.body.status;
  const adminOverride = isAdmin(u);
  if (!adminOverride) {
    if (u.role !== 'driver' || leg.driver_id !== u.id) throw forbidden('You can only update journeys assigned to you.');
  }
  if (!['on_the_way', 'arrived', 'started', 'completed', ...(adminOverride ? ['assigned'] : [])].includes(target)) throw bad('Unknown status.');
  if (b.status.startsWith('cancelled') || TERMINAL.includes(b.status)) throw conflict('This booking has been cancelled or closed. Please contact the dispatcher.');
  if (!['confirmed', 'driver_assigned', ...DELIVERY, 'completed'].includes(b.status)) throw conflict('This booking is not confirmed.');
  if (leg.status === 'unassigned') throw conflict('This leg has no assignment yet.');

  // Duplicate press: state already reached — report the truth, change nothing.
  if (leg.status === target) return res.json({ unchanged: true, booking: bookingView(b.id, u) });

  if (!adminOverride && leg.status === 'assigned' && target === 'on_the_way') {
    if (paymentBlocks(b, 'start')) throw conflict('Payment for this journey is still outstanding. Please contact the dispatcher before setting off.', { code: 'payment_outstanding' });
    const opensAt = startAvailableAt(leg);
    if (opensAt && Date.now() < new Date(opensAt).getTime()) {
      throw conflict(`You can start this journey from ${fmtWhen(opensAt)} (${setting('start_window_minutes')} minutes before pickup).`, { code: 'too_early', opens_at: opensAt });
    }
  }

  const from = LEG_FLOW.indexOf(leg.status);
  const to = LEG_FLOW.indexOf(target);
  if (!adminOverride && to !== from + 1) {
    throw conflict(`Status is currently "${leg.status.replace(/_/g, ' ')}". Please press the next step in order.`, { current: leg.status });
  }
  const reason = String(req.body.reason || '').trim();
  if (adminOverride && to < from && !reason) throw bad('Give a reason when moving a status backwards.');

  // Journey Distance Exceeded (feature 3): the driver records the actual distance driven
  // when completing the journey. Miles are converted to metres to compare against the
  // accepted route distance already stored on the leg (from Google Routes at confirm time).
  let actualDistanceM = null;
  if (target === 'completed') {
    const miles = req.body.actual_distance_mi;
    if (miles != null && miles !== '') {
      const n = Number(miles);
      if (!Number.isFinite(n) || n < 0 || n > 2000) throw bad('Enter the actual distance driven, in miles.', { fields: { actual_distance_mi: 'Enter a valid distance in miles.' } });
      actualDistanceM = Math.round(n * 1609.344);
    }
  }

  tx(() => {
    const patch = { status: target };
    if (!leg.driver_accepted_at && to > from) patch.driver_accepted_at = new Date().toISOString();
    if (LEG_TIMESTAMP[target]) patch[LEG_TIMESTAMP[target]] = new Date().toISOString();
    if (actualDistanceM != null) patch.actual_distance_m = actualDistanceM;
    // When moving backwards, clear later timestamps so history stays truthful.
    for (const s of LEG_FLOW.slice(to + 1)) if (LEG_TIMESTAMP[s]) patch[LEG_TIMESTAMP[s]] = null;
    update('booking_legs', leg.id, patch);
    audit({ bookingId: b.id, entity: 'leg', entityId: leg.id, action: adminOverride ? 'status_override' : 'status_update', detail: { leg: leg.label, from: leg.status, to: target, reason: reason || null, actual_distance_m: actualDistanceM }, actorId: u.id });
    deriveDeliveryStatus(b.id);
  });

  const msg = STATUS_MESSAGES[target];
  if (msg && to > from) {
    const fresh = legsFor(b.id).find((l) => l.id === leg.id);
    notify(b.customer_id, { bookingId: b.id, event: msg[0], title: `${msg[1]} · ${b.ref}`, body: msg[2](fresh) });
    if (!adminOverride) notifyAdmins({ bookingId: b.id, event: msg[0], title: `${b.ref} · ${target.replace(/_/g, ' ')}`, body: `${fresh.driver_name || 'Chauffeur'} — ${fresh.label}.` });
    if (target === 'completed') checkDistanceExceeded(b, fresh);
  }
  res.json({ unchanged: false, booking: bookingView(b.id, u) });
}));

/** Notify the admin once if a completed journey's actual distance exceeds its accepted distance. */
function checkDistanceExceeded(b, leg) {
  if (leg.distance_exceeded_notified_at) return;
  if (leg.actual_distance_m == null || leg.distance_m == null) return;
  if (leg.actual_distance_m <= leg.distance_m) return;
  const extraMi = (leg.actual_distance_m - leg.distance_m) / 1609.344;
  update('booking_legs', leg.id, { distance_exceeded_notified_at: new Date().toISOString() });
  notifyAdmins({
    bookingId: b.id, event: 'journey_distance_exceeded',
    title: `Journey Distance Exceeded · ${b.ref}`,
    body: `${leg.label}: accepted ${(leg.distance_m / 1609.344).toFixed(1)} mi, actual ${(leg.actual_distance_m / 1609.344).toFixed(1)} mi — ${extraMi.toFixed(1)} mi over.`,
  });
  audit({ bookingId: b.id, entity: 'leg', entityId: leg.id, action: 'distance_exceeded_alert', detail: { accepted_m: leg.distance_m, actual_m: leg.actual_distance_m, extra_m: leg.actual_distance_m - leg.distance_m } });
}

// ---------- cancellation (CUS-4) ----------
r.post('/:id/cancel', h((req, res) => {
  const u = req.user;
  const b = loadBookingRow(Number(req.params.id), u);
  if (u.role === 'driver') throw forbidden();
  const reason = String(req.body.reason || '').trim();
  const legs = legsFor(b.id);
  if (isAdmin(u)) {
    if (['closed', 'cancelled_customer', 'cancelled_management'].includes(b.status)) throw conflict('Booking is already closed or cancelled.');
    if (!reason) throw bad('Enter a cancellation reason.');
  } else if (!customerMayCancel(b, legs)) {
    throw conflict('Your chauffeur is already on the way, so this booking can no longer be cancelled online. Please call Encore Executive.', { code: 'cancel_blocked' });
  }
  const status = isAdmin(u) ? 'cancelled_management' : 'cancelled_customer';
  tx(() => {
    // Re-check inside the transaction: the authoritative current state decides.
    const now = legsFor(b.id);
    if (!isAdmin(u) && !customerMayCancel(get('SELECT * FROM bookings WHERE id = ?', b.id), now)) {
      throw conflict('Your chauffeur has just set off. Please call Encore Executive.', { code: 'cancel_blocked' });
    }
    update('bookings', b.id, { status, cancel_reason: reason || null, cancelled_by: u.id, cancelled_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    run("UPDATE quotes SET status='superseded' WHERE booking_id=? AND status IN ('draft','sent')", b.id);
    audit({ bookingId: b.id, entity: 'booking', entityId: b.id, action: 'cancelled', detail: { from: b.status, to: status, reason: reason || null }, actorId: u.id });
  });
  for (const l of legs) {
    if (l.driver_id && l.status !== 'completed') notify(l.driver_id, { bookingId: b.id, event: 'job_cancelled', title: `Journey cancelled · ${b.ref}`, body: `${l.label} on ${fmtWhen(l.pickup_at)} has been cancelled.` });
  }
  if (isAdmin(u)) notify(b.customer_id, { bookingId: b.id, event: 'booking_cancelled', title: `Booking cancelled · ${b.ref}`, body: reason });
  else notifyAdmins({ bookingId: b.id, event: 'customer_cancelled', title: `Customer cancelled ${b.ref}`, body: reason || 'No reason given.' });
  res.json(bookingView(b.id, u));
}));

// ---------- management status override / close ----------
r.post('/:id/status', adminOnly, h((req, res) => {
  const b = loadBookingRow(Number(req.params.id), req.user);
  const target = req.body.status;
  if (!BOOKING_STATUSES.includes(target)) throw bad('Unknown status.');
  const reason = String(req.body.reason || '').trim();
  if (!reason) throw bad('Give a reason for the status override.');
  if (target === 'closed' && !['completed', 'no_show', 'cancelled_management', 'cancelled_customer'].includes(b.status)) {
    throw conflict('Only completed, no-show or cancelled bookings can be closed.');
  }
  tx(() => {
    update('bookings', b.id, { status: target, updated_at: new Date().toISOString(), ...(target === 'closed' ? { closed_at: new Date().toISOString() } : {}) });
    audit({ bookingId: b.id, entity: 'booking', entityId: b.id, action: 'status_override', detail: { from: b.status, to: target, reason }, actorId: req.user.id });
  });
  res.json(bookingView(b.id, req.user));
}));

r.post('/:id/close', adminOnly, h((req, res) => {
  const b = loadBookingRow(Number(req.params.id), req.user);
  if (!['completed', 'no_show', 'cancelled_customer', 'cancelled_management'].includes(b.status)) throw conflict('Only completed, no-show or cancelled bookings can be closed.');
  if (!['paid', 'invoiced'].includes(b.payment_status) && !req.body.allow_unpaid) {
    throw conflict('Payment is not recorded as paid or invoiced. Close anyway?', { code: 'unpaid' });
  }
  tx(() => {
    update('bookings', b.id, { status: 'closed', closed_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    audit({ bookingId: b.id, entity: 'booking', entityId: b.id, action: 'closed', detail: { payment_status: b.payment_status, closed_unpaid: !['paid', 'invoiced'].includes(b.payment_status) }, actorId: req.user.id });
  });
  res.json(bookingView(b.id, req.user));
}));

// ---------- payments (ADM-6) ----------
r.post('/:id/payment-link', adminOnly, h((req, res) => {
  const b = loadBookingRow(Number(req.params.id), req.user);
  const url = String(req.body.url || '').trim();
  if (!/^https:\/\//i.test(url)) throw bad('Enter the secure (https) payment link from your payment provider.');
  tx(() => {
    update('bookings', b.id, { payment_link: url });
    audit({ bookingId: b.id, entity: 'payment', entityId: b.id, action: 'payment_link_sent', detail: { url }, actorId: req.user.id });
    recomputePaymentStatus(b.id);
  });
  const total = (b && get("SELECT total FROM quotes WHERE booking_id=? AND status='accepted' ORDER BY version DESC LIMIT 1", b.id))?.total;
  notify(b.customer_id, { bookingId: b.id, event: 'payment_link', title: `Payment link · ${b.ref}`, body: `${total ? `Amount due ${gbp(total)}. ` : ''}Pay securely via the link in your booking. Card details are handled only by our payment provider.` });
  res.json(bookingView(b.id, req.user));
}));

r.post('/:id/payments', adminOnly, h((req, res) => {
  const b = loadBookingRow(Number(req.params.id), req.user);
  const amount = Number(req.body.amount);
  if (!(amount > 0)) throw bad('Enter the amount.');
  const kind = ['payment', 'deposit', 'refund'].includes(req.body.kind) ? req.body.kind : 'payment';
  const method = ['card_link', 'card_terminal', 'cash', 'bank_transfer', 'external', 'invoice'].includes(req.body.method) ? req.body.method : 'external';
  const outcome = req.body.outcome === 'failed' ? 'failed' : 'succeeded';
  tx(() => {
    const id = insert('payments', { booking_id: b.id, amount, kind, method, outcome, reference: req.body.reference || null, note: req.body.note || null, recorded_by: req.user.id });
    audit({ bookingId: b.id, entity: 'payment', entityId: id, action: outcome === 'failed' ? 'payment_failed' : `${kind}_recorded`, detail: { amount, method, reference: req.body.reference || null }, actorId: req.user.id });
    recomputePaymentStatus(b.id);
  });
  res.status(201).json(bookingView(b.id, req.user));
}));

r.post('/:id/payment-status', adminOnly, h((req, res) => {
  const b = loadBookingRow(Number(req.params.id), req.user);
  if (!PAYMENT_STATUSES.includes(req.body.payment_status)) throw bad('Unknown payment status.');
  const reason = String(req.body.reason || '').trim();
  if (!reason) throw bad('Give a reason for overriding the payment status.');
  tx(() => {
    update('bookings', b.id, { payment_status: req.body.payment_status });
    audit({ bookingId: b.id, entity: 'payment', entityId: b.id, action: 'payment_status_override', detail: { from: b.payment_status, to: req.body.payment_status, reason }, actorId: req.user.id });
  });
  res.json(bookingView(b.id, req.user));
}));

function setStatus(b, status, actorId, reason = null) {
  update('bookings', b.id, { status, updated_at: new Date().toISOString() });
  audit({ bookingId: b.id, entity: 'booking', entityId: b.id, action: 'status_change', detail: { from: b.status, to: status, ...(reason ? { reason } : {}) }, actorId });
  b.status = status;
}

export default r;
