import { afterEach, expect, spyOn, test } from "bun:test"
import { join } from "node:path"
import { NodeService } from "../src/node.ts"
import type { ActionDispatch } from "../src/protocol.ts"
import { sleep } from "../src/util.ts"
import { permission, temporaryDirectory, testConfig, testSecrets } from "./helpers.ts"

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const item of cleanup.splice(0).reverse()) await item()
})

function fixture() {
  const temp = temporaryDirectory()
  cleanup.push(temp.remove)
  const node = new NodeService(testConfig(temp.path), testSecrets(), join(temp.path, "node.db"))
  cleanup.push(() => node.stop())
  const sent: string[] = []
  const socket = { readyState: WebSocket.OPEN, bufferedAmount: 0, send: (raw: string) => sent.push(raw), close() {} }
  const internal = node as unknown as {
    socket: typeof socket
    hubConnected: boolean
    flush(): void
    fetch(request: Request): Promise<Response>
    waiters: Map<string, Array<(command: ActionDispatch | undefined) => void>>
  }
  internal.socket = socket
  internal.hubConnected = true
  return { node, internal, socket, sent }
}

test("repeated flushes neither duplicate unacknowledged messages nor send into a full buffer", () => {
  const { node, internal, socket, sent } = fixture()
  for (let index = 0; index < 100; index++) node.store.enqueue(permission(), 1000)
  node.store.completeCommand("action-1", { type: "action.result", actionId: "action-1" })
  socket.bufferedAmount = 8 * 1024 * 1024
  for (let index = 0; index < 100; index++) internal.flush()
  expect(sent).toHaveLength(0)
  socket.bufferedAmount = 0
  for (let index = 0; index < 100; index++) internal.flush()
  expect(sent.map((raw) => JSON.parse(raw).type)).toEqual(["action.result", "event"])
  expect(node.store.pendingCount()).toBe(100)
  expect(node.store.results()).toHaveLength(1)
})

test("settled and already-aborted polls release their waiter entries and abort listeners", async () => {
  const { internal } = fixture()
  for (const aborted of [false, true]) {
    const controller = new AbortController()
    if (aborted) controller.abort()
    const request = new Request("http://localhost/v1/commands?instanceId=test-instance", {
      headers: { authorization: `Bearer ${testSecrets().localPluginSecret}` },
      signal: controller.signal,
    })
    const remove = spyOn(request.signal, "removeEventListener")
    const response = internal.fetch(request)
    if (!aborted) internal.waiters.get("test-instance")?.[0]?.(undefined)
    expect(await (await response).json()).toEqual({ command: null })
    expect(internal.waiters.size).toBe(0)
    expect(remove).toHaveBeenCalledTimes(1)
    remove.mockRestore()
  }
})

test("plugin retries reuse the queued event instead of creating another sequence", () => {
  const { node } = fixture()
  const event = permission()
  for (let index = 0; index < 100; index++) expect(node.store.enqueue(event, 100)).toBe(true)
  expect(node.store.pendingCount()).toBe(1)
})

test("completed retry sleeps remove listeners from the long-lived shutdown signal", async () => {
  const controller = new AbortController()
  const remove = spyOn(controller.signal, "removeEventListener")
  await sleep(1, controller.signal)
  expect(remove).toHaveBeenCalledTimes(1)
  remove.mockRestore()
  const pending = sleep(60_000, controller.signal)
  controller.abort(new Error("stopped"))
  await expect(pending).rejects.toThrow("stopped")
})
