# Offline Incident Queue

Submission for the Caygnus product engineering challenge — **Problem 1: Offline
Mobile Queue**. The original brief is preserved in [CHALLENGE.md](CHALLENGE.md).

Field teams report incidents from places with no connectivity. Losing a report is
unacceptable; retrying one must not create a duplicate. This prototype does both.

**→ [SUBMISSION.md](SUBMISSION.md) has the architecture, decisions and demo video.**

## Quick start

```bash
npm install
npm run server   # terminal 1 — incident receiver on :4000
npm start        # terminal 2 — Expo
npm test         # 15 unit tests, no device needed
npm run test:e2e # optional: real HTTP, needs the server running
```

## Where to look

| Path | What it is |
| --- | --- |
| [src/queue/syncEngine.ts](src/queue/syncEngine.ts) | Every synchronization decision |
| [src/queue/transitions.ts](src/queue/transitions.ts) | State machine, declared as data |
| [src/queue/storage.ts](src/queue/storage.ts) · [transport.ts](src/queue/transport.ts) | The two boundaries that make it testable |
| [server/index.js](server/index.js) | Receiver with forced-failure modes |
| [__tests__/syncEngine.test.ts](__tests__/syncEngine.test.ts) | Tests named after the acceptance criteria |
| [__tests__/concurrency.test.ts](__tests__/concurrency.test.ts) | Overlapping flushes, retry racing a background sync |
| [__tests__/integration/](__tests__/integration/) | Real HTTP: 503 → lost response → retry → one record |

`src/queue/` imports no React and no Expo (except the one SQLite adapter), so the
logic worth testing runs in Node in under a second.
