# OpenCode Compatibility

## Tested Surface

- Installed CLI inspected: `1.17.20`.
- Current npm plugin/SDK declarations and source inspected: `1.18.23`.
- Minimum supported mutation baseline: `1.17.7`.
- Automated adapter test: stable permission reply plus replied-event, pending-state, and continuation evidence.
- Real interactive TUI E2E: not yet completed; the opt-in gate remains skipped by default.

## Current API

The plugin uses `@opencode-ai/plugin/tui`, `api.event.on`, `api.state.session.permission/question`, `api.client.permission.reply`, and `api.client.question.reply/reject`. It passes the originating directory. Current public TUI state does not expose a reliable workspace identity, so `workspaceRouting` is reported unavailable and remote-workspace mutation is not claimed.

There is no `context.data` API in the current TUI package. TUI state is `api.state`; the SDK client is `api.client`. Current structured input is the stable Question model; no generic public Form builder exists on this package surface.

## Upstream Risks

- [#36835](https://github.com/anomalyco/opencode/issues/36835): externally answered interactive TUI permissions may route to a different location-scoped store.
- [#28037](https://github.com/anomalyco/opencode/issues/28037): historical plugin-client `200` without unblocking, fixed in 1.17.7.
- [#23843](https://github.com/anomalyco/opencode/issues/23843): remote workspace question routing remains incomplete.
- [#36604](https://github.com/anomalyco/opencode/issues/36604): TUI reconnect can miss pending prompt hydration.
- [#34853](https://github.com/anomalyco/opencode/issues/34853): concurrent settlements can race.
- [#36582](https://github.com/anomalyco/opencode/issues/36582): native TUI reply calls can hide failures.
- [#36347](https://github.com/anomalyco/opencode/issues/36347): pending waits are not durable across OpenCode restart.

Because of these issues, an SDK/HTTP success response is never treated as approval. If confirmation evidence is incomplete, the bridge reports failure/unknown and leaves local OpenCode authoritative.

Remote workspace questions should be considered notification-only until real E2E proves settlement on the deployed OpenCode build. The compatibility layer is the only code allowed to change this policy.
