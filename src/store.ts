import { Database } from "bun:sqlite"
import { chmodSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type { ActionDispatch, BridgeEvent, SessionTelemetry, TuiMetadata } from "./protocol.ts"
import { requestIdentity } from "./protocol.ts"
import { randomId, safeEqualHash, sha256 } from "./util.ts"

export type PendingRow = {
  identity: string
  node_id: string
  instance_id: string
  session_id: string
  request_id: string
  kind: "permission" | "question"
  state: "pending" | "dispatching" | "confirmed" | "resolved_locally" | "failed" | "expired" | "stale"
  event_json: string
  callback_id: string
  chat_id: number | null
  message_id: number | null
  thread_id: number | null
  draft_json: string | null
  created_at: number
  updated_at: number
  expires_at: number
}

export type ActionRow = {
  id: string
  pending_identity: string
  operation: ActionDispatch["operation"]
  state: "dispatching" | "confirmed" | "failed" | "stale" | "expired"
  payload_json: string
  detail: string | null
  created_at: number
  updated_at: number
  expires_at: number
}

export type SessionTelemetryRow = {
  node_id: string
  instance_id: string
  session_id: string
  payload_json: string
  updated_at: number
}

const MAX_SESSION_TELEMETRY_ROWS = 128
const MAX_SESSION_TELEMETRY_ROW_BYTES = 384 * 1024
const MAX_SESSION_TELEMETRY_TOTAL_BYTES = 4 * 1024 * 1024

export class HubStore {
  readonly db: Database

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new Database(path, { create: true, strict: true })
    chmodSync(dirname(path), 0o700)
    chmodSync(path, 0o600)
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;")
    this.migrate()
    this.pruneSessionTelemetry()
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '1'), ('telegram_offset', '0');
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, credential_hash TEXT NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, last_seen INTEGER,
        connected_at INTEGER, join_notified_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS enrollments (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL,
        expires_at INTEGER NOT NULL, used_at INTEGER, revoked_at INTEGER, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        node_id TEXT NOT NULL, generation TEXT NOT NULL, seq INTEGER NOT NULL, event_id TEXT NOT NULL UNIQUE,
        payload_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(node_id, generation, seq)
      );
      CREATE TABLE IF NOT EXISTS tuis (
        instance_id TEXT PRIMARY KEY, node_id TEXT NOT NULL, metadata_json TEXT NOT NULL,
        connected INTEGER NOT NULL DEFAULT 1, last_seen INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_telemetry (
        node_id TEXT NOT NULL, instance_id TEXT NOT NULL, session_id TEXT NOT NULL,
        payload_json TEXT NOT NULL, source_updated_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
        PRIMARY KEY(node_id, session_id)
      );
      CREATE INDEX IF NOT EXISTS session_telemetry_updated_idx ON session_telemetry(updated_at);
      CREATE TABLE IF NOT EXISTS pending (
        identity TEXT PRIMARY KEY, node_id TEXT NOT NULL, instance_id TEXT NOT NULL,
        session_id TEXT NOT NULL, request_id TEXT NOT NULL, kind TEXT NOT NULL,
        state TEXT NOT NULL, event_json TEXT NOT NULL, callback_id TEXT UNIQUE NOT NULL,
        chat_id INTEGER, message_id INTEGER, thread_id INTEGER, draft_json TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pending_state_idx ON pending(state, updated_at);
      CREATE INDEX IF NOT EXISTS pending_callback_idx ON pending(callback_id);
      CREATE TABLE IF NOT EXISTS telegram_messages (
        pending_identity TEXT NOT NULL, chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL,
        thread_id INTEGER, created_at INTEGER NOT NULL,
        PRIMARY KEY(chat_id, message_id),
        UNIQUE(pending_identity, chat_id, thread_id),
        FOREIGN KEY(pending_identity) REFERENCES pending(identity)
      );
      CREATE TABLE IF NOT EXISTS actions (
        id TEXT PRIMARY KEY, pending_identity TEXT NOT NULL, operation TEXT NOT NULL,
        state TEXT NOT NULL, payload_json TEXT NOT NULL, detail TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        FOREIGN KEY(pending_identity) REFERENCES pending(identity)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS action_active_idx ON actions(pending_identity)
        WHERE state = 'dispatching';
      CREATE TABLE IF NOT EXISTS mutes (
        scope TEXT NOT NULL, scope_id TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(scope, scope_id)
      );
    `)
    const nodeColumns = this.db.query("PRAGMA table_info(nodes)").all() as Array<{ name: string }>
    if (!nodeColumns.some((column) => column.name === "connected_at")) {
      this.db.exec("ALTER TABLE nodes ADD COLUMN connected_at INTEGER")
      this.db.exec("UPDATE nodes SET connected_at=last_seen")
    }
    if (!nodeColumns.some((column) => column.name === "join_notified_at")) {
      this.db.exec("ALTER TABLE nodes ADD COLUMN join_notified_at INTEGER")
      this.db.exec("UPDATE nodes SET join_notified_at=last_seen")
    }
    const telemetryColumns = this.db.query("PRAGMA table_info(session_telemetry)").all() as Array<{ name: string }>
    if (!telemetryColumns.some((column) => column.name === "source_updated_at")) {
      this.db.exec("ALTER TABLE session_telemetry ADD COLUMN source_updated_at INTEGER NOT NULL DEFAULT 0")
      this.db.exec(
        "UPDATE session_telemetry SET source_updated_at=COALESCE(CAST(json_extract(payload_json,'$.updatedAt') AS INTEGER),0)",
      )
    }
  }

  close() {
    this.db.close()
  }

  createEnrollment(name: string, ttlMs = 15 * 60_000) {
    const id = randomId("join")
    const token = randomId("oct_join", 24)
    const now = Date.now()
    this.db
      .query("INSERT INTO enrollments(id,name,token_hash,expires_at,created_at) VALUES(?,?,?,?,?)")
      .run(id, name, sha256(token), now + ttlMs, now)
    return { id, token, expiresAt: now + ttlMs }
  }

  exchangeEnrollment(token: string) {
    const now = Date.now()
    const row = this.db
      .query(
        "SELECT id,name FROM enrollments WHERE token_hash=? AND used_at IS NULL AND revoked_at IS NULL AND expires_at>?",
      )
      .get(sha256(token), now) as { id: string; name: string } | null
    if (!row) return undefined
    const nodeId = randomId("node")
    const credential = randomId("oct_node", 32)
    this.db.transaction(() => {
      const result = this.db.query("UPDATE enrollments SET used_at=? WHERE id=? AND used_at IS NULL").run(now, row.id)
      if (result.changes !== 1) throw new Error("Enrollment token was already used")
      this.db
        .query("INSERT INTO nodes(id,name,credential_hash,created_at,last_seen) VALUES(?,?,?,?,?)")
        .run(nodeId, row.name, sha256(credential), now, now)
    })()
    return { nodeId, nodeName: row.name, credential }
  }

  ensureNode(nodeId: string, name: string, credential: string) {
    const now = Date.now()
    this.db
      .query("INSERT OR IGNORE INTO nodes(id,name,credential_hash,created_at,last_seen) VALUES(?,?,?,?,?)")
      .run(nodeId, name, sha256(credential), now, now)
  }

  authenticateNode(nodeId: string, credential: string) {
    const row = this.db.query("SELECT credential_hash,revoked FROM nodes WHERE id=?").get(nodeId) as {
      credential_hash: string
      revoked: number
    } | null
    return Boolean(row && !row.revoked && safeEqualHash(credential, row.credential_hash))
  }

  isNodeActive(nodeId: string) {
    return Boolean(
      (this.db.query("SELECT revoked FROM nodes WHERE id=?").get(nodeId) as { revoked: number } | null)?.revoked === 0,
    )
  }

  touchNode(nodeId: string) {
    this.db.query("UPDATE nodes SET last_seen=? WHERE id=?").run(Date.now(), nodeId)
  }

  connectNode(nodeId: string) {
    const row = this.db
      .query("SELECT name,revoked,connected_at,join_notified_at FROM nodes WHERE id=?")
      .get(nodeId) as {
      name: string
      revoked: number
      connected_at: number | null
      join_notified_at: number | null
    } | null
    if (!row || row.revoked) return undefined
    const now = Date.now()
    this.db.query("UPDATE nodes SET last_seen=?,connected_at=COALESCE(connected_at,?) WHERE id=?").run(now, now, nodeId)
    return row.join_notified_at === null ? { nodeId, nodeName: row.name } : undefined
  }

  markNodeJoinNotified(nodeId: string) {
    this.db.query("UPDATE nodes SET join_notified_at=COALESCE(join_notified_at,?) WHERE id=?").run(Date.now(), nodeId)
  }

  listNodes() {
    return this.db.query("SELECT id,name,revoked,created_at,last_seen FROM nodes ORDER BY name").all() as Array<{
      id: string
      name: string
      revoked: number
      created_at: number
      last_seen: number | null
    }>
  }

  renameNode(id: string, name: string) {
    return this.db.query("UPDATE nodes SET name=? WHERE id=?").run(name, id).changes === 1
  }

  revokeNode(id: string) {
    return this.db.query("UPDATE nodes SET revoked=1 WHERE id=?").run(id).changes === 1
  }

  acceptEvent(nodeId: string, generation: string, seq: number, event: BridgeEvent) {
    return (
      this.db
        .query(
          "INSERT OR IGNORE INTO events(node_id,generation,seq,event_id,payload_json,created_at) VALUES(?,?,?,?,?,?)",
        )
        .run(nodeId, generation, seq, event.eventId, JSON.stringify(event), Date.now()).changes === 1
    )
  }

  hasEvent(nodeId: string, generation: string, seq: number) {
    return Boolean(
      this.db
        .query("SELECT 1 AS found FROM events WHERE node_id=? AND generation=? AND seq=?")
        .get(nodeId, generation, seq),
    )
  }

  registerTui(nodeId: string, metadata: TuiMetadata) {
    this.db
      .query(`INSERT INTO tuis(instance_id,node_id,metadata_json,connected,last_seen) VALUES(?,?,?,1,?)
        ON CONFLICT(instance_id) DO UPDATE SET node_id=excluded.node_id,metadata_json=excluded.metadata_json,connected=1,last_seen=excluded.last_seen`)
      .run(metadata.instanceId, nodeId, JSON.stringify(metadata), Date.now())
  }

  disconnectTui(nodeId: string, instanceId: string) {
    this.db
      .query("UPDATE tuis SET connected=0,last_seen=? WHERE node_id=? AND instance_id=?")
      .run(Date.now(), nodeId, instanceId)
  }

  disconnectNodeTuis(nodeId: string) {
    this.db.query("UPDATE tuis SET connected=0,last_seen=? WHERE node_id=? AND connected=1").run(Date.now(), nodeId)
  }

  disconnectAllTuis() {
    this.db.query("UPDATE tuis SET connected=0,last_seen=? WHERE connected=1").run(Date.now())
  }

  listTuis(instanceIds?: string[]) {
    if (instanceIds?.length === 0) return []
    const where = instanceIds ? ` WHERE instance_id IN (${instanceIds.map(() => "?").join(",")})` : ""
    return this.db
      .query(`SELECT instance_id,node_id,metadata_json,connected,last_seen FROM tuis${where} ORDER BY last_seen DESC`)
      .all(...(instanceIds ?? [])) as Array<{
      instance_id: string
      node_id: string
      metadata_json: string
      connected: number
      last_seen: number
    }>
  }

  activeTuiCount() {
    return (this.db.query("SELECT COUNT(*) AS count FROM tuis WHERE connected=1").get() as { count: number }).count
  }

  upsertSessionTelemetry(nodeId: string, instanceId: string, telemetry: SessionTelemetry) {
    const payload = JSON.stringify(telemetry)
    if (Buffer.byteLength(payload) > MAX_SESSION_TELEMETRY_ROW_BYTES) return false
    return this.db.transaction(() => {
      this.db
        .query(`INSERT INTO session_telemetry(node_id,instance_id,session_id,payload_json,source_updated_at,updated_at)
          VALUES(?,?,?,?,?,?) ON CONFLICT(node_id,session_id) DO UPDATE SET instance_id=excluded.instance_id,
          payload_json=excluded.payload_json,source_updated_at=excluded.source_updated_at,updated_at=excluded.updated_at
          WHERE excluded.source_updated_at>=session_telemetry.source_updated_at`)
        .run(nodeId, instanceId, telemetry.sessionId, payload, telemetry.updatedAt, Date.now())
      this.db
        .query(
          "DELETE FROM session_telemetry WHERE rowid IN (SELECT rowid FROM session_telemetry ORDER BY updated_at DESC LIMIT -1 OFFSET ?)",
        )
        .run(MAX_SESSION_TELEMETRY_ROWS)
      this.pruneSessionTelemetry()
      return true
    })()
  }

  private pruneSessionTelemetry() {
    this.db
      .query("DELETE FROM session_telemetry WHERE length(CAST(payload_json AS BLOB))>?")
      .run(MAX_SESSION_TELEMETRY_ROW_BYTES)
    let total = Number(
      (
        this.db
          .query("SELECT COALESCE(SUM(length(CAST(payload_json AS BLOB))),0) AS bytes FROM session_telemetry")
          .get() as { bytes: number }
      ).bytes,
    )
    while (total > MAX_SESSION_TELEMETRY_TOTAL_BYTES) {
      const oldest = this.db
        .query(
          "SELECT rowid,length(CAST(payload_json AS BLOB)) AS bytes FROM session_telemetry ORDER BY updated_at,rowid LIMIT 1",
        )
        .get() as { rowid: number; bytes: number } | null
      if (!oldest) break
      this.db.query("DELETE FROM session_telemetry WHERE rowid=?").run(oldest.rowid)
      total -= oldest.bytes
    }
  }

  listSessionTelemetry(updatedAfter = 0) {
    return this.db
      .query(
        "SELECT node_id,instance_id,session_id,payload_json,updated_at FROM session_telemetry WHERE updated_at>=? ORDER BY updated_at DESC LIMIT ?",
      )
      .all(updatedAfter, MAX_SESSION_TELEMETRY_ROWS) as SessionTelemetryRow[]
  }

  clearSessionTelemetry() {
    this.db.query("DELETE FROM session_telemetry").run()
  }

  cleanupTelemetry(now: number, retentionMs: number) {
    this.db.query("DELETE FROM session_telemetry WHERE updated_at<?").run(now - retentionMs)
  }

  upsertPending(nodeId: string, event: BridgeEvent & { requestId: string }) {
    const identity = this.pendingIdentity(nodeId, event)
    const kind = event.type === "permission.asked" ? "permission" : "question"
    const now = Date.now()
    const existing = this.getPending(identity)
    this.db
      .query(`INSERT INTO pending(identity,node_id,instance_id,session_id,request_id,kind,state,event_json,callback_id,created_at,updated_at,expires_at)
        VALUES(?,?,?,?,?,?,'pending',?,?,?,?,?)
        ON CONFLICT(identity) DO UPDATE SET event_json=excluded.event_json,updated_at=excluded.updated_at,
          expires_at=excluded.expires_at,state=CASE WHEN pending.state IN ('stale','expired') THEN 'pending' ELSE pending.state END`)
      .run(
        identity,
        nodeId,
        event.instanceId,
        event.sessionId ?? "",
        event.requestId,
        kind,
        JSON.stringify(event),
        existing?.callback_id ?? randomId("cb", 12),
        now,
        now,
        now + 6 * 60 * 60_000,
      )
    return { row: this.getPending(identity) as PendingRow, created: !existing }
  }

  pendingIdentity(nodeId: string, event: Parameters<typeof requestIdentity>[0]) {
    return `${nodeId}\u001f${requestIdentity(event)}`
  }

  getPending(identity: string) {
    return this.db.query("SELECT * FROM pending WHERE identity=?").get(identity) as PendingRow | null
  }

  getPendingByCallback(callbackId: string) {
    return this.db.query("SELECT * FROM pending WHERE callback_id=?").get(callbackId) as PendingRow | null
  }

  getPendingByMessage(chatId: number, messageId: number) {
    return this.db
      .query(
        "SELECT pending.* FROM pending JOIN telegram_messages ON telegram_messages.pending_identity=pending.identity WHERE telegram_messages.chat_id=? AND telegram_messages.message_id=?",
      )
      .get(chatId, messageId) as PendingRow | null
  }

  listPending(activeOnly = true) {
    const sql = activeOnly
      ? "SELECT * FROM pending WHERE state IN ('pending','dispatching','failed') ORDER BY created_at"
      : "SELECT * FROM pending ORDER BY created_at DESC"
    return this.db.query(sql).all() as PendingRow[]
  }

  setTelegramMessage(identity: string, chatId: number, messageId: number, threadId?: number) {
    this.db.transaction(() => {
      this.db
        .query(
          "INSERT OR REPLACE INTO telegram_messages(pending_identity,chat_id,message_id,thread_id,created_at) VALUES(?,?,?,?,?)",
        )
        .run(identity, chatId, messageId, threadId ?? null, Date.now())
      this.db
        .query(
          "UPDATE pending SET chat_id=COALESCE(chat_id,?),message_id=COALESCE(message_id,?),thread_id=COALESCE(thread_id,?),updated_at=? WHERE identity=?",
        )
        .run(chatId, messageId, threadId ?? null, Date.now(), identity)
    })()
  }

  telegramMessages(identity: string) {
    return this.db
      .query("SELECT chat_id,message_id,thread_id FROM telegram_messages WHERE pending_identity=?")
      .all(identity) as Array<{ chat_id: number; message_id: number; thread_id: number | null }>
  }

  setDraft(identity: string, draft: unknown) {
    this.db
      .query("UPDATE pending SET draft_json=?,updated_at=? WHERE identity=?")
      .run(JSON.stringify(draft), Date.now(), identity)
  }

  markResolved(identity: string, state: PendingRow["state"]) {
    this.db.query("UPDATE pending SET state=?,updated_at=? WHERE identity=?").run(state, Date.now(), identity)
  }

  resolveByRequest(nodeId: string, event: BridgeEvent & { requestId: string }) {
    const row = this.db
      .query("SELECT * FROM pending WHERE node_id=? AND instance_id=? AND request_id=? AND session_id=?")
      .get(nodeId, event.instanceId, event.requestId, event.sessionId ?? "") as PendingRow | null
    if (row && !(event.type === "request.resolved" && event.source === "telegram"))
      this.markResolved(row.identity, "resolved_locally")
    return row
  }

  reconcileInstance(nodeId: string, instanceId: string, activeIdentities: Set<string>, scopeSessionIds: Set<string>) {
    const rows = this.db
      .query("SELECT * FROM pending WHERE node_id=? AND instance_id=? AND state IN ('pending','dispatching','failed')")
      .all(nodeId, instanceId) as PendingRow[]
    const stale = rows.filter((row) => scopeSessionIds.has(row.session_id) && !activeIdentities.has(row.identity))
    this.db.transaction(() => {
      for (const row of stale) this.markResolved(row.identity, "stale")
    })()
    return stale
  }

  createAction(
    row: PendingRow,
    input: Omit<
      ActionDispatch,
      "type" | "actionId" | "instanceId" | "sessionId" | "requestId" | "requestKind" | "location"
    >,
  ) {
    if (!row.session_id) throw new Error("Request has no session identity")
    if (row.state !== "pending" && row.state !== "failed") throw new Error("Request is no longer actionable")
    if (row.expires_at <= Date.now()) throw new Error("Request has expired")
    const event = JSON.parse(row.event_json) as BridgeEvent
    const action: ActionDispatch = {
      type: "action.dispatch",
      actionId: randomId("act", 20),
      instanceId: row.instance_id,
      sessionId: row.session_id,
      requestId: row.request_id,
      requestKind: row.kind,
      location: event.location,
      ...input,
    }
    this.db.transaction(() => {
      const claimed = this.db
        .query(
          "UPDATE pending SET state='dispatching',updated_at=? WHERE identity=? AND state IN ('pending','failed') AND expires_at>?",
        )
        .run(Date.now(), row.identity, Date.now())
      if (claimed.changes !== 1) throw new Error("Request was concurrently resolved or claimed")
      this.db
        .query(
          "INSERT INTO actions(id,pending_identity,operation,state,payload_json,created_at,updated_at,expires_at) VALUES(?,?,?,'dispatching',?,?,?,?)",
        )
        .run(
          action.actionId,
          row.identity,
          action.operation,
          JSON.stringify(action),
          action.createdAt,
          action.createdAt,
          action.expiresAt,
        )
    })()
    return action
  }

  getAction(id: string) {
    return this.db.query("SELECT * FROM actions WHERE id=?").get(id) as ActionRow | null
  }

  dispatchingActionsForNode(nodeId: string) {
    return this.db
      .query(
        "SELECT actions.payload_json FROM actions JOIN pending ON pending.identity=actions.pending_identity WHERE pending.node_id=? AND actions.state='dispatching' AND actions.expires_at>?",
      )
      .all(nodeId, Date.now()) as Array<{ payload_json: string }>
  }

  finishAction(id: string, state: ActionRow["state"], detail?: string) {
    const action = this.getAction(id)
    if (action?.state !== "dispatching") return action
    this.db.transaction(() => {
      this.db
        .query("UPDATE actions SET state=?,detail=?,updated_at=? WHERE id=?")
        .run(state, detail ?? null, Date.now(), id)
      const pendingState = state === "confirmed" ? "confirmed" : state === "stale" ? "stale" : "failed"
      this.db
        .query("UPDATE pending SET state=?,updated_at=? WHERE identity=? AND state='dispatching'")
        .run(pendingState, Date.now(), action.pending_identity)
    })()
    return this.getAction(id)
  }

  telegramOffset() {
    return Number(
      (this.db.query("SELECT value FROM meta WHERE key='telegram_offset'").get() as { value: string }).value,
    )
  }

  setTelegramOffset(offset: number) {
    this.db.query("UPDATE meta SET value=? WHERE key='telegram_offset'").run(String(offset))
  }

  acquireHubLease(owner: string, ttlMs = 30_000) {
    return this.db.transaction(() => {
      const row = this.db.query("SELECT value FROM meta WHERE key='hub_lease'").get() as { value: string } | null
      const current = row ? (JSON.parse(row.value) as { owner: string; expiresAt: number }) : undefined
      if (current && current.owner !== owner && current.expiresAt > Date.now()) return false
      this.db
        .query("INSERT INTO meta(key,value) VALUES('hub_lease',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(JSON.stringify({ owner, expiresAt: Date.now() + ttlMs }))
      return true
    })()
  }

  releaseHubLease(owner: string) {
    const row = this.db.query("SELECT value FROM meta WHERE key='hub_lease'").get() as { value: string } | null
    if (row && (JSON.parse(row.value) as { owner: string }).owner === owner)
      this.db.query("DELETE FROM meta WHERE key='hub_lease'").run()
  }

  cleanup(now = Date.now(), telemetryRetentionMs = 24 * 60 * 60_000) {
    const expired = this.db
      .query(
        "SELECT pending.* FROM pending JOIN actions ON actions.pending_identity=pending.identity WHERE pending.state='dispatching' AND actions.state='dispatching' AND actions.expires_at<=?",
      )
      .all(now) as PendingRow[]
    this.db.transaction(() => {
      this.db
        .query("UPDATE actions SET state='expired',updated_at=? WHERE state='dispatching' AND expires_at<=?")
        .run(now, now)
      this.db
        .query(
          "UPDATE pending SET state='expired',updated_at=? WHERE state='dispatching' AND identity IN (SELECT pending_identity FROM actions WHERE state='expired')",
        )
        .run(now)
    })()
    this.db
      .query("UPDATE pending SET state='expired',updated_at=? WHERE state IN ('pending','failed') AND expires_at<=?")
      .run(now, now)
    this.db.query("DELETE FROM events WHERE created_at<?").run(now - 7 * 24 * 60 * 60_000)
    this.cleanupTelemetry(now, telemetryRetentionMs)
    const retention = now - 30 * 24 * 60 * 60_000
    this.db.query("DELETE FROM tuis WHERE connected=0 AND last_seen<?").run(retention)
    this.db.transaction(() => {
      this.db
        .query(
          "DELETE FROM telegram_messages WHERE pending_identity IN (SELECT identity FROM pending WHERE updated_at<? AND state NOT IN ('pending','dispatching','failed'))",
        )
        .run(retention)
      this.db
        .query(
          "DELETE FROM actions WHERE pending_identity IN (SELECT identity FROM pending WHERE updated_at<? AND state NOT IN ('pending','dispatching','failed'))",
        )
        .run(retention)
      this.db
        .query("DELETE FROM pending WHERE updated_at<? AND state NOT IN ('pending','dispatching','failed')")
        .run(retention)
    })()
    return expired
  }

  setMuted(scope: "chat" | "node" | "project" | "session", scopeId: string, muted: boolean) {
    if (muted)
      this.db
        .query("INSERT OR IGNORE INTO mutes(scope,scope_id,created_at) VALUES(?,?,?)")
        .run(scope, scopeId, Date.now())
    else this.db.query("DELETE FROM mutes WHERE scope=? AND scope_id=?").run(scope, scopeId)
  }

  isMuted(scope: "chat" | "node" | "project" | "session", scopeId: string) {
    return Boolean(this.db.query("SELECT 1 AS found FROM mutes WHERE scope=? AND scope_id=?").get(scope, scopeId))
  }
}

export class NodeStore {
  readonly db: Database
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new Database(path, { create: true, strict: true })
    chmodSync(dirname(path), 0o700)
    chmodSync(path, 0o600)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS spool(seq INTEGER PRIMARY KEY AUTOINCREMENT,payload_json TEXT NOT NULL,kind TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS command_inbox(action_id TEXT PRIMARY KEY,instance_id TEXT NOT NULL,payload_json TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS result_outbox(action_id TEXT PRIMARY KEY,payload_json TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      INSERT OR IGNORE INTO state(key,value) VALUES('last_ack','0'),('generation','');`)
    const generation = (this.db.query("SELECT value FROM state WHERE key='generation'").get() as { value: string })
      .value
    if (!generation)
      this.db.query("UPDATE state SET value=? WHERE key='generation'").run(`generation_${crypto.randomUUID()}`)
  }
  enqueue(event: BridgeEvent, limit: number) {
    const critical = [
      "permission.asked",
      "question.asked",
      "request.resolved",
      "execution.failed",
      "tui.disconnected",
    ].includes(event.type)
    return this.db.transaction(() => {
      if (event.type === "reconcile")
        this.db
          .query("DELETE FROM spool WHERE kind='reconcile' AND json_extract(payload_json,'$.instanceId')=?")
          .run(event.instanceId)
      const count = (this.db.query("SELECT COUNT(*) AS count FROM spool").get() as { count: number }).count
      if (count >= limit) {
        const removed = this.db
          .query("DELETE FROM spool WHERE seq=(SELECT seq FROM spool WHERE kind='telemetry' ORDER BY seq LIMIT 1)")
          .run()
        if (removed.changes === 0) {
          if (critical) throw new Error("Node spool is full of correctness-critical events")
          return false
        }
      }
      const kind = critical ? "critical" : event.type === "reconcile" ? "reconcile" : "telemetry"
      this.db
        .query("INSERT INTO spool(payload_json,kind,created_at) VALUES(?,?,?)")
        .run(JSON.stringify(event), kind, Date.now())
      return true
    })()
  }
  pending() {
    return this.db.query("SELECT seq,payload_json FROM spool ORDER BY seq ASC").all() as Array<{
      seq: number
      payload_json: string
    }>
  }
  ack(seq: number) {
    this.db.transaction(() => {
      this.db.query("DELETE FROM spool WHERE seq<=?").run(seq)
      this.db.query("UPDATE state SET value=? WHERE key='last_ack'").run(String(seq))
    })()
  }
  lastAck() {
    return Number((this.db.query("SELECT value FROM state WHERE key='last_ack'").get() as { value: string }).value)
  }
  generation() {
    return (this.db.query("SELECT value FROM state WHERE key='generation'").get() as { value: string }).value
  }
  storeCommand(action: ActionDispatch) {
    return (
      this.db
        .query("INSERT OR IGNORE INTO command_inbox(action_id,instance_id,payload_json,created_at) VALUES(?,?,?,?)")
        .run(action.actionId, action.instanceId, JSON.stringify(action), Date.now()).changes === 1
    )
  }
  command(instanceId: string) {
    const row = this.db
      .query("SELECT payload_json FROM command_inbox WHERE instance_id=? ORDER BY created_at LIMIT 1")
      .get(instanceId) as { payload_json: string } | null
    return row ? (JSON.parse(row.payload_json) as ActionDispatch) : undefined
  }
  completeCommand(actionId: string, result: unknown) {
    this.db.transaction(() => {
      this.db
        .query("INSERT OR REPLACE INTO result_outbox(action_id,payload_json,created_at) VALUES(?,?,?)")
        .run(actionId, JSON.stringify(result), Date.now())
      this.db.query("DELETE FROM command_inbox WHERE action_id=?").run(actionId)
    })()
  }
  results() {
    return this.db.query("SELECT action_id,payload_json FROM result_outbox ORDER BY created_at").all() as Array<{
      action_id: string
      payload_json: string
    }>
  }
  ackResult(actionId: string) {
    this.db.query("DELETE FROM result_outbox WHERE action_id=?").run(actionId)
  }
  close() {
    this.db.close()
  }
}
