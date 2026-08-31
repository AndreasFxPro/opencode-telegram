import { describe, expect, test } from "bun:test"
import { ActionDispatchSchema, BridgeEventSchema, requestIdentity } from "../src/protocol.ts"
import { permission } from "./helpers.ts"

describe("protocol validation", () => {
  test("accepts a typed permission event", () => {
    expect(BridgeEventSchema.parse(permission()).type).toBe("permission.asked")
  })

  test("rejects oversized external payloads", () => {
    expect(() => BridgeEventSchema.parse({ ...permission(), patterns: ["x".repeat(9000)] })).toThrow()
  })

  test("rejects expired or malformed action fields structurally", () => {
    expect(() =>
      ActionDispatchSchema.parse({ type: "action.dispatch", actionId: "short", operation: "shell" }),
    ).toThrow()
  })

  test("routing identity includes workspace and TUI instance", () => {
    const event = permission()
    const first = requestIdentity(event)
    expect(requestIdentity({ ...event, instanceId: "tui_other_12345678" })).not.toBe(first)
    expect(requestIdentity({ ...event, location: { ...event.location, workspace: "remote" } })).not.toBe(first)
  })
})
