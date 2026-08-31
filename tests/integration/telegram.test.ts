import { afterEach, expect, test } from "bun:test"
import { join } from "node:path"
import { HubStore, type PendingRow } from "../../src/store.ts"
import type { HubView } from "../../src/telegram.ts"
import { TelegramGateway } from "../../src/telegram.ts"
import { eventually, permission, temporaryDirectory, testConfig } from "../helpers.ts"

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const item of cleanup.splice(0).reverse()) await item()
})

test("fake Telegram callback dispatches one opaque action for an authorized approver", async () => {
  const temp = temporaryDirectory()
  cleanup.push(temp.remove)
  const updates: unknown[] = []
  const calls: Array<{ method: string; body: Record<string, unknown> }> = []
  let messageId = 100
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const method = new URL(request.url).pathname.split("/").at(-1) ?? ""
      const body = (await request.json()) as Record<string, unknown>
      calls.push({ method, body })
      if (method === "getMe") return Response.json({ ok: true, result: { username: "fake_bot" } })
      if (method === "getUpdates") {
        await Bun.sleep(10)
        return Response.json({ ok: true, result: updates.splice(0) })
      }
      if (method === "sendMessage")
        return Response.json({ ok: true, result: { message_id: messageId++, chat: { id: body.chat_id } } })
      return Response.json({ ok: true, result: true })
    },
  })
  cleanup.push(() => server.stop(true))
  const config = testConfig(temp.path)
  config.telegram.apiBase = `http://127.0.0.1:${server.port}`
  config.telegram.authorizedChats = [{ id: 42, role: "approver" }]
  config.telegram.authorizedUsers = [{ id: 42, role: "approver" }]
  config.telegram.pollTimeoutSeconds = 1
  const store = new HubStore(join(temp.path, "hub.db"))
  cleanup.push(() => store.close())
  const row = store.upsertPending("node-a", permission()).row
  const dispatched: Array<{ row: PendingRow; operation: string }> = []
  const hub: HubView = {
    uptimeMs: () => 1000,
    connectedNodeIds: () => ["node-a"],
    dispatch: async (pending, operation) => {
      dispatched.push({ row: pending, operation })
    },
  }
  const gateway = new TelegramGateway(config, "123456789:abcdefghijklmnopqrstuvwxyz", store, hub)
  cleanup.push(() => gateway.stop())
  await gateway.validate()
  await gateway.notifyPending(row)
  const sent = calls.find((call) => call.method === "sendMessage")
  const keyboard = sent?.body.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> }
  const callbackData = keyboard.inline_keyboard[0]?.[0]?.callback_data
  expect(callbackData?.length).toBeLessThanOrEqual(64)
  updates.push({
    update_id: 1,
    callback_query: {
      id: "callback-1",
      data: callbackData,
      from: { id: 42 },
      message: { message_id: 100, chat: { id: 42 } },
    },
  })
  gateway.start()
  await eventually(() => dispatched.length === 1)
  expect(dispatched[0]).toMatchObject({ operation: "once" })
  updates.push({
    update_id: 2,
    callback_query: {
      id: "callback-2",
      data: callbackData,
      from: { id: 99 },
      message: { message_id: 100, chat: { id: 99 } },
    },
  })
  await Bun.sleep(100)
  expect(dispatched).toHaveLength(1)

  const unsafe = store.upsertPending("node-a", {
    ...permission("tui_unsafe_12345678"),
    eventId: `evt_${crypto.randomUUID()}`,
    requestId: "permission-unsafe",
    patterns: Array.from({ length: 9 }, (_, index) => `command-${index}`),
  }).row
  await gateway.notifyPending(unsafe)
  const unsafeSend = calls.filter((call) => call.method === "sendMessage").at(-1)
  expect(unsafeSend?.body.reply_markup).toEqual({ inline_keyboard: [] })
})
