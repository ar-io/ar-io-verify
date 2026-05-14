import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

let db: Database.Database | null = null;

export function initDb(): Database.Database {
  if (db) return db;
  const dbPath = config.SQLITE_PATH;
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Shared schema for the verification cache. Created here (not in cache.ts)
  // because the jobs store joins against it when building the bundle's
  // verified-row enumeration, so the table must exist whenever the DB is
  // open — even in tests that only initialize the jobs store.
  db.exec(`
    CREATE TABLE IF NOT EXISTS verification_results (
      id          TEXT PRIMARY KEY,
      tx_id       TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_verification_results_tx_id ON verification_results(tx_id);
  `);

  logger.info({ path: dbPath }, 'Database connection opened');
  return db;
}

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized — call initDb() first');
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    logger.info('Database connection closed');
  }
}
