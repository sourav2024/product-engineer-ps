import type { Incident, SyncState } from './types';

/**
 * The complete set of legal synchronization transitions.
 *
 * Keeping this as data rather than scattered `if` statements means the legal
 * moves can be read in one place and asserted in tests. `synced` is terminal:
 * once the server has acknowledged an incident there is nothing left to do.
 */
const LEGAL: Record<SyncState, readonly SyncState[]> = {
  pending: ['syncing'],
  syncing: ['synced', 'failed', 'pending'],
  failed: ['syncing', 'pending'],
  synced: [],
};

export function canTransition(from: SyncState, to: SyncState): boolean {
  return LEGAL[from].includes(to);
}

export class IllegalTransitionError extends Error {
  constructor(
    public readonly id: string,
    public readonly from: SyncState,
    public readonly to: SyncState,
  ) {
    super(`Incident ${id}: illegal transition ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

/**
 * Produce a new Incident in the target state, rejecting illegal moves.
 *
 * Returns a new object rather than mutating so callers cannot accidentally
 * share state between the durable record and the rendered one.
 */
export function transition(
  incident: Incident,
  to: SyncState,
  patch: Partial<Pick<Incident, 'attempts' | 'lastError' | 'lastAttemptAt'>> = {},
): Incident {
  if (!canTransition(incident.syncState, to)) {
    throw new IllegalTransitionError(incident.id, incident.syncState, to);
  }

  const next: Incident = { ...incident, ...patch, syncState: to };

  // A successful sync clears any error left over from an earlier attempt, so
  // the UI never shows a stale failure reason next to a synced badge.
  if (to === 'synced') {
    delete next.lastError;
  }

  return next;
}
