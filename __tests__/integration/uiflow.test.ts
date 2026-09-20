/**
 * Drives the exact engine calls the screen's buttons make, against the real
 * receiver over real HTTP. This covers the button-press behaviour that cannot
 * be automated in the simulator without accessibility permissions.
 */
import { SyncEngine } from '../../src/queue/syncEngine';
import { InMemoryIncidentStorage } from '../../src/queue/storage';
import { HttpIncidentTransport } from '../../src/queue/transport';
import type { Incident } from '../../src/queue/types';

const BASE = process.env.E2E_SERVER_URL ?? 'http://localhost:4000';
const setMode = (m: string) => fetch(`${BASE}/mode?to=${m}`, { method: 'POST' });

/** Count only this test's record — the receiver is shared across test files. */
const countFor = async (id: string): Promise<number> => {
  const body = await (await fetch(`${BASE}/incidents`)).json();
  return body.incidents.filter((i: { id: string }) => i.id === id).length;
};

it('reproduces the full demo script end to end', async () => {
  jest.setTimeout(30_000);
  await setMode('ok');

  const storage = new InMemoryIncidentStorage();
  const engine = new SyncEngine({
    storage,
    transport: new HttpIncidentTransport(BASE, 2000),
    maxAutoAttempts: 10,
  });

  // What the UI renders, captured on every engine notification.
  const renders: string[] = [];
  engine.subscribe((rows: Incident[]) =>
    renders.push(rows.map((r) => `${r.title}:${r.syncState}`).join(',')),
  );

  // 1. "Add incident" while offline (server unreachable from the client's view)
  await setMode('fail');
  const a = await engine.create({ title: 'Pump failure', severity: 'high' });
  expect((await engine.list())[0].syncState).toBe('pending');

  // 2. "Sync now" against a failing receiver
  await engine.flush();
  expect((await engine.list())[0].syncState).toBe('failed');
  expect((await engine.list())[0].lastError).toContain('503');

  // 3. App restart: a fresh engine over the same storage keeps the incident
  const restarted = new SyncEngine({
    storage,
    transport: new HttpIncidentTransport(BASE, 2000),
  });
  await restarted.recoverInterrupted();
  expect((await restarted.list())[0].title).toBe('Pump failure');

  // 4. Receiver recovers, user taps "Retry"
  await setMode('ok');
  await restarted.retry(a.id);
  expect((await restarted.list())[0].syncState).toBe('synced');

  // 5. Exactly one record despite two delivery attempts
  expect(await countFor(a.id)).toBe(1);

  // The UI observed every transition in order, never skipping a state.
  expect(renders.join(' | ')).toContain('Pump failure:pending');
  expect(renders.join(' | ')).toContain('Pump failure:syncing');
  expect(renders.join(' | ')).toContain('Pump failure:failed');
});
