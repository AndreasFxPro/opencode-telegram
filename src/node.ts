import { hostname } from "node:os"
import { join } from "node:path"
import type { Server } from "bun"
import type { Config, Secrets } from "./config.ts"
import { dataDir, splitListen } from "./config.ts"
import {
  type ActionDispatch,
  ActionDispatchSchema,
  type BridgeEvent,
  HubToNodeSchema,
  LocalRequestSchema,
  type TuiMetadata,
} from "./protocol.ts"
import { NodeStore } from "./store.ts"
import { backoff, createLogger, safeEqualHash, sha256, sleep } from "./util.ts"
import { PROTOCOL_VERSION, VERSION } from "./version.ts"

type Waiter = (command: ActionDispatch | undefined) => void

export class NodeService {
  readonly store: NodeStore
  readonly startedAt = Date.now()
  private readonly log = createLogger("node")
  private readonly controller = new AbortController()
  private readonly waiters = new Map<string, Waiter[]>()
  private readonly instances = new Map<string, { seenAt: number; metadata: TuiMetadata }>()
  private socket?: WebSocket
  private localServer?: Server<undefined>
  private heartbeat?: Timer
  private instanceTimer?: Timer
  private hubConnected = false
  private telegramReachable = false
  private telemetrySupported = false
  private attempt = 0

  constructor(
    readonly config: Config,
    readonly secrets: Secrets,
    databasePath = join(dataDir(config), "node.db"),
  ) {
    this.store = new NodeStore(databasePath)
    this.assertTransportSecurity()
  }

  private assertTransportSecurity() {
    const url = new URL(this.config.node.hubUrl)
    const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname.replace(/^\[|\]$/g, ""))
    if (url.protocol !== "wss:" && !loopback && !this.config.node.allowInsecureHub) {
      throw new Error(
        "Non-loopback node-to-hub connections require wss://. Set node.allowInsecureHub only for development.",
      )
    }
  }

  async start() {
    const listen = splitListen(this.config.node.localListen)
    if (!["127.0.0.1", "localhost", "::1"].includes(listen.hostname))
      throw new Error("Plugin-to-node listener must remain loopback-only")
    this.localServer = Bun.serve({ ...listen, fetch: (request) => this.fetch(request), idleTimeout: 30 })
    this.instanceTimer = setInterval(() => {
      const cutoff = Date.now() - 20_000
      for (const [instanceId, instance] of this.instances)
        if (instance.seenAt < cutoff) this.disconnectInstance(instanceId)
    }, 10_000)
    void this.connectLoop()
    this.log.info("local listener ready", { address: this.config.node.localListen })
  }

  async stop() {
    this.controller.abort()
    if (this.heartbeat) clearInterval(this.heartbeat)
    if (this.instanceTimer) clearInterval(this.instanceTimer)
    this.socket?.close(1001, "Node shutting down")
    for (const callbacks of this.waiters.values()) for (const callback of callbacks) callback(undefined)
    this.localServer?.stop(true)
    this.store.close()
  }

  private authenticated(request: Request) {
    const value = request.headers.get("authorization") ?? ""
    const secret = value.startsWith("Bearer ") ? value.slice(7) : ""
    return secret.length > 0 && safeEqualHash(secret, sha256(this.secrets.localPluginSecret))
  }

  private async readJson(request: Request) {
    const length = Number(request.headers.get("content-length") ?? 0)
    if (length > 1024 * 1024) throw new Error("Request exceeds 1 MiB")
    return request.json() as Promise<unknown>
  }

  private disconnectInstance(instanceId: string) {
    const instance = this.instances.get(instanceId)
    this.instances.delete(instanceId)
    if (!instance) return
    this.enqueue({
      type: "tui.disconnected",
      eventId: `evt_${crypto.randomUUID()}`,
      emittedAt: Date.now(),
      instanceId,
      ...(instance.metadata.sessionId ? { sessionId: instance.metadata.sessionId } : {}),
      ...(instance.metadata.rootSessionId ? { rootSessionId: instance.metadata.rootSessionId } : {}),
      location: instance.metadata.location,
    })
  }

  private async fetch(request: Request) {
    const url = new URL(request.url)
    if (url.pathname === "/health") {
      if (!this.authenticated(request)) return new Response("Forbidden", { status: 403 })
      return Response.json({
        ok: true,
        hubConnected: this.hubConnected,
        telegramReachable: this.telegramReachable,
        activeTuis: this.instances.size,
        queued: this.store.pending().length,
        uptimeMs: Date.now() - this.startedAt,
      })
    }
    if (!this.authenticated(request)) return new Response("Forbidden", { status: 403 })
    if (url.pathname === "/v1/plugin" && request.method === "POST") {
      let body: unknown
      try {
        body = await this.readJson(request)
      } catch (error) {
        const status = error instanceof Error && error.message.includes("exceeds 1 MiB") ? 413 : 400
        return Response.json({ error: String(error) }, { status })
      }
      const parsed = LocalRequestSchema.safeParse(body)
      if (!parsed.success) return Response.json({ error: parsed.error.message }, { status: 400 })
      const message = parsed.data
      try {
        if (message.type === "register") {
          this.instances.set(message.metadata.instanceId, { seenAt: Date.now(), metadata: message.metadata })
          return Response.json({ ok: true }, { status: 202 })
        }
        if (message.type === "unregister") {
          this.disconnectInstance(message.instanceId)
          return Response.json({ ok: true }, { status: 202 })
        }
        if (message.type === "event") {
          if (message.event.type === "reconcile")
            this.instances.set(message.event.instanceId, { seenAt: Date.now(), metadata: message.event.metadata })
          else {
            const current = this.instances.get(message.event.instanceId)
            if (current) current.seenAt = Date.now()
          }
          this.enqueue(message.event)
          return Response.json({ ok: true }, { status: 202 })
        }
        this.store.completeCommand(message.actionId, message)
        this.flushResults()
        return Response.json({ ok: true }, { status: 202 })
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 503 })
      }
    }
    if (url.pathname === "/v1/commands" && request.method === "GET") {
      const instanceId = url.searchParams.get("instanceId") ?? ""
      if (!instanceId) return Response.json({ error: "instanceId required" }, { status: 400 })
      const queued = this.store.command(instanceId)
      if (queued) return Response.json({ command: queued })
      const command = await new Promise<ActionDispatch | undefined>((resolve) => {
        const list = this.waiters.get(instanceId) ?? []
        let settled = false
        let timer: Timer
        const finish: Waiter = (value) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          const current = this.waiters.get(instanceId) ?? []
          const index = current.indexOf(finish)
          if (index >= 0) current.splice(index, 1)
          resolve(value)
        }
        list.push(finish)
        this.waiters.set(instanceId, list)
        timer = setTimeout(() => finish(undefined), 20_000)
        request.signal.addEventListener(
          "abort",
          () => {
            finish(undefined)
          },
          { once: true },
        )
      })
      return Response.json({ command: command ?? null })
    }
    return new Response("Not found", { status: 404 })
  }

  private enqueue(event: BridgeEvent) {
    if (event.type === "reconcile" && !this.telemetrySupported) {
      const { telemetry: _telemetry, ...compatibleEvent } = event
      this.store.enqueue(compatibleEvent, this.config.node.queueLimit)
    } else this.store.enqueue(event, this.config.node.queueLimit)
    this.flush()
  }

  private sendHub(message: unknown) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN)
      throw new Error("Hub is offline; action result will be retried by plugin")
    this.socket.send(JSON.stringify(message))
  }

  private flush() {
    if (!this.hubConnected || !this.socket || this.socket.readyState !== WebSocket.OPEN) return
    for (const row of this.store.pending()) {
      const event = JSON.parse(row.payload_json) as BridgeEvent
      const compatibleEvent =
        event.type === "reconcile" && !this.telemetrySupported
          ? (({ telemetry: _telemetry, ...compatible }) => compatible)(event)
          : event
      this.socket.send(
        JSON.stringify({
          type: "event",
          generation: this.store.generation(),
          seq: row.seq,
          event: compatibleEvent,
        }),
      )
      if (this.socket.bufferedAmount > 4 * 1024 * 1024) break
    }
    this.flushResults()
  }

  private flushResults() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return
    for (const row of this.store.results()) this.socket.send(row.payload_json)
  }

  private route(action: ActionDispatch) {
    if (Date.now() >= action.expiresAt) {
      this.sendHub({
        type: "action.result",
        actionId: action.actionId,
        ok: false,
        state: "stale",
        detail: "Action expired before local delivery",
      })
      return
    }
    this.store.storeCommand(action)
    const waiter = this.waiters.get(action.instanceId)?.shift()
    if (waiter) waiter(action)
  }

  private async connectLoop() {
    while (!this.controller.signal.aborted) {
      if (!this.secrets.nodeCredential) {
        this.log.error("node is not enrolled", { fix: "Run setup node with an enrollment token" })
        return
      }
      try {
        await this.connect()
        this.attempt = 0
      } catch (error) {
        this.log.warn("hub connection failed", { error })
      }
      this.hubConnected = false
      if (this.heartbeat) clearInterval(this.heartbeat)
      await sleep(backoff(this.attempt++), this.controller.signal).catch(() => undefined)
    }
  }

  private connect() {
    return new Promise<void>((resolve, reject) => {
      this.telemetrySupported = false
      const BunWebSocket = WebSocket as typeof WebSocket & {
        new (url: string | URL, options?: Bun.WebSocketOptions): WebSocket
      }
      const socket = new BunWebSocket(this.config.node.hubUrl, {
        headers: { authorization: `Bearer ${this.secrets.nodeCredential}`, "x-node-id": this.secrets.nodeId },
      })
      this.socket = socket
      let welcomed = false
      let settled = false
      const fail = (error: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        socket.close()
        reject(error)
      }
      const timeout = setTimeout(() => fail(new Error("Hub connection timed out")), 10_000)
      socket.addEventListener("open", () => {
        socket.send(
          JSON.stringify({
            type: "hello",
            protocolVersion: PROTOCOL_VERSION,
            nodeId: this.secrets.nodeId,
            nodeName: this.config.node.name,
            hostname: hostname(),
            version: VERSION,
            lastAck: this.store.lastAck(),
            generation: this.store.generation(),
          }),
        )
      })
      socket.addEventListener("message", (event) => {
        if (this.socket !== socket) return
        try {
          const message = HubToNodeSchema.parse(JSON.parse(String(event.data)))
          if (message.type === "welcome") {
            clearTimeout(timeout)
            welcomed = true
            this.hubConnected = true
            this.telegramReachable = message.telegramReachable
            this.telemetrySupported = Boolean(message.telemetry)
            this.heartbeat = setInterval(() => {
              if (socket.readyState === WebSocket.OPEN)
                socket.send(JSON.stringify({ type: "heartbeat", at: Date.now() }))
            }, message.heartbeatMs)
            this.flush()
          } else if (message.type === "ack") {
            this.store.ack(message.seq)
            this.flush()
          } else if (message.type === "action.ack") {
            this.store.ackResult(message.actionId)
          } else if (message.type === "action.dispatch") this.route(ActionDispatchSchema.parse(message))
        } catch (error) {
          socket.close(4002, "Invalid hub message")
          fail(error instanceof Error ? error : new Error(String(error)))
        }
      })
      socket.addEventListener("error", () => fail(new Error("WebSocket connection failed")), { once: true })
      socket.addEventListener("close", () => {
        clearTimeout(timeout)
        this.hubConnected = false
        this.telemetrySupported = false
        if (settled) return
        settled = true
        if (welcomed) resolve()
        else reject(new Error("Hub closed before protocol welcome"))
      })
    })
  }
}
