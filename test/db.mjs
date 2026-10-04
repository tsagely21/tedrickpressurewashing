// Test harness: loads supabase/schema.sql into an in-process Postgres (PGlite) with minimal stand-ins for the
// parts Supabase provides (roles, auth.users/auth.uid, storage tables). Used by the SQL tests and the fake Supabase API.
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const SUPABASE_STUBS = `
create role anon nologin;
create role authenticated nologin;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text unique);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create schema storage;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid, created_at timestamptz default now(), unique (bucket_id, name));
alter table storage.objects enable row level security;
grant usage on schema public, storage, auth to anon, authenticated;
grant select, insert, delete on storage.objects to anon, authenticated;
-- Supabase grants new public tables and functions to the API roles by default; schema.sql must lock them down.
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant execute on functions to anon, authenticated;
`;

export async function createDb() {
  const db = new PGlite({ extensions: { btree_gist } });
  await db.exec(SUPABASE_STUBS);
  await db.exec(readFileSync(join(ROOT, 'supabase', 'schema.sql'), 'utf8'));
  return db;
}

/**
 * Call a database function the way PostgREST does: as role `anon` or `authenticated` (with a JWT subject),
 * using named arguments. Everything runs in one transaction so SET LOCAL ROLE cannot leak.
 */
export async function rpc(db, role, fn, args = {}, { sub = null, headers = {} } = {}) {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true), set_config('request.headers', $2, true)`, [sub || '', JSON.stringify(headers)]);
    await tx.exec(`set local role ${role}`);
    const keys = Object.keys(args);
    const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`;
    const res = await tx.query(sql, keys.map((k) => args[k]));
    return res.rows[0].r;
  });
}
