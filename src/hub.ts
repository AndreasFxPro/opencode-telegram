import { join } from "node:path"
import type { Server, ServerWebSocket } from "bun"
import type { Config, Secrets } from "./config.ts"
import { dataDir, splitListen } from "./config.ts"
import { dashboardApiHeaders, dashboardAsset } from "./dashboard.ts"
import {
  type ActionDispatch,
  type BridgeEvent,
  HubToNodeSchema,
  NodeToHubSchema,
  SessionTelemetrySchema,
  TuiMetadataSchema,
} from "./protocol.ts"
import { HubStore, type PendingRow } from "./store.ts"
import { type HubView, TelegramGateway } from "./telegram.ts"
import { clip, createLogger, safeEqualHash, sha256 } from "./util.ts"
import { PROTOCOL_VERSION } from "./version.ts"

type SocketData = { nodeId: string }

function json(value: string) {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

function dashboardUrl(config: Config) {
  if (config.hub.publicUrl) return new URL(config.hub.publicUrl)
  const listen = splitListen(config.hub.listen)
  const hostname = listen.hostname.includes(":") ? `[${listen.hostname}]` : listen.hostname
  return new URL(`http://${hostname}:${listen.port}`)
}

function requireSecureDashboard(config: Config) {
  const url = dashboardUrl(config)
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname.replace(/^\[|\]$/g, ""))
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    throw new Error(`Dashboard credentials require HTTPS for non-loopback URLs: ${url.origin}`)
  const listener = splitListen(config.hub.listen)
  if (!["localhost", "127.0.0.1", "::1"].includes(listener.hostname))
    throw new Error("Dashboard listener must be loopback-only; expose it through an HTTPS reverse proxy")
}

export class Hub implements HubView {
  readonly store: HubStore
  readonly startedAt = Date.now()
  private readonly log = createLogger("hub")
  private readonly sockets = new Map<string, ServerWebSocket<SocketData>>()
  private readonly messageChains = new Map<string, Promise<void>>()
  private server?: Server<SocketData>
  private telegram?: TelegramGateway
  private cleanupTimer?: Timer
  private leaseTimer?: Timer
  private readonly leaseId = `hub_${crypto.randomUUID()}`

  constructor(
    readonly config: Config,
    readonly secrets: Secrets,
    databasePath = join(dataDir(config), "hub.db"),
  ) {
    this.store = new HubStore(databasePath)
  }

  uptimeMs() {
    return Date.now() - this.startedAt
  }

  connectedNodeIds() {
    return [...this.sockets.keys()]
  }

  async start() {
    if (this.config.dashboard.enabled && !this.secrets.dashboardToken)
      throw new Error("Dashboard is enabled without a dashboard token")
    if (this.config.dashboard.enabled) {
      requireSecureDashboard(this.config)
      this.store.cleanupTelemetry(Date.now(), this.config.dashboard.retentionHours * 60 * 60_000)
    } else this.store.clearSessionTelemetry()
    this.store.disconnectAllTuis()
    const listen = splitListen(this.config.hub.listen)
    this.server = Bun.serve<SocketData>({
      ...listen,
      fetch: (request, server) => this.fetch(request, server),
      websocket: {
        open: (socket) => this.open(socket),
        message: (socket, message) => this.enqueueMessage(socket, message),
        close: (socket) => this.close(socket),
        drain: (socket) => this.drain(socket),
        perMessageDeflate: false,
        maxPayloadLength: 1024 * 1024,
      },
    })
    if (this.secrets.telegramBotToken) {
      if (!this.store.acquireHubLease(this.leaseId)) throw new Error("Another hub holds the Telegram poller lease")
      this.leaseTimer = setInterval(() => {
        if (!this.store.acquireHubLease(this.leaseId)) {
          this.log.error("Telegram poller lease lost")
          this.telegram?.stop()
        }
      }, 10_000)
      const telegramUrl = new URL(this.config.telegram.apiBase)
      const loopback = ["localhost", "127.0.0.1", "::1"].includes(telegramUrl.hostname.replace(/^\[|\]$/g, ""))
      if (telegramUrl.protocol !== "https:" && !loopback)
        throw new Error("Telegram API must use HTTPS unless it is a loopback development server")
      this.telegram = new TelegramGateway(this.config, this.secrets.telegramBotToken, this.store, this)
      try {
        await this.telegram.validate()
      } catch (error) {
        if (this.leaseTimer) clearInterval(this.leaseTimer)
        this.store.releaseHubLease(this.leaseId)
        this.server.stop(true)
        throw error
      }
      this.telegram.start()
    }
    this.cleanupTimer = setInterval(() => {
      for (const row of this.store.cleanup(Date.now(), this.config.dashboard.retentionHours * 60 * 60_000))
        void this.telegram?.updatePending(row, "⌛ Request expired")
    }, 60_000)
    this.log.info("listening", { address: this.config.hub.listen, telegram: Boolean(this.telegram) })
  }

  async stop() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer)
    if (this.leaseTimer) clearInterval(this.leaseTimer)
    this.telegram?.stop()
    for (const socket of this.sockets.values()) socket.close(1001, "Hub shutting down")
    this.server?.stop(true)
    this.store.releaseHubLease(this.leaseId)
    this.store.close()
  }

  private async fetch(request: Request, server: Server<SocketData>) {
    const url = new URL(request.url)
    if (this.config.dashboard.enabled) {
      const asset = request.method === "GET" ? dashboardAsset(url.pathname) : undefined
      if (asset) return asset
      if (url.pathname === "/v1/dashboard/snapshot") {
        if (request.method !== "GET")
          return new Response("Method not allowed", {
            status: 405,
            headers: { allow: "GET", ...dashboardApiHeaders() },
          })
        if (!this.dashboardAuthenticated(request))
          return Response.json(
            { error: "Unauthorized" },
            {
              status: 401,
              headers: { "www-authenticate": 'Bearer realm="opencode-telegram-dashboard"', ...dashboardApiHeaders() },
            },
          )
        return Response.json(this.dashboardSnapshot(), { headers: dashboardApiHeaders() })
      }
    }
    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        protocolVersion: PROTOCOL_VERSION,
        uptimeMs: this.uptimeMs(),
        connectedNodes: this.sockets.size,
        activeTuis: this.store.activeTuiCount(),
        pending: this.store.listPending().length,
        telegram: Boolean(this.telegram),
      })
    }
    if (url.pathname === "/v1/enroll" && request.method === "POST") {
      try {
        const body = (await request.json()) as unknown
        if (!body || typeof body !== "object" || !("token" in body) || typeof body.token !== "string")
          return Response.json({ error: "token required" }, { status: 400 })
        const result = this.store.exchangeEnrollment(body.token)
        if (!result) return Response.json({ error: "invalid, expired, revoked, or used token" }, { status: 403 })
        return Response.json(result)
      } catch {
        return Response.json({ error: "invalid JSON" }, { status: 400 })
      }
    }
    if (url.pathname === "/v1/node/ws") {
      const nodeId = request.headers.get("x-node-id") ?? ""
      const authorization = request.headers.get("authorization") ?? ""
      const credential = authorization.startsWith("Bearer ") ? authorization.slice(7) : ""
      if (!nodeId || !credential || !this.store.authenticateNode(nodeId, credential))
        return new Response("Unauthorized", { status: 401 })
      if (server.upgrade(request, { data: { nodeId } })) return undefined
      return new Response("Upgrade required", { status: 426 })
    }
    return new Response("Not found", { status: 404 })
  }

  private dashboardAuthenticated(request: Request) {
    const authorization = request.headers.get("authorization") ?? ""
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : ""
    return Boolean(token && this.secrets.dashboardToken && safeEqualHash(token, sha256(this.secrets.dashboardToken)))
  }

  dashboardSnapshot() {
    const connectedNodeIds = new Set(this.connectedNodeIds())
    const nodes = this.store.listNodes().map((node) => ({
      id: node.id,
      name: node.name,
      connected: connectedNodeIds.has(node.id),
      revoked: Boolean(node.revoked),
      createdAt: node.created_at,
      lastSeen: node.last_seen,
    }))
    const nodeNames = new Map(nodes.map((node) => [node.id, node.name]))
    const telemetryRows = this.store.listSessionTelemetry(
      Date.now() - this.config.dashboard.retentionHours * 60 * 60_000,
    )
    const tuis = new Map(
      this.store.listTuis([...new Set(telemetryRows.map((row) => row.instance_id))]).flatMap((row) => {
        const metadata = TuiMetadataSchema.safeParse(json(row.metadata_json))
        return metadata.success
          ? [[`${row.node_id}:${row.instance_id}`, { row, metadata: metadata.data }] as const]
          : []
      }),
    )
    const sessions = telemetryRows
      .flatMap((row) => {
        const parsed = SessionTelemetrySchema.safeParse(json(row.payload_json))
        if (!parsed.success) return []
        const tui = tuis.get(`${row.node_id}:${row.instance_id}`)
        const telemetry = parsed.data
        return [
          {
            key: `${row.node_id}:${row.session_id}`,
            nodeId: row.node_id,
            nodeName: nodeNames.get(row.node_id) ?? row.node_id.slice(0, 12),
            instanceId: row.instance_id,
            project: tui?.metadata.project ?? "unknown",
            ...(telemetry.capture === "full" && tui?.metadata.directory ? { directory: tui.metadata.directory } : {}),
            connected: Boolean(connectedNodeIds.has(row.node_id) && tui?.row.connected),
            ...telemetry,
          },
        ]
      })
      .sort((left, right) => Number(right.connected) - Number(left.connected) || right.updatedAt - left.updatedAt)
    const cost = sessions.reduce((total, session) => total + session.cost, 0)
    return {
      generatedAt: Date.now(),
      protocolVersion: PROTOCOL_VERSION,
      uptimeMs: this.uptimeMs(),
      totals: {
        nodes: nodes.length,
        connectedNodes: connectedNodeIds.size,
        sessions: sessions.length,
        busy: sessions.filter((session) => session.connected && session.status === "busy").length,
        pending: this.store.listPending().length,
        cost,
      },
      nodes,
      sessions,
    }
  }

  private open(socket: ServerWebSocket<SocketData>) {
    const previous = this.sockets.get(socket.data.nodeId)
    previous?.close(4001, "Replaced by newer node connection")
    this.store.disconnectNodeTuis(socket.data.nodeId)
    this.sockets.set(socket.data.nodeId, socket)
    const joined = this.store.connectNode(socket.data.nodeId)
    if (joined && this.config.notifications.nodeJoin && this.telegram)
      void this.telegram
        .notifyNodeJoined(joined.nodeId, joined.nodeName)
        .then((sent) => {
          if (sent > 0) this.store.markNodeJoinNotified(joined.nodeId)
        })
        .catch((error) => {
          this.log.warn("node join notification failed", { node: joined.nodeId, error })
        })
    this.log.info("node connected", { node: socket.data.nodeId })
  }

  private close(socket: ServerWebSocket<SocketData>) {
    if (this.sockets.get(socket.data.nodeId) === socket) {
      this.sockets.delete(socket.data.nodeId)
      this.store.disconnectNodeTuis(socket.data.nodeId)
    }
    this.log.info("node disconnected", { node: socket.data.nodeId })
  }

  private enqueueMessage(socket: ServerWebSocket<SocketData>, raw: string | Buffer) {
    const nodeId = socket.data.nodeId
    const previous = this.messageChains.get(nodeId) ?? Promise.resolve()
    const next = previous
      .then(() => this.message(socket, raw))
      .catch((error) => {
        this.log.warn("invalid node message", { node: nodeId, error })
        socket.close(4002, "Invalid protocol message")
      })
      .finally(() => {
        if (this.messageChains.get(nodeId) === next) this.messageChains.delete(nodeId)
      })
    this.messageChains.set(nodeId, next)
  }

  private drain(socket: ServerWebSocket<SocketData>) {
    this.log.info("node backpressure cleared", { node: socket.data.nodeId })
  }

  private send(socket: ServerWebSocket<SocketData>, message: unknown) {
    const parsed = HubToNodeSchema.parse(message)
    if (socket.send(JSON.stringify(parsed)) === 0) throw new Error("Node connection is backpressured")
  }

  private async message(socket: ServerWebSocket<SocketData>, raw: string | Buffer) {
    if (this.sockets.get(socket.data.nodeId) !== socket) return
    if (!this.store.isNodeActive(socket.data.nodeId)) {
      socket.close(4003, "Node revoked")
      return
    }
    const message = NodeToHubSchema.parse(JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8")))
    if (message.type === "hello") {
      if (message.nodeId !== socket.data.nodeId) throw new Error("Node identity mismatch")
      this.store.touchNode(message.nodeId)
      this.send(socket, {
        type: "welcome",
        protocolVersion: PROTOCOL_VERSION,
        heartbeatMs: 15_000,
        telegramReachable: Boolean(this.telegram),
        telemetry: this.config.dashboard.enabled,
      })
      for (const row of this.store.dispatchingActionsForNode(socket.data.nodeId))
        this.send(socket, JSON.parse(row.payload_json))
      return
    }
    if (message.type === "heartbeat") {
      this.store.touchNode(socket.data.nodeId)
      this.send(socket, { type: "heartbeat.ack", at: message.at })
      return
    }
    if (message.type === "action.result") {
      await this.handleActionResult(socket.data.nodeId, message)
      this.send(socket, { type: "action.ack", actionId: message.actionId })
      return
    }
    if (!this.store.hasEvent(socket.data.nodeId, message.generation, message.seq)) {
      await this.handleEvent(socket.data.nodeId, message.event)
      if (message.event.type === "reconcile") {
        const { telemetry: _telemetry, ...storedEvent } = message.event
        this.store.acceptEvent(socket.data.nodeId, message.generation, message.seq, storedEvent)
      } else this.store.acceptEvent(socket.data.nodeId, message.generation, message.seq, message.event)
    }
    this.send(socket, { type: "ack", seq: message.seq })
  }

  private async handleEvent(nodeId: string, event: BridgeEvent) {
    if (event.type === "reconcile") {
      this.store.registerTui(nodeId, event.metadata)
      if (this.config.dashboard.enabled)
        for (const telemetry of event.telemetry ?? [])
          this.store.upsertSessionTelemetry(nodeId, event.instanceId, telemetry)
      const active = new Set<string>()
      for (const pendingEvent of [...event.pendingPermissions, ...event.pendingQuestions]) {
        const result = this.store.upsertPending(nodeId, pendingEvent)
        active.add(this.store.pendingIdentity(nodeId, pendingEvent))
        if (
          (pendingEvent.type === "permission.asked" && this.config.notifications.permission) ||
          (pendingEvent.type === "question.asked" && this.config.notifications.question)
        ) {
          if (result.reactivated) await this.telegram?.updatePending(result.row, "", true)
          await this.telegram?.notifyPending(result.row)
        }
      }
      const stale = this.store.reconcileInstance(nodeId, event.instanceId, active, new Set(event.scopeSessionIds))
      for (const row of stale) await this.telegram?.updatePending(row, "⌛ Request is no longer pending in OpenCode")
      return
    }
    if (event.type === "permission.asked" || event.type === "question.asked") {
      if (event.type === "permission.asked" && !this.config.notifications.permission) return
      if (event.type === "question.asked" && !this.config.notifications.question) return
      const result = this.store.upsertPending(nodeId, event)
      if (result.reactivated) await this.telegram?.updatePending(result.row, "", true)
      await this.telegram?.notifyPending(result.row)
      return
    }
    if (event.type === "tui.disconnected") {
      this.store.disconnectTui(nodeId, event.instanceId)
      return
    }
    if (event.type === "request.resolved") {
      const row = this.store.resolveByRequest(nodeId, event)
      if (row) {
        const label =
          event.source === "telegram"
            ? "⌛ OpenCode replied; verifying continuation"
            : event.resolution === "reject" || event.resolution === "cancelled"
              ? "⛔ Rejected locally in OpenCode TUI"
              : "✅ Resolved locally in OpenCode TUI"
        await this.telegram?.updatePending(
          { ...row, state: event.source === "telegram" ? "dispatching" : "resolved_locally" },
          label,
        )
      }
      return
    }
    await this.telegram?.notifyExecution(event)
  }

  async dispatch(
    row: PendingRow,
    operation: ActionDispatch["operation"],
    data: { message?: string; answers?: string[][] } = {},
  ) {
    const now = Date.now()
    const action = this.store.createAction(row, {
      operation,
      ...data,
      createdAt: now,
      expiresAt: Math.min(row.expires_at, now + 60_000),
    })
    const socket = this.sockets.get(row.node_id)
    if (!socket || !this.store.isNodeActive(row.node_id)) {
      this.store.finishAction(action.actionId, "failed", "Originating node is offline")
      throw new Error("Originating node is offline; no action was applied")
    }
    try {
      this.send(socket, action)
    } catch (error) {
      this.store.finishAction(action.actionId, "failed", clip(error, 500))
      throw error
    }
  }

  private async handleActionResult(
    nodeId: string,
    result: Extract<ReturnType<typeof NodeToHubSchema.parse>, { type: "action.result" }>,
  ) {
    const action = this.store.getAction(result.actionId)
    if (action?.state !== "dispatching") return
    const owned = this.store.getPending(action.pending_identity)
    if (!owned || owned.node_id !== nodeId) throw new Error("Action result node does not own pending request")
    const proven = Boolean(
      result.evidence?.repliedEvent && result.evidence.pendingAbsent && result.evidence.executionObserved,
    )
    const state =
      result.ok && result.state === "confirmed" && proven ? "confirmed" : result.state === "stale" ? "stale" : "failed"
    this.store.finishAction(result.actionId, state, result.detail)
    const row = this.store.getPending(action.pending_identity)
    if (!row) return
    if (state === "confirmed") {
      const labels: Record<string, string> = {
        once: "✅ Allowed once via Telegram",
        always: "✅ Saved exact OpenCode permission via Telegram",
        reject: "⛔ Rejected via Telegram",
        answer: "✅ Answered via Telegram",
        cancel: "⛔ Cancelled via Telegram",
      }
      await this.telegram?.updatePending(row, labels[action.operation] ?? "✅ Confirmed by OpenCode")
    } else if (state === "stale") {
      await this.telegram?.updatePending(row, "⌛ Request was already resolved")
    } else {
      await this.telegram?.updatePending(
        row,
        `❌ Not confirmed by OpenCode${result.detail ? `: ${clip(result.detail, 260)}` : ""}`,
        true,
      )
    }
  }
}
