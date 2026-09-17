import type * as SQLite from 'expo-sqlite';
import type { IncidentStorage } from './storage';
import type { Incident, Severity, SyncState } from './types';

/**
 * Durable storage on the device.
 *
 * The only file in src/queue that knows about Expo. The engine depends on the
 * IncidentStorage interface, so swapping this for the in-memory implementation
 * in tests changes nothing about the synchronization logic.
 */
export class SqliteIncidentStorage implements IncidentStorage {
  constructor(private readonly db: SQLite.SQLiteDatabase) {}

  static async open(db: SQLite.SQLiteDatabase): Promise<SqliteIncidentStorage> {
    await db.execAsync(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS incidents (
        id           TEXT PRIMARY KEY NOT NULL,
        title        TEXT NOT NULL,
        severity     TEXT NOT NULL,
        createdAt    TEXT NOT NULL,
        syncState    TEXT NOT NULL,
        attempts     INTEGER NOT NULL DEFAULT 0,
        lastError    TEXT,
        lastAttemptAt TEXT
      );
    `);
    return new SqliteIncidentStorage(db);
  }

  async list(): Promise<Incident[]> {
    const rows = await this.db.getAllAsync<RawRow>(
      'SELECT * FROM incidents ORDER BY createdAt DESC',
    );
    return rows.map(toIncident);
  }

  async get(id: string): Promise<Incident | undefined> {
    const row = await this.db.getFirstAsync<RawRow>('SELECT * FROM incidents WHERE id = ?', id);
    return row ? toIncident(row) : undefined;
  }

  /** INSERT OR REPLACE keyed on the client id — the local half of idempotency. */
  async put(incident: Incident): Promise<void> {
    await this.db.runAsync(
      `INSERT OR REPLACE INTO incidents
         (id, title, severity, createdAt, syncState, attempts, lastError, lastAttemptAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      incident.id,
      incident.title,
      incident.severity,
      incident.createdAt,
      incident.syncState,
      incident.attempts,
      incident.lastError ?? null,
      incident.lastAttemptAt ?? null,
    );
  }
}

interface RawRow {
  id: string;
  title: string;
  severity: string;
  createdAt: string;
  syncState: string;
  attempts: number;
  lastError: string | null;
  lastAttemptAt: string | null;
}

function toIncident(row: RawRow): Incident {
  return {
    id: row.id,
    title: row.title,
    severity: row.severity as Severity,
    createdAt: row.createdAt,
    syncState: row.syncState as SyncState,
    attempts: row.attempts,
    lastError: row.lastError ?? undefined,
    lastAttemptAt: row.lastAttemptAt ?? undefined,
  };
}
