import type { Incident, NewIncidentInput } from './types';
import type { IncidentStorage } from './storage';
import type { IncidentTransport } from './transport';
import { transition } from './transitions';

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export interface SyncEngineOptions {
  storage: IncidentStorage;
  transport: IncidentTransport;
  /** Injected so tests can assert backoff without waiting. */
  clock?: Clock;
  /** Injected so tests can assert on stable ids. */
  generateId?: () => string;
  /** Attempts beyond this leave the incident in `failed` for manual retry. */
  maxAutoAttempts?: number;
}

/** Exponential backoff, capped. Attempt 1 -> 1s, 2 -> 2s, 3 -> 4s, ... max 60s. */
export function backoffMs(attempts: number): number {
  return Math.min(1000 * 2 ** Math.max(0, attempts - 1), 60_000);
}

type Listener = (incidents: Incident[]) => void;

/**
 * Owns the durable queue and every synchronization decision.
 *
 * Deliberately contains no React and no Expo imports: the UI subscribes to
 * snapshots, and never reaches into storage or transport itself.
 */
export class SyncEngine {
  private readonly storage: IncidentStorage;
  private readonly transport: IncidentTransport;
  private readonly clock: Clock;
  private readonly generateId: () => string;
  private readonly maxAutoAttempts: number;
  private readonly listeners = new Set<Listener>();

  /** Guards against two concurrent flushes double-sending the same incident. */
  private flushing = false;

  constructor(opts: SyncEngineOptions) {
    this.storage = opts.storage;
    this.transport = opts.transport;
    this.clock = opts.clock ?? systemClock;
    this.generateId = opts.generateId ?? defaultId;
    this.maxAutoAttempts = opts.maxAutoAttempts ?? 5;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private async notify(): Promise<void> {
    const snapshot = await this.storage.list();
    for (const fn of this.listeners) fn(snapshot);
  }

  async list(): Promise<Incident[]> {
    return this.storage.list();
  }

  /**
   * Create an incident and persist it before returning.
   *
   * The id is generated here, on the device, so the incident has a stable
   * identity that survives restarts and is the same on every delivery attempt.
   * This is what makes retries idempotent at the server.
   */
  async create(input: NewIncidentInput): Promise<Incident> {
    const title = input.title.trim();
    if (!title) throw new Error('Title is required');

    const incident: Incident = {
      id: this.generateId(),
      title,
      severity: input.severity,
      createdAt: this.clock.now().toISOString(),
      syncState: 'pending',
      attempts: 0,
    };

    await this.storage.put(incident);
    await this.notify();
    return incident;
  }

  /**
   * Recover state left behind by a crash or force-quit.
   *
   * Anything still marked `syncing` had an attempt in flight when the process
   * died, so its outcome is unknown. Returning it to `pending` schedules
   * another attempt; sending it twice is safe because the server keys on the
   * client-generated id. This is the "app closed mid-sync" case.
   */
  async recoverInterrupted(): Promise<number> {
    const rows = await this.storage.list();
    const stuck = rows.filter((r) => r.syncState === 'syncing');

    for (const row of stuck) {
      await this.storage.put(
        transition(row, 'pending', {
          lastError: 'Interrupted before the outcome was known; will retry',
        }),
      );
    }

    if (stuck.length) await this.notify();
    return stuck.length;
  }

  /**
   * Attempt delivery of every incident that is due.
   *
   * Serial rather than parallel: the queue is small, ordering is predictable,
   * and it keeps a burst of failures from hammering a struggling server.
   */
  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;

    try {
      const rows = await this.storage.list();
      const due = rows.filter((r) => this.isDue(r)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));

      for (const row of due) {
        await this.deliver(row);
      }
    } finally {
      this.flushing = false;
    }
  }

  /**
   * Force one incident back into the queue, ignoring backoff.
   *
   * Re-read immediately before writing, because a background flush may have
   * moved this incident since the user tapped Retry. Anything already queued
   * or in flight needs no nudge, so those states are a no-op rather than an
   * error — a retry that races a flush must not reject in the UI.
   */
  async retry(id: string): Promise<void> {
    const row = await this.storage.get(id);
    if (!row) return;
    if (row.syncState !== 'failed') {
      // pending: already queued. syncing: an attempt is in flight.
      // synced: terminal. In every case, flushing is the only useful action.
      await this.flush();
      return;
    }

    await this.storage.put(transition(row, 'pending', { lastError: undefined }));
    await this.notify();
    await this.flush();
  }

  private isDue(row: Incident): boolean {
    if (row.syncState === 'pending') return true;

    // A failed incident is retried automatically until the attempt budget runs
    // out, after which it waits for an explicit user retry.
    if (row.syncState === 'failed' && row.attempts < this.maxAutoAttempts) {
      if (!row.lastAttemptAt) return true;
      const elapsed = this.clock.now().getTime() - new Date(row.lastAttemptAt).getTime();
      // A timestamp in the future (clock skew, or a device whose clock was
      // wrong when the attempt was recorded) would otherwise leave the
      // incident permanently un-due. Treat it as ready rather than stranding
      // it in the queue for ever.
      if (elapsed < 0) return true;
      return elapsed >= backoffMs(row.attempts);
    }

    return false;
  }

  private async deliver(row: Incident): Promise<void> {
    // Mark in-flight and persist *before* sending, so a crash mid-request is
    // detectable on restart rather than looking like it never started.
    const inFlight = transition(row, 'syncing');
    await this.storage.put(inFlight);
    await this.notify();

    const result = await this.transport.send(inFlight);
    const at = this.clock.now().toISOString();
    const attempts = inFlight.attempts + 1;

    if (result.ok) {
      await this.storage.put(transition(inFlight, 'synced', { attempts, lastAttemptAt: at }));
    } else {
      await this.storage.put(
        transition(inFlight, 'failed', { attempts, lastAttemptAt: at, lastError: result.error }),
      );
    }

    await this.notify();
  }
}

function defaultId(): string {
  // crypto.randomUUID exists in Node 19+, Hermes with the polyfill, and browsers.
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `inc_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
