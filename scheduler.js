import { all, run, setting, tx } from './db.js';
import { audit, fmtWhen, notify } from './lib.js';
import { recomputePaymentStatus } from './domain.js';

/** Pickup reminders (BRD §12: one hour before pickup) and overdue invoices. */
export function runScheduledJobs(now = new Date()) {
  const minutes = Number(setting('reminder_minutes_before')) || 60;
  const horizon = new Date(now.getTime() + minutes * 60000).toISOString();
  const due = all(`
    SELECT l.*, b.customer_id, b.ref, v.registration, v.make, v.model, v.colour
    FROM booking_legs l JOIN bookings b ON b.id = l.booking_id LEFT JOIN vehicles v ON v.id = l.vehicle_id
    WHERE l.reminder_sent_at IS NULL AND l.status IN ('unassigned','assigned')
      AND b.status IN ('confirmed','driver_assigned') AND l.pickup_at > ? AND l.pickup_at <= ?`, now.toISOString(), horizon);
  for (const l of due) {
    run("UPDATE booking_legs SET reminder_sent_at = datetime('now') WHERE id = ? AND reminder_sent_at IS NULL", l.id);
    const reg = l.registration || l.external_vehicle_reg;
    notify(l.customer_id, {
      bookingId: l.booking_id, event: 'pickup_reminder',
      title: `Pickup reminder · ${l.ref}`,
      body: `Your chauffeur will collect you at ${fmtWhen(l.pickup_at)} from ${l.pickup}.${reg ? ` Vehicle: ${[l.colour, l.make, l.model].filter(Boolean).join(' ')} (${reg}).` : ''}`,
    });
    if (l.driver_id) notify(l.driver_id, { bookingId: l.booking_id, event: 'pickup_reminder', title: `Upcoming pickup · ${l.ref}`, body: `${fmtWhen(l.pickup_at)} from ${l.pickup}.`, whatsapp: false });
  }

  const overdue = all("SELECT id, number FROM invoices WHERE status = 'issued' AND due_date < ?", now.toISOString());
  for (const inv of overdue) {
    tx(() => {
      run("UPDATE invoices SET status = 'overdue' WHERE id = ?", inv.id);
      for (const it of all('SELECT booking_id FROM invoice_items WHERE invoice_id = ?', inv.id)) recomputePaymentStatus(it.booking_id);
      audit({ entity: 'invoice', entityId: inv.id, action: 'invoice_overdue', detail: { number: inv.number } });
    });
  }
  return { reminders: due.length, overdue: overdue.length };
}

export function startScheduler() {
  const tick = () => {
    try { runScheduledJobs(); } catch (err) { console.error('[scheduler]', err); }
  };
  tick();
  return setInterval(tick, 60_000);
}
