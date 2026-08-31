import { expect, test } from "bun:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { boundedTelemetry, sessionTelemetry } from "../src/opencode/telemetry.ts"
import { MAX_TELEMETRY_BATCH_BYTES, SessionTelemetrySchema } from "../src/protocol.ts"

const session = {
  id: "session-a",
  slug: "session-a",
  projectID: "project-a",
  directory: "/private/project",
  title: "Telemetry test",
  version: "1",
  agent: "build",
  model: { id: "model-a", providerID: "provider-a" },
  cost: 0.25,
  tokens: { input: 100, output: 20, reasoning: 4, cache: { read: 30, write: 2 } },
  time: { created: 1, updated: 2 },
}

function api(options: { toolTitle?: string; toolOutput?: string } = {}) {
  return {
    state: {
      session: {
        get: () => session,
        status: () => ({ type: "busy" }),
        messages: () => [
          {
            id: "message-a",
            sessionID: "session-a",
            role: "assistant",
            time: { created: 1 },
            parentID: "message-user",
            modelID: "model-a",
            providerID: "provider-a",
            mode: "build",
            agent: "build",
            path: { cwd: "/private/project", root: "/private/project" },
            cost: 0.25,
            tokens: { input: 100, output: 20, reasoning: 4, cache: { read: 30, write: 2 } },
          },
        ],
        todo: () => [{ content: "Private todo", status: "in_progress" }],
      },
      part: () => [
        {
          id: "reasoning-a",
          sessionID: "session-a",
          messageID: "message-a",
          type: "reasoning",
          text: "Explicit thought",
          time: { start: 10 },
        },
        {
          id: "tool-a",
          sessionID: "session-a",
          messageID: "message-a",
          type: "tool",
          callID: "call-a",
          tool: "bash",
          state: {
            status: "completed",
            input: { command: "secret-command" },
            output: options.toolOutput ?? "secret-output",
            title: options.toolTitle ?? "Run command",
            metadata: {},
            time: { start: 11, end: 12 },
          },
        },
        {
          id: "retry-a",
          sessionID: "session-a",
          messageID: "message-a",
          type: "retry",
          attempt: 1,
          error: { data: { message: "private retry error" } },
          time: { created: 13 },
        },
        {
          id: "text-a",
          sessionID: "session-a",
          messageID: "message-a",
          type: "text",
          text: "Private response",
        },
      ],
    },
  } as unknown as TuiPluginApi
}

test("telemetry capture levels progressively expose session content", () => {
  const metadata = sessionTelemetry(api(), "session-a", "metadata")
  expect(metadata).toMatchObject({ cost: 0.25, status: "busy", tokens: { input: 100, cacheRead: 30 } })
  expect(metadata?.title).toBeUndefined()
  expect(metadata?.activities).toEqual([])
  expect(metadata?.todos).toEqual([])
  const activity = sessionTelemetry(api(), "session-a", "activity")
  expect(activity?.title).toBeUndefined()
  expect(activity?.todos[0]?.content).toBe("Private todo")
  expect(activity?.activities.map((item) => item.type)).toEqual(["thought", "tool", "retry"])
  expect(JSON.stringify(activity)).toContain("secret-command")
  expect(JSON.stringify(activity)).not.toContain("secret-output")
  expect(JSON.stringify(activity)).not.toContain("private retry error")
  expect(JSON.stringify(activity)).not.toContain("Private response")
  const full = sessionTelemetry(api(), "session-a", "full")
  expect(JSON.stringify(full)).toContain("secret-output")
  expect(JSON.stringify(full)).toContain("private retry error")
  expect(JSON.stringify(full)).toContain("Private response")
})

test("generated telemetry is schema-valid and batches stay below the UTF-8 byte budget", () => {
  const telemetry = sessionTelemetry(
    api({ toolTitle: "t".repeat(1000), toolOutput: "output".repeat(1000) }),
    "session-a",
    "full",
  )
  expect(telemetry).toBeDefined()
  expect(telemetry?.activities.find((item) => item.type === "tool")?.title.length).toBeLessThanOrEqual(256)
  expect(telemetry?.activities.find((item) => item.type === "tool")?.detail?.length).toBeLessThanOrEqual(2400)
  const large = Array.from({ length: 8 }, (_, sessionIndex) => ({
    ...(telemetry as NonNullable<typeof telemetry>),
    sessionId: `session-${sessionIndex}`,
    todos: Array.from({ length: 64 }, (_, index) => ({
      content: "界".repeat(1000),
      status: `todo-${index}`,
      priority: "high",
    })),
    activities: Array.from({ length: 48 }, (_, index) => ({
      id: `activity-${sessionIndex}-${index}`,
      type: "tool" as const,
      title: "界".repeat(256),
      detail: "界".repeat(2400),
    })),
  }))
  const bounded = boundedTelemetry(large)
  expect(new TextEncoder().encode(JSON.stringify(bounded)).byteLength).toBeLessThanOrEqual(MAX_TELEMETRY_BATCH_BYTES)
  expect(bounded.length).toBeGreaterThan(0)
  for (const item of bounded) expect(SessionTelemetrySchema.safeParse(item).success).toBeTrue()
})
