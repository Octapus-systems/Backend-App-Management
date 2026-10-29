import { all, db, get, run, setting } from './db.js';

// Route distance / drive time via Google Routes API. The key stays on the server.
// Results are informational (pricing factor "distance from base", conflict timing) —
// they never produce a customer price automatically (BRD: no per-mile fares).

for (const col of ['distance_m INTEGER', 'duration_s INTEGER', 'base_distance_m INTEGER', 'base_duration_s INTEGER', 'route_checked_at TEXT', 'route_error TEXT', 'driver_accepted_at TEXT', 'actual_distance_m INTEGER', 'distance_exceeded_notified_at TEXT']) {
  try { db.exec(`ALTER TABLE booking_legs ADD COLUMN ${col}`); } catch { /* already exists */ }
}

const cache = new Map();
const TTL = 6 * 3600 * 1000;

export const mapsEnabled = () => !!process.env.GOOGLE_MAPS_API_KEY;

export async function computeRoute(origin, destination, stops = []) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new Error('Google Maps API key not configured');
  const ck = JSON.stringify([origin, destination, stops]);
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.at < TTL) return hit.value;

  const body = {
    origin: { address: origin },
    destination: { address: destination },
    travelMode: 'DRIVE',
    routingPreference: 'TRAFFIC_UNAWARE',
    regionCode: 'GB',
    units: 'IMPERIAL',
    ...(stops.length ? { intermediates: stops.map((address) => ({ address })) } : {}),
  };
  const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Routes API HTTP ${res.status}`);
  const r = data.routes?.[0];
  if (!r) throw new Error('No driving route found for these addresses');
  const value = { distance_m: r.distanceMeters ?? 0, duration_s: Number(String(r.duration || '0s').replace('s', '')) };
  cache.set(ck, { at: Date.now(), value });
  return value;
}

/** Calculate route + distance from Encore's base for one leg and store it. Never throws. */
export async function refreshLegRoute(legId) {
  const leg = get('SELECT * FROM booking_legs WHERE id = ?', legId);
  if (!leg || !mapsEnabled()) return null;
  const stops = JSON.parse(leg.stops || '[]');
  try {
    const journey = leg.destination && !/^as directed$/i.test(leg.destination)
      ? await computeRoute(leg.pickup, leg.destination, stops) : null;
    let base = null;
    try { base = await computeRoute(setting('base_location'), leg.pickup); } catch { /* base distance is optional */ }
    const b = get('SELECT journey_type FROM bookings WHERE id = ?', leg.booking_id);
    run(`UPDATE booking_legs SET distance_m = ?, duration_s = ?, base_distance_m = ?, base_duration_s = ?, route_checked_at = datetime('now'), route_error = NULL,
           est_minutes = COALESCE(est_minutes, ?) WHERE id = ?`,
    journey?.distance_m ?? null, journey?.duration_s ?? null, base?.distance_m ?? null, base?.duration_s ?? null,
    journey && b?.journey_type !== 'hourly' ? Math.ceil(journey.duration_s / 60 / 5) * 5 + 15 : null, legId);
    return { journey, base };
  } catch (err) {
    run("UPDATE booking_legs SET route_error = ?, route_checked_at = datetime('now') WHERE id = ?", String(err.message).slice(0, 200), legId);
    return null;
  }
}

export function refreshBookingRoutes(bookingId) {
  const legs = all('SELECT id FROM booking_legs WHERE booking_id = ?', bookingId);
  return Promise.all(legs.map((l) => refreshLegRoute(l.id)));
}

// ---------- Address suggestions (Google Places Autocomplete, UK only) ----------
const placeCache = new Map();
export async function suggestPlaces(input, sessionToken) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new Error('Google Maps API key not configured');
  const q = String(input || '').trim().slice(0, 120);
  if (q.length < 3) return [];
  const ck = q.toLowerCase();
  const hit = placeCache.get(ck);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  const res = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'suggestions.placePrediction.placeId,suggestions.placePrediction.text.text,suggestions.placePrediction.structuredFormat,suggestions.placePrediction.types',
    },
    body: JSON.stringify({
      input: q, includedRegionCodes: ['gb'], languageCode: 'en-GB',
      // Bias towards Staffordshire / the Midlands without excluding the rest of the UK.
      locationBias: { circle: { center: { latitude: 52.95, longitude: -2.1 }, radius: 50000 } },
      ...(sessionToken ? { sessionToken } : {}),
    }),
    signal: AbortSignal.timeout(8000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `Places API HTTP ${res.status}`);
  const value = (data.suggestions || []).map((s) => s.placePrediction).filter(Boolean).slice(0, 6).map((p) => ({
    id: p.placeId,
    text: p.text?.text,
    main: p.structuredFormat?.mainText?.text || p.text?.text,
    secondary: p.structuredFormat?.secondaryText?.text || '',
    airport: (p.types || []).includes('airport'),
  }));
  placeCache.set(ck, { at: Date.now(), value });
  if (placeCache.size > 2000) placeCache.delete(placeCache.keys().next().value);
  return value;
}

/** Turn the customer's GPS position into a readable pickup address (Geocoding API, Places fallback). */
export async function reverseGeocode(lat, lng) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new Error('Google Maps API key not configured');
  const la = Number(lat); const ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln) || Math.abs(la) > 90 || Math.abs(ln) > 180) throw new Error('Invalid coordinates');
  const ck = `rev:${la.toFixed(4)},${ln.toFixed(4)}`;
  const hit = placeCache.get(ck);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  let value = null;
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${la},${ln}&language=en-GB&key=${key}`;
    const data = await (await fetch(url, { signal: AbortSignal.timeout(8000) })).json();
    const best = (data.results || []).find((r) => !r.types?.includes('plus_code'));
    if (data.status === 'OK' && best) {
      const short = best.formatted_address.replace(/, UK$/, '');
      const [main, ...rest] = short.split(', ');
      value = { text: short, main, secondary: rest.join(', ') };
    }
  } catch { /* fall back to Places */ }
  if (!value) {
    const res = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'places.formattedAddress,places.displayName' },
      body: JSON.stringify({ maxResultCount: 1, rankPreference: 'DISTANCE', languageCode: 'en-GB', locationRestriction: { circle: { center: { latitude: la, longitude: ln }, radius: 150 } } }),
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json().catch(() => ({}));
    const p = data.places?.[0];
    if (!res.ok || !p) throw new Error(data?.error?.message || 'No address found here');
    const text = p.formattedAddress.replace(/, UK$/, '');
    value = { text, main: p.displayName?.text || text.split(', ')[0], secondary: text };
  }
  placeCache.set(ck, { at: Date.now(), value });
  return value;
}
