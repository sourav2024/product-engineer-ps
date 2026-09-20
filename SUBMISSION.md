# Product Engineering Challenge Submission

## Candidate

- **Name:** Sourav Kashyap
- **Email:** sourav.kashyap@truxo.ai
- **GitHub:** [sourav2024](https://github.com/sourav2024)
- **Selected problem:** Problem 1 — Offline Mobile Queue
- **Demo video:** https://drive.google.com/file/d/1O8OrHx3xvHDmFji43ql6JlzAlCqQrG-Z/view?usp=drive_link

## Run the project

Prerequisites: Node 20+ and the Expo Go app on a phone, or an iOS/Android simulator.

```bash
npm install

# Terminal 1 — incident receiver (no dependencies, in-memory store)
npm run server

# Terminal 2 — the app
npm start        # then press i / a, or scan the QR code with Expo Go
```

If you run the app on a **physical device**, it cannot reach the host's `localhost`.
Point it at your machine's LAN address instead:

```bash
EXPO_PUBLIC_SERVER_URL=http://192.168.1.20:4000 npm start
```

### Triggering the required scenarios

The receiver exposes three controls, so every scenario can be produced on demand:

| Action | Command |
| --- | --- |
| Inspect what the server actually stored | `curl localhost:4000/incidents` |
| Force temporary failures (503) | `curl -X POST "localhost:4000/mode?to=fail"` |
| Force an uncertain outcome (stores, then hangs past the client timeout) | `curl -X POST "localhost:4000/mode?to=slow"` |
| Lengthen that hang for a slower manual demo | `SLOW_DELAY_MS=30000 npm run server` |
| Return to healthy | `curl -X POST "localhost:4000/mode?to=ok"` |
| Clear the store | `curl -X POST localhost:4000/reset` |

**Successful scenario (AC1–AC3):** enable Airplane Mode, create an incident — it
appears immediately as `pending`. Force-quit and reopen the app: it is still there
(AC2). Disable Airplane Mode; the queue flushes and the badge becomes `synced`.

**Failure and recovery (AC4–AC5):** set the receiver to `fail`, create an incident
and watch it reach `failed` with the HTTP status shown and an attempt count.
Set the mode back to `ok` and press **Retry**. Then run `curl localhost:4000/incidents`
and confirm `count` is 1 despite multiple delivery attempts.

The sharpest demonstration of AC5 is `mode=slow`. The receiver **writes the
incident and then stalls**, so the client times out never knowing it succeeded —
the genuinely dangerous case, and the reason a client-side check alone cannot
solve this. The retry sends the same client id and the store still holds exactly
one incident. `npm run test:e2e` asserts precisely this sequence.

## Run the tests

```bash
npm test         # 15 unit tests, ~1.5s, no device or simulator needed
npm run typecheck

# Optional end-to-end check against the real receiver process:
npm run server               # terminal 1
npm run test:e2e             # terminal 2
```

The unit tests run in plain Node against in-memory doubles. There are no sleeps,
no real timers and no network, so they are deterministic and fast.

`test:e2e` is separate and excluded from `npm test`, because it needs the server
running. Two tests drive the real HTTP transport: one through a forced 503, a
lost response and a successful retry; one reproducing the entire demo script
(offline create → failed sync → app restart → retry → synced) and asserting the
receiver holds exactly one record. Both run serially against
the shared receiver and need no extra configuration.

## Architecture and data flow

```
  App.tsx  ──────────────┐   renders snapshots, forwards intent
                         │
  useIncidentQueue  ─────┤   React binding: subscribe, flush on reconnect
                         │
  SyncEngine  ───────────┤   ALL synchronization decisions live here
      │                  │
      ├── IncidentStorage (interface)
      │      ├── SqliteIncidentStorage   (device)
      │      └── InMemoryIncidentStorage (tests)
      │
      └── IncidentTransport (interface)
             ├── HttpIncidentTransport   (device)
             └── FakeTransport           (tests)
```

Creating an incident writes it to SQLite as `pending` **before** any network call
and before the UI updates, so the durable record is never derived from screen
state. `flush()` selects due incidents, marks each `syncing` *and persists that*
before sending, then records the outcome. The UI learns about all of it through
`engine.subscribe()`.

The deliberate constraint: **`src/queue/` contains no React and no Expo imports**
(except the one SQLite adapter). That is what lets the interesting logic be tested
in about a second without a simulator.

### State machine

`pending → syncing → synced | failed`, with `failed → pending` on retry and
`syncing → pending` on crash recovery. `synced` is terminal. The legal moves are
[declared as data](src/queue/transitions.ts) and illegal ones throw, rather than
being spread across conditionals in the engine.

## Technology choices

**React Native + Expo** because the problem is explicitly a mobile one and Expo
removes native build setup from the reviewer's path — `npm start` is enough.

**expo-sqlite** over AsyncStorage: the queue needs per-row updates and a primary
key, and `INSERT OR REPLACE` on the client id gives local idempotency for free.
AsyncStorage would have meant read-modify-write of a whole JSON blob, which is
both slower and racy.

**A real HTTP receiver** rather than an in-app mock. It costs ~130 dependency-free
lines and makes the duplicate-prevention claim demonstrable rather than merely
asserted: the reviewer can query the store and count records.

**Trade-offs accepted:** the receiver is in-memory and single-process, so it is a
stand-in rather than a backend. Retries run in the foreground only. Both are
consistent with the stated scope.

## Important decisions

**1. The client generates the identity, and it never changes.** A UUID is minted
at creation time and is the idempotency key for every subsequent attempt. Without
it, a retry after an uncertain failure is indistinguishable from a new report.

**2. Persist `syncing` before sending, not after.** This costs an extra write but
makes a crash mid-request *detectable*. On launch, `recoverInterrupted()` returns
anything stuck in `syncing` to `pending`. Re-sending is safe precisely because the
server is idempotent — the two decisions only work as a pair.

**3. Retryable and permanent failures are classified, not lumped together.**
5xx, 408, 429 and network throws retry with capped exponential backoff; 4xx does
not, because resending a malformed incident will never succeed. Automatic retries
stop at 5 attempts and hand control to the user, so the queue cannot spin forever.

## Assumptions and limitations

- One device, one user, no authentication — all out of scope per the brief.
- The receiver holds incidents in memory; restarting it clears them. Restarting
  the *app* does not, which is the durability the problem actually asks about.
- Sync runs only while the app is foregrounded. Background sync is out of scope.
- Backoff is per-incident, not a global circuit breaker. With one endpoint and a
  small queue this is adequate; see below for what would change at scale.
- No conflict resolution: incidents are append-only, so there is nothing to merge.
- Verified on the iOS simulator: the full lifecycle (offline create → restart →
  failed sync with HTTP 503 → recovery → synced) was confirmed against the app's
  own SQLite database and the receiver, which held one record after two
  attempts. Tap-level UI automation is not included; the flows the buttons
  invoke are covered by `test:e2e`.

## Production and scale

**First change:** move delivery off the UI thread into a background task
(`expo-task-manager`), so a user who closes the app mid-sync still gets their
reports delivered rather than waiting for the next launch.

**Second:** batch delivery. One request per incident is fine for tens of rows and
wasteful for thousands. A batch endpoint accepting an array of client ids keeps
the same idempotency contract while cutting round trips.

**Third:** bound the queue. Right now it grows without limit. In production I
would page the list view, cap retained synced incidents, and add a dead-letter
state after repeated permanent failures so a poisoned record cannot block the head
of the queue.

On the server, the `Map` becomes a table with a unique constraint on the client id,
and the duplicate path becomes a caught constraint violation returning the existing
row — the same semantics, enforced by the database rather than by application code,
which is what makes it correct under concurrency.

## Answers to the brief's questions

**What happens if the app closes during synchronization?**
The incident is durably `syncing` with an unknown outcome. On next launch
`recoverInterrupted()` moves it back to `pending` and it is retried. If the server
had in fact received it, the retry carries the same client id and is deduplicated
server-side, so the worst case is a redundant request — never a lost report and
never a duplicate. This is covered by the `crash recovery` test.

**Where does duplicate prevention belong: client, server, or both?**
Both, with the server authoritative. The client contributes a stable identifier
and refuses to mint a new one on retry; the server enforces uniqueness on it. The
client half alone cannot work, because the dangerous case is precisely the one
where the client does not know what happened. The server half alone would work but
requires the client to cooperate by keeping the id stable — so the guarantee is
genuinely shared.

**How would this design change with thousands of pending incidents?**
`list()` currently loads every row to find due work. At that size I would add an
index on `syncState`, query only due rows with a `LIMIT`, and process in bounded
batches instead of one serial pass. The UI would move to a paged or virtualized
list. The engine's interface would not change, which is the point of keeping
storage behind an interface.

**What would you monitor in a production version?**
Queue depth and the age of the oldest pending incident (the real user-facing
signal — "is anything stuck?"), sync success rate by HTTP status, attempt-count
distribution to catch endpoints that only succeed after retries, count of records
recovered from `syncing` at launch as a proxy for crashes mid-delivery, and
server-side duplicate-ingest rate, which shows how often uncertain outcomes are
actually occurring in the field.

## AI usage

I used Claude (Claude Code) throughout: to review the brief against the published
scorecard, to draft the queue module, receiver and test suite, and to draft this
document. I directed the architecture — the React-free queue boundary, persisting
`syncing` before sending, and the injected clock for deterministic backoff tests
were the decisions I set, and I reviewed and ran everything submitted here. I can
walk through and modify any part of it.

## Credibility note

_TODO before submitting. The scorecard grades this separately from the code, and
looks for specificity over big names. Cover: the problem the system solved, what
**you personally** built (not what the team shipped), one concrete scale or
operational figure, one difficult decision and what you traded away, and a link
if one exists._
