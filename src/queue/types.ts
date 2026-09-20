/**
 * Core domain types for the offline incident queue.
 *
 * This module is deliberately free of React and Expo imports so the queue can be
 * tested in plain Node, and so UI state is never confused with durable state.
 */

export type Severity = 'low' | 'medium' | 'high' | 'critical';

export const SEVERITIES: readonly Severity[] = ['low', 'medium', 'high', 'critical'];

/**
 * Synchronization state of a locally held incident.
 *
 * pending  - durably stored, not yet accepted by the server
 * syncing  - a delivery attempt is in flight; outcome unknown
 * synced   - the server has acknowledged this incident
 * failed   - an attempt failed; retryable, either automatically or by the user
 */
export type SyncState = 'pending' | 'syncing' | 'synced' | 'failed';

export interface Incident {
  /** Client-generated UUID. Stable for the life of the incident; the idempotency key. */
  id: string;
  title: string;
  severity: Severity;
  /** ISO-8601, assigned on the device at creation time. */
  createdAt: string;
  syncState: SyncState;
  /** Number of completed delivery attempts. Used for backoff and for display. */
  attempts: number;
  /** Human-readable reason for the most recent failure, if any. */
  lastError?: string;
  /** ISO-8601 timestamp of the most recent attempt, if any. */
  lastAttemptAt?: string;
}

/** The fields a user supplies when creating an incident. */
export interface NewIncidentInput {
  title: string;
  severity: Severity;
}
