# ADR-0003: Capability-Gated OpenCode Adapter

Status: accepted.

All OpenCode types, pending queries, reply calls, and settlement verification live under `src/opencode/`. Feature detection supplements version checks. Unsupported or unverified mutations degrade to notification-only rather than guessing routes.
