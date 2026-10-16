import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.ENCORE_DATA_DIR || path.resolve(import.meta.dirname, '..', 'data');
const DB_FILE = process.env.ENCORE_DB_FILE || path.join(DATA_DIR, 'encore.db');

if (DB_FILE !== ':memory:') fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

export const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS organisations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  billing_email TEXT,
  billing_address TEXT,
  payment_terms TEXT DEFAULT 'Monthly consolidated invoice',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT,
  role TEXT NOT NULL CHECK (role IN ('customer','corporate','driver','admin')),
  organisation_id INTEGER REFERENCES organisations(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('pending','active','rejected','suspended')),
  driver_availability TEXT DEFAULT 'available' CHECK (driver_availability IN ('available','unavailable')),
  licence_number TEXT,
  notes TEXT,
  whatsapp_opt_in INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invitations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'customer',
  organisation_id INTEGER REFERENCES organisations(id),
  created_by INTEGER REFERENCES users(id),
  used_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS vehicles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  registration TEXT NOT NULL UNIQUE COLLATE NOCASE,
  make TEXT NOT NULL,
  model TEXT NOT NULL,
  colour TEXT,
  category TEXT NOT NULL,
  seats INTEGER NOT NULL,
  luggage_capacity INTEGER NOT NULL DEFAULT 0,
  child_seat_capable INTEGER NOT NULL DEFAULT 1,
  accessible INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','unavailable','retired')),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS external_operators (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  contact_name TEXT,
  phone TEXT,
  email TEXT,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES users(id),
  organisation_id INTEGER REFERENCES organisations(id),
  created_by INTEGER REFERENCES users(id),
  journey_type TEXT NOT NULL,
  lead_passenger TEXT NOT NULL,
  contact_phone TEXT NOT NULL,
  passenger_count INTEGER NOT NULL DEFAULT 1,
  passenger_names TEXT,
  luggage_large INTEGER NOT NULL DEFAULT 0,
  luggage_small INTEGER NOT NULL DEFAULT 0,
  child_seats INTEGER NOT NULL DEFAULT 0,
  accessibility_needs TEXT,
  special_instructions TEXT,
  sensitive_notes TEXT,
  preferred_category TEXT,
  flight_number TEXT,
  duration_hours REAL,
  is_return INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  payment_arrangement TEXT NOT NULL DEFAULT 'pay_after',
  payment_status TEXT NOT NULL DEFAULT 'unpaid',
  payment_link TEXT,
  internal_notes TEXT,
  cancel_reason TEXT,
  cancelled_by INTEGER REFERENCES users(id),
  cancelled_at TEXT,
  confirmed_by INTEGER REFERENCES users(id),
  confirmed_at TEXT,
  closed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS booking_legs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  leg_no INTEGER NOT NULL,
  label TEXT NOT NULL,
  pickup TEXT NOT NULL,
  destination TEXT NOT NULL,
  stops TEXT NOT NULL DEFAULT '[]',
  pickup_at TEXT NOT NULL,
  est_minutes INTEGER,
  driver_id INTEGER REFERENCES users(id),
  vehicle_id INTEGER REFERENCES vehicles(id),
  external_operator_id INTEGER REFERENCES external_operators(id),
  external_vehicle_reg TEXT,
  external_driver_name TEXT,
  conflict_override_reason TEXT,
  status TEXT NOT NULL DEFAULT 'unassigned',
  reminder_sent_at TEXT,
  on_the_way_at TEXT, arrived_at TEXT, started_at TEXT, completed_at TEXT,
  UNIQUE (booking_id, leg_no)
);

CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  reference_price REAL,
  extras TEXT NOT NULL DEFAULT '[]',
  customer_lines TEXT NOT NULL DEFAULT '[]',
  total REAL NOT NULL,
  internal_notes TEXT,
  message_to_customer TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','change_requested','accepted','declined','superseded')),
  valid_until TEXT,
  customer_response_note TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT,
  responded_at TEXT,
  responded_by INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'message',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  amount REAL NOT NULL,
  kind TEXT NOT NULL DEFAULT 'payment' CHECK (kind IN ('payment','deposit','refund')),
  method TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'succeeded' CHECK (outcome IN ('succeeded','failed')),
  reference TEXT,
  note TEXT,
  recorded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,
  organisation_id INTEGER NOT NULL REFERENCES organisations(id),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  total REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('draft','issued','paid','overdue','void')),
  issued_at TEXT,
  due_date TEXT,
  paid_at TEXT,
  notes TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoice_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  description TEXT NOT NULL,
  amount REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  booking_id INTEGER REFERENCES bookings(id),
  event TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  destination TEXT,
  status TEXT NOT NULL CHECK (status IN ('delivered','sent','failed','not_configured','skipped')),
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  action TEXT NOT NULL,
  detail TEXT,
  actor_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bookings_customer ON bookings(customer_id);
CREATE INDEX IF NOT EXISTS idx_bookings_org ON bookings(organisation_id);
CREATE INDEX IF NOT EXISTS idx_legs_booking ON booking_legs(booking_id);
CREATE INDEX IF NOT EXISTS idx_legs_driver ON booking_legs(driver_id);
CREATE INDEX IF NOT EXISTS idx_legs_vehicle ON booking_legs(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_booking ON audit_log(booking_id);
`);

export const DEFAULT_SETTINGS = {
  company_name: 'Encore Executive',
  dispatcher_name: 'Encore Dispatch',
  dispatcher_phone: '+44 1782 000000',
  dispatcher_whatsapp: '+44 7700 900000',
  base_location: 'Stoke-on-Trent, Staffordshire',
  admission_mode: 'both',
  default_job_minutes: '120',
  turnaround_minutes: '30',
  quote_validity_hours: '48',
  reminder_minutes_before: '60',
  invoice_due_days: '30',
  invoice_prefix: 'ENC-INV-',
  cancellation_policy: 'You can cancel online until your chauffeur is on the way. After that, please call us. Any cancellation charges follow the terms agreed for your booking.',
  vehicle_categories: JSON.stringify(['Executive Saloon', 'Luxury Saloon', 'Executive MPV (7-seat)', 'Luxury SUV']),
  channel_whatsapp: 'on',
  channel_email: 'off',
  max_drivers: '10',
  max_admins: '5',
};

for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

export const all = (sql, ...params) => db.prepare(sql).all(...params);
export const get = (sql, ...params) => db.prepare(sql).get(...params);
export const run = (sql, ...params) => db.prepare(sql).run(...params);

let depth = 0;
/** Run fn atomically. Nested calls join the outer transaction. */
export function tx(fn) {
  if (depth > 0) return fn();
  depth++;
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    depth--;
  }
}

export function getSettings() {
  const rows = all('SELECT key, value FROM settings');
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export function setting(key) {
  return get('SELECT value FROM settings WHERE key = ?', key)?.value ?? DEFAULT_SETTINGS[key];
}

/** Insert row object into table, returning new id. Keys are trusted (from code). */
export function insert(table, row) {
  const keys = Object.keys(row);
  const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
  return Number(run(sql, ...keys.map((k) => normalise(row[k]))).lastInsertRowid);
}

export function update(table, id, patch) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
  run(sql, ...keys.map((k) => normalise(patch[k])), id);
}

function normalise(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v;
}
