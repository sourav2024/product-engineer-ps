/**
 * End-to-end check against the real receiver process and the real HTTP
 * transport. Unlike the unit tests this starts a server, so it is kept
 * separate and skipped when the receiver is not running.
 *
 *   npm run server   # in another terminal
 *   npm run test:e2e
 */
import { SyncEngine } from '../../src/queue/syncEngine';
import { InMemoryIncidentStorage } from '../../src/queue/storage';
import { HttpIncidentTransport } from '../../src/queue/transport';

const BASE = process.env.E2E_SERVER_URL ?? 'http://localhost:4000';

const setMode = (m: 'ok' | 'fail' | 'slow') => fetch(`${BASE}/mode?to=${m}`, { method: 'POST' });

/**
 * Count only the records for one id. The receiver is shared, and Jest runs test
 * files in parallel, so a global count would see the other file's incidents.
 */
const countFor = async (id: string): Promise<number> => {
  const body = await (await fetch(`${BASE}/incidents`)).json();
  return body.incidents.filter((i: { id: string }) => i.id === id).length;
};

describe('end-to-end against the real receiver', () => {
  jest.setTimeout(30_000);

  it('delivers exactly one record despite a failure, a timeout and a retry', async () => {
    const storage = new InMemoryIncidentStorage();
    const engine = new SyncEngine({
      storage,
      transport: new HttpIncidentTransport(BASE, 2000),
      maxAutoAttempts: 10,
    });

    // 1. Hard failure: the incident must survive, visibly failed.
    await setMode('fail');
    const created = await engine.create({ title: 'E2E incident', severity: 'high' });
    await engine.flush();
    expect((await engine.list())[0].syncState).toBe('failed');
    expect(await countFor(created.id)).toBe(0);

    // 2. Uncertain outcome: the server accepts it but the client times out.
    await setMode('slow');
    await engine.retry(created.id);
    expect((await engine.list())[0].syncState).toBe('failed');
    expect(await countFor(created.id)).toBe(1); // it landed — the client never heard

    // 3. Recovery: retrying the same id must not create a second record.
    await setMode('ok');
    await engine.retry(created.id);

    const final = (await engine.list())[0];
    expect(final.syncState).toBe('synced');
    expect(final.id).toBe(created.id);
    expect(await countFor(created.id)).toBe(1);

    await setMode('ok');
  });
});
