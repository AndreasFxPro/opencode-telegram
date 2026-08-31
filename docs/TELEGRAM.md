# Telegram

Use a dedicated bot. Private DMs are simplest; private groups and one configured forum `threadId` are supported.

The hub persists `getUpdates` offsets after each processed update. Flood-limit `retry_after` is honored. Telegram HTML is escaped and messages are clipped below platform limits. Opaque callback data stays well below 64 bytes and contains no request details or credentials.

Direct free-text input is accepted only as a reply to the exact bot message representing a text-capable pending question or rejection-feedback flow. Unassociated text is ignored. Remote prompting is disabled and is not implemented as an arbitrary-text fallback.

Multiple-choice answers are persisted as drafts. A `Continue` button advances after at least one selection. Sequential questions reuse and edit the original Telegram message.
