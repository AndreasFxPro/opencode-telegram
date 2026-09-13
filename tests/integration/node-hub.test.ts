import { afterEach, expect, test } from "bun:test"
import { join } from "node:path"
import type { ServerWebSocket } from "bun"
import { Hub } from "../../src/hub.ts"
import { NodeService } from "../../src/node.ts"
import { PROTOCOL_VERSION } from "../../src/version.ts"
import { eventually, metadata, permission, temporaryDirectory, testConfig, testSecrets } from "../helpers.ts"

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const item of cleanup.splice(0).reverse()) await item()
})

test("slow ACKs bound delivery and reconnect replays only unacknowledged messages", async () => {
  const temp = temporaryDirectory()
  cleanup.push(temp.remove)
  let socket: ServerWebSocket<undefined> | undefined
  const received: Array<{ type: string; seq?: number; actionId?: string }> = []
  const server = Bun.serve<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return
      return new Response("Expected WebSocket", { status: 400 })
    },
    websocket: {
      message(ws, raw) {
        const message = JSON.parse(String(raw))
        if (message.type === "hello") {
          socket = ws
          ws.send(
            JSON.stringify({
              type: "welcome",
              protocolVersion: PROTOCOL_VERSION,
              heartbeatMs: 15_000,
              telegramReachable: false,
            }),
          )
        } else if (message.type !== "heartbeat") received.push(message)
      },
    },
  })
  cleanup.push(() => server.stop(true))
  const config = testConfig(temp.path, server.port, 51000 + Math.floor(Math.random() * 500))
  const node = new NodeService(config, testSecrets(), join(temp.path, "node.db"))
  for (let index = 0; index < 3; index++) node.store.enqueue(permission(), 100)
  for (const actionId of ["action-one", "action-two"])
    node.store.completeCommand(actionId, { type: "action.result", actionId, ok: true, state: "confirmed" })
  await node.start()
  cleanup.push(() => node.stop())
  await eventually(() => received.length === 2)
  await Bun.sleep(600)
  expect(received).toHaveLength(2)
  socket?.send(JSON.stringify({ type: "ack", seq: 1 }))
  socket?.send(JSON.stringify({ type: "action.ack", actionId: "action-one" }))
  await eventually(() => received.length === 4)
  expect(node.store.pending().map((row) => row.seq)).toEqual([2, 3])
  const previous = socket
  socket?.close()
  await eventually(() => socket !== previous && received.length === 6)
  expect(received.filter((message) => message.type === "event").map((message) => message.seq)).toEqual([1, 2, 2])
  expect(received.filter((message) => message.type === "action.result").map((message) => message.actionId)).toEqual([
    "action-one",
    "action-two",
    "action-two",
  ])
  // Stale ACKs must not release the current in-flight message.
  socket?.send(JSON.stringify({ type: "ack", seq: 1 }))
  socket?.send(JSON.stringify({ type: "ack", seq: 2 }))
  socket?.send(JSON.stringify({ type: "action.ack", actionId: "action-two" }))
  await eventually(() => received.length === 7)
  socket?.send(JSON.stringify({ type: "ack", seq: 3 }))
  await eventually(() => node.store.pendingCount() === 0 && node.store.results().length === 0)
})

test("node routes an idempotent action only to the originating TUI", async () => {
  const temp = temporaryDirectory()
  cleanup.push(temp.remove)
  const offset = Math.floor(Math.random() * 500)
  const config = testConfig(temp.path, 49100 + offset, 49600 + offset)
  const secrets = testSecrets()
  const hub = new Hub(config, secrets, join(temp.path, "hub.db"))
  hub.store.ensureNode(secrets.nodeId, config.node.name, secrets.nodeCredential ?? "")
  await hub.start()
  cleanup.push(() => hub.stop())
  const node = new NodeService(config, secrets, join(temp.path, "node.db"))
  await node.start()
  cleanup.push(() => node.stop())
  const auth = { authorization: `Bearer ${secrets.localPluginSecret}`, "content-type": "application/json" }
  const base = `http://${config.node.localListen}`
  await fetch(`${base}/v1/plugin`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ type: "register", metadata: metadata() }),
  })
  const event = permission()
  await fetch(`${base}/v1/plugin`, { method: "POST", headers: auth, body: JSON.stringify({ type: "event", event }) })
  await eventually(() => hub.store.listPending().length === 1)
  const row = hub.store.listPending()[0]
  if (!row) throw new Error("Pending row missing")
  await hub.dispatch(row, "once")
  const commandResponse = await fetch(`${base}/v1/commands?instanceId=${encodeURIComponent(event.instanceId)}`, {
    headers: auth,
  })
  const commandBody = (await commandResponse.json()) as {
    command: { actionId: string; requestId: string; instanceId: string }
  }
  expect(commandBody.command).toMatchObject({ requestId: event.requestId, instanceId: event.instanceId })
  await fetch(`${base}/v1/plugin`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      type: "action.result",
      actionId: commandBody.command.actionId,
      ok: true,
      state: "confirmed",
      evidence: { repliedEvent: true, pendingAbsent: true, executionObserved: true },
    }),
  })
  await eventually(() => hub.store.getPending(row.identity)?.state === "confirmed")

  const unconfirmedEvent = {
    ...permission(),
    eventId: `evt_${crypto.randomUUID()}`,
    requestId: "permission-unconfirmed",
  }
  await fetch(`${base}/v1/plugin`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ type: "event", event: unconfirmedEvent }),
  })
  await eventually(() => hub.store.listPending().some((pending) => pending.request_id === unconfirmedEvent.requestId))
  const unconfirmed = hub.store.listPending().find((pending) => pending.request_id === unconfirmedEvent.requestId)
  if (!unconfirmed) throw new Error("Unconfirmed pending row missing")
  await hub.dispatch(unconfirmed, "once")
  const unconfirmedCommandResponse = await fetch(
    `${base}/v1/commands?instanceId=${encodeURIComponent(unconfirmedEvent.instanceId)}`,
    { headers: auth },
  )
  const unconfirmedCommandBody = (await unconfirmedCommandResponse.json()) as { command: { actionId: string } }
  await fetch(`${base}/v1/plugin`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      type: "action.result",
      actionId: unconfirmedCommandBody.command.actionId,
      ok: false,
      state: "failed",
      detail: "OpenCode did not confirm resolution: missing session continuation event",
      evidence: { repliedEvent: true, pendingAbsent: true, executionObserved: false },
    }),
  })
  await eventually(() => hub.store.getPending(unconfirmed.identity)?.state === "failed")
})

test("replayed completion events with new sequence numbers notify only once", async () => {
  const temp = temporaryDirectory()
  cleanup.push(temp.remove)
  const offset = Math.floor(Math.random() * 400)
  const config = testConfig(temp.path, 52000 + offset, 52500 + offset)
  config.notifications.nodeJoin = false
  const secrets = testSecrets()
  const hub = new Hub(config, secrets, join(temp.path, "hub.db"))
  let notifications = 0
  // Exercise real protocol delivery and durable deduplication while replacing
  // only the external Telegram side effect.
  const internal = hub as unknown as { telegram: { notifyExecution(): Promise<void> } | undefined }
  await hub.start()
  internal.telegram = {
    async notifyExecution() {
      notifications++
    },
  }
  cleanup.push(async () => {
    internal.telegram = undefined
    await hub.stop()
  })
  hub.store.ensureNode(secrets.nodeId, config.node.name, secrets.nodeCredential ?? "")
  const node = new NodeService(config, secrets, join(temp.path, "node.db"))
  const event = { ...permission(), type: "execution.succeeded", durationMs: 63_000 }
  // Simulate an existing spool produced by an older node, before enqueue deduplication.
  for (let index = 0; index < 100; index++)
    node.store.db
      .query("INSERT INTO spool(payload_json,kind,created_at) VALUES(?,'telemetry',?)")
      .run(JSON.stringify(event), Date.now())
  await node.start()
  cleanup.push(() => node.stop())
  await eventually(() => node.store.pendingCount() === 0)
  expect(notifications).toBe(1)
})

test("node reports a full correctness-critical spool as retryable", async () => {
  const temp = temporaryDirectory()
  cleanup.push(temp.remove)
  const offset = Math.floor(Math.random() * 400)
  const config = testConfig(temp.path, 50100 + offset, 50500 + offset)
  config.node.queueLimit = 100
  const secrets = testSecrets()
  const node = new NodeService(config, secrets, join(temp.path, "node.db"))
  await node.start()
  cleanup.push(() => node.stop())
  const auth = { authorization: `Bearer ${secrets.localPluginSecret}`, "content-type": "application/json" }
  const base = `http://${config.node.localListen}`
  for (let index = 0; index < 100; index++) {
    const event = { ...permission(), eventId: `evt_${crypto.randomUUID()}` }
    const response = await fetch(`${base}/v1/plugin`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ type: "event", event }),
    })
    expect(response.status).toBe(202)
  }
  const response = await fetch(`${base}/v1/plugin`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ type: "event", event: { ...permission(), eventId: `evt_${crypto.randomUUID()}` } }),
  })
  expect(response.status).toBe(503)
})
