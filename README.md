# Encore Executive — Backend (API)

Node.js + Express API for the Encore Executive premium chauffeur platform (BRD v1.0, Phase 1).
SQLite via the built-in `node:sqlite` — no native build step. All access rules are enforced here.

Web app: [Octapus-systems/Encore-App-Repo](https://github.com/Octapus-systems/Encore-App-Repo) — clone this repo into its `./server` folder.

## Run

```bash
npm install
cp .env.example .env   # set JWT_SECRET and GOOGLE_MAPS_API_KEY
npm run dev            # http://localhost:4000
npm test               # business-rule tests (in-memory DB)
```

First start creates `../data/encore.db` (or `ENCORE_DB_FILE`) with demo accounts (password `Encore2026!`, development only).

## Environment

| Variable | Purpose |
|---|---|
| `JWT_SECRET` | **Required in production.** Signs sign-in tokens. |
| `GOOGLE_MAPS_API_KEY` | Routes API (distance, drive time, distance from base) and Places API (address suggestions). Server-side only. |
| `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID` | WhatsApp Business Cloud API. Unset = deliveries logged as *not configured*. |
| `ENCORE_DB_FILE` / `ENCORE_DATA_DIR` | Database location. |
| `API_PORT` / `PORT` | Port (`PORT` used when `NODE_ENV=production`). |

## Layout

| File | Purpose |
|---|---|
| `index.js` | Starts the API, scheduler and route backfill |
| `app.js` | Express app and route mounting |
| `db.js` | Schema, settings, helpers, transactions |
| `domain.js` | Access scoping, lifecycle, conflict detection, payment status |
| `lib.js` | Auth, errors, audit log, notifications (in-app / WhatsApp) |
| `maps.js` | Google Routes + Places |
| `scheduler.js` | One-hour pickup reminders, overdue invoices |
| `routes/` | `auth`, `bookings`, `driver`, `admin` endpoints |
| `seed.js` | Demo data |
| `tests/` | `node --test` business-rule tests |

## Key rules (BRD)

- Customer quote acceptance never confirms — only management confirms.
- Drivers see only their assigned legs; no prices, payments or margins.
- Corporate users see only their organisation's bookings.
- Driver/vehicle overlaps need an explicit, recorded override.
- Every change to bookings, quotes, assignments, payments and statuses is audited.
