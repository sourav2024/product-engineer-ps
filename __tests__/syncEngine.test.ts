import { SyncEngine, backoffMs } from '../src/queue/syncEngine';
import { InMemoryIncidentStorage } from '../src/queue/storage';
import { transition, canTransition, IllegalTransitionError } from '../src/queue/transitions';
import type { Incident } from '../src/queue/types';
import { FakeClock, FakeTransport, FakeServer, sequentialIds } from './helpers';

function build(transport: FakeTransport | ReturnType<FakeServer['transport']>, clock = new FakeClock()) {
  const storage = new InMemoryIncidentStorage();
  const engine = new SyncEngine({
    storage,
    transport,
    clock,
    generateId: sequentialIds(),
    maxAutoAttempts: 3,
  });
  return { engine, storage, clock };
}

describe('AC1 + AC2: offline creation is durable', () => {
  it('persists a new incident as pending without contacting the server', async () => {
    const transport = new FakeTransport();
    const { engine, storage } = build(transport);

    const created = await engine.create({ title: 'Pump offline', severity: 'high' });

    expect(created.syncState).toBe('pending');
    expect(transport.sent).toHaveLength(0);
    expect(await storage.list()).toHaveLength(1);
  });

  it('survives a restart: a new engine over the same storage sees the pending incident', async () => {
    const transport = new FakeTransport();
    const { engine, storage } = build(transport);
    await engine.create({ title: 'Generator fault', severity: 'critical' });

    // Simulate relaunch: fresh engine, same durable storage.
    const restarted = new SyncEngine({ storage, transport, clock: new FakeClock() });
    const rows = await restarted.list();

    expect(rows).toHaveLength(1);
    expect(rows[0].syncState).toBe('pending');
    expect(rows[0].title).toBe('Generator fault');
  });
});

describe('AC3: successful synchronization', () => {
  it('delivers pending incidents and marks them synced', async () => {
    const transport = new FakeTransport({ ok: true });
    const { engine } = build(transport);

    await engine.create({ title: 'Valve leak', severity: 'medium' });
    await engine.flush();

    const [row] = await engine.list();
    expect(row.syncState).toBe('synced');
    expect(row.attempts).toBe(1);
    expect(row.lastError).toBeUndefined();
  });
});

describe('AC4: failure then retry', () => {
  it('records the failure, keeps the incident, and succeeds on a later retry', async () => {
    const transport = new FakeTransport().script_(
      { ok: false, retryable: true, error: 'HTTP 503' },
      { ok: true },
    );
    const { engine, clock } = build(transport);

    const created = await engine.create({ title: 'Sensor down', severity: 'high' });
    await engine.flush();

    let [row] = await engine.list();
    expect(row.syncState).toBe('failed');
    expect(row.lastError).toBe('HTTP 503');
    expect(row.attempts).toBe(1);

    // Backoff not yet elapsed: flush must not attempt again.
    await engine.flush();
    expect(transport.sent).toHaveLength(1);

    clock.advance(backoffMs(1));
    await engine.flush();

    [row] = await engine.list();
    expect(row.syncState).toBe('synced');
    expect(transport.sent).toHaveLength(2);
    expect(created.id).toBe(row.id);
  });

  it('stops automatic retries at the attempt limit and leaves the incident retryable by hand', async () => {
    const transport = new FakeTransport({ ok: false, retryable: true, error: 'HTTP 503' });
    const { engine, clock } = build(transport);

    await engine.create({ title: 'Comms loss', severity: 'low' });

    for (let i = 0; i < 6; i++) {
      await engine.flush();
      clock.advance(60_000);
    }

    const [row] = await engine.list();
    expect(row.syncState).toBe('failed');
    expect(row.attempts).toBe(3); // maxAutoAttempts, not unbounded
    expect(transport.sent).toHaveLength(3);
  });
});

describe('AC5: duplicate prevention', () => {
  it('reuses the client id across retries so the server holds one logical incident', async () => {
    const server = new FakeServer();
    let firstCall = true;
    // The first attempt reaches the server but the response is lost — the
    // classic uncertain outcome. The client must retry the *same* id.
    const transport = server.transport(() => {
      if (firstCall) {
        firstCall = false;
        return { ok: false, retryable: true, error: 'network timeout' };
      }
      return { ok: true };
    });

    const { engine, clock } = build(transport as FakeTransport);

    await engine.create({ title: 'Duplicate risk', severity: 'critical' });
    await engine.flush();
    clock.advance(backoffMs(1));
    await engine.flush();

    const [row] = await engine.list();
    expect(row.syncState).toBe('synced');
    expect(server.store.size).toBe(1); // delivered twice, stored once
  });

  it('never sends two different ids for one created incident', async () => {
    const transport = new FakeTransport().script_(
      { ok: false, retryable: true, error: 'boom' },
      { ok: false, retryable: true, error: 'boom' },
      { ok: true },
    );
    const { engine, clock } = build(transport);

    await engine.create({ title: 'Stable id', severity: 'high' });
    for (let i = 0; i < 3; i++) {
      await engine.flush();
      clock.advance(60_000);
    }

    expect(transport.sent.length).toBeGreaterThan(1);
    expect(transport.uniqueIds()).toHaveLength(1);
  });
});

describe('crash recovery', () => {
  it('returns incidents stuck in syncing to pending on restart', async () => {
    const storage = new InMemoryIncidentStorage();
    const stuck: Incident = {
      id: 'inc_stuck',
      title: 'Killed mid-flight',
      severity: 'high',
      createdAt: '2026-09-17T09:00:00.000Z',
      syncState: 'syncing',
      attempts: 1,
    };
    await storage.put(stuck);

    const transport = new FakeTransport({ ok: true });
    const engine = new SyncEngine({ storage, transport, clock: new FakeClock() });

    const recovered = await engine.recoverInterrupted();
    expect(recovered).toBe(1);
    expect((await engine.list())[0].syncState).toBe('pending');

    await engine.flush();
    expect((await engine.list())[0].syncState).toBe('synced');
  });
});

describe('manual retry', () => {
  it('ignores backoff and re-delivers immediately', async () => {
    const transport = new FakeTransport().script_(
      { ok: false, retryable: true, error: 'HTTP 500' },
      { ok: true },
    );
    const { engine } = build(transport);

    const created = await engine.create({ title: 'Manual', severity: 'medium' });
    await engine.flush();
    expect((await engine.list())[0].syncState).toBe('failed');

    await engine.retry(created.id); // no clock advance
    expect((await engine.list())[0].syncState).toBe('synced');
  });
});

describe('state machine', () => {
  it('rejects illegal transitions', () => {
    const synced: Incident = {
      id: 'x',
      title: 't',
      severity: 'low',
      createdAt: '2026-09-17T10:00:00.000Z',
      syncState: 'synced',
      attempts: 1,
    };
    expect(canTransition('synced', 'pending')).toBe(false);
    expect(() => transition(synced, 'pending')).toThrow(IllegalTransitionError);
  });

  it('caps backoff growth', () => {
    expect(backoffMs(1)).toBe(1000);
    expect(backoffMs(3)).toBe(4000);
    expect(backoffMs(99)).toBe(60_000);
  });
});

describe('clock skew', () => {
  it('retries an incident whose lastAttemptAt is in the future', async () => {
    const storage = new InMemoryIncidentStorage();
    const sent: string[] = [];
    const engine = new SyncEngine({
      storage,
      transport: {
        send: async (i) => {
          sent.push(i.id);
          return { ok: true };
        },
      },
    });

    // A device with a skewed clock can record an attempt "in the future".
    // Without a guard the elapsed time is negative and the incident is never
    // due again — silently stranded, which is the one outcome this queue
    // exists to prevent.
    await storage.put({
      id: 'skewed',
      title: 'Future timestamp',
      severity: 'high',
      createdAt: new Date().toISOString(),
      syncState: 'failed',
      attempts: 1,
      lastError: 'HTTP 503',
      lastAttemptAt: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
    });

    await engine.flush();

    expect(sent).toEqual(['skewed']);
    expect((await engine.list())[0].syncState).toBe('synced');
  });
});
