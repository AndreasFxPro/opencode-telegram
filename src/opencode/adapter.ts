import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2"
import type { ActionDispatch, Capabilities } from "../protocol.ts"
import { sleep } from "../util.ts"

type Evidence = { repliedEvent: boolean; pendingAbsent: boolean; executionObserved: boolean }
type Observation = Evidence & { sessionId: string; requestId: string; createdAt: number }

export type AdapterResult = {
  ok: boolean
  state: "confirmed" | "failed" | "stale"
  detail?: string
  evidence: Evidence
}

export class OpenCodeAdapter {
  readonly capabilities: Capabilities
  private readonly observations = new Map<string, Observation>()

  constructor(private readonly api: TuiPluginApi) {
    const client = api.client
    this.capabilities = {
      permissionReply: typeof client.permission?.reply === "function",
      savedPermission: typeof client.permission?.reply === "function",
      questionReply: typeof client.question?.reply === "function",
      questionReject: typeof client.question?.reject === "function",
      sessionExecutionEvents: true,
      pendingSync:
        typeof api.state.session.permission === "function" && typeof api.state.session.question === "function",
      workspaceRouting: false,
      locationRouting: true,
      sessionHierarchy: typeof api.state.session.get === "function",
    }
  }

  pendingPermissions(sessionId: string): ReadonlyArray<PermissionRequest> {
    return this.api.state.session.permission(sessionId)
  }

  pendingQuestions(sessionId: string): ReadonlyArray<QuestionRequest> {
    return this.api.state.session.question(sessionId)
  }

  observeReply(sessionId: string, requestId: string) {
    for (const observation of this.observations.values()) {
      if (observation.sessionId === sessionId && observation.requestId === requestId) observation.repliedEvent = true
    }
  }

  observeExecution(sessionId: string) {
    for (const observation of this.observations.values()) {
      if (observation.sessionId === sessionId && observation.repliedEvent) observation.executionObserved = true
    }
  }

  private isPending(action: ActionDispatch) {
    const list =
      action.requestKind === "permission"
        ? this.pendingPermissions(action.sessionId)
        : this.pendingQuestions(action.sessionId)
    return list.some((request) => request.id === action.requestId)
  }

  async apply(action: ActionDispatch): Promise<AdapterResult> {
    const empty: Evidence = { repliedEvent: false, pendingAbsent: false, executionObserved: false }
    if (Date.now() >= action.expiresAt)
      return { ok: false, state: "stale", detail: "Action expired before reaching the TUI", evidence: empty }
    if (!this.isPending(action))
      return {
        ok: false,
        state: "stale",
        detail: "OpenCode no longer reports this request as pending",
        evidence: { ...empty, pendingAbsent: true },
      }
    const current = this.api.state.session.get(action.sessionId)
    const directory = current?.directory ?? action.location.directory
    if (directory !== action.location.directory)
      return {
        ok: false,
        state: "failed",
        detail: "Session directory changed; refusing an ambiguous reply",
        evidence: empty,
      }
    const observation: Observation = {
      ...empty,
      sessionId: action.sessionId,
      requestId: action.requestId,
      createdAt: Date.now(),
    }
    this.observations.set(action.actionId, observation)
    try {
      await this.invoke(action, {
        directory,
        ...(action.location.workspace ? { workspace: action.location.workspace } : {}),
      })
      const deadline = Math.min(action.expiresAt, Date.now() + 12_000)
      while (Date.now() < deadline) {
        observation.pendingAbsent = !this.isPending(action)
        if (observation.repliedEvent && observation.pendingAbsent && observation.executionObserved) {
          return { ok: true, state: "confirmed", evidence: this.evidence(observation) }
        }
        await sleep(100)
      }
      return {
        ok: false,
        state: observation.pendingAbsent ? "failed" : "failed",
        detail: this.failureDetail(observation),
        evidence: this.evidence(observation),
      }
    } catch (error) {
      observation.pendingAbsent = !this.isPending(action)
      return {
        ok: false,
        state: "failed",
        detail: error instanceof Error ? error.message : String(error),
        evidence: this.evidence(observation),
      }
    } finally {
      this.observations.delete(action.actionId)
    }
  }

  private evidence(observation: Observation): Evidence {
    return {
      repliedEvent: observation.repliedEvent,
      pendingAbsent: observation.pendingAbsent,
      executionObserved: observation.executionObserved,
    }
  }

  private failureDetail(observation: Observation) {
    const missing = [
      !observation.repliedEvent && "matching OpenCode replied event",
      !observation.pendingAbsent && "pending prompt disappearance",
      !observation.executionObserved && "session continuation event",
    ].filter(Boolean)
    return `OpenCode did not confirm resolution: missing ${missing.join(", ")}`
  }

  private async invoke(action: ActionDispatch, location: { directory: string; workspace?: string }) {
    const routing = {
      directory: location.directory,
      ...(location.workspace ? { workspace: location.workspace } : {}),
    }
    if (action.requestKind === "permission") {
      if (!this.capabilities.permissionReply)
        throw new Error("Permission replies are unavailable on this OpenCode build")
      if (!(["once", "always", "reject"] as const).includes(action.operation as "once" | "always" | "reject"))
        throw new Error("Invalid permission operation")
      const reply = action.operation as "once" | "always" | "reject"
      await this.api.client.permission.reply(
        { requestID: action.requestId, reply, ...routing, ...(action.message ? { message: action.message } : {}) },
        { throwOnError: true },
      )
      return
    }
    if (action.operation === "answer") {
      if (!this.capabilities.questionReply) throw new Error("Question replies are unavailable on this OpenCode build")
      if (!action.answers) throw new Error("Question action has no answers")
      await this.api.client.question.reply(
        { requestID: action.requestId, answers: action.answers, ...routing },
        { throwOnError: true },
      )
      return
    }
    if (action.operation === "cancel" || action.operation === "reject") {
      if (!this.capabilities.questionReject)
        throw new Error("Question cancellation is unavailable on this OpenCode build")
      await this.api.client.question.reject({ requestID: action.requestId, ...routing }, { throwOnError: true })
      return
    }
    throw new Error("Unsupported question operation")
  }
}
