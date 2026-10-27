import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import authRoutes, { account } from './routes/auth.js';
import bookingRoutes from './routes/bookings.js';
import adminRoutes from './routes/admin.js';
import driverRoutes from './routes/driver.js';
import { HttpError, authenticate, h, requireRole } from './lib.js';
import { computeRoute, mapsEnabled, suggestPlaces, reverseGeocode } from './maps.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '200kb' }));
  app.use((_req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    next();
  });

  // The Capacitor mobile app serves its bundled pages from these origins and calls the API cross-origin.
  const appOrigins = new Set(['https://localhost', 'capacitor://localhost', 'http://localhost']);
  app.use('/api', (req, res, next) => {
    if (!appOrigins.has(req.get('Origin'))) return next();
    res.set('Access-Control-Allow-Origin', req.get('Origin'));
    res.set('Vary', 'Origin');
    if (req.method !== 'OPTIONS') return next();
    res.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.set('Access-Control-Max-Age', '600');
    res.sendStatus(204);
  });

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRoutes);
  app.use('/api/bookings', authenticate, bookingRoutes);
  app.use('/api/account', authenticate, account);
  // Address suggestions and "use my location". Open to guests booking without an account,
  // rate-limited per user (or per IP for guests). The Google key never leaves the server.
  const recent = new Map();
  const limit = (req) => {
    const signedIn = (req.headers.authorization || '').startsWith('Bearer ');
    const k = signedIn ? `u:${req.headers.authorization.slice(-24)}` : `ip:${req.ip}`;
    const now = Date.now(); const hits = (recent.get(k) || []).filter((t) => now - t < 60000);
    if (hits.length > (signedIn ? 120 : 40)) throw new HttpError(429, 'Too many lookups — please slow down.');
    recent.set(k, [...hits, now]);
    if (recent.size > 5000) recent.delete(recent.keys().next().value);
  };
  app.get('/api/places', h(async (req, res) => {
    if (!mapsEnabled()) return res.json([]);
    limit(req);
    try { res.json(await suggestPlaces(req.query.q, req.query.session)); } catch (e) { console.error('[places]', e.message); res.json([]); }
  }));
  // Route preview while booking (distance + drive time only; never a price).
  app.get('/api/places/route', h(async (req, res) => {
    if (!mapsEnabled()) return res.json(null);
    limit(req);
    const from = String(req.query.from || '').slice(0, 200); const to = String(req.query.to || '').slice(0, 200);
    if (from.length < 3 || to.length < 3) return res.json(null);
    try { res.json(await computeRoute(from, to)); } catch (e) { console.error('[route]', e.message); res.json(null); }
  }));
  app.get('/api/places/reverse', h(async (req, res) => {
    if (!mapsEnabled()) throw new HttpError(503, 'Location lookup is not available.');
    limit(req);
    try { res.json(await reverseGeocode(req.query.lat, req.query.lng)); } catch (e) { console.error('[reverse]', e.message); throw new HttpError(404, 'We could not find an address for your location. Please type your pickup.'); }
  }));
  app.use('/api/driver', authenticate, requireRole('driver'), driverRoutes);
  app.use('/api/admin', authenticate, requireRole('admin'), adminRoutes);
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found.')));

  // Serve the built web app in production.
  const dist = path.resolve(import.meta.dirname, '..', 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

   
  app.use((err, _req, res, _next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request body.' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Nothing was saved — please try again.' });
  });
  return app;
}
