# ADR-0005: SQLite State Machines

Status: accepted.

Use Bun SQLite in WAL mode for offsets, enrollment, nodes, event dedupe, pending requests, message mappings, and actions. Transactions and a partial unique index provide exactly-once-ish callback admission while allowing explicit retry after failure.
