import { afterEach, expect, test } from "bun:test"
import { join } from "node:path"
import { Hub } from "../../src/hub.ts"
import { NodeService } from "../../src/node.ts"
import { eventually, metadata, permission, temporaryDirectory, testConfig, testSecrets } from "../helpers.ts"

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const item of cleanup.splice(0).reverse()) await item()
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
