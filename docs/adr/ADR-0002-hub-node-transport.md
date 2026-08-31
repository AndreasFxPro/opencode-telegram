# ADR-0002: Outbound WebSocket

Status: accepted.

Nodes use authenticated persistent outbound WebSockets with heartbeat, monotonic SQLite spool sequence, acknowledgement, replay, bounded buffering, and jittered exponential reconnect. Non-loopback transport requires TLS by default.
