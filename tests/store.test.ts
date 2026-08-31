import { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { HubStore, NodeStore } from "../src/store.ts"
import { permission, temporaryDirectory } from "./helpers.ts"

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const remove of cleanup.splice(0)) remove()
})

describe("hub persistence and idempotency", () => {
  test("enrollment tokens are single-use and credentials are independently revocable", () => {
    const temp = temporaryDirectory()
    cleanup.push(temp.remove)
    const store = new HubStore(join(temp.path, "hub.db"))
    const enrollment = store.createEnrollment("machine-a")
    const node = store.exchangeEnrollment(enrollment.token)
    if (!node) throw new Error("Enrollment failed")
    expect(node?.nodeName).toBe("machine-a")
    expect(store.exchangeEnrollment(enrollment.token)).toBeUndefined()
    expect(store.authenticateNode(node?.nodeId ?? "", node?.credential ?? "")).toBeTrue()
    expect(store.connectNode(node.nodeId)).toEqual({ nodeId: node.nodeId, nodeName: "machine-a" })
    expect(store.connectNode(node.nodeId)).toEqual({ nodeId: node.nodeId, nodeName: "machine-a" })
    store.markNodeJoinNotified(node.nodeId)
    expect(store.connectNode(node.nodeId)).toBeUndefined()
    store.revokeNode(node.nodeId)
    expect(store.authenticateNode(node.nodeId, node.credential)).toBeFalse()
    store.close()
  })

  test("deduplicates replayed events across restart", () => {
    const temp = temporaryDirectory()
    cleanup.push(temp.remove)
    const path = join(temp.path, "hub.db")
    const event = permission()
    const first = new HubStore(path)
    expect(first.acceptEvent("node-a", "generation-a", 1, event)).toBeTrue()
    first.close()
    const second = new HubStore(path)
    expect(second.acceptEvent("node-a", "generation-a", 1, event)).toBeFalse()
    second.close()
  })

  test("migrates existing nodes without replaying join notifications", () => {
    const temp = temporaryDirectory()
    cleanup.push(temp.remove)
    const path = join(temp.path, "hub.db")
    const legacy = new Database(path, { create: true })
    legacy.exec(
      "CREATE TABLE nodes (id TEXT PRIMARY KEY, name TEXT NOT NULL, credential_hash TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_seen INTEGER)",
    )
    legacy.query("INSERT INTO nodes VALUES(?,?,?,?,?,?)").run("node-existing", "existing", "hash", 0, 1, 2)
    legacy.close()
    const store = new HubStore(path)
    expect(store.connectNode("node-existing")).toBeUndefined()
    store.close()
  })

  test("allows only one in-flight action for a pending request", () => {
    const temp = temporaryDirectory()
    cleanup.push(temp.remove)
    const store = new HubStore(join(temp.path, "hub.db"))
    const row = store.upsertPending("node-a", permission()).row
    store.createAction(row, { operation: "once", createdAt: Date.now(), expiresAt: Date.now() + 60_000 })
    expect(() =>
      store.createAction(
        { ...row, state: "pending" },
        { operation: "once", createdAt: Date.now(), expiresAt: Date.now() + 60_000 },
      ),
    ).toThrow()
    store.close()
  })

  test("reconciliation does not stale an action while OpenCode confirmation is in flight", () => {
    const temp = temporaryDirectory()
    cleanup.push(temp.remove)
    const store = new HubStore(join(temp.path, "hub.db"))
    const event = permission()
    const row = store.upsertPending("node-a", event).row
    const action = store.createAction(row, {
      operation: "once",
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    })
    expect(store.reconcileInstance("node-a", event.instanceId, new Set(), new Set([event.sessionId ?? ""]))).toEqual([])
    expect(store.getPending(row.identity)?.state).toBe("dispatching")
    store.finishAction(action.actionId, "confirmed")
    expect(store.getPending(row.identity)?.state).toBe("confirmed")
    store.close()
  })

  test("cleanup returns pending expirations so Telegram can make them non-actionable", () => {
    const temp = temporaryDirectory()
    cleanup.push(temp.remove)
    const store = new HubStore(join(temp.path, "hub.db"))
    const row = store.upsertPending("node-a", permission()).row
    store.db.query("UPDATE pending SET expires_at=1 WHERE identity=?").run(row.identity)
    expect(store.cleanup(2).map((expired) => expired.identity)).toEqual([row.identity])
    expect(store.getPending(row.identity)?.state).toBe("expired")
    store.close()
  })

  test("an old expired action cannot expire a reactivated retry", () => {
    const temp = temporaryDirectory()
    cleanup.push(temp.remove)
    const store = new HubStore(join(temp.path, "hub.db"))
    const event = permission()
    const row = store.upsertPending("node-a", event).row
    store.createAction(row, { operation: "once", createdAt: 0, expiresAt: 1 })
    store.cleanup(2)
    const reactivated = store.upsertPending("node-a", event)
    expect(reactivated.reactivated).toBeTrue()
    const retry = store.createAction(reactivated.row, { operation: "once", createdAt: 2, expiresAt: 100 })
    store.cleanup(3)
    expect(store.getPending(row.identity)?.state).toBe("dispatching")
    store.finishAction(retry.actionId, "confirmed")
    expect(store.getPending(row.identity)?.state).toBe("confirmed")
    store.close()
  })

  test("binds pending identities to their originating node", () => {
    const temp = temporaryDirectory()
    cleanup.push(temp.remove)
    const store = new HubStore(join(temp.path, "hub.db"))
    const event = permission()
    const first = store.upsertPending("node-a", event).row
    const second = store.upsertPending("node-b", event).row
    expect(first.identity).not.toBe(second.identity)
    expect(store.listPending()).toHaveLength(2)
    store.close()
  })

  test("reconciliation only stales sessions in its explicit scope", () => {
    const temp = temporaryDirectory()
    cleanup.push(temp.remove)
    const store = new HubStore(join(temp.path, "hub.db"))
    const first = permission()
    const second = {
      ...permission(),
      eventId: `evt_${crypto.randomUUID()}`,
      sessionId: "session-other",
      requestId: "permission-other",
    }
    store.upsertPending("node-a", first)
    store.upsertPending("node-a", second)
    store.reconcileInstance("node-a", first.instanceId, new Set(), new Set([first.sessionId ?? ""]))
    expect(store.listPending().map((row) => row.request_id)).toEqual(["permission-other"])
    store.close()
  })

  test("keeps only the latest bounded telemetry snapshot and expires it", () => {
    const temp = temporaryDirectory()
    cleanup.push(temp.remove)
    const store = new HubStore(join(temp.path, "hub.db"))
    const telemetry = {
      sessionId: "session-a",
      capture: "metadata" as const,
      title: "Session",
      status: "busy" as const,
      updatedAt: 1,
      cost: 0,
      tokens: { input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 },
      todos: [],
      activities: [],
    }
    store.upsertSessionTelemetry("node-a", "instance-a", telemetry)
    store.upsertSessionTelemetry("node-a", "instance-b", { ...telemetry, title: "Updated", updatedAt: 2 })
    store.upsertSessionTelemetry("node-a", "instance-c", { ...telemetry, title: "Stale", updatedAt: 1 })
    expect(store.listSessionTelemetry()).toHaveLength(1)
    expect(store.listSessionTelemetry()[0]?.payload_json).toContain("Updated")
    expect(store.listSessionTelemetry(Date.now() + 1)).toHaveLength(0)
    store.cleanup(Date.now() + 2, 1)
    expect(store.listSessionTelemetry()).toHaveLength(0)
    store.close()
  })

  test("bounds stored telemetry and disconnects all TUIs for a lost node", () => {
    const temp = temporaryDirectory()
    cleanup.push(temp.remove)
    const store = new HubStore(join(temp.path, "hub.db"))
    store.registerTui("node-a", {
      instanceId: "instance-a",
      project: "project",
      directory: "/project",
      worktree: "/project",
      pid: 1,
      hostname: "host",
      opencodeVersion: "1",
      pluginVersion: "1",
      startedAt: 1,
      location: { directory: "/project" },
      capabilities: {
        permissionReply: true,
        savedPermission: true,
        questionReply: true,
        questionReject: true,
        sessionExecutionEvents: true,
        pendingSync: true,
        workspaceRouting: true,
        locationRouting: true,
        sessionHierarchy: true,
      },
    })
    for (let index = 0; index < 140; index++) {
      store.upsertSessionTelemetry("node-a", "instance-a", {
        sessionId: `session-${index}`,
        capture: "metadata",
        status: "idle",
        updatedAt: index,
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        todos: [],
        activities: [],
      })
    }
    expect(store.listSessionTelemetry()).toHaveLength(128)
    store.disconnectNodeTuis("node-a")
    expect(store.listTuis()[0]?.connected).toBe(0)
    store.db.query("UPDATE tuis SET last_seen=1").run()
    store.disconnectNodeTuis("node-a")
    expect(store.listTuis()[0]?.last_seen).toBe(1)
    store.db.query("UPDATE tuis SET connected=1").run()
    store.disconnectAllTuis()
    expect(store.listTuis()[0]?.connected).toBe(0)
    store.clearSessionTelemetry()
    expect(store.listSessionTelemetry()).toHaveLength(0)
    store.close()
  })

  test("enforces per-session and aggregate telemetry byte quotas", () => {
    const temp = temporaryDirectory()
    cleanup.push(temp.remove)
    const store = new HubStore(join(temp.path, "hub.db"))
    const telemetry = {
      capture: "full" as const,
      status: "idle" as const,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      todos: Array.from({ length: 64 }, (_, index) => ({
        content: `todo-${index}-${"x".repeat(980)}`,
        status: "pending",
        priority: "high",
      })),
      activities: Array.from({ length: 48 }, (_, index) => ({
        id: `activity-${index}`,
        type: "tool" as const,
        title: "Tool",
        detail: "x".repeat(2400),
      })),
    }
    for (let index = 0; index < 30; index++)
      expect(
        store.upsertSessionTelemetry("node-a", "instance-a", {
          ...telemetry,
          sessionId: `session-${index}`,
          updatedAt: index,
        }),
      ).toBeTrue()
    const total = store.db
      .query("SELECT COALESCE(SUM(length(CAST(payload_json AS BLOB))),0) AS bytes FROM session_telemetry")
      .get() as { bytes: number }
    expect(total.bytes).toBeLessThanOrEqual(4 * 1024 * 1024)
    expect(
      store.upsertSessionTelemetry("node-a", "instance-a", {
        ...telemetry,
        sessionId: "session-oversized",
        title: "x".repeat(400 * 1024),
        updatedAt: 100,
      }),
    ).toBeFalse()
    store.close()
  })

  test("persists action commands and results across node store restart", () => {
    const temp = temporaryDirectory()
    cleanup.push(temp.remove)
    const path = join(temp.path, "node.db")
    const action = {
      type: "action.dispatch" as const,
      actionId: "action_persist_123456",
      instanceId: "instance_12345678",
      sessionId: "session-a",
      requestId: "request-a",
      requestKind: "permission" as const,
      operation: "once" as const,
      location: { directory: "/project" },
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    }
    const first = new NodeStore(path)
    expect(first.storeCommand(action)).toBeTrue()
    first.close()
    const second = new NodeStore(path)
    expect(second.command(action.instanceId)?.actionId).toBe(action.actionId)
    second.completeCommand(action.actionId, { type: "action.result", actionId: action.actionId })
    expect(second.command(action.instanceId)).toBeUndefined()
    expect(second.results()).toHaveLength(1)
    second.close()
  })
})
