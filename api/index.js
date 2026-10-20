// Vercel serverless entry for the Encore API (demo hosting).
// The database lives in /tmp and is synced with Supabase by snapshot.js.
process.env.ENCORE_DB_FILE ||= '/tmp/encore.db';
process.env.ENCORE_JOURNAL ||= 'DELETE';

const sync = await import('../snapshot.js');
await sync.initialPull();

const { db, get } = await import('../db.js');
const { createApp } = await import('../app.js');
const { seed } = await import('../seed.js');

if (!get('SELECT 1 FROM users LIMIT 1')) {
  seed();
  await sync.push(db);
}

const app = createApp();

// One request at a time per instance, so a snapshot reload never happens mid-request.
let queue = Promise.resolve();
const serial = (fn) => {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
};

export default function handler(req, res) {
  return serial(async () => {
    try {
      await sync.refresh(db);
    } catch (err) {
      console.error('[snapshot] refresh', err.message);
    }
    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    await new Promise((resolve) => {
      if (mutating) {
        // Hold the response until the change is saved to Supabase.
        const end = res.end.bind(res);
        res.end = (...args) => {
          const save = res.statusCode < 400 ? sync.push(db) : Promise.resolve();
          save.catch((err) => console.error('[snapshot] push', err.message)).finally(() => { end(...args); resolve(); });
          return res;
        };
      } else {
        res.on('finish', resolve);
        res.on('close', resolve);
      }
      app(req, res);
    });
  });
}
