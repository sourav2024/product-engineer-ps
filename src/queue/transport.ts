import type { Incident } from './types';

/**
 * Outcome of a single delivery attempt.
 *
 * `retryable` distinguishes a failure worth another attempt (network loss, 5xx,
 * timeout) from one that will never succeed (4xx validation). Retrying a
 * permanent failure forever is the mistake this type exists to prevent.
 */
export type DeliveryResult =
  | { ok: true }
  | { ok: false; retryable: boolean; error: string };

export interface IncidentTransport {
  /**
   * Deliver one incident to the server.
   *
   * Implementations must treat delivery as idempotent on `incident.id`: sending
   * the same incident twice is expected and must not create two server records.
   */
  send(incident: Incident): Promise<DeliveryResult>;
}

/** Thrown-error shape used to mark a network-level failure as retryable. */
function classifyStatus(status: number): DeliveryResult {
  if (status >= 200 && status < 300) return { ok: true };
  // 408 and 429 are temporary by definition; 5xx is a server-side problem that
  // may clear. Everything else in 4xx is a bad request that will not improve.
  const retryable = status === 408 || status === 429 || status >= 500;
  return { ok: false, retryable, error: `HTTP ${status}` };
}

/**
 * Real transport over fetch.
 *
 * A network-level throw (device offline, DNS failure, connection reset) is
 * always retryable: the request may or may not have reached the server, which
 * is precisely the uncertain case server-side idempotency exists to absorb.
 */
export class HttpIncidentTransport implements IncidentTransport {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 10_000,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(incident: Incident): Promise<DeliveryResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await this.fetchImpl(`${this.baseUrl}/incidents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          id: incident.id,
          title: incident.title,
          severity: incident.severity,
          createdAt: incident.createdAt,
        }),
      });
      return classifyStatus(res.status);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { ok: false, retryable: true, error };
    } finally {
      clearTimeout(timer);
    }
  }
}
