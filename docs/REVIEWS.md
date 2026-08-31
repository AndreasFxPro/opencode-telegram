# Review Gates

Reviews were run after the first complete implementation and fixes were applied before the alpha verification pass.

## Architecture

Fixed:

- Added node ID to durable request identity and bound action results to the reporting node.
- Removed accidental OpenCode server-plugin packaging; discovery now detects only `./tui`.
- Scoped reconciliation to explicit tracked sessions and added TUI disconnect/liveness handling.
- Added durable node command inbox/result outbox and hub redispatch by action ID.
- Added spool generation so a recreated node database cannot collide with old sequence numbers.

Deferred: semantic duplicate requests still have separate Telegram presentations. Safe grouping needs a first-class display-group model without broadening allow-once semantics.

## Security

Fixed:

- Challenge-bound Telegram pairing with explicit owner confirmation.
- User plus chat plus optional topic authorization.
- HTTPS enforcement before enrollment and Telegram API credential transmission.
- Live node revocation checks and node-bound action-result evidence.
- Notification-only fallback when complete permission/options cannot be shown safely.
- Safe path validation, service escaping, non-recursive uninstall, file modes, and full macOS artifact checksum verification.
- Generic remote error text by default.

Accepted boundary: processes running as the same OS user are trusted. Use separate OS accounts for hostile local workloads.

## Reliability

Fixed:

- Serialized per-node event processing and ACK only after durable state plus notification handling.
- Retryable per-chat pending notification fan-out.
- Durable action command/result path, reconnect redispatch, result acknowledgement, action expiry propagation, and monotonic terminal transitions.
- Canceled long-poll cleanup, reconnect fencing, flush-on-ACK, and Telegram offset rollback after handler failure.
- Priority-aware bounded spool behavior, reconciliation coalescing, poller lease, and API deadlines.

Residual risk: completion/error Telegram notifications do not yet use the per-destination durable outbox used by pending actions. A crash in the narrow send boundary can duplicate or omit non-action notifications.

## UX

Fixed:

- Persistent multi-select/sequential drafts, custom-answer policy, review/submit/back, and exact reply-message routing.
- Expired/stale/failed action updates and non-actionable unsafe previews.
- Root completion tracks busy descendants; stuck detection uses activity and configurable `stuckMinutes`.
- TUI status reports local node, hub, Telegram, and mutation capability separately.
- Setup fails when required OpenCode is absent and doctor is mode-aware.

Deferred: quiet hours, project/node/session mute policies, per-project topics, remote prompting, semantic duplicate grouping, real Telegram screenshots, and real interactive OpenCode E2E.
