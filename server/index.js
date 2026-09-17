/**
 * Minimal incident receiver for the offline-queue prototype.
 *
 * Two jobs:
 *   1. Store one logical incident per client-generated id (idempotent ingest).
 *   2. Let the reviewer force failures, so retry and recovery are demonstrable.
 *
 * Deliberately in-memory and single-process: this stands in for a real backend,
 * it is not one. No dependencies, so `node server/index.js` just works.
 */
const http = require('http');

const PORT = process.env.PORT || 4000;

/** id -> stored incident. The Map key *is* the idempotency constraint. */
const incidents = new Map();

/** 'ok' | 'fail' (500s) | 'slow' (delays past the client timeout) */
let mode = 'ok';

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) reject(new Error('payload too large'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // --- reviewer controls -------------------------------------------------
  if (url.pathname === '/mode' && req.method === 'POST') {
    const next = url.searchParams.get('to');
    if (!['ok', 'fail', 'slow'].includes(next)) {
      return json(res, 400, { error: "mode must be one of ok, fail, slow" });
    }
    mode = next;
    console.log(`[mode] -> ${mode}`);
    return json(res, 200, { mode });
  }

  if (url.pathname === '/incidents' && req.method === 'GET') {
    return json(res, 200, { count: incidents.size, incidents: [...incidents.values()] });
  }

  if (url.pathname === '/reset' && req.method === 'POST') {
    incidents.clear();
    console.log('[reset] store cleared');
    return json(res, 200, { ok: true });
  }

  // --- ingest ------------------------------------------------------------
  if (url.pathname === '/incidents' && req.method === 'POST') {
    if (mode === 'fail') {
      console.log('[ingest] forced 503');
      return json(res, 503, { error: 'forced failure (mode=fail)' });
    }

    if (mode === 'slow') {
      // Longer than the client's timeout: the request *does* land, but the
      // client never hears back. This is the uncertain-outcome case that
      // makes server-side idempotency necessary rather than merely tidy.
      await new Promise((r) => setTimeout(r, 15_000));
    }

    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      return json(res, 400, { error: err.message });
    }

    const { id, title, severity, createdAt } = body;
    if (!id || !title || !severity) {
      return json(res, 400, { error: 'id, title and severity are required' });
    }

    // Idempotent ingest: the same client id is an acknowledgement of the
    // record we already hold, not a conflict and not a second incident.
    const existing = incidents.get(id);
    if (existing) {
      console.log(`[ingest] duplicate ${id} -> returning existing`);
      return json(res, 200, { ...existing, duplicate: true });
    }

    const stored = {
      id,
      title,
      severity,
      createdAt: createdAt ?? new Date().toISOString(),
      receivedAt: new Date().toISOString(),
    };
    incidents.set(id, stored);
    console.log(`[ingest] stored ${id} (${incidents.size} total)`);
    return json(res, 201, { ...stored, duplicate: false });
  }

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`incident receiver on http://localhost:${PORT}  (mode=${mode})`);
  console.log(`  POST /mode?to=ok|fail|slow   GET /incidents   POST /reset`);
});
