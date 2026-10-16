import { db, insert, run, tx } from './db.js';
import { hashPassword } from './lib.js';
import { nextRef } from './domain.js';

export const DEMO_PASSWORD = 'Encore2026!';

const TABLES = ['notification_deliveries', 'notifications', 'audit_log', 'invoice_items', 'invoices', 'payments', 'messages',
  'quotes', 'booking_legs', 'bookings', 'invitations', 'external_operators', 'vehicles', 'users', 'organisations'];

export function seed({ reset = false } = {}) {
  tx(() => {
    if (reset) for (const t of TABLES) run(`DELETE FROM ${t}`);
    const pw = hashPassword(DEMO_PASSWORD);

    const org = insert('organisations', { name: 'Hallam Partners LLP', billing_email: 'accounts@hallam.example', billing_address: '1 Market Square, Stafford ST16 2AA', payment_terms: 'Monthly consolidated invoice, 30 days' });

    const admin = insert('users', { email: 'admin@encore.test', password_hash: pw, name: 'Asma (Management)', phone: '+447700900001', role: 'admin' });
    const d1 = insert('users', { email: 'james@encore.test', password_hash: pw, name: 'James Whitmore', phone: '+447700900101', role: 'driver', licence_number: 'WHITM801234JW9AB' });
    const d2 = insert('users', { email: 'oliver@encore.test', password_hash: pw, name: 'Oliver Grant', phone: '+447700900102', role: 'driver', licence_number: 'GRANT902345OG8CD' });
    insert('users', { email: 'daniel@encore.test', password_hash: pw, name: 'Daniel Price', phone: '+447700900103', role: 'driver', driver_availability: 'unavailable' });
    const cust = insert('users', { email: 'customer@encore.test', password_hash: pw, name: 'Charlotte Bennett', phone: '+447700900201', role: 'customer' });
    const corp = insert('users', { email: 'corporate@encore.test', password_hash: pw, name: 'Mark Hallam', phone: '+447700900301', role: 'corporate', organisation_id: org });
    insert('users', { email: 'pending@encore.test', password_hash: pw, name: 'Priya Shah', phone: '+447700900401', role: 'customer', status: 'pending', notes: 'Registered via website' });

    const veh = (registration, make, model, colour, category, seats, luggage, extra = {}) =>
      insert('vehicles', { registration, make, model, colour, category, seats, luggage_capacity: luggage, ...extra });
    const v1 = veh('EN24 COR', 'Mercedes-Benz', 'S-Class', 'Obsidian Black', 'Luxury Saloon', 3, 2);
    const v2 = veh('EN23 EXE', 'Mercedes-Benz', 'E-Class', 'Black', 'Executive Saloon', 3, 2);
    const v3 = veh('EN24 VCL', 'Mercedes-Benz', 'V-Class', 'Black', 'Executive MPV (7-seat)', 7, 7, { accessible: 1 });
    veh('EN22 RRS', 'Range Rover', 'Sport', 'Santorini Black', 'Luxury SUV', 4, 4);
    veh('EN21 BMW', 'BMW', '7 Series', 'Carbon Black', 'Luxury Saloon', 3, 2, { status: 'unavailable', notes: 'In for service' });
    insert('external_operators', { name: 'Midlands Prestige Cars', contact_name: 'Sam Patel', phone: '+441216000000', email: 'bookings@midlandsprestige.example', notes: 'Trusted cover, Birmingham-based' });

    // Demo times are UK wall-clock (BST, UTC+1) regardless of the server's timezone.
    const at = (days, hour, min = 0) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + days); d.setUTCHours(hour - 1, min, 0, 0); return d.toISOString(); };
    const booking = (fields, legs) => {
      const id = insert('bookings', { contact_phone: '+447700900201', passenger_count: 1, ...fields });
      run('UPDATE bookings SET ref = ? WHERE id = ?', nextRef(id), id);
      legs.forEach((l, i) => insert('booking_legs', { booking_id: id, leg_no: i + 1, label: legs.length > 1 ? (i ? 'Return' : 'Outbound') : 'Journey', stops: [], ...l }));
      insert('audit_log', { booking_id: id, entity: 'booking', entity_id: id, action: 'requested', actor_id: fields.customer_id, detail: '{"status":"pending"}' });
      return id;
    };
    const quote = (bid, total, status, extras = []) => insert('quotes', {
      booking_id: bid, version: 1, reference_price: total - extras.reduce((s, e) => s + e.amount, 0), extras,
      customer_lines: [{ label: 'Chauffeur journey', amount: total }], total, status, created_by: admin,
      sent_at: new Date().toISOString(), valid_until: at(2, 23),
      responded_at: ['accepted', 'declined'].includes(status) ? new Date().toISOString() : null,
    });

    // 1. New pending request
    booking({ customer_id: cust, created_by: cust, journey_type: 'airport', lead_passenger: 'Charlotte Bennett', passenger_count: 2, luggage_large: 3, luggage_small: 2, flight_number: 'BA1427', special_instructions: 'Meet in arrivals with name board, please.', preferred_category: 'Luxury Saloon' },
      [{ pickup: 'Manchester Airport (MAN), Terminal 1', destination: 'The Mount, Newcastle-under-Lyme ST5', pickup_at: at(3, 14, 30) }]);

    // 2. Quote sent, awaiting customer
    const b2 = booking({ customer_id: cust, created_by: cust, journey_type: 'return', is_return: 1, status: 'quote_sent', lead_passenger: 'Charlotte Bennett', passenger_count: 2, luggage_small: 1 },
      [{ pickup: 'Trentham Estate, Stoke-on-Trent ST4 8JG', destination: 'The Ivy, Birmingham B3 2HJ', pickup_at: at(5, 18) },
        { pickup: 'The Ivy, Birmingham B3 2HJ', destination: 'Trentham Estate, Stoke-on-Trent ST4 8JG', pickup_at: at(5, 23) }]);
    quote(b2, 340, 'sent', [{ label: 'Waiting time (evening)', amount: 60 }]);

    // 3. Corporate, accepted, needs confirmation
    const b3 = booking({ customer_id: corp, organisation_id: org, created_by: corp, journey_type: 'corporate', status: 'quote_accepted', lead_passenger: 'Helen Carter (guest)', contact_phone: '+447700900555', passenger_count: 1, luggage_large: 1, payment_arrangement: 'corporate_account' },
      [{ pickup: 'Stafford Railway Station ST16 2AE', destination: 'One Canada Square, London E14', pickup_at: at(1, 7) }]);
    quote(b3, 420, 'accepted');

    // 4. Confirmed and assigned (today, for the driver demo)
    const b4 = booking({ customer_id: cust, created_by: cust, journey_type: 'point_to_point', status: 'driver_assigned', lead_passenger: 'Charlotte Bennett', passenger_count: 1, confirmed_by: admin, confirmed_at: new Date().toISOString(), payment_arrangement: 'pay_after', sensitive_notes: 'Passenger uses a walking stick — assist to the door.' },
      [{ pickup: 'Keele University, Newcastle ST5 5BG', destination: 'Birmingham Airport (BHX)', pickup_at: at(0, 23, 30), driver_id: d1, vehicle_id: v1, status: 'assigned' }]);
    quote(b4, 165, 'accepted');

    // 5. Completed corporate journey, awaiting invoice
    const b5 = booking({ customer_id: corp, organisation_id: org, created_by: corp, journey_type: 'event', status: 'completed', lead_passenger: 'Mark Hallam', passenger_count: 5, luggage_small: 2, payment_arrangement: 'corporate_account', confirmed_by: admin, confirmed_at: at(-3, 9) },
      [{ pickup: 'Hallam Partners, Stafford ST16 2AA', destination: 'Royal Albert Hall, London SW7', pickup_at: at(-2, 15), driver_id: d2, vehicle_id: v3, status: 'completed', on_the_way_at: at(-2, 14, 30), arrived_at: at(-2, 14, 55), started_at: at(-2, 15, 5), completed_at: at(-2, 18, 20) }]);
    quote(b5, 680, 'accepted');

    // 6. Completed private, paid & closed
    const b6 = booking({ customer_id: cust, created_by: cust, journey_type: 'point_to_point', status: 'closed', lead_passenger: 'Charlotte Bennett', payment_arrangement: 'pay_before', payment_status: 'paid', confirmed_by: admin, confirmed_at: at(-9, 9), closed_at: at(-6, 9) },
      [{ pickup: 'Stoke-on-Trent Station ST4 2AA', destination: 'Chester Grosvenor Hotel CH1 1LT', pickup_at: at(-7, 10), driver_id: d1, vehicle_id: v2, status: 'completed', completed_at: at(-7, 11, 30) }]);
    quote(b6, 145, 'accepted');
    insert('payments', { booking_id: b6, amount: 145, kind: 'payment', method: 'card_link', reference: 'SUMUP-82731', recorded_by: admin });
  });
  console.log(`[encore] demo data loaded — password for all demo accounts: ${DEMO_PASSWORD}`);
}

if (process.argv[1] && process.argv[1].endsWith('seed.js')) {
  seed({ reset: process.argv.includes('--reset') });
  db.close();
}

