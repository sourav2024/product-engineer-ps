import type { Incident } from './types';

/**
 * Durable storage for the incident queue.
 *
 * The engine depends on this interface rather than on SQLite directly, so the
 * same logic runs against expo-sqlite on a device and against an in-memory
 * implementation in tests.
 */
export interface IncidentStorage {
  /** All incidents, newest first. */
  list(): Promise<Incident[]>;
  /** Insert or replace by id. Must be durable before resolving. */
  put(incident: Incident): Promise<void>;
  get(id: string): Promise<Incident | undefined>;
}

/**
 * In-memory storage used by tests and by the Expo web preview.
 *
 * Clones on the way in and out so callers cannot mutate stored records by
 * holding a reference — the same guarantee the SQLite implementation gives
 * for free by serializing through the database.
 */
export class InMemoryIncidentStorage implements IncidentStorage {
  private readonly rows = new Map<string, Incident>();

  async list(): Promise<Incident[]> {
    return [...this.rows.values()]
      .map((r) => ({ ...r }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async put(incident: Incident): Promise<void> {
    this.rows.set(incident.id, { ...incident });
  }

  async get(id: string): Promise<Incident | undefined> {
    const row = this.rows.get(id);
    return row ? { ...row } : undefined;
  }
}
