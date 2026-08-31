# Architecture

## Components

The TUI plugin is an in-process adapter. It subscribes to typed stable OpenCode events, snapshots TUI-owned pending state, and applies only exact actions received from the node. Event forwarding is bounded, asynchronous, and timeout-protected.

The node is one per machine. Its loopback HTTP interface requires a random local secret. A SQLite WAL spool assigns monotonic sequence numbers. The node opens one outbound WebSocket to the hub, replays unacknowledged events after reconnect, heartbeats, and routes hub actions by immutable TUI instance ID.

The hub is one per Telegram bot. It authenticates each node separately, persists Telegram offsets and action state, authorizes Telegram roles, and owns the only long poller. SQLite transactions serialize callback admission and action transitions.

The optional dashboard is embedded in the hub binary. Its static shell contains no operational data and its snapshot API requires an independent bearer token. The browser polls bounded read-only snapshots and keeps the token only in memory. Telegram exposes the same validated projection through expiring, user/message-bound inline views. Neither dashboard path dispatches node actions.

TUI reconciliation may carry up to eight bounded session telemetry snapshots. Nodes strip telemetry unless the hub advertises support. The hub stores only the latest snapshot per node/session, removes telemetry from the long-lived event ledger, and applies configured retention.

## Action Lifecycle

```text
pending -> dispatching -> confirmed
                    \-> failed -> dispatching (explicit retry)
                    \-> stale
                    \-> expired
```

Telegram never moves an action directly to `confirmed`. The originating plugin requires:

1. A matching OpenCode `permission.replied`, `question.replied`, or `question.rejected` event.
2. Absence from the TUI plugin's exact session pending state.
3. A subsequent session execution/status event.

The node reports this evidence to the hub. Duplicate callbacks cannot create a second dispatching action because of a partial unique SQLite index.

## Routing

Request identity is the tuple:

```text
protocol generation + workspace + directory + node + TUI instance + session + request
```

The current implementation carries stable OpenCode generation implicitly and stores node, workspace, directory, instance, session, and request in its identity. The action payload repeats immutable routing fields and expires quickly. No fallback selects another TUI when the origin disconnects.

## Reconciliation

Every TUI emits a current-state reconciliation at startup and every five seconds while active. The hub upserts reported pending requests and marks formerly active requests stale when they disappear. Events are deduplicated by event ID and node sequence.

OpenCode's pending waits are process-local and not durable. A bridge restart can recover presentation state; an OpenCode server restart cannot restore a suspended JavaScript continuation. Such requests are marked stale rather than replayed.

## Backpressure

- TUI queue: replaceable reconciliation/execution updates are coalesced within a 256-message bound; a queue containing only correctness-critical events fails explicitly instead of silently discarding them.
- Node spool: configurable, default 10,000 events; replaceable telemetry is discarded before correctness-critical events.
- WebSocket: flush stops above 4 MiB buffered data and resumes on future activity/reconnect.
- Telegram: `retry_after` is honored. Failed edits are logged without changing action truth.

See ADRs under [`docs/adr`](adr/).
