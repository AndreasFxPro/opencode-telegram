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
    expect(node?.nodeName).toBe("machine-a")
    expect(store.exchangeEnrollment(enrollment.token)).toBeUndefined()
    expect(store.authenticateNode(node?.nodeId ?? "", node?.credential ?? "")).toBeTrue()
    store.revokeNode(node?.nodeId ?? "")
    expect(store.authenticateNode(node?.nodeId ?? "", node?.credential ?? "")).toBeFalse()
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
