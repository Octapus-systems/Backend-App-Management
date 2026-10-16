import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import authRoutes, { account } from './routes/auth.js';
import bookingRoutes from './routes/bookings.js';
import adminRoutes from './routes/admin.js';
import driverRoutes from './routes/driver.js';
import { HttpError, authenticate, h, requireRole } from './lib.js';
import { mapsEnabled, suggestPlaces } from './maps.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '200kb' }));
  app.use((_req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    next();
  });

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRoutes);
  app.use('/api/bookings', authenticate, bookingRoutes);
  app.use('/api/account', authenticate, account);
  // Address suggestions for signed-in users. Key never leaves the server.
  const recent = new Map();
  app.get('/api/places', authenticate, h(async (req, res) => {
    if (!mapsEnabled()) return res.json([]);
    const now = Date.now(); const k = req.user.id; const hits = (recent.get(k) || []).filter((t) => now - t < 60000);
    if (hits.length > 120) throw new HttpError(429, 'Too many lookups — please slow down.');
    recent.set(k, [...hits, now]);
    try { res.json(await suggestPlaces(req.query.q, req.query.session)); } catch (e) { console.error('[places]', e.message); res.json([]); }
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
