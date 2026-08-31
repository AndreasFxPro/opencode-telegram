# Changelog

All notable changes follow Keep a Changelog. This project uses semantic versioning.

## [Unreleased]

## [0.3.1] - 2026-09-01

### Added

- Telegram Bot API 10.3 Rich Message dashboards with structured usage tables, expandable full activity, and bounded activity/todo pagination.
- Short request and TUI-origin references on approval messages to distinguish separate OpenCode continuations.

### Fixed

- Session continuation confirmation now recognizes post-reply message activity without allowing reconciliation to stale an in-flight action.
- Incomplete or ambiguous post-reply outcomes remain retryable failures instead of being mislabeled as already resolved.
- Duplicate pending notifications, request reactivation, and action expiration races no longer leave contradictory or non-actionable Telegram state.
- Older Bot API servers receive the bounded HTML dashboard without unrelated Telegram errors disabling Rich Messages globally.

## [0.3.0] - 2026-08-31

### Added

- Authenticated, read-only hub dashboard for live and recent OpenCode sessions.
- Bounded metadata, activity, and full telemetry capture levels with token, cost, todo, reasoning, tool, and log views.
- Read-only Telegram session dashboard with viewer-authorized inline navigation, activity, todo, usage, and refresh controls.

## [0.2.0] - 2026-08-31

### Added

- Telegram notifications for a node's first authenticated connection.
- Hub-generated one-command node installation and enrollment.
- Persistent, step-by-step install logs and automatic active-service restart during updates.

## [0.1.0] - 2026-08-26

### Added

- Versioned validated protocol, durable hub, reconnecting node, and current OpenCode TUI plugin.
- Telegram permissions, confirmed saved rules, structured questions, direct replies, commands, and role authorization.
- SQLite persistence, enrollment, replay protection, reconciliation, setup, doctor, services, tests, CI, and release packaging.
