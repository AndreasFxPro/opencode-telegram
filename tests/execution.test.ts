import { expect, test } from "bun:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { ConfigSchema } from "../src/config.ts"
import { completionReport, executionDetails } from "../src/opencode/execution.ts"
import { BridgeEventSchema } from "../src/protocol.ts"
import { renderExecution } from "../src/telegram.ts"

const notifications = ConfigSchema.parse({}).notifications
const event = {
  type: "execution.succeeded" as const,
  eventId: "event-completed",
  emittedAt: 5000,
  instanceId: "instance-test",
  sessionId: "ses_f3a892aa1ffe",
  location: { directory: "/projects/app-backend" },
  context: { title: "Add <auth>", host: "dev-node", branch: "feature/auth" },
  durationMs: 4_259_000,
  finalPreview: "Added login & logout.",
  changes: { files: 8, additions: 243, deletions: 61 },
  verification: "• Tests: 42 passed",
  followUp: "Run the migration.",
}

test("detailed execution messages preserve metadata, escape HTML and format duration", () => {
  expect(BridgeEventSchema.parse(event)).toMatchObject(event)
  const text = renderExecution(event, notifications)
  for (const expected of [
    "Project:",
    "app-backend",
    "Task: Add &lt;auth&gt;",
    "Branch:",
    "Node:",
    "1h 10m 59s",
    "Added login &amp; logout.",
    "8 files changed · +243 / −61",
    "42 passed",
    "Run the migration.",
    "ses_f3a892aa1ffe",
  ])
    expect(text).toContain(expected)
  expect(renderExecution({ ...event, durationMs: 59_000 }, notifications)).toContain("Duration: 59s")
  expect(renderExecution({ ...event, durationMs: 60_000 }, notifications)).toContain("Duration: 1m 0s")
})

test("explicit preview and metadata settings remain effective", () => {
  const text = renderExecution(event, { ...notifications, includeFinalPreview: false, includeBranch: false })
  for (const hidden of ["Added login", "42 passed", "Run the migration", "feature/auth"])
    expect(text).not.toContain(hidden)
  expect(text).toContain("8 files changed")
  const legacy = renderExecution(
    { type: event.type, eventId: event.eventId, emittedAt: 0, instanceId: event.instanceId, location: event.location },
    notifications,
  )
  expect(legacy).toContain("app-backend")
  expect(legacy).not.toContain("Verification")
  expect(legacy).not.toContain("undefined")
})

test("only explicit final-response report sections become verification claims", () => {
  expect(
    completionReport("Implemented auth.\n\n## Verification\n• Tests: 42 passed\n\n**Next steps**\nRun migration."),
  ).toEqual({
    finalPreview: "Implemented auth.",
    verification: "• Tests: 42 passed",
    followUp: "Run migration.",
  })
  expect(completionReport("I will run tests next.").verification).toBe("")
})

test("execution details use the current final answer, exclude thoughts, and carry pending todos", () => {
  let created = 2000
  const api = {
    state: {
      path: { directory: "/projects/app-backend", worktree: "/projects/app-backend" },
      vcs: { branch: "feature/auth" },
      session: {
        get: () => ({ title: "Authentication", summary: event.changes }),
        messages: () => [{ id: "answer", role: "assistant", time: { created, completed: 3000 }, finish: "stop" }],
        todo: () => [
          { content: "Deploy", status: "pending" },
          { content: "Implement", status: "completed" },
        ],
      },
      part: () => [
        { type: "reasoning", text: "Private thoughts" },
        { type: "text", synthetic: true, text: "Synthetic text" },
        { type: "text", text: "Added auth.\n## Verification\nTests passed." },
      ],
    },
  } as unknown as TuiPluginApi
  const details = executionDetails(api, "session-test", 1000)
  expect(details.finalPreview).toBe("Added auth.")
  expect(details.verification).toBe("Tests passed.")
  expect(details.followUp).toBe("• Deploy")
  expect(details.changes).toEqual(event.changes)
  expect(details.context?.title).toBe("Authentication")
  created = 500
  expect(executionDetails(api, "session-test", 1000).finalPreview).toBeUndefined()
})

test("bounded fields fit the Telegram message limit after HTML parsing", () => {
  const text = renderExecution(
    {
      ...event,
      context: {
        project: "x".repeat(512),
        title: "x".repeat(512),
        branch: "x".repeat(512),
        host: "x".repeat(256),
        tmux: "x".repeat(256),
        agent: "x".repeat(256),
        model: "x".repeat(256),
      },
      sessionId: "x".repeat(256),
      finalPreview: "x".repeat(1024),
      verification: "x".repeat(500),
      followUp: "x".repeat(500),
      error: "x".repeat(4096),
    },
    notifications,
  )
  expect(text.replace(/<[^>]*>/g, "").length).toBeLessThanOrEqual(4096)
})
