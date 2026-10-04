import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { env } from './env.js';

mkdirSync(join(env.dataDir, 'uploads'), { recursive: true });

export const db = new DatabaseSync(join(env.dataDir, 'tedrick.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY,
  ref TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  data TEXT NOT NULL,
  estimate TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_id TEXT NOT NULL REFERENCES quotes(id),
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  original_name TEXT
);

-- status: pending | proposed | confirmed | declined | cancelled
-- req_*: what the customer asked for. slot_*: the confirmed (or proposed) time, minutes in business time zone.
CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL REFERENCES quotes(id),
  status TEXT NOT NULL,
  req_date TEXT NOT NULL,
  req_window TEXT NOT NULL,
  note TEXT,
  slot_date TEXT,
  slot_start INTEGER,
  slot_end INTEGER,
  full_day INTEGER NOT NULL DEFAULT 0,
  owner_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookings_slot ON bookings(status, slot_date);

-- start_min/end_min NULL means the whole day is blocked.
CREATE TABLE IF NOT EXISTS blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  start_min INTEGER,
  end_min INTEGER,
  reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blocks_date ON blocks(date);
`);

/** Run fn inside an IMMEDIATE transaction (write lock taken up front). */
export function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
