# ADR-0004: Server-Side Opaque Actions

Status: accepted.

Telegram callback data contains an opaque random ID and fixed operation code only. The hub reconstructs immutable routing from persisted events, authorizes the chat, requires explicit saved-rule confirmation, and exposes no generic command or filesystem RPC.
