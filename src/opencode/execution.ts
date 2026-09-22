import { hostname } from "node:os"
import { basename } from "node:path"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BridgeEvent } from "../protocol.ts"
import { clip, redact } from "../util.ts"

type Execution = Extract<
  BridgeEvent,
  { type: "execution.succeeded" | "execution.failed" | "execution.started" | "execution.stuck" }
>

// Only recognize explicit report headings; command completion alone is not proof that tests passed.
export function completionReport(text: string) {
  const sections = { result: [] as string[], verification: [] as string[], followUp: [] as string[] }
  let section: keyof typeof sections = "result"
  for (const line of text.split("\n")) {
    const heading = line
      .trim()
      .replace(/^#{1,6}\s+/, "")
      .replace(/\*\*/g, "")
      .replace(/:$/, "")
      .trim()
    if (/^(verification|validation|tests?|testing|checks)(\s+results)?$/i.test(heading)) {
      section = "verification"
    } else if (/^(follow[- ]?ups?|next steps?|remaining work)$/i.test(heading)) {
      section = "followUp"
    } else if (/^(result|summary|changes|implementation)$/i.test(heading)) {
      section = "result"
    } else {
      if (/^#{1,6}\s/.test(line.trim())) section = "result"
      sections[section].push(line)
    }
  }
  return {
    finalPreview: clip(redact(sections.result.join("\n")), 1024),
    verification: clip(redact(sections.verification.join("\n")), 500),
    followUp: clip(redact(sections.followUp.join("\n")), 500),
  }
}

export function executionDetails(api: TuiPluginApi, sessionId: string, startedAt?: number): Partial<Execution> {
  const session = api.state.session.get(sessionId)
  const directory = session?.directory ?? api.state.path.directory
  const details: Partial<Execution> = {
    context: {
      host: hostname(),
      project: clip(basename(api.state.path.worktree || directory) || directory, 512),
      ...(session?.title ? { title: clip(session.title, 512) } : {}),
      ...(api.state.vcs?.branch ? { branch: clip(api.state.vcs.branch, 512) } : {}),
      ...(process.env.TMUX_PANE ? { tmux: clip(process.env.TMUX_PANE, 256) } : {}),
      ...(session?.agent ? { agent: clip(session.agent, 256) } : {}),
      ...(session?.model?.id ? { model: clip(session.model.id, 256) } : {}),
    },
  }
  if (startedAt === undefined) return details
  // Stop at the latest user turn and never reuse an earlier execution's response.
  for (const message of [...api.state.session.messages(sessionId)].reverse()) {
    if (message.role === "user" || message.time.created < startedAt) break
    if (message.role !== "assistant" || message.summary || message.error) continue
    const text = api.state
      .part(message.id)
      .filter((part) => part.type === "text" && !part.ignored && !part.synthetic)
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n")
      .trim()
    if (!text || !message.time.completed || message.finish === "tool-calls") continue
    Object.assign(details, completionReport(text))
    break
  }
  if (session?.summary) {
    details.changes = {
      files: session.summary.files,
      additions: session.summary.additions,
      deletions: session.summary.deletions,
    }
  }
  const pending = api.state.session
    .todo(sessionId)
    .filter((todo) => todo.status === "pending" || todo.status === "in_progress")
    .slice(0, 5)
    .map((todo) => `• ${todo.content}`)
  if (pending.length) details.followUp = clip(redact([details.followUp, ...pending].filter(Boolean).join("\n")), 500)
  return details
}
