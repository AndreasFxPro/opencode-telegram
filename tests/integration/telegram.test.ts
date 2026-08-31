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

function stringContentLength(value: unknown): number {
  if (typeof value === "string") return value.length
  if (Array.isArray(value)) return value.reduce((total, item) => total + stringContentLength(item), 0)
  if (value && typeof value === "object")
    return Object.values(value as Record<string, unknown>).reduce(
      (total: number, item) => total + stringContentLength(item),
      0,
    )
  return 0
}

test("fake Telegram callback dispatches one opaque action for an authorized approver", async () => {
  const temp = temporaryDirectory()
  cleanup.push(temp.remove)
  const updates: unknown[] = []
  const calls: Array<{ method: string; body: Record<string, unknown> }> = []
  let messageId = 100
  let failNextAnswer = false
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
      if (method === "sendMessage" || method === "sendRichMessage")
        return Response.json({ ok: true, result: { message_id: messageId++, chat: { id: body.chat_id } } })
      if (method === "answerCallbackQuery" && failNextAnswer) {
        failNextAnswer = false
        return Response.json({ ok: false, error_code: 400, description: "query is too old" })
      }
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
    dashboardSnapshot: () => ({
      generatedAt: Date.now(),
      totals: { nodes: 1, connectedNodes: 1, sessions: 0, busy: 0, pending: 1, cost: 0 },
      sessions: [],
    }),
    dispatch: async (pending, operation) => {
      dispatched.push({ row: pending, operation })
    },
  }
  const gateway = new TelegramGateway(config, "123456789:abcdefghijklmnopqrstuvwxyz", store, hub)
  cleanup.push(() => gateway.stop())
  await gateway.validate()
  expect(await gateway.notifyNodeJoined("node-joined-123456789", "<build&node>")).toBe(1)
  const joined = calls.find((call) => call.method === "sendMessage" && String(call.body.text).includes("Node joined"))
  expect(joined?.body.text).toContain("&lt;build&amp;node&gt;")
  expect(joined?.body.text).not.toContain("<build&node>")
  config.telegram.authorizedChats.push({ id: 42, role: "approver" })
  await Promise.all([gateway.notifyPending(row), gateway.notifyPending(row)])
  expect(calls.filter((call) => call.method === "sendMessage" && call.body.reply_markup)).toHaveLength(1)
  const sent = calls.find((call) => call.method === "sendMessage" && call.body.reply_markup)
  expect(sent?.body.text).toContain("Ref: <code>mission-test</code>")
  expect(sent?.body.text).toContain("origin <code>12345678</code>")
  const keyboard = sent?.body.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> }
  const callbackData = keyboard.inline_keyboard[0]?.[0]?.callback_data
  const pendingMessageId = store.telegramMessages(row.identity)[0]?.message_id
  expect(callbackData?.length).toBeLessThanOrEqual(64)
  failNextAnswer = true
  updates.push({
    update_id: 1,
    callback_query: {
      id: "callback-1",
      data: callbackData,
      from: { id: 42 },
      message: { message_id: pendingMessageId, chat: { id: 42 } },
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
      message: { message_id: pendingMessageId, chat: { id: 99 } },
    },
  })
  await Bun.sleep(100)
  expect(dispatched).toHaveLength(1)
  const feedbackData = keyboard.inline_keyboard[1]?.[0]?.callback_data
  failNextAnswer = true
  updates.push({
    update_id: 3,
    callback_query: {
      id: "callback-feedback",
      data: feedbackData,
      from: { id: 42 },
      message: { message_id: pendingMessageId, chat: { id: 42 } },
    },
  })
  await eventually(() => store.telegramOffset() >= 4)
  expect(store.getPending(row.identity)?.draft_json).toContain("reject_feedback")

  const unsafe = store.upsertPending("node-a", {
    ...permission("tui_unsafe_12345678"),
    eventId: `evt_${crypto.randomUUID()}`,
    requestId: "permission-unsafe",
    patterns: Array.from({ length: 9 }, (_, index) => `command-${index}`),
  }).row
  await gateway.notifyPending(unsafe)
  const unsafeSend = calls.filter((call) => call.method === "sendMessage").at(-1)
  expect(unsafeSend?.body.reply_markup).toEqual({ inline_keyboard: [] })
  expect(calls.filter((call) => call.method === "sendMessage" && call.body.reply_markup)).toHaveLength(2)
})

test("viewer navigates a read-only Telegram dashboard with opaque bound callbacks", async () => {
  const temp = temporaryDirectory()
  cleanup.push(temp.remove)
  const updates: unknown[] = []
  const calls: Array<{ method: string; body: Record<string, unknown> }> = []
  let messageId = 200
  let failNextEdit = false
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
      if (method === "sendMessage" || method === "sendRichMessage")
        return Response.json({ ok: true, result: { message_id: messageId++, chat: { id: body.chat_id } } })
      if (method === "editMessageText" && failNextEdit) {
        failNextEdit = false
        return Response.json({ ok: false, error_code: 400, description: "message to edit not found" })
      }
      return Response.json({ ok: true, result: true })
    },
  })
  cleanup.push(() => server.stop(true))
  const config = testConfig(temp.path)
  config.telegram.apiBase = `http://127.0.0.1:${server.port}`
  config.telegram.authorizedChats = [{ id: 42, role: "viewer", threadId: 7 }]
  config.telegram.authorizedUsers = [{ id: 42, role: "viewer" }]
  config.telegram.pollTimeoutSeconds = 1
  const store = new HubStore(join(temp.path, "hub.db"))
  cleanup.push(() => store.close())
  let dispatches = 0
  const hub: HubView = {
    uptimeMs: () => 1000,
    connectedNodeIds: () => ["node-a"],
    dashboardSnapshot: () => ({
      generatedAt: Date.now(),
      totals: { nodes: 1, connectedNodes: 0, sessions: 1, busy: 0, pending: 0, cost: 0.25 },
      sessions: [
        {
          key: "node-a:session-private",
          nodeId: "node-a",
          nodeName: "build-node",
          instanceId: "tui-dashboard-1",
          project: "<unsafe-project>",
          connected: false,
          sessionId: "session-private",
          capture: "full",
          title: "<b>Unsafe title</b>",
          status: "busy",
          updatedAt: Date.now(),
          agent: "build",
          model: "model-a",
          provider: "provider-a",
          cost: 0.25,
          tokens: { input: 100, output: 20, reasoning: 5, cacheRead: 40, cacheWrite: 2 },
          todos: [{ content: `Review <secret> ${"&".repeat(900)}`, status: "in_progress", priority: "high" }],
          activities: [
            ...Array.from({ length: 9 }, (_, index) => ({
              id: `activity-${index}`,
              type: "tool" as const,
              title: `Retained activity ${index}`,
              status: "completed",
              detail: `${index}:${"x".repeat(2398)}`,
            })),
            {
              id: "activity-a",
              type: "tool",
              title: "Run <tool>",
              status: "completed",
              detail: "Output <script>alert(1)</script>",
            },
            {
              id: "activity-b",
              type: "thought",
              title: "&".repeat(200),
              detail: "&".repeat(2200),
            },
          ],
        },
      ],
    }),
    dispatch: async () => {
      dispatches++
    },
  }
  const gateway = new TelegramGateway(config, "123456789:abcdefghijklmnopqrstuvwxyz", store, hub)
  cleanup.push(() => gateway.stop())
  await gateway.validate()
  gateway.start()
  updates.push({
    update_id: 1,
    message: { message_id: 10, message_thread_id: 7, chat: { id: 42 }, from: { id: 42 }, text: "/dashboard" },
  })
  await eventually(() => calls.some((call) => call.method === "sendRichMessage" && call.body.reply_markup))
  const sent = calls.find((call) => call.method === "sendRichMessage" && call.body.reply_markup)
  expect(sent?.body.message_thread_id).toBe(7)
  expect(sent?.body.text).toBeUndefined()
  expect(sent?.body.rich_message).toMatchObject({ skip_entity_detection: true })
  const listKeyboard = sent?.body.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> }
  const openData = listKeyboard.inline_keyboard[0]?.[0]?.callback_data
  expect(openData?.length).toBeLessThanOrEqual(64)
  expect(openData).not.toContain("session-private")
  updates.push({
    update_id: 2,
    callback_query: {
      id: "dashboard-unauthorized",
      data: openData,
      from: { id: 99 },
      message: { message_id: 200, message_thread_id: 7, chat: { id: 42 } },
    },
  })
  await Bun.sleep(100)
  expect(calls.filter((call) => call.method === "editMessageText")).toHaveLength(0)
  updates.push({
    update_id: 3,
    callback_query: {
      id: "dashboard-wrong-message",
      data: openData,
      from: { id: 42 },
      message: { message_id: 201, message_thread_id: 7, chat: { id: 42 } },
    },
  })
  await Bun.sleep(100)
  expect(calls.filter((call) => call.method === "editMessageText")).toHaveLength(0)
  updates.push({
    update_id: 4,
    callback_query: {
      id: "dashboard-open",
      data: openData,
      from: { id: 42 },
      message: { message_id: 200, message_thread_id: 7, chat: { id: 42 } },
    },
  })
  await eventually(() => calls.filter((call) => call.method === "editMessageText").length === 1)
  const detail = calls.filter((call) => call.method === "editMessageText")[0]
  expect(detail?.body.text).toBeUndefined()
  const detailRich = detail?.body.rich_message as { blocks: Array<Record<string, unknown>> }
  expect(detailRich).toMatchObject({ skip_entity_detection: true })
  expect(detailRich.blocks).toContainEqual(expect.objectContaining({ type: "heading", text: "<b>Unsafe title</b>" }))
  expect(detailRich.blocks).toContainEqual(expect.objectContaining({ type: "table" }))
  expect(JSON.stringify(detailRich.blocks)).toContain("<unsafe-project>")
  expect(JSON.stringify(detailRich.blocks)).toContain("offline")
  const detailKeyboard = detail?.body.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> }
  const activityData = detailKeyboard.inline_keyboard[0]?.[0]?.callback_data
  expect(activityData?.length).toBeLessThanOrEqual(64)
  updates.push({
    update_id: 5,
    callback_query: {
      id: "dashboard-activity",
      data: activityData,
      from: { id: 42 },
      message: { message_id: 200, message_thread_id: 7, chat: { id: 42 } },
    },
  })
  await eventually(() => calls.filter((call) => call.method === "editMessageText").length === 2)
  const activity = calls.filter((call) => call.method === "editMessageText")[1]
  expect(activity?.body.text).toBeUndefined()
  const activityRich = activity?.body.rich_message as { blocks: Array<Record<string, unknown>> }
  const activityJson = JSON.stringify(activityRich.blocks)
  expect(activityJson).toContain("Output <script>alert(1)</script>")
  expect(stringContentLength(activityRich)).toBeLessThanOrEqual(32_768)
  expect(activityRich.blocks.filter((block) => block.type === "details")).toHaveLength(8)
  expect(activityRich.blocks.filter((block) => block.type === "details").every((block) => !block.is_open)).toBe(true)
  const activityKeyboard = activity?.body.reply_markup as {
    inline_keyboard: Array<Array<{ text: string; callback_data: string }>>
  }
  const nextData = activityKeyboard.inline_keyboard.flat().find((button) => button.text === "→")?.callback_data
  updates.push({
    update_id: 6,
    callback_query: {
      id: "dashboard-next-activity",
      data: nextData,
      from: { id: 42 },
      message: { message_id: 200, message_thread_id: 7, chat: { id: 42 } },
    },
  })
  await eventually(() => calls.filter((call) => call.method === "editMessageText").length === 3)
  const nextPage = calls.filter((call) => call.method === "editMessageText")[2]
  const nextPageRich = nextPage?.body.rich_message as { blocks: Array<Record<string, unknown>> }
  expect(nextPageRich.blocks.filter((block) => block.type === "details")).toHaveLength(3)
  const fullData = activityKeyboard.inline_keyboard.flat().find((button) => button.text === "Show full")?.callback_data
  updates.push({
    update_id: 7,
    callback_query: {
      id: "dashboard-full",
      data: fullData,
      from: { id: 42 },
      message: { message_id: 200, message_thread_id: 7, chat: { id: 42 } },
    },
  })
  await eventually(() => calls.filter((call) => call.method === "editMessageText").length === 4)
  const full = calls.filter((call) => call.method === "editMessageText")[3]
  const fullRich = full?.body.rich_message as { blocks: Array<Record<string, unknown>> }
  expect(fullRich.blocks.filter((block) => block.type === "details").every((block) => block.is_open === true)).toBe(
    true,
  )
  const fullKeyboard = full?.body.reply_markup as {
    inline_keyboard: Array<Array<{ text: string; callback_data: string }>>
  }
  const refreshData = fullKeyboard.inline_keyboard.flat().find((button) => button.text === "↻ Refresh")?.callback_data
  failNextEdit = true
  updates.push({
    update_id: 8,
    callback_query: {
      id: "dashboard-refresh",
      data: refreshData,
      from: { id: 42 },
      message: { message_id: 200, message_thread_id: 7, chat: { id: 42 } },
    },
  })
  await eventually(() => store.telegramOffset() >= 9)
  expect(calls.filter((call) => call.method === "editMessageText")).toHaveLength(5)
  updates.push({
    update_id: 9,
    callback_query: {
      id: "dashboard-refresh-retry",
      data: refreshData,
      from: { id: 42 },
      message: { message_id: 200, message_thread_id: 7, chat: { id: 42 } },
    },
  })
  await eventually(() => calls.filter((call) => call.method === "editMessageText").length === 6)
  updates.push({
    update_id: 10,
    callback_query: {
      id: "dashboard-stale",
      data: openData,
      from: { id: 42 },
      message: { message_id: 200, message_thread_id: 7, chat: { id: 42 } },
    },
  })
  await eventually(() => store.telegramOffset() >= 11)
  expect(calls.filter((call) => call.method === "editMessageText")).toHaveLength(6)
  updates.push({
    update_id: 11,
    message: { message_id: 11, message_thread_id: 7, chat: { id: 42 }, from: { id: 42 }, text: "/status" },
  })
  await eventually(() => calls.filter((call) => call.method === "sendMessage").length === 1)
  for (const edit of calls.filter((call) => call.method === "editMessageText")) {
    if (edit.body.text) expect(String(edit.body.text).length).toBeLessThanOrEqual(4096)
    else expect(edit.body.rich_message).toBeDefined()
  }
  expect(dispatches).toBe(0)
})

test("Telegram dashboard remembers an HTML fallback when rich messages are unavailable", async () => {
  const temp = temporaryDirectory()
  cleanup.push(temp.remove)
  const updates: unknown[] = []
  const calls: Array<{ method: string; body: Record<string, unknown> }> = []
  let messageId = 300
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const method = new URL(request.url).pathname.split("/").at(-1) ?? ""
      const body = (await request.json()) as Record<string, unknown>
      calls.push({ method, body })
      if (method === "getMe") return Response.json({ ok: true, result: { username: "legacy_bot" } })
      if (method === "getUpdates") {
        await Bun.sleep(10)
        return Response.json({ ok: true, result: updates.splice(0) })
      }
      if (method === "sendRichMessage")
        return Response.json({ ok: false, error_code: 404, description: "Not Found: method not found" })
      if (method === "sendMessage")
        return Response.json({ ok: true, result: { message_id: messageId++, chat: { id: body.chat_id } } })
      return Response.json({ ok: true, result: true })
    },
  })
  cleanup.push(() => server.stop(true))
  const config = testConfig(temp.path)
  config.telegram.apiBase = `http://127.0.0.1:${server.port}`
  config.telegram.authorizedChats = [{ id: 42, role: "viewer" }]
  config.telegram.authorizedUsers = [{ id: 42, role: "viewer" }]
  config.telegram.pollTimeoutSeconds = 1
  const store = new HubStore(join(temp.path, "hub.db"))
  cleanup.push(() => store.close())
  const hub: HubView = {
    uptimeMs: () => 1000,
    connectedNodeIds: () => [],
    dashboardSnapshot: () => ({
      generatedAt: Date.now(),
      totals: { nodes: 0, connectedNodes: 0, sessions: 0, busy: 0, pending: 0, cost: 0 },
      sessions: [],
    }),
    dispatch: async () => undefined,
  }
  const gateway = new TelegramGateway(config, "123456789:abcdefghijklmnopqrstuvwxyz", store, hub)
  cleanup.push(() => gateway.stop())
  await gateway.validate()
  gateway.start()
  updates.push(
    {
      update_id: 1,
      message: { message_id: 10, chat: { id: 42 }, from: { id: 42 }, text: "/dashboard" },
    },
    {
      update_id: 2,
      message: { message_id: 11, chat: { id: 42 }, from: { id: 42 }, text: "/sessions" },
    },
  )
  await eventually(() => calls.filter((call) => call.method === "sendMessage").length === 2)
  expect(calls.filter((call) => call.method === "sendRichMessage")).toHaveLength(1)
  for (const fallback of calls.filter((call) => call.method === "sendMessage")) {
    expect(fallback.body.parse_mode).toBe("HTML")
    expect(String(fallback.body.text).length).toBeLessThanOrEqual(4096)
    expect(fallback.body.rich_message).toBeUndefined()
  }
})
