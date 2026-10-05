// A local stand-in for the Supabase HTTP API, for tests only. It runs the REAL supabase/schema.sql in an in-process
// Postgres (PGlite) and implements just the endpoints the site uses: /rest/v1/rpc, /auth/v1, /storage/v1.
// It also builds and serves the static site (with the CSP headers from _headers) so the browser test is one process.
//   env: PORT (default 3113), OUT (directory to build the site into)
import { createServer } from 'node:http';
import { createDb, rpc } from './db.mjs';
import { build } from '../build.mjs';
import { staticHandler } from '../scripts/static-server.mjs';

const PORT = Number(process.env.PORT) || 3113;
const OUT = process.env.OUT;
const OWNER_EMAIL = 'owner@test.local';
const OWNER_PASSWORD = 'testpass';

const db = await createDb();
const ownerId = (await db.query(`insert into auth.users (email) values ($1) returning id`, [OWNER_EMAIL])).rows[0].id;
await db.query('insert into public.owners (user_id) values ($1)', [ownerId]);
const files = new Map(); // storage path -> Buffer

process.env.SUPABASE_URL = `http://localhost:${PORT}`;
process.env.SUPABASE_KEY = 'sb_publishable_test';
process.env.FORMSPREE_URL = `http://localhost:${PORT}/formspree/f/test`;
const formspree = []; // messages the site tried to email to the owner
const serveStatic = staticHandler(build(OUT));

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body === undefined ? '' : JSON.stringify(body));
};
const readBody = async (req) => { const c = []; for await (const x of req) c.push(x); return Buffer.concat(c); };
const makeToken = (sub) => 'fake.' + Buffer.from(JSON.stringify({ sub, exp: Date.now() + 3600_000 })).toString('base64url');
const readToken = (req) => {
  const m = /^Bearer fake\.(.+)$/.exec(req.headers.authorization || '');
  try { const t = m && JSON.parse(Buffer.from(m[1], 'base64url').toString()); return t && t.exp > Date.now() ? t.sub : null; } catch { return null; }
};
const session = () => ({ access_token: makeToken(ownerId), refresh_token: 'refresh', expires_in: 3600, token_type: 'bearer', user: { id: ownerId, email: OWNER_EMAIL } });

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;
  try {
    let m;
    if ((m = /^\/rest\/v1\/rpc\/(\w+)$/.exec(path)) && req.method === 'POST') {
      const sub = readToken(req);
      const role = sub ? 'authenticated' : 'anon';
      const args = JSON.parse((await readBody(req)).toString() || '{}');
      try {
        const out = await rpc(db, role, m[1], args, { sub, headers: { 'x-forwarded-for': '203.0.113.9' } });
        return json(res, 200, out === undefined ? null : out);
      } catch (err) {
        if (/does not exist/.test(err.message) && err.code === '42883') return json(res, 404, { code: 'PGRST202', message: err.message });
        const status = err.code === '42501' ? (role === 'anon' ? 401 : 403) : err.code === 'PT404' ? 404 : 400;
        return json(res, status, { code: err.code, message: err.message, details: err.detail || null, hint: null });
      }
    }

    if (path === '/auth/v1/token' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      if (url.searchParams.get('grant_type') === 'password') {
        if (body.email === OWNER_EMAIL && body.password === OWNER_PASSWORD) return json(res, 200, session());
        return json(res, 400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
      }
      return body.refresh_token === 'refresh' ? json(res, 200, session()) : json(res, 400, { msg: 'Invalid Refresh Token' });
    }
    if (path === '/auth/v1/logout') return json(res, 204);

    // Test double for the Formspree endpoint, plus a way for the test to read what was sent
    if (path === '/formspree/f/test' && req.method === 'POST') {
      formspree.push(JSON.parse((await readBody(req)).toString() || '{}'));
      return json(res, 200, { ok: true });
    }
    if (path === '/__formspree') return json(res, 200, formspree);

    // Storage: upload (anonymous allowed only when the database policy helper says so)
    if ((m = /^\/storage\/v1\/object\/quote-photos\/(.+)$/.exec(path)) && req.method === 'POST') {
      const name = decodeURIComponent(m[1]);
      const body = await readBody(req);
      const sub = readToken(req);
      const allowed = await rpc(db, sub ? 'authenticated' : 'anon', 'can_upload_photo', { p_name: name }, { sub });
      if (!allowed) return json(res, 403, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' });
      if (files.has(name)) return json(res, 409, { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' });
      files.set(name, body);
      await db.query(`insert into storage.objects (bucket_id, name) values ('quote-photos', $1)`, [name]);
      return json(res, 200, { Key: `quote-photos/${name}` });
    }
    // Storage: owner-only signed URLs
    if (path === '/storage/v1/object/sign/quote-photos' && req.method === 'POST') {
      const sub = readToken(req);
      if (!sub || !(await rpc(db, 'authenticated', 'is_owner', {}, { sub }))) return json(res, 400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
      const { paths } = JSON.parse((await readBody(req)).toString());
      return json(res, 200, paths.map((p) => (files.has(p) ? { error: null, path: p, signedURL: `/object/sign/quote-photos/${p}?token=signed` } : { error: 'Object not found', path: p, signedURL: null })));
    }
    if ((m = /^\/storage\/v1\/object\/sign\/quote-photos\/(.+)$/.exec(path)) && req.method === 'GET') {
      const buf = files.get(decodeURIComponent(m[1]));
      if (!buf || url.searchParams.get('token') !== 'signed') return json(res, 404, { error: 'not_found' });
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      return res.end(buf);
    }
    if (path === '/storage/v1/object/quote-photos' && req.method === 'DELETE') {
      const { prefixes } = JSON.parse((await readBody(req)).toString());
      for (const p of prefixes) { files.delete(p); await db.query(`delete from storage.objects where bucket_id='quote-photos' and name=$1`, [p]); }
      return json(res, 200, []);
    }

    return serveStatic(req, res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, 500, { message: String(err.message) });
  }
});

server.listen(PORT, () => console.log(`fake supabase + site on http://localhost:${PORT}`));
