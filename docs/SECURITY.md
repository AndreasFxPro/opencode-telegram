# Security Threat Model

Telegram is a privileged remote approval surface, not a trusted execution environment.

## Trust Boundaries

- The hub alone holds the Telegram bot token.
- Each node has an independent random credential; the hub stores its SHA-256 digest because credentials have high entropy.
- Each machine has a separate random plugin-to-node secret in a `0600` file.
- Telegram chats are explicitly allowlisted as `viewer`, `approver`, or `owner`.
- Dashboard access uses an independent random bearer token stored only in the hub's `0600` secrets file.
- Project/model text is untrusted data. It is escaped, clipped, and never parsed into button behavior.

## Threats And Mitigations

| Threat | Mitigation |
| --- | --- |
| Stolen Telegram account | Explicit chat allowlist, least-privilege roles, expiring pending actions, second confirmation for saved rules. Revoke the chat and rotate the bot token. |
| Stolen bot token | Token exists only at the hub and is redacted from logs. Rotate it with BotFather; inspect hub compromise. |
| Stolen node credential | Credentials are per node and revocable. Compromise cannot authenticate as another node. Rotate by revoke/re-enroll. |
| Malicious local process | Loopback transport still requires a random secret. A process running as the same user may read process-owned files; OS user isolation remains required. |
| Replayed callback | Opaque callback maps to one persistent pending row. A partial unique index permits one dispatching action. Resolved/expired callbacks receive a friendly stale response. |
| Callback confusion / CSRF-like mixup | Callback semantics are server-side and fixed. Routing fields come from persisted OpenCode events, never callback data or model text. Telegram chat role is checked again. |
| Multiple sessions / route mixup | Immutable node, instance, session, location, and request identity; no random fallback TUI. Directory changes fail closed. |
| Malicious project content | HTML escaping, length limits, no URL interpretation, and fixed button labels. Prompt injection cannot add actions. |
| Log leakage | Structured logger clips and redacts bot, node, dashboard, local plugin, common API, and authorization tokens. Full prompts/output are not logged. |
| Hub compromise | The attacker controls Telegram and connected-node action dispatch for known pending requests. They do not gain a generic shell RPC. Rotate all node credentials and bot token. |
| Node compromise | The attacker can observe that machine's metadata and dispatch known pending actions to local TUIs if they also control node memory. Other node credentials and the bot token remain isolated. |
| Broad saved permission | Exact OpenCode pattern is shown verbatim; wildcard is highlighted; explicit second confirmation is mandatory. |
| Dashboard disclosure | Disabled by default, loopback-only listener, HTTPS public URL, no collection after restart while disabled, independent token, no token in URL/storage, strict same-origin CSP, no CORS, no mutation routes, bounded retention, metadata-only capture default. Disable deletes the token and purges snapshots; restart promptly to invalidate in-memory state. |
| Telegram dashboard button reuse | Read-only callbacks use opaque short-lived view IDs bound to the initiating user, authorized chat, configured topic, and exact bot message. They cannot enter approval dispatch paths. |
| Telemetry content leakage | Capture is enforced at the node. Activity/full modes are explicit opt-ins; fields are clipped and schema-validated before transport and rendering. |

## Non-Goals

- Protecting against a fully compromised account running the TUI, node, or hub.
- Making Telegram end-to-end encrypted. Bot conversations are visible to Telegram infrastructure.
- Persisting or restoring OpenCode's in-memory pending continuation after an OpenCode server restart.

## Deployment

1. Prefer private DM or a tightly controlled private group.
2. Put remote hubs behind HTTPS/TLS, Tailscale Serve HTTPS, or an authenticated TLS reverse proxy.
3. Never set `allowInsecureHub` outside an isolated development network.
4. Run `opencode-telegram doctor` after permission, service, or proxy changes.
5. Back up hub SQLite only as sensitive operational data and apply retention controls.
6. Protect config directories as `0700` and secret files as `0600`.
7. Expose the dashboard only through HTTPS (including Tailscale Serve), rotate its token after suspected disclosure, and use `full` capture only on trusted projects.

There is no arbitrary shell, filesystem, terminal-control, keyboard-injection, or generic OpenCode client RPC endpoint.
