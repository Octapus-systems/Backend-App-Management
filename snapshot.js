// Keeps the SQLite database file in step with a snapshot stored in Supabase.
// Used only for serverless hosting (Vercel), where the local disk is temporary:
// every request first pulls a newer snapshot if one exists, and every successful
// change pushes the file back. Writes use optimistic versioning.
import fs from 'node:fs';

const URL_BASE = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_KEY;
const SECRET = process.env.ENCORE_SYNC_SECRET;
const FILE = process.env.ENCORE_DB_FILE;

let version = -1;

export const syncEnabled = () => !!(URL_BASE && KEY && SECRET && FILE);

async function rpc(name, body) {
  const res = await fetch(`${URL_BASE}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_secret: SECRET, ...body }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`Snapshot ${name} failed: ${data?.message || res.status}`);
  return data;
}

/** Before the database is opened: download the latest snapshot to disk if there is one. */
export async function initialPull() {
  if (!syncEnabled()) return false;
  const [row] = await rpc('encore_pull', { p_have: -1 });
  if (row?.data) {
    fs.writeFileSync(FILE, Buffer.from(row.data, 'base64'));
    version = Number(row.version);
    return true;
  }
  version = Number(row?.version ?? 0);
  return false;
}

/** Reload the open database if someone else saved a newer snapshot. */
export async function refresh(db) {
  if (!syncEnabled()) return;
  const [row] = await rpc('encore_pull', { p_have: version });
  if (row?.data && Number(row.version) > version) {
    db.close();
    fs.writeFileSync(FILE, Buffer.from(row.data, 'base64'));
    db.open();
    version = Number(row.version);
  }
}

/** Save the current database file. On a version conflict, reload the newer copy instead. */
export async function push(db) {
  if (!syncEnabled()) return;
  const data = fs.readFileSync(FILE).toString('base64');
  const v = Number(await rpc('encore_push', { p_base: version, p_data: data }));
  if (v === -1) {
    console.warn('[snapshot] another instance saved first — reloading its copy');
    await refresh(db);
  } else {
    version = v;
  }
}
