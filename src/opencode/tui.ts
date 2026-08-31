import { hostname } from "node:os"
import { basename } from "node:path"
import type { TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2"
import { loadConfig, loadSecrets } from "../config.ts"
import {
  ActionDispatchSchema,
  type BridgeEvent,
  type LocalRequest,
  MAX_TELEMETRY_BATCH_BYTES,
  type TuiMetadata,
} from "../protocol.ts"
import { clip, randomId, sleep } from "../util.ts"
import { VERSION } from "../version.ts"
import { OpenCodeAdapter } from "./adapter.ts"
import { boundedTelemetry, sessionTelemetry } from "./telemetry.ts"

function tmuxMetadata() {
  return process.env.TMUX_PANE || undefined
}

function rootSession(api: TuiPluginApi, sessionId: string) {
  let current = api.state.session.get(sessionId)
  const seen = new Set<string>()
  while (current?.parentID && !seen.has(current.parentID)) {
    seen.add(current.id)
    const parent = api.state.session.get(current.parentID)
    if (!parent) break
    current = parent
  }
  return current?.id ?? sessionId
}

function currentSessionId(api: TuiPluginApi) {
  const current = api.route.current
  if (current.name !== "session") return undefined
  const sessionId = current.params?.sessionID
  return typeof sessionId === "string" ? sessionId : undefined
}

function permissionEvent(api: TuiPluginApi, instanceId: string, request: PermissionRequest): BridgeEvent {
  const session = api.state.session.get(request.sessionID)
  const directory = session?.directory ?? api.state.path.directory
  return {
    type: "permission.asked",
    eventId: randomId("evt"),
    emittedAt: Date.now(),
    instanceId,
    sessionId: request.sessionID,
    rootSessionId: rootSession(api, request.sessionID),
    location: { directory },
    context: {
      host: hostname(),
      project: basename(api.state.path.worktree || directory) || directory,
      ...(api.state.vcs?.branch ? { branch: api.state.vcs.branch } : {}),
      ...(tmuxMetadata() ? { tmux: tmuxMetadata() } : {}),
      ...(session?.title ? { title: session.title } : {}),
    },
    requestId: request.id,
    action: request.permission,
    patterns: request.patterns,
    always: request.always,
    metadata: request.metadata,
  }
}

function questionEvent(api: TuiPluginApi, instanceId: string, request: QuestionRequest): BridgeEvent {
  const session = api.state.session.get(request.sessionID)
  const directory = session?.directory ?? api.state.path.directory
  return {
    type: "question.asked",
    eventId: randomId("evt"),
    emittedAt: Date.now(),
    instanceId,
    sessionId: request.sessionID,
    rootSessionId: rootSession(api, request.sessionID),
    location: { directory },
    context: {
      host: hostname(),
      project: basename(api.state.path.worktree || directory) || directory,
      ...(api.state.vcs?.branch ? { branch: api.state.vcs.branch } : {}),
      ...(tmuxMetadata() ? { tmux: tmuxMetadata() } : {}),
      ...(session?.title ? { title: session.title } : {}),
    },
    requestId: request.id,
    questions: request.questions.map((question) => ({
      header: question.header,
      question: question.question,
      options: question.options.map((option) => ({
        label: option.label,
        ...(option.description ? { description: option.description } : {}),
      })),
      ...(question.multiple !== undefined ? { multiple: question.multiple } : {}),
      ...(question.custom !== undefined ? { custom: question.custom } : {}),
    })),
  }
}

class NodeRequestError extends Error {
  constructor(readonly status: number) {
    super(`Node returned HTTP ${status}`)
  }
}

function replaceableRequest(message: LocalRequest | undefined) {
  return Boolean(
    message?.type === "event" &&
      (message.event.type === "reconcile" ||
        message.event.type === "execution.started" ||
        message.event.type === "execution.succeeded"),
  )
}

class LocalNodeClient {
  connected = false
  muted = false
  private readonly queue: LocalRequest[] = []
  private sending = false

  constructor(
    private readonly secret: string,
    private readonly baseUrl: string,
  ) {}

  enqueue(message: LocalRequest) {
    if (message.type === "event" && message.event.type === "reconcile") {
      const start = this.sending ? 1 : 0
      const offset = this.queue
        .slice(start)
        .findIndex(
          (queued) =>
            queued.type === "event" &&
            queued.event.type === "reconcile" &&
            queued.event.instanceId === message.event.instanceId,
        )
      if (offset >= 0) this.queue.splice(start + offset, 1)
    }
    if (this.queue.length >= 256) {
      const start = this.sending ? 1 : 0
      const offset = this.queue.slice(start).findIndex((queued) => replaceableRequest(queued))
      if (offset >= 0) this.queue.splice(start + offset, 1)
      else if (replaceableRequest(message)) return
      else throw new Error("Local node queue is full of correctness-critical events")
    }
    this.queue.push(message)
    void this.flush()
  }

  private async request(path: string, init?: RequestInit) {
    const signal = AbortSignal.timeout(path.startsWith("/v1/commands") ? 25_000 : 1500)
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      signal,
      headers: { authorization: `Bearer ${this.secret}`, "content-type": "application/json", ...init?.headers },
    })
    if (!response.ok) throw new NodeRequestError(response.status)
    this.connected = true
    return response
  }

  private async flush() {
    if (this.sending) return
    this.sending = true
    try {
      while (this.queue.length) {
        const message = this.queue[0]
        if (!message) break
        try {
          await this.request("/v1/plugin", { method: "POST", body: JSON.stringify(message) })
          this.queue.shift()
        } catch (error) {
          if (
            replaceableRequest(message) &&
            error instanceof NodeRequestError &&
            (error.status === 400 || error.status === 413)
          ) {
            this.queue.shift()
            continue
          }
          this.connected = false
          break
        }
      }
    } finally {
      this.sending = false
    }
  }

  async commands(instanceId: string) {
    const response = await this.request(`/v1/commands?instanceId=${encodeURIComponent(instanceId)}`)
    const body = (await response.json()) as { command?: unknown }
    return body.command ? ActionDispatchSchema.parse(body.command) : undefined
  }

  async health() {
    const response = await this.request("/health")
    return (await response.json()) as {
      hubConnected: boolean
      telegramReachable: boolean
      activeTuis: number
      queued: number
    }
  }
}

async function setup(api: TuiPluginApi, options?: Record<string, unknown>) {
  let secrets: ReturnType<typeof loadSecrets>
  let dashboard: ReturnType<typeof loadConfig>["dashboard"]
  try {
    secrets = loadSecrets()
    dashboard = loadConfig().dashboard
  } catch (error) {
    api.ui.toast({ title: "Telegram bridge", variant: "warning", message: clip(error, 300) })
    return
  }
  const adapter = new OpenCodeAdapter(api)
  const instanceId = randomId(`tui_${process.pid}`, 12)
  const nodeAddress = process.env.OPENCODE_TELEGRAM_NODE ?? "http://127.0.0.1:47621"
  const node = new LocalNodeClient(secrets.localPluginSecret, nodeAddress)
  const executions = new Map<
    string,
    { startedAt: number; lastActivity: number; stuckNotified: boolean; busy: Set<string> }
  >()
  const trackedSessions = new Set<string>()
  const knownSessions = new Set<string>()
  const telegramRequests = new Set<string>()
  let disposed = false
  const stuckMinutes =
    typeof options?.stuckMinutes === "number" && options.stuckMinutes >= 1 ? options.stuckMinutes : 10

  function metadata(): TuiMetadata {
    const sessionId = currentSessionId(api)
    const session = sessionId ? api.state.session.get(sessionId) : undefined
    const directory = session?.directory ?? api.state.path.directory
    return {
      instanceId,
      ...(sessionId ? { sessionId, rootSessionId: rootSession(api, sessionId) } : {}),
      ...(session?.parentID ? { parentSessionId: session.parentID } : {}),
      project: basename(api.state.path.worktree || directory) || directory,
      directory,
      worktree: api.state.path.worktree,
      ...(api.state.vcs?.branch ? { branch: api.state.vcs.branch } : {}),
      ...(tmuxMetadata() ? { tmux: tmuxMetadata() } : {}),
      ...(session?.title ? { sessionTitle: session.title } : {}),
      pid: process.pid,
      hostname: hostname(),
      opencodeVersion: api.app.version,
      pluginVersion: VERSION,
      startedAt: Date.now(),
      location: { directory },
      capabilities: adapter.capabilities,
    }
  }

  function emit(event: BridgeEvent) {
    if (!node.muted || event.type === "reconcile") node.enqueue({ type: "event", event })
  }

  function trackSession(sessionId: string) {
    knownSessions.delete(sessionId)
    knownSessions.add(sessionId)
    while (knownSessions.size > 32) {
      const oldest = knownSessions.values().next().value
      if (!oldest) break
      knownSessions.delete(oldest)
    }
  }

  function reconcile() {
    const sessionId = currentSessionId(api)
    if (sessionId) trackSession(sessionId)
    const sessionIds = new Set<string>()
    if (sessionId) sessionIds.add(sessionId)
    for (const id of trackedSessions) sessionIds.add(id)
    for (const [rootId, execution] of executions) {
      sessionIds.add(rootId)
      for (const id of execution.busy) sessionIds.add(id)
    }
    const permissions = [...sessionIds].flatMap((id) =>
      adapter.pendingPermissions(id).map((request) => permissionEvent(api, instanceId, request)),
    )
    const questions = [...sessionIds].flatMap((id) =>
      adapter.pendingQuestions(id).map((request) => questionEvent(api, instanceId, request)),
    )
    const meta = metadata()
    const event: Extract<BridgeEvent, { type: "reconcile" }> = {
      type: "reconcile",
      eventId: randomId("evt"),
      emittedAt: Date.now(),
      instanceId,
      ...(sessionId ? { sessionId, rootSessionId: rootSession(api, sessionId) } : {}),
      location: meta.location,
      metadata: meta,
      pendingPermissions: permissions.filter(
        (event): event is Extract<BridgeEvent, { type: "permission.asked" }> => event.type === "permission.asked",
      ),
      pendingQuestions: questions.filter(
        (event): event is Extract<BridgeEvent, { type: "question.asked" }> => event.type === "question.asked",
      ),
      scopeSessionIds: [...sessionIds],
    }
    if (dashboard.enabled) {
      const envelopeBytes = new TextEncoder().encode(JSON.stringify({ type: "event", event })).byteLength
      const telemetryBudget = Math.min(MAX_TELEMETRY_BATCH_BYTES, Math.max(0, 1024 * 1024 - envelopeBytes - 16_384))
      event.telemetry = boundedTelemetry(
        [...new Set([...knownSessions, ...sessionIds])]
          .slice(-8)
          .map((id) => sessionTelemetry(api, id, dashboard.capture))
          .filter((item) => item !== undefined),
        telemetryBudget,
      )
    }
    emit(event)
  }

  node.enqueue({ type: "register", metadata: metadata() })

  const disposers = [
    api.event.on("session.created", (event) => trackSession(event.properties.sessionID)),
    api.event.on("session.updated", (event) => trackSession(event.properties.sessionID)),
    api.event.on("session.deleted", (event) => knownSessions.delete(event.properties.sessionID)),
    api.event.on("message.updated", (event) => trackSession(event.properties.sessionID)),
    api.event.on("todo.updated", (event) => trackSession(event.properties.sessionID)),
    api.event.on("permission.asked", (event) => {
      trackedSessions.add(event.properties.sessionID)
      emit(permissionEvent(api, instanceId, event.properties))
    }),
    api.event.on("permission.replied", (event) => {
      adapter.observeReply(event.properties.sessionID, event.properties.requestID)
      trackedSessions.delete(event.properties.sessionID)
      emit({
        type: "request.resolved",
        eventId: randomId("evt"),
        emittedAt: Date.now(),
        instanceId,
        sessionId: event.properties.sessionID,
        rootSessionId: rootSession(api, event.properties.sessionID),
        location: {
          directory: api.state.session.get(event.properties.sessionID)?.directory ?? api.state.path.directory,
        },
        requestId: event.properties.requestID,
        requestKind: "permission",
        resolution: event.properties.reply,
        source: telegramRequests.has(event.properties.requestID) ? "telegram" : "tui",
      })
    }),
    api.event.on("question.asked", (event) => {
      trackedSessions.add(event.properties.sessionID)
      emit(questionEvent(api, instanceId, event.properties))
    }),
    api.event.on("question.replied", (event) => {
      adapter.observeReply(event.properties.sessionID, event.properties.requestID)
      trackedSessions.delete(event.properties.sessionID)
      emit({
        type: "request.resolved",
        eventId: randomId("evt"),
        emittedAt: Date.now(),
        instanceId,
        sessionId: event.properties.sessionID,
        rootSessionId: rootSession(api, event.properties.sessionID),
        location: {
          directory: api.state.session.get(event.properties.sessionID)?.directory ?? api.state.path.directory,
        },
        requestId: event.properties.requestID,
        requestKind: "question",
        resolution: "answered",
        source: telegramRequests.has(event.properties.requestID) ? "telegram" : "tui",
      })
    }),
    api.event.on("question.rejected", (event) => {
      adapter.observeReply(event.properties.sessionID, event.properties.requestID)
      trackedSessions.delete(event.properties.sessionID)
      emit({
        type: "request.resolved",
        eventId: randomId("evt"),
        emittedAt: Date.now(),
        instanceId,
        sessionId: event.properties.sessionID,
        rootSessionId: rootSession(api, event.properties.sessionID),
        location: {
          directory: api.state.session.get(event.properties.sessionID)?.directory ?? api.state.path.directory,
        },
        requestId: event.properties.requestID,
        requestKind: "question",
        resolution: "cancelled",
        source: telegramRequests.has(event.properties.requestID) ? "telegram" : "tui",
      })
    }),
    api.event.on("session.status", (event) => {
      adapter.observeExecution(event.properties.sessionID)
      const rootId = rootSession(api, event.properties.sessionID)
      if (event.properties.status.type === "busy") {
        let execution = executions.get(rootId)
        if (!execution) {
          execution = { startedAt: Date.now(), lastActivity: Date.now(), stuckNotified: false, busy: new Set() }
          executions.set(rootId, execution)
          emit({
            type: "execution.started",
            eventId: randomId("evt"),
            emittedAt: Date.now(),
            instanceId,
            sessionId: rootId,
            rootSessionId: rootId,
            location: { directory: api.state.session.get(rootId)?.directory ?? api.state.path.directory },
          })
        }
        execution.busy.add(event.properties.sessionID)
        execution.lastActivity = Date.now()
      }
      if (event.properties.status.type === "idle") {
        const execution = executions.get(rootId)
        execution?.busy.delete(event.properties.sessionID)
        if (execution && execution.busy.size === 0) {
          executions.delete(rootId)
          emit({
            type: "execution.succeeded",
            eventId: randomId("evt"),
            emittedAt: Date.now(),
            instanceId,
            sessionId: rootId,
            rootSessionId: rootId,
            location: { directory: api.state.session.get(rootId)?.directory ?? api.state.path.directory },
            durationMs: Date.now() - execution.startedAt,
          })
        }
      }
    }),
    api.event.on("session.error", (event) => {
      if (!event.properties.sessionID) return
      const rootId = rootSession(api, event.properties.sessionID)
      const execution = executions.get(rootId)
      executions.delete(rootId)
      emit({
        type: "execution.failed",
        eventId: randomId("evt"),
        emittedAt: Date.now(),
        instanceId,
        sessionId: rootId,
        rootSessionId: rootId,
        location: { directory: api.state.session.get(rootId)?.directory ?? api.state.path.directory },
        ...(execution ? { durationMs: Date.now() - execution.startedAt } : {}),
        error: "OpenCode session failed. See the originating TUI for private details.",
      })
    }),
    api.event.on("message.part.updated", (event) => {
      adapter.observeExecution(event.properties.sessionID)
      trackSession(event.properties.sessionID)
      const rootId = rootSession(api, event.properties.sessionID)
      const execution = executions.get(rootId)
      if (execution) execution.lastActivity = Date.now()
    }),
  ]

  const removeCommands = api.keymap.registerLayer({
    commands: [
      {
        name: "telegram.status",
        title: "Telegram bridge status",
        category: "Telegram",
        namespace: "palette",
        slashName: "telegram-status",
        async run() {
          try {
            const health = await node.health()
            api.ui.toast({
              title: "Telegram",
              variant: health.hubConnected && health.telegramReachable ? "success" : "warning",
              message: `Node connected; hub ${health.hubConnected ? "connected" : "offline"}; Telegram ${health.telegramReachable ? "reachable" : "unavailable"}; mutations ${adapter.capabilities.permissionReply ? "available" : "notification-only"}`,
            })
          } catch {
            api.ui.toast({ title: "Telegram", variant: "warning", message: "Local node disconnected" })
          }
        },
      },
      {
        name: "telegram.test",
        title: "Test Telegram bridge",
        category: "Telegram",
        namespace: "palette",
        slashName: "telegram-test",
        run() {
          reconcile()
          api.ui.toast({
            title: "Telegram",
            variant: "info",
            message: "Registration and reconciliation sent to local node",
          })
        },
      },
      {
        name: "telegram.mute",
        title: "Mute Telegram for this TUI",
        category: "Telegram",
        namespace: "palette",
        slashName: "telegram-mute",
        run() {
          node.muted = !node.muted
          api.ui.toast({
            title: "Telegram",
            variant: "info",
            message: node.muted ? "Muted for this TUI" : "Unmuted for this TUI",
          })
        },
      },
    ],
  })

  async function commandLoop() {
    while (!disposed) {
      try {
        const action = await node.commands(instanceId)
        if (!action || disposed) continue
        telegramRequests.add(action.requestId)
        const result = await adapter.apply(action)
        node.enqueue({
          type: "action.result",
          actionId: action.actionId,
          ok: result.ok,
          state: result.state,
          ...(result.detail ? { detail: result.detail } : {}),
          evidence: result.evidence,
        })
        api.ui.toast({
          title: result.ok ? "Telegram" : "Telegram bridge",
          variant: result.ok ? "success" : "error",
          message: result.ok
            ? action.requestKind === "permission"
              ? `Permission ${action.operation} confirmed`
              : "Answer confirmed by OpenCode"
            : clip(result.detail, 350),
          duration: result.ok ? 2500 : 6000,
        })
        telegramRequests.delete(action.requestId)
      } catch {
        node.connected = false
        if (!disposed) await sleep(1200)
      }
    }
  }

  void commandLoop()
  const reconcileTimer = setInterval(reconcile, 5000)
  const stuckTimer = setInterval(() => {
    const now = Date.now()
    for (const [rootId, execution] of executions) {
      if (execution.stuckNotified || now - execution.lastActivity < stuckMinutes * 60_000) continue
      execution.stuckNotified = true
      emit({
        type: "execution.stuck",
        eventId: randomId("evt"),
        emittedAt: now,
        instanceId,
        sessionId: rootId,
        rootSessionId: rootId,
        location: { directory: api.state.session.get(rootId)?.directory ?? api.state.path.directory },
        durationMs: now - execution.startedAt,
      })
    }
  }, 30_000)
  reconcile()
  api.lifecycle.onDispose(() => {
    disposed = true
    node.enqueue({ type: "unregister", instanceId })
    clearInterval(reconcileTimer)
    clearInterval(stuckTimer)
    removeCommands()
    for (const dispose of disposers) dispose()
  })
}

const plugin = {
  id: "opencode-telegram",
  tui: setup,
} satisfies TuiPluginModule

export default plugin
