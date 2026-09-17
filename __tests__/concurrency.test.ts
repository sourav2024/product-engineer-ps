/**
 * Concurrency behaviour of the queue.
 *
 * Both cases below are reachable from the UI: a connectivity change and a user
 * tap can land in the same tick, and NetInfo can fire repeatedly while a flush
 * is already running.
 */
import { SyncEngine } from '../src/queue/syncEngine';
import { InMemoryIncidentStorage } from '../src/queue/storage';
import type { IncidentTransport, DeliveryResult } from '../src/queue/transport';
import type { Incident } from '../src/queue/types';

/** Transport that takes real (tiny) time, so overlap is observable. */
class SlowTransport implements IncidentTransport {
  public sent: Incident[] = [];
  public maxConcurrent = 0;
  private active = 0;

  constructor(private readonly result: DeliveryResult = { ok: true }) {}

  async send(incident: Incident): Promise<DeliveryResult> {
    this.sent.push({ ...incident });
    this.active++;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.active);
    await new Promise((r) => setTimeout(r, 20));
    this.active--;
    return this.result;
  }
}

describe('concurrent flushes', () => {
  it('collapses overlapping flushes into a single serial pass', async () => {
    const storage = new InMemoryIncidentStorage();
    const transport = new SlowTransport();
    const engine = new SyncEngine({ storage, transport });

    await engine.create({ title: 'A', severity: 'low' });
    await engine.create({ title: 'B', severity: 'low' });

    await Promise.all([engine.flush(), engine.flush(), engine.flush()]);

    // Three callers, two incidents, one delivery each — no double-send.
    expect(transport.sent).toHaveLength(2);
    expect(new Set(transport.sent.map((s) => s.id)).size).toBe(2);
    expect(transport.maxConcurrent).toBe(1);
  });
});

describe('manual retry racing a background flush', () => {
  it('does not reject when the flush has already moved the incident', async () => {
    const storage = new InMemoryIncidentStorage();
    const transport = new SlowTransport({ ok: false, retryable: true, error: 'HTTP 503' });
    const engine = new SyncEngine({ storage, transport });

    const created = await engine.create({ title: 'Raced', severity: 'high' });

    // The user taps Retry while a flush is mid-flight. Previously this threw
    // IllegalTransitionError (pending -> pending) and rejected in the UI.
    await expect(
      Promise.all([engine.flush(), engine.retry(created.id)]),
    ).resolves.toBeDefined();

    const [row] = await engine.list();
    expect(row.syncState).toBe('failed');
    expect(transport.sent).toHaveLength(1); // not delivered twice
  });

  it('is a no-op for an incident that is already synced', async () => {
    const storage = new InMemoryIncidentStorage();
    const transport = new SlowTransport({ ok: true });
    const engine = new SyncEngine({ storage, transport });

    const created = await engine.create({ title: 'Done', severity: 'low' });
    await engine.flush();
    expect((await engine.list())[0].syncState).toBe('synced');

    await expect(engine.retry(created.id)).resolves.toBeUndefined();
    expect(transport.sent).toHaveLength(1); // terminal state is not re-sent
  });
});
