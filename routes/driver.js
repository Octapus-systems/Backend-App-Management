import { Router } from 'express';
import { all } from '../db.js';
import { h } from '../lib.js';
import { navigationUrl } from '../domain.js';

const r = Router();

/** Driver's own legs only (DRV-1). No prices, payments or customer account data. */
r.get('/legs', h((req, res) => {
  const rows = all(`
    SELECT l.id, l.booking_id, l.leg_no, l.label, l.pickup, l.destination, l.stops, l.pickup_at, l.status, l.completed_at, l.driver_accepted_at,
      b.ref, b.status AS booking_status, b.journey_type, b.lead_passenger, b.passenger_count, b.luggage_large, b.luggage_small,
      b.child_seats, b.accessibility_needs, b.flight_number,
      (SELECT COUNT(*) FROM booking_legs x WHERE x.booking_id = b.id) AS leg_count,
      v.registration AS vehicle_registration, v.make AS vehicle_make, v.model AS vehicle_model
    FROM booking_legs l JOIN bookings b ON b.id = l.booking_id LEFT JOIN vehicles v ON v.id = l.vehicle_id
    WHERE l.driver_id = ? AND b.status NOT IN ('rejected','expired','quote_declined')
      AND (l.status != 'completed' OR datetime(l.completed_at) > datetime('now','-7 days'))
    ORDER BY l.pickup_at`, req.user.id);
  res.json(rows.map((l) => ({ ...l, stops: JSON.parse(l.stops || '[]'), navigation_url: navigationUrl(l) })));
}));

export default r;
