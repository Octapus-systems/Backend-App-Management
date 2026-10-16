import { createApp } from './app.js';
import { startScheduler } from './scheduler.js';
import { all, get } from './db.js';
import { seed } from './seed.js';
import { mapsEnabled, refreshLegRoute } from './maps.js';

if (!get('SELECT 1 FROM users LIMIT 1')) {
  console.log('[encore] empty database — loading demo data');
  seed();
}

// API_PORT in development (PORT belongs to the web dev server); PORT when serving the built app in production.
const port = Number(process.env.API_PORT || (process.env.NODE_ENV === 'production' && process.env.PORT)) || 4000;
createApp().listen(port, () => console.log(`[encore] API listening on http://localhost:${port}`));
startScheduler();

// Fill in distance / drive time for any legs that have never been checked.
if (mapsEnabled()) {
  (async () => {
    for (const l of all('SELECT id FROM booking_legs WHERE route_checked_at IS NULL')) await refreshLegRoute(l.id);
  })().catch((e) => console.error('[maps]', e.message));
} else {
  console.log('[encore] GOOGLE_MAPS_API_KEY not set — route distances disabled');
}
