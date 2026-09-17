import type { Incident } from '../src/queue/types';
import type { IncidentTransport, DeliveryResult } from '../src/queue/transport';
import type { Clock } from '../src/queue/syncEngine';

/** A clock the test drives by hand, so backoff is asserted without waiting. */
export class FakeClock implements Clock {
  constructor(private t = new Date('2026-09-17T10:00:00.000Z')) {}
  now(): Date {
    return new Date(this.t);
  }
  advance(ms: number): void {
    this.t = new Date(this.t.getTime() + ms);
  }
}

/** Sequential ids, so assertions can name a specific incident. */
export function sequentialIds(prefix = 'inc'): () => string {
  let n = 0;
  return () => `${prefix}_${++n}`;
}

/**
 * Scripted transport: each call shifts the next queued result, and every
 * delivered incident is recorded so duplicate sends are observable.
 */
export class FakeTransport implements IncidentTransport {
  public readonly sent: Incident[] = [];
  private script: DeliveryResult[] = [];

  constructor(private fallback: DeliveryResult = { ok: true }) {}

  script_(...results: DeliveryResult[]): this {
    this.script.push(...results);
    return this;
  }

  async send(incident: Incident): Promise<DeliveryResult> {
    this.sent.push({ ...incident });
    return this.script.shift() ?? this.fallback;
  }

  /** Distinct incident ids actually delivered — the duplicate-prevention check. */
  uniqueIds(): string[] {
    return [...new Set(this.sent.map((s) => s.id))];
  }
}

/** A server that stores by id, mirroring the real receiver's idempotency. */
export class FakeServer {
  public readonly store = new Map<string, Incident>();

  transport(behaviour: () => DeliveryResult = () => ({ ok: true })): IncidentTransport {
    return {
      send: async (incident: Incident): Promise<DeliveryResult> => {
        const outcome = behaviour();
        // The write happens even when the *response* fails, which is exactly
        // the uncertain case: the server accepted it, the client never knew.
        if (!this.store.has(incident.id)) this.store.set(incident.id, { ...incident });
        return outcome;
      },
    };
  }
}
