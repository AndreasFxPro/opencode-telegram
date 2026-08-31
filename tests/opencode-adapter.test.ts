import { expect, test } from "bun:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { OpenCodeAdapter } from "../src/opencode/adapter.ts"

test("adapter confirms only after reply event, pending disappearance, and execution continuation", async () => {
  let pending: PermissionRequest[] = [
    {
      id: "request-a",
      sessionID: "session-a",
      permission: "bash",
      patterns: ["bun test"],
      always: ["bun test"],
      metadata: {},
    },
  ]
  let adapter: OpenCodeAdapter
  const api = {
    client: {
      permission: {
        reply: async () => {
          pending = []
          queueMicrotask(() => {
            adapter.observeReply("session-a", "request-a")
            adapter.observeExecution("session-a")
          })
        },
      },
      question: { reply: async () => true, reject: async () => true },
    },
    state: {
      session: {
        permission: () => pending,
        question: () => [],
        get: () => ({ id: "session-a", directory: "/project" }),
      },
    },
  } as unknown as TuiPluginApi
  adapter = new OpenCodeAdapter(api)
  const result = await adapter.apply({
    type: "action.dispatch",
    actionId: "action_12345678",
    instanceId: "instance_12345678",
    sessionId: "session-a",
    requestId: "request-a",
    requestKind: "permission",
    operation: "once",
    location: { directory: "/project" },
    createdAt: Date.now(),
    expiresAt: Date.now() + 5000,
  })
  expect(result).toMatchObject({
    ok: true,
    state: "confirmed",
    evidence: { repliedEvent: true, pendingAbsent: true, executionObserved: true },
  })
})
