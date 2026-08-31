import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { Config } from "../config.ts"
import {
  MAX_TELEMETRY_BATCH_BYTES,
  type SessionTelemetry,
  SessionTelemetrySchema,
  type TelemetryActivity,
} from "../protocol.ts"
import { clip, redact } from "../util.ts"

function finite(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0
}

function detail(value: unknown, max: number) {
  try {
    return clip(redact(typeof value === "string" ? value : JSON.stringify(value)), max)
  } catch {
    return "[unavailable]"
  }
}

function bytes(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

export function boundedTelemetry(items: SessionTelemetry[], maxBytes = MAX_TELEMETRY_BATCH_BYTES) {
  const result: SessionTelemetry[] = []
  for (const item of items.slice(-8).reverse()) {
    let activities = item.activities
    let todos = item.todos
    let candidate = { ...item, activities, todos }
    while (bytes([candidate, ...result]) > maxBytes && (activities.length || todos.length)) {
      if (activities.length) activities = activities.slice(Math.max(1, Math.ceil(activities.length / 4)))
      else todos = todos.slice(Math.max(1, Math.ceil(todos.length / 4)))
      candidate = { ...item, activities, todos }
    }
    if (bytes([candidate, ...result]) <= maxBytes) result.unshift(candidate)
  }
  return result
}

export function sessionTelemetry(
  api: TuiPluginApi,
  sessionId: string,
  capture: Config["dashboard"]["capture"],
): SessionTelemetry | undefined {
  const session = api.state.session.get(sessionId)
  if (!session) return undefined
  const status = api.state.session.status(sessionId)?.type ?? "unknown"
  const activities: TelemetryActivity[] = []
  if (capture !== "metadata") {
    const messages = api.state.session.messages(sessionId).slice(-24)
    let inspected = 0
    activity: for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
      const message = messages[messageIndex]
      if (!message) continue
      const parts = api.state.part(message.id)
      for (let partIndex = parts.length - 1; partIndex >= 0; partIndex--) {
        const part = parts[partIndex]
        if (!part) continue
        inspected++
        let activity: TelemetryActivity | undefined
        if (part.type === "reasoning") {
          activity = {
            id: part.id,
            type: "thought",
            title: "Thought",
            detail: detail(part.text, capture === "full" ? 2400 : 900),
            startedAt: part.time.start,
            ...(part.time.end ? { endedAt: part.time.end } : {}),
          }
        } else if (part.type === "tool") {
          const state = part.state
          const input = detail(state.input, capture === "full" ? 1400 : 700)
          const output =
            capture === "full"
              ? state.status === "completed"
                ? `\n\nOutput:\n${detail(state.output, 1600)}`
                : state.status === "error"
                  ? `\n\nError:\n${detail(state.error, 1600)}`
                  : ""
              : ""
          activity = {
            id: part.id,
            type: "tool",
            title: clip("title" in state && state.title ? state.title : part.tool, 256),
            status: state.status,
            detail: clip(`Input:\n${input}${output}`, 2400),
            ...(state.status !== "pending" ? { startedAt: state.time.start } : {}),
            ...(state.status === "completed" || state.status === "error" ? { endedAt: state.time.end } : {}),
          }
        } else if (part.type === "subtask") {
          activity = {
            id: part.id,
            type: "tool",
            title: clip(part.description || `Subtask: ${part.agent}`, 256),
            status: "delegated",
            detail: detail(part.command ?? part.prompt, 900),
          }
        } else if (part.type === "text" && capture === "full" && !part.ignored) {
          activity = {
            id: part.id,
            type: "text",
            title: message.role === "user" ? "Prompt" : "Response",
            detail: detail(part.text, 2400),
            ...(part.time?.start ? { startedAt: part.time.start } : {}),
            ...(part.time?.end ? { endedAt: part.time.end } : {}),
          }
        } else if (part.type === "retry") {
          activity = {
            id: part.id,
            type: "retry",
            title: `Retry ${part.attempt}`,
            status: "waiting",
            ...(capture === "full" ? { detail: detail(part.error.data.message, 900) } : {}),
            startedAt: part.time.created,
          }
        } else if (part.type === "compaction") {
          activity = {
            id: part.id,
            type: "compaction",
            title: part.auto ? "Automatic compaction" : "Context compacted",
            status: part.overflow ? "overflow" : "completed",
          }
        }
        if (activity) activities.push(activity)
        if (activities.length === 48 || inspected === 512) break activity
      }
    }
    activities.reverse()
  }
  const telemetry = SessionTelemetrySchema.safeParse({
    sessionId,
    capture,
    ...(session.parentID ? { parentId: session.parentID } : {}),
    ...(capture === "full" && session.title ? { title: clip(session.title, 512) } : {}),
    status: status === "idle" || status === "busy" || status === "retry" ? status : "unknown",
    updatedAt: session.time.updated,
    ...(session.agent ? { agent: session.agent } : {}),
    ...(session.model?.id ? { model: session.model.id } : {}),
    ...(session.model?.providerID ? { provider: session.model.providerID } : {}),
    cost: finite(session.cost),
    tokens: {
      input: finite(session.tokens?.input),
      output: finite(session.tokens?.output),
      reasoning: finite(session.tokens?.reasoning),
      cacheRead: finite(session.tokens?.cache.read),
      cacheWrite: finite(session.tokens?.cache.write),
    },
    todos:
      capture === "metadata"
        ? []
        : api.state.session
            .todo(sessionId)
            .slice(0, 64)
            .map((todo) => ({ content: clip(todo.content, 1000), status: todo.status, priority: "unknown" })),
    activities,
  })
  return telemetry.success ? telemetry.data : undefined
}
