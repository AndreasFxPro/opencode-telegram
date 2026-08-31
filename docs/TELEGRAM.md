# Telegram

Use a dedicated bot. Private DMs are simplest; private groups and one configured forum `threadId` are supported.

The hub persists `getUpdates` offsets after each processed update. Flood-limit `retry_after` is honored. Notification HTML is escaped and messages are clipped below platform limits. Opaque callback data stays well below 64 bytes and contains no request details or credentials.

Direct free-text input is accepted only as a reply to the exact bot message representing a text-capable pending question or rejection-feedback flow. Unassociated text is ignored. Remote prompting is disabled and is not implemented as an arbitrary-text fallback.

Pending approval messages include short request and TUI-origin references. Requests that look identical can still be separate OpenCode continuations; the references make that distinction visible without placing routing data in callback buttons. Duplicate sends for the same pending identity and chat/topic are serialized in memory, and reconciliation cannot stale an action while OpenCode confirmation is still in flight.

Multiple-choice answers are persisted as drafts. A `Continue` button advances after at least one selection. Sequential questions reuse and edit the original Telegram message.

`/dashboard` and `/sessions` open the read-only session telemetry dashboard. On Telegram Bot API 10.3 or newer, the dashboard uses Rich Messages with structured tables, preformatted telemetry, and native expandable activity details. `Show full` opens every retained detail on the current page; activity and todo pagination makes all retained bounded telemetry reachable. If the configured Bot API server does not support Rich Messages, the gateway remembers that result until restart and uses the clipped 4096-character HTML dashboard instead.

Viewer-authorized users can inspect overview, identifiers, paths captured at `full` level, activity, todos, token and cache usage, cost, timestamps, and duration. Rich-message content is sent as structured plain-text fields rather than parsing model or project text as markup, and automatic entity detection is disabled. Dashboard callback data contains only a short random view ID and operation code. Views are held in memory for 30 minutes and are bound to the initiating user, authorized chat, configured topic, and exact bot message; stale or copied buttons cannot dispatch actions.
