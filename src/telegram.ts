import type { Config } from "./config.ts"
import type { MissionControlSnapshot } from "./mission.ts"
import type {
  BridgeEvent,
  PermissionAsked,
  QuestionAsked,
  Role,
  SessionTelemetry,
  TelemetryActivity,
} from "./protocol.ts"
import type { HubStore, PendingRow } from "./store.ts"
import { clip, createLogger, escapeHtml, randomId, sleep } from "./util.ts"
import { PROTOCOL_VERSION, VERSION } from "./version.ts"

type TelegramResponse<T> =
  | { ok: true; result: T }
  | { ok: false; error_code: number; description: string; parameters?: { retry_after?: number } }
type TelegramMessage = {
  message_id: number
  message_thread_id?: number
  chat: { id: number }
  from?: { id: number }
  text?: string
  reply_to_message?: TelegramMessage
}
type TelegramCallback = { id: string; data?: string; from: { id: number }; message?: TelegramMessage }
type TelegramUpdate = { update_id: number; message?: TelegramMessage; callback_query?: TelegramCallback }

class TelegramApiError extends Error {
  constructor(
    readonly code: number,
    readonly method: string,
    readonly description: string,
  ) {
    super(`Telegram API ${code}: ${method}: ${description}`)
  }
}

export type HubView = {
  uptimeMs(): number
  connectedNodeIds(): string[]
  dashboardSnapshot(): DashboardSnapshot
  dispatch(
    row: PendingRow,
    operation: "once" | "always" | "reject" | "answer" | "cancel",
    data?: { message?: string; answers?: string[][] },
  ): Promise<void>
}

export type DashboardSession = SessionTelemetry & {
  key: string
  nodeId: string
  nodeName: string
  instanceId: string
  project: string
  directory?: string
  connected: boolean
}

export type DashboardSnapshot = {
  generatedAt: number
  totals: {
    nodes: number
    connectedNodes: number
    sessions: number
    busy: number
    pending: number
    cost: number
  }
  sessions: DashboardSession[]
  missionControl: MissionControlSnapshot
}

type DashboardView = {
  token: string
  chatId: number
  userId: number
  threadId?: number
  messageId: number
  keys: string[]
  revision: number
  page: number
  selectedKey?: string
  mode: "detail" | "activity" | "todos"
  contentPage: number
  expanded: boolean
  rich: boolean
  expiresAt: number
}

type MissionView = {
  token: string
  chatId: number
  userId: number
  threadId?: number
  messageId: number
  revision: number
  section: "home" | "projects" | "queue" | "inbox"
  page: number
  rich: boolean
  expiresAt: number
}

type InlineKeyboard = Array<Array<{ text: string; callback_data: string }>>
type RichTableCell = {
  text: string
  is_header?: true
  align: "left" | "center" | "right"
  valign: "top" | "middle" | "bottom"
}
type InputRichBlock =
  | { type: "heading"; text: string; size: 1 | 2 | 3 | 4 | 5 | 6 }
  | { type: "paragraph"; text: string }
  | { type: "pre"; text: string; language?: string }
  | { type: "details"; summary: string; blocks: InputRichBlock[]; is_open?: true }
  | { type: "expandable_blockquote"; text: string; credit?: string }
  | {
      type: "table"
      cells: RichTableCell[][]
      is_bordered?: true
      is_striped?: true
      is_compact?: true
      caption?: string
    }
type DashboardPresentation = {
  text: string
  richMessage: { blocks: InputRichBlock[]; skip_entity_detection: true }
  keyboard: InlineKeyboard
}

function richCell(text: unknown, isHeader = false, align: RichTableCell["align"] = "left"): RichTableCell {
  return {
    text: String(text ?? ""),
    ...(isHeader ? { is_header: true as const } : {}),
    align,
    valign: "top",
  }
}

function richRows(rows: Array<[string, unknown]>) {
  return rows.map(([label, value]) => [richCell(label, true), richCell(value)])
}

function roleAllows(role: Role, required: Role) {
  const rank: Record<Role, number> = { viewer: 0, approver: 1, owner: 2 }
  return rank[role] >= rank[required]
}

function eventContext(event: BridgeEvent) {
  if (event.type === "reconcile") return ""
  const parts = []
  if (event.context?.host) parts.push(`🖥 <code>${escapeHtml(clip(event.context.host, 80))}</code>`)
  parts.push(
    `📁 <code>${escapeHtml(clip(event.context?.project ?? event.location.directory.split("/").filter(Boolean).at(-1) ?? event.location.directory, 100))}</code>${event.context?.branch ? ` · <code>${escapeHtml(clip(event.context.branch, 80))}</code>` : ""}`,
  )
  if (event.context?.tmux) parts.push(`🪟 <code>${escapeHtml(clip(event.context.tmux, 80))}</code>`)
  if (event.context?.title) parts.push(`💬 ${escapeHtml(clip(event.context.title, 100))}`)
  if (event.context?.agent || event.context?.model)
    parts.push(`🤖 ${escapeHtml(clip([event.context.agent, event.context.model].filter(Boolean).join(" · "), 120))}`)
  if (event.sessionId) parts.push(`🔑 <code>${escapeHtml(event.sessionId.slice(0, 16))}</code>`)
  if ("requestId" in event)
    parts.push(
      `Ref: <code>${escapeHtml(event.requestId.slice(-12))}</code> · origin <code>${escapeHtml(event.instanceId.slice(-8))}</code>`,
    )
  return parts.join("\n")
}

export function renderPermission(event: PermissionAsked, status?: string) {
  const actionable = permissionActionable(event)
  const patterns = event.patterns
    .slice(0, actionable ? 8 : 4)
    .map((pattern) => `<code>${escapeHtml(clip(pattern, actionable ? 450 : 100))}</code>`)
  const risk = event.always.includes("*") ? "\n\n⚠️ <b>OpenCode proposes a wildcard saved rule.</b>" : ""
  const incomplete = actionable
    ? ""
    : "\n\n⚠️ <b>Details exceed the safe Telegram preview. Resolve this request in the TUI.</b>"
  return `🔐 <b>OpenCode needs approval</b>\n\n${eventContext(event)}\n\n<b>${escapeHtml(clip(event.action, 100))}</b>\n${patterns.join("\n")}${risk}${incomplete}${status ? `\n\n<b>${escapeHtml(clip(status, 300))}</b>` : ""}`
}

function permissionActionable(event: PermissionAsked) {
  return (
    event.patterns.length <= 8 &&
    event.always.length <= 8 &&
    [...event.patterns, ...event.always].every((value) => value.length <= 450) &&
    [...event.patterns, ...event.always, event.action].reduce((size, value) => size + escapeHtml(value).length, 0) <=
      2600
  )
}

export function renderQuestion(event: QuestionAsked, status?: string, index = 0, answers: string[][] = []) {
  if (index >= event.questions.length) {
    const review = event.questions
      .map(
        (question, questionIndex) =>
          `<b>${escapeHtml(clip(question.header, 40))}</b>: ${escapeHtml(clip(answers[questionIndex]?.join(", ") ?? "(not answered)", 120))}`,
      )
      .join("\n")
    return `🚨 <b>Review OpenCode answers</b>\n\n${eventContext(event)}\n\n${review}${status ? `\n\n<b>${escapeHtml(clip(status, 300))}</b>` : ""}`
  }
  const question = event.questions[index]
  const progress = event.questions.length > 1 ? `<b>Question ${index + 1}/${event.questions.length}</b>\n` : ""
  const selected =
    question?.multiple && answers[index]?.length
      ? `\n\nSelected: ${answers[index].map((answer) => `<code>${escapeHtml(clip(answer, 40))}</code>`).join(", ")}`
      : ""
  const custom = question?.custom !== false ? "\n\n<i>Reply to this exact message for free text.</i>" : ""
  const incomplete =
    (question?.options.length ?? 0) > 8
      ? "\n\n⚠️ <b>Some options do not fit safely in Telegram. Choose in the TUI.</b>"
      : ""
  return `🚨 <b>OpenCode needs your input</b>\n\n${eventContext(event)}\n\n${progress}${question?.header ? `<b>${escapeHtml(clip(question.header, 60))}</b>\n` : ""}${escapeHtml(clip(question?.question, 350))}${question?.multiple ? " <i>(select all that apply)</i>" : ""}${selected}${incomplete}${status ? `\n\n<b>${escapeHtml(clip(status, 300))}</b>` : ""}${custom}`
}

type QuestionDraft = { index: number; answers: string[][] }

function questionDraft(row: PendingRow): QuestionDraft {
  if (!row.draft_json) return { index: 0, answers: [] }
  const parsed = JSON.parse(row.draft_json) as Partial<QuestionDraft> & { mode?: string }
  return {
    index: typeof parsed.index === "number" ? parsed.index : 0,
    answers: Array.isArray(parsed.answers) ? parsed.answers : [],
  }
}

export class TelegramGateway {
  private readonly log = createLogger("telegram")
  private readonly controller = new AbortController()
  private readonly dashboardViews = new Map<string, DashboardView>()
  private readonly missionViews = new Map<string, MissionView>()
  private readonly pendingNotifications = new Set<string>()
  private botUsername = ""
  private richMessagesSupported: boolean | undefined

  constructor(
    private readonly config: Config,
    private readonly token: string,
    private readonly store: HubStore,
    private readonly hub: HubView,
  ) {}

  private async api<T>(method: string, payload: Record<string, unknown> = {}): Promise<T> {
    const timeout = method === "getUpdates" ? (this.config.telegram.pollTimeoutSeconds + 10) * 1000 : 15_000
    const response = await fetch(`${this.config.telegram.apiBase}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(timeout)]),
    })
    const body = (await response.json()) as TelegramResponse<T>
    if (!body.ok) {
      if (body.error_code === 429 && body.parameters?.retry_after)
        await sleep(body.parameters.retry_after * 1000, this.controller.signal)
      throw new TelegramApiError(body.error_code, method, body.description)
    }
    return body.result
  }

  async validate() {
    const me = await this.api<{ username?: string }>("getMe")
    this.botUsername = me.username ?? ""
    return me
  }

  start() {
    void this.poll()
  }

  stop() {
    this.controller.abort()
  }

  private visibleEvent<Event extends BridgeEvent>(event: Event): Event {
    if (!event.context) return event
    const { agent, branch, model, tmux, ...base } = event.context
    return {
      ...event,
      context: {
        ...base,
        ...(this.config.notifications.includeBranch && branch ? { branch } : {}),
        ...(this.config.notifications.includeTmux && tmux ? { tmux } : {}),
        ...(this.config.notifications.includeAgent && agent ? { agent } : {}),
        ...(this.config.notifications.includeModel && model ? { model } : {}),
      },
    }
  }

  private keyboard(row: PendingRow) {
    if (row.kind === "permission") {
      const event = JSON.parse(row.event_json) as PermissionAsked
      if (!permissionActionable(event)) return []
      return [
        [
          { text: "✅ Allow once", callback_data: `a:${row.callback_id}:o` },
          ...(event.always.length ? [{ text: "🧠 Always...", callback_data: `a:${row.callback_id}:w` }] : []),
        ],
        [
          { text: "💬 Reject with feedback", callback_data: `a:${row.callback_id}:f` },
          { text: "⛔ Reject", callback_data: `a:${row.callback_id}:r` },
        ],
      ]
    }
    const event = JSON.parse(row.event_json) as QuestionAsked
    const draft = questionDraft(row)
    if (draft.index >= event.questions.length)
      return [
        [{ text: "✅ Submit answers", callback_data: `s:${row.callback_id}:y` }],
        [{ text: "← Back", callback_data: `s:${row.callback_id}:b` }],
        [{ text: "⛔ Cancel", callback_data: `a:${row.callback_id}:x` }],
      ]
    const question = event.questions[draft.index]
    if ((question?.options.length ?? 0) > 8) return [[{ text: "⛔ Cancel", callback_data: `a:${row.callback_id}:x` }]]
    const rows = (question?.options ?? []).slice(0, 8).map((option, index) => {
      const picked = draft.answers[draft.index]?.includes(option.label) ?? false
      return [
        { text: `${picked ? "✓ " : ""}${clip(option.label, 44)}`, callback_data: `q:${row.callback_id}:${index}` },
      ]
    })
    if (question?.multiple) rows.push([{ text: "Continue", callback_data: `d:${row.callback_id}:y` }])
    rows.push([{ text: "⛔ Cancel", callback_data: `a:${row.callback_id}:x` }])
    return rows
  }

  async notifyPending(row: PendingRow) {
    const existing = this.store.telegramMessages(row.identity)
    const destinations = new Set(existing.map((message) => `${message.chat_id}:${message.thread_id ?? ""}`))
    const event = this.visibleEvent(JSON.parse(row.event_json) as PermissionAsked | QuestionAsked)
    const draft = row.kind === "question" ? questionDraft(row) : undefined
    const text =
      row.kind === "permission"
        ? renderPermission(event as PermissionAsked)
        : renderQuestion(event as QuestionAsked, undefined, draft?.index, draft?.answers)
    for (const auth of this.config.telegram.authorizedChats) {
      if (this.store.isMuted("chat", String(auth.id))) continue
      const destination = `${auth.id}:${auth.threadId ?? ""}`
      const notification = `${row.identity}:${destination}`
      if (destinations.has(destination) || this.pendingNotifications.has(notification)) continue
      this.pendingNotifications.add(notification)
      try {
        const result = await this.api<TelegramMessage>("sendMessage", {
          chat_id: auth.id,
          ...(auth.threadId ? { message_thread_id: auth.threadId } : {}),
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
          disable_notification: false,
          reply_markup: { inline_keyboard: this.keyboard(row) },
        })
        this.store.setTelegramMessage(row.identity, auth.id, result.message_id, auth.threadId)
        destinations.add(destination)
      } finally {
        this.pendingNotifications.delete(notification)
      }
    }
  }

  async notifyNodeJoined(nodeId: string, nodeName: string) {
    const text = `🖥 <b>Node joined</b>\n\nName: <code>${escapeHtml(clip(nodeName, 100))}</code>\nID: <code>${escapeHtml(nodeId.slice(0, 16))}</code>`
    let sent = 0
    for (const auth of this.config.telegram.authorizedChats) {
      if (this.store.isMuted("chat", String(auth.id))) continue
      try {
        await this.api("sendMessage", {
          chat_id: auth.id,
          ...(auth.threadId ? { message_thread_id: auth.threadId } : {}),
          text,
          parse_mode: "HTML",
          disable_notification: false,
        })
        sent++
      } catch (error) {
        this.log.warn("node join notification failed", { chat: auth.id, error })
      }
    }
    return sent
  }

  async notifyExecution(event: BridgeEvent) {
    event = this.visibleEvent(event)
    if (
      event.type !== "execution.started" &&
      event.type !== "execution.succeeded" &&
      event.type !== "execution.failed" &&
      event.type !== "execution.stuck"
    )
      return
    if (
      event.type === "execution.succeeded" &&
      (!this.config.notifications.done.enabled ||
        (event.durationMs ?? 0) < this.config.notifications.done.minimumDurationSeconds * 1000)
    )
      return
    if (event.type === "execution.failed" && !this.config.notifications.error) return
    if (event.type === "execution.started") return
    const heading =
      event.type === "execution.succeeded"
        ? "✅ <b>OpenCode finished</b>"
        : event.type === "execution.stuck"
          ? "⌛ <b>OpenCode needs attention</b>"
          : "❌ <b>OpenCode failed</b>"
    let text = `${heading}\n\n${eventContext(event)}`
    if (event.durationMs !== undefined) text += `\n⏱ ${Math.round(event.durationMs / 1000)}s`
    if (event.error) text += `\n\n<code>${escapeHtml(clip(event.error, 900))}</code>`
    if (this.config.notifications.includeFinalPreview && event.finalPreview)
      text += `\n\n${escapeHtml(clip(event.finalPreview, this.config.notifications.previewMaxChars))}`
    for (const auth of this.config.telegram.authorizedChats) {
      if (this.store.isMuted("chat", String(auth.id))) continue
      await this.api("sendMessage", {
        chat_id: auth.id,
        ...(auth.threadId ? { message_thread_id: auth.threadId } : {}),
        text,
        parse_mode: "HTML",
        disable_notification: event.type === "execution.succeeded",
      })
    }
  }

  async updatePending(row: PendingRow, label: string, actionable = false) {
    const messages = this.store.telegramMessages(row.identity)
    if (!messages.length) return
    const event = this.visibleEvent(JSON.parse(row.event_json) as PermissionAsked | QuestionAsked)
    const draft = row.kind === "question" ? questionDraft(row) : undefined
    const text =
      row.kind === "permission"
        ? renderPermission(event as PermissionAsked, label)
        : renderQuestion(event as QuestionAsked, label, draft?.index, draft?.answers)
    for (const message of messages) {
      try {
        await this.api("editMessageText", {
          chat_id: message.chat_id,
          message_id: message.message_id,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
          reply_markup: { inline_keyboard: actionable ? this.keyboard(row) : [] },
        })
      } catch (error) {
        this.log.warn("message update failed", { error })
      }
    }
  }

  private authorized(chatId: number, userId: number | undefined, threadId: number | undefined, required: Role) {
    const chat = this.config.telegram.authorizedChats.find((item) => item.id === chatId)
    const user = this.config.telegram.authorizedUsers.find((item) => item.id === userId)
    if (
      !chat ||
      !user ||
      (chat.threadId !== undefined && chat.threadId !== threadId) ||
      !roleAllows(chat.role, required) ||
      !roleAllows(user.role, required)
    )
      return undefined
    return { ...chat, role: roleAllows(chat.role, user.role) ? user.role : chat.role }
  }

  private async answerCallback(id: string, text: string, alert = false) {
    await this.api("answerCallbackQuery", { callback_query_id: id, text: clip(text, 180), show_alert: alert })
  }

  private pruneDashboardViews() {
    const now = Date.now()
    for (const [token, view] of this.dashboardViews) if (view.expiresAt <= now) this.dashboardViews.delete(token)
    while (this.dashboardViews.size >= 256) {
      const oldest = this.dashboardViews.keys().next().value
      if (!oldest) break
      this.dashboardViews.delete(oldest)
    }
    for (const [token, view] of this.missionViews) if (view.expiresAt <= now) this.missionViews.delete(token)
    while (this.missionViews.size >= 256) {
      const oldest = this.missionViews.keys().next().value
      if (!oldest) break
      this.missionViews.delete(oldest)
    }
  }

  private dashboardData(view: DashboardView, operation: string, value?: number) {
    return `v:${view.token}:${view.revision}:${operation}${value === undefined ? "" : `:${value}`}`
  }

  private dashboardAge(timestamp: number) {
    const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000))
    if (seconds < 60) return `${seconds}s ago`
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
    return `${Math.floor(seconds / 3600)}h ago`
  }

  private dashboardTimestamp(timestamp: number | undefined) {
    return timestamp ? new Date(timestamp).toISOString().replace("T", " ").replace(".000Z", " UTC") : "unknown"
  }

  private dashboardDuration(activity: TelemetryActivity) {
    if (activity.startedAt === undefined || activity.endedAt === undefined) return "unknown"
    const milliseconds = Math.max(0, activity.endedAt - activity.startedAt)
    return milliseconds < 1000 ? `${milliseconds}ms` : `${(milliseconds / 1000).toFixed(1)}s`
  }

  private dashboardActivitySymbol(activity: TelemetryActivity) {
    if (activity.status === "error" || activity.type === "retry") return "!"
    if (activity.status === "pending" || activity.status === "running") return "~"
    if (activity.type === "thought") return "?"
    return "+"
  }

  private dashboardRichUnsupported(error: unknown) {
    return (
      error instanceof TelegramApiError &&
      (error.code === 404 ||
        (error.code === 400 &&
          /(?:method not found|unknown method|rich[ _-]?message.{0,40}(?:unsupported|unknown)|(?:unsupported|unknown).{0,40}rich[ _-]?message)/i.test(
            error.description,
          )))
    )
  }

  private dashboardPresentation(view: DashboardView, snapshot: DashboardSnapshot): DashboardPresentation {
    const sessions = new Map(snapshot.sessions.map((session) => [session.key, session]))
    const availableKeys = view.keys.filter((key) => sessions.has(key))
    const nextKeys = [
      ...availableKeys,
      ...snapshot.sessions.map((session) => session.key).filter((key) => !availableKeys.includes(key)),
    ]
    if (nextKeys.length !== view.keys.length || nextKeys.some((key, index) => key !== view.keys[index])) {
      view.keys = nextKeys
      view.revision++
    }
    const selected = view.selectedKey ? sessions.get(view.selectedKey) : undefined
    if (!view.selectedKey) {
      const pageSize = 5
      const pages = Math.max(1, Math.ceil(view.keys.length / pageSize))
      view.page = Math.min(Math.max(0, view.page), pages - 1)
      const start = view.page * pageSize
      const keyboard: InlineKeyboard = view.keys.slice(start, start + pageSize).flatMap((key, offset) => {
        const session = sessions.get(key)
        if (!session) return []
        const state = !session.connected ? "○" : session.status === "busy" ? "◐" : "●"
        const label = session.title || `${clip(session.project, 24)} · ${session.sessionId.slice(-8)}`
        return [
          [
            {
              text: `${state} ${clip(label, 38)}`,
              callback_data: this.dashboardData(view, "o", start + offset),
            },
          ],
        ]
      })
      if (pages > 1)
        keyboard.push([
          { text: "←", callback_data: this.dashboardData(view, "p", Math.max(0, view.page - 1)) },
          { text: `${view.page + 1}/${pages}`, callback_data: this.dashboardData(view, "p", view.page) },
          { text: "→", callback_data: this.dashboardData(view, "p", Math.min(pages - 1, view.page + 1)) },
        ])
      keyboard.push([{ text: "↻ Refresh", callback_data: this.dashboardData(view, "r") }])
      const totals = snapshot.totals
      const text = view.keys.length
        ? `<b>OpenCode dashboard</b> · read-only\n\nNodes: <b>${totals.connectedNodes}/${totals.nodes}</b> · Sessions: <b>${totals.sessions}</b> · Running: <b>${totals.busy}</b>\nPending: <b>${totals.pending}</b> · Cost: <b>$${totals.cost.toFixed(3)}</b>\n\nSelect a session. Updated ${this.dashboardAge(snapshot.generatedAt)}.`
        : `<b>OpenCode dashboard</b> · read-only\n\nNo retained session telemetry is currently available.\n\nUpdated ${this.dashboardAge(snapshot.generatedAt)}.`
      const blocks: InputRichBlock[] = [
        { type: "heading", text: "OpenCode dashboard", size: 2 },
        { type: "paragraph", text: "Read-only telemetry" },
        {
          type: "table",
          caption: "Hub snapshot",
          is_bordered: true,
          is_compact: true,
          cells: richRows([
            ["Nodes", `${totals.connectedNodes}/${totals.nodes}`],
            ["Sessions", totals.sessions],
            ["Running", totals.busy],
            ["Pending", totals.pending],
            ["Cost", `$${totals.cost.toFixed(3)}`],
          ]),
        },
        {
          type: "paragraph",
          text: view.keys.length
            ? `Select a session below. Updated ${this.dashboardAge(snapshot.generatedAt)}.`
            : `No retained session telemetry is currently available. Updated ${this.dashboardAge(snapshot.generatedAt)}.`,
        },
      ]
      return { text, richMessage: { blocks, skip_entity_detection: true }, keyboard }
    }
    if (!selected)
      return {
        text: "<b>Session unavailable</b>\n\nIt expired or is no longer retained.",
        richMessage: {
          blocks: [
            { type: "heading", text: "Session unavailable", size: 2 },
            { type: "paragraph", text: "It expired or is no longer retained." },
          ],
          skip_entity_detection: true,
        },
        keyboard: [
          [{ text: "← Sessions", callback_data: this.dashboardData(view, "l") }],
          [{ text: "↻ Refresh", callback_data: this.dashboardData(view, "r") }],
        ] satisfies InlineKeyboard,
      }
    const titleText = clip(selected.title || selected.sessionId, 120)
    const title = escapeHtml(clip(titleText, 80))
    const effectiveStatus = selected.connected ? selected.status : "offline"
    const state = !selected.connected ? "○" : selected.status === "busy" ? "◐" : "●"
    const model = [selected.provider, selected.model].filter(Boolean).join("/") || "unknown"
    let text = ""
    let blocks: InputRichBlock[] = []
    let pages = 1
    if (view.mode === "activity") {
      const pageSize = view.rich ? 8 : 1
      const activities = [...selected.activities].reverse()
      pages = Math.max(1, Math.ceil(activities.length / pageSize))
      view.contentPage = Math.min(Math.max(0, view.contentPage), pages - 1)
      const pageActivities = activities.slice(view.contentPage * pageSize, (view.contentPage + 1) * pageSize)
      const heading = `<b>Activity</b> · ${title}`
      const fallbackBlocks: string[] = []
      blocks = [
        { type: "heading", text: `Activity · ${titleText}`, size: 2 },
        {
          type: "paragraph",
          text: `${selected.activities.length} retained · newest first · page ${view.contentPage + 1}/${pages}`,
        },
      ]
      for (const activity of pageActivities) {
        const symbol = this.dashboardActivitySymbol(activity)
        const summary = `${symbol} ${clip(activity.title, 180)}${activity.status ? ` · ${clip(activity.status, 48)}` : ""}`
        const metadata = [
          `Type: ${activity.type}`,
          `Status: ${activity.status ?? "unknown"}`,
          `Started: ${this.dashboardTimestamp(activity.startedAt)}`,
          `Duration: ${this.dashboardDuration(activity)}`,
        ].join("\n")
        blocks.push({
          type: "details",
          summary,
          blocks: [
            { type: "paragraph", text: metadata },
            activity.detail
              ? { type: "pre", text: activity.detail }
              : { type: "paragraph", text: "No detail was captured for this activity." },
          ],
          ...(view.expanded ? { is_open: true as const } : {}),
        })
        const detail = activity.detail ? escapeHtml(clip(activity.detail, view.expanded ? 600 : 220)) : ""
        const fallback = `<b>${escapeHtml(clip(activity.title, 80))}</b>${activity.status ? ` · ${escapeHtml(clip(activity.status, 32))}` : ""}${detail ? `\n<code>${detail}</code>` : ""}`
        if (`${heading}\n\n${[...fallbackBlocks, fallback].join("\n\n")}`.length <= 3900) fallbackBlocks.push(fallback)
      }
      if (!pageActivities.length) blocks.push({ type: "paragraph", text: "No captured activity." })
      text = `${heading}\n\n${fallbackBlocks.join("\n\n") || "No captured activity."}`
    } else if (view.mode === "todos") {
      const pageSize = view.rich ? 12 : 1
      pages = Math.max(1, Math.ceil(selected.todos.length / pageSize))
      view.contentPage = Math.min(Math.max(0, view.contentPage), pages - 1)
      const todos = selected.todos.slice(view.contentPage * pageSize, (view.contentPage + 1) * pageSize)
      const heading = `<b>Todos</b> · ${title}`
      const lines: string[] = []
      blocks = [
        { type: "heading", text: `Todos · ${titleText}`, size: 2 },
        {
          type: "paragraph",
          text: `${selected.todos.length} retained · page ${view.contentPage + 1}/${pages}`,
        },
      ]
      for (const todo of todos) {
        const symbol = todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "◐" : "○"
        const line = `${symbol} ${escapeHtml(clip(todo.content, 600))}`
        if (`${heading}\n\n${[...lines, line].join("\n")}`.length > 3600) break
        lines.push(line)
        blocks.push({
          type: "paragraph",
          text: `${symbol} ${todo.content}\nStatus: ${todo.status} · Priority: ${todo.priority}`,
        })
      }
      if (!todos.length) blocks.push({ type: "paragraph", text: "No captured todos." })
      text = `${heading}\n\n${lines.join("\n") || "No captured todos."}`
    } else {
      const tokens = selected.tokens
      const totalTokens = Math.round(tokens.input + tokens.output).toLocaleString("en-US")
      text = `<b>${title}</b>\n\n${state} <b>${escapeHtml(effectiveStatus)}</b> · ${escapeHtml(clip(selected.nodeName, 60))}\nProject: <code>${escapeHtml(clip(selected.project, 60))}</code>${selected.directory ? `\nPath: <code>${escapeHtml(clip(selected.directory, 100))}</code>` : ""}\nAgent: <code>${escapeHtml(clip(selected.agent || "unknown", 40))}</code>\nModel: <code>${escapeHtml(clip(model, 60))}</code>\n\nTokens: <b>${totalTokens}</b> · In ${Math.round(tokens.input).toLocaleString("en-US")} · Out ${Math.round(tokens.output).toLocaleString("en-US")}\nCache read: ${Math.round(tokens.cacheRead).toLocaleString("en-US")} · Cache write: ${Math.round(tokens.cacheWrite).toLocaleString("en-US")}\nReasoning: ${Math.round(tokens.reasoning).toLocaleString("en-US")} · Cost: <b>$${selected.cost.toFixed(4)}</b>\nCapture: <code>${selected.capture}</code> · Updated ${this.dashboardAge(selected.updatedAt)}.`
      const identifiers = [
        `Session: ${selected.sessionId}`,
        ...(selected.parentId ? [`Parent: ${selected.parentId}`] : []),
        `Instance: ${selected.instanceId}`,
        `Node: ${selected.nodeId}`,
        ...(selected.directory ? [`Path: ${selected.directory}`] : []),
      ].join("\n")
      blocks = [
        { type: "heading", text: titleText, size: 2 },
        { type: "paragraph", text: `${state} ${effectiveStatus} · ${selected.nodeName}` },
        {
          type: "table",
          caption: "Session",
          is_bordered: true,
          is_compact: true,
          cells: richRows([
            ["Project", selected.project],
            ["Agent", selected.agent || "unknown"],
            ["Model", model],
            ["Capture", selected.capture],
            ["Updated", `${this.dashboardAge(selected.updatedAt)} · ${this.dashboardTimestamp(selected.updatedAt)}`],
          ]),
        },
        {
          type: "table",
          caption: "Usage",
          is_bordered: true,
          is_striped: true,
          is_compact: true,
          cells: richRows([
            ["Tokens", totalTokens],
            ["Input", Math.round(tokens.input).toLocaleString("en-US")],
            ["Output", Math.round(tokens.output).toLocaleString("en-US")],
            ["Reasoning", Math.round(tokens.reasoning).toLocaleString("en-US")],
            ["Cache read", Math.round(tokens.cacheRead).toLocaleString("en-US")],
            ["Cache write", Math.round(tokens.cacheWrite).toLocaleString("en-US")],
            ["Cost", `$${selected.cost.toFixed(4)}`],
          ]),
        },
        {
          type: "details",
          summary: "Identifiers and path",
          blocks: [{ type: "pre", text: identifiers }],
        },
      ]
      const latest = selected.activities.at(-1)
      if (latest)
        blocks.push({
          type: "details",
          summary: `Latest · ${clip(latest.title, 180)}`,
          blocks: [
            {
              type: "paragraph",
              text: `Type: ${latest.type} · Status: ${latest.status ?? "unknown"} · Duration: ${this.dashboardDuration(latest)}`,
            },
            latest.detail
              ? { type: "pre", text: latest.detail }
              : { type: "paragraph", text: "No detail was captured for this activity." },
          ],
        })
    }
    const keyboard: InlineKeyboard = [
      [
        { text: `Activity ${selected.activities.length}`, callback_data: this.dashboardData(view, "a") },
        { text: `Todos ${selected.todos.length}`, callback_data: this.dashboardData(view, "t") },
      ],
    ]
    if (view.mode !== "detail" && pages > 1)
      keyboard.push([
        { text: "←", callback_data: this.dashboardData(view, "x", Math.max(0, view.contentPage - 1)) },
        { text: `${view.contentPage + 1}/${pages}`, callback_data: this.dashboardData(view, "x", view.contentPage) },
        { text: "→", callback_data: this.dashboardData(view, "x", Math.min(pages - 1, view.contentPage + 1)) },
      ])
    if (view.mode === "activity")
      keyboard.push([
        { text: view.expanded ? "Collapse" : "Show full", callback_data: this.dashboardData(view, "e") },
        { text: "Overview", callback_data: this.dashboardData(view, "d") },
        { text: "↻ Refresh", callback_data: this.dashboardData(view, "r") },
      ])
    else
      keyboard.push([
        { text: "Overview", callback_data: this.dashboardData(view, "d") },
        { text: "↻ Refresh", callback_data: this.dashboardData(view, "r") },
      ])
    keyboard.push([{ text: "← Sessions", callback_data: this.dashboardData(view, "l") }])
    return { text, richMessage: { blocks, skip_entity_detection: true }, keyboard }
  }

  private async sendDashboard(message: TelegramMessage) {
    if (!message.from) return
    this.pruneDashboardViews()
    const snapshot = this.hub.dashboardSnapshot()
    const view: DashboardView = {
      token: randomId("dv", 8),
      chatId: message.chat.id,
      userId: message.from.id,
      ...(message.message_thread_id ? { threadId: message.message_thread_id } : {}),
      messageId: 0,
      keys: snapshot.sessions.map((session) => session.key),
      revision: 0,
      page: 0,
      mode: "detail",
      contentPage: 0,
      expanded: false,
      rich: this.richMessagesSupported !== false,
      expiresAt: Date.now() + 30 * 60_000,
    }
    let presentation = this.dashboardPresentation(view, snapshot)
    let sent: TelegramMessage | undefined
    if (view.rich) {
      try {
        sent = await this.api<TelegramMessage>("sendRichMessage", {
          chat_id: message.chat.id,
          ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
          rich_message: presentation.richMessage,
          reply_markup: { inline_keyboard: presentation.keyboard },
        })
        this.richMessagesSupported = true
      } catch (error) {
        if (!this.dashboardRichUnsupported(error)) throw error
        this.richMessagesSupported = false
        view.rich = false
        presentation = this.dashboardPresentation(view, snapshot)
        this.log.warn("rich Telegram dashboards unavailable; using HTML fallback", { error })
      }
    }
    sent ??= await this.api<TelegramMessage>("sendMessage", {
      chat_id: message.chat.id,
      ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
      text: presentation.text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: presentation.keyboard },
    })
    view.messageId = sent.message_id
    this.dashboardViews.set(view.token, view)
  }

  private async dashboardCallback(callback: TelegramCallback) {
    const message = callback.message
    const chatId = message?.chat.id
    const parts = callback.data?.split(":") ?? []
    const view = parts[1] ? this.dashboardViews.get(parts[1]) : undefined
    const expired = Boolean(view && view.expiresAt <= Date.now())
    if (
      !message ||
      !chatId ||
      !this.authorized(chatId, callback.from.id, message.message_thread_id, "viewer") ||
      !view ||
      expired ||
      view.chatId !== chatId ||
      view.userId !== callback.from.id ||
      view.threadId !== message.message_thread_id ||
      view.messageId !== message.message_id
    ) {
      if (view && expired) this.dashboardViews.delete(view.token)
      await this.answerCallback(callback.id, "Dashboard expired or is not yours. Run /dashboard again.", true)
      return
    }
    if (Number(parts[2]) !== view.revision) {
      await this.answerCallback(callback.id, "Dashboard changed. Use the latest buttons.", true)
      return
    }
    const previous = {
      keys: [...view.keys],
      revision: view.revision,
      page: view.page,
      mode: view.mode,
      contentPage: view.contentPage,
      expanded: view.expanded,
      selectedKey: view.selectedKey,
    }
    const operation = parts[3]
    let snapshot: DashboardSnapshot | undefined
    if (operation === "l") {
      delete view.selectedKey
      view.mode = "detail"
      view.contentPage = 0
      view.expanded = false
    } else if (operation === "p") view.page = Math.max(0, Number(parts[4]) || 0)
    else if (operation === "o") {
      const key = view.keys[Number(parts[4])]
      if (key) view.selectedKey = key
      else delete view.selectedKey
      view.mode = "detail"
      view.contentPage = 0
      view.expanded = false
    } else if (operation === "a") {
      view.mode = "activity"
      view.contentPage = 0
      view.expanded = false
    } else if (operation === "t") {
      view.mode = "todos"
      view.contentPage = 0
      view.expanded = false
    } else if (operation === "d") {
      view.mode = "detail"
      view.contentPage = 0
      view.expanded = false
    } else if (operation === "x" && view.mode !== "detail") view.contentPage = Math.max(0, Number(parts[4]) || 0)
    else if (operation === "e" && view.mode === "activity") view.expanded = !view.expanded
    else if (operation === "r") {
      snapshot = this.hub.dashboardSnapshot()
      view.keys = snapshot.sessions.map((session) => session.key)
      view.revision++
      if (view.selectedKey && !view.keys.includes(view.selectedKey)) delete view.selectedKey
      view.page = Math.min(view.page, Math.max(0, Math.ceil(view.keys.length / 5) - 1))
    } else {
      await this.answerCallback(callback.id, "Invalid dashboard action.", true)
      return
    }
    snapshot ??= this.hub.dashboardSnapshot()
    let presentation = this.dashboardPresentation(view, snapshot)
    try {
      if (view.rich) {
        try {
          await this.api("editMessageText", {
            chat_id: chatId,
            message_id: message.message_id,
            rich_message: presentation.richMessage,
            reply_markup: { inline_keyboard: presentation.keyboard },
          })
        } catch (error) {
          if (!this.dashboardRichUnsupported(error)) throw error
          this.richMessagesSupported = false
          view.rich = false
          presentation = this.dashboardPresentation(view, snapshot)
          this.log.warn("rich Telegram dashboard edit unavailable; using HTML fallback", { error })
          await this.api("editMessageText", {
            chat_id: chatId,
            message_id: message.message_id,
            text: presentation.text,
            parse_mode: "HTML",
            disable_web_page_preview: true,
            reply_markup: { inline_keyboard: presentation.keyboard },
          })
        }
      } else
        await this.api("editMessageText", {
          chat_id: chatId,
          message_id: message.message_id,
          text: presentation.text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
          reply_markup: { inline_keyboard: presentation.keyboard },
        })
    } catch (error) {
      if (!String(error).toLowerCase().includes("message is not modified")) {
        view.keys = previous.keys
        view.revision = previous.revision
        view.page = previous.page
        view.mode = previous.mode
        view.contentPage = previous.contentPage
        view.expanded = previous.expanded
        if (previous.selectedKey) view.selectedKey = previous.selectedKey
        else delete view.selectedKey
        throw error
      }
    }
    await this.answerCallback(
      callback.id,
      operation === "r"
        ? "Dashboard refreshed"
        : operation === "e" && view.expanded
          ? "Showing full activity"
          : "Updated",
    )
  }

  private missionData(view: MissionView, operation: string, value?: number) {
    return `m:${view.token}:${view.revision}:${operation}${value === undefined ? "" : `:${value}`}`
  }

  private missionPresentation(view: MissionView, snapshot: DashboardSnapshot): DashboardPresentation {
    const mission = snapshot.missionControl
    const keyboard: InlineKeyboard = []
    let text = ""
    let blocks: InputRichBlock[] = []
    if (view.section === "home") {
      const totals = mission.totals
      text = `<b>Mission Control</b> · read-only\n\nInbox: <b>${totals.inbox}</b> · Active work: <b>${totals.activeWork}</b>\nBlocked: <b>${totals.blocked}</b> · Review: <b>${totals.review}</b>\nProjects: <b>${totals.projects}</b> · Sessions: <b>${snapshot.totals.sessions}</b>\n\nUse the queue CLI to change work state.`
      blocks = [
        { type: "heading", text: "Mission Control", size: 2 },
        { type: "paragraph", text: "Operator overview · read-only Telegram surface" },
        {
          type: "table",
          caption: "Control plane",
          is_bordered: true,
          is_compact: true,
          cells: richRows([
            ["Inbox", totals.inbox],
            ["Active work", totals.activeWork],
            ["Blocked", totals.blocked],
            ["Review", totals.review],
            ["Projects", totals.projects],
            ["Sessions", snapshot.totals.sessions],
          ]),
        },
        { type: "paragraph", text: "Use the Mission Control CLI on the hub to add and advance work." },
      ]
      keyboard.push(
        [
          { text: `Inbox ${totals.inbox}`, callback_data: this.missionData(view, "i") },
          { text: `Queue ${totals.activeWork}`, callback_data: this.missionData(view, "q") },
        ],
        [
          { text: `Projects ${totals.projects}`, callback_data: this.missionData(view, "p") },
          { text: "↻ Refresh", callback_data: this.missionData(view, "r") },
        ],
      )
      return { text, richMessage: { blocks, skip_entity_detection: true }, keyboard }
    }
    const pageSize = view.rich ? 8 : 1
    const source =
      view.section === "projects"
        ? mission.projects
        : view.section === "queue"
          ? mission.workItems.filter((work) => work.state !== "completed" && work.state !== "cancelled")
          : mission.inbox
    const pages = Math.max(1, Math.ceil(source.length / pageSize))
    view.page = Math.min(Math.max(0, view.page), pages - 1)
    const page = source.slice(view.page * pageSize, (view.page + 1) * pageSize)
    const heading =
      view.section === "projects" ? "Projects" : view.section === "queue" ? "Work queue" : "Operator inbox"
    blocks = [
      { type: "heading", text: heading, size: 2 },
      {
        type: "paragraph",
        text: `${source.length} item${source.length === 1 ? "" : "s"} · page ${view.page + 1}/${pages}`,
      },
    ]
    const fallback: string[] = []
    for (const item of page) {
      if (view.section === "projects") {
        const project = item as (typeof mission.projects)[number]
        blocks.push({
          type: "details",
          summary: `${project.priority.toUpperCase()} · ${project.name}`,
          blocks: [
            {
              type: "paragraph",
              text: `${clip(project.description || "No description", 1200)}\nActive work: ${project.activeWork} · Blocked: ${project.blockedWork} · Review: ${project.reviewWork} · Sessions: ${project.activeSessions}`,
            },
            ...(project.repository ? [{ type: "pre" as const, text: clip(project.repository, 512) }] : []),
          ],
        })
        fallback.push(
          `<b>${escapeHtml(project.name)}</b> · ${project.activeWork} active · ${project.blockedWork} blocked`,
        )
      } else if (view.section === "queue") {
        const work = item as (typeof mission.workItems)[number]
        blocks.push({
          type: "details",
          summary: `${work.priority.toUpperCase()} · ${work.state} · ${clip(work.title, 180)}`,
          blocks: [
            {
              type: "paragraph",
              text: `${work.projectName}\n${clip(work.description || "No description", 1200)}`,
            },
            ...(work.acceptance ? [{ type: "pre" as const, text: `Acceptance:\n${clip(work.acceptance, 1600)}` }] : []),
            ...(work.sessionKey ? [{ type: "pre" as const, text: `Session: ${work.sessionKey}` }] : []),
          ],
        })
        fallback.push(`<b>${escapeHtml(clip(work.title, 120))}</b> · ${work.state}\n${escapeHtml(work.projectName)}`)
      } else {
        const inbox = item as (typeof mission.inbox)[number]
        blocks.push({
          type: "details",
          summary: `${inbox.state.toUpperCase()} · ${clip(inbox.title, 180)}`,
          blocks: [
            {
              type: "paragraph",
              text: `${inbox.project}${inbox.nodeName ? ` · ${inbox.nodeName}` : ""}\n${clip(inbox.summary, 1200)}`,
            },
            { type: "paragraph", text: "Resolve approval requests in their exact Telegram message or in OpenCode." },
          ],
        })
        fallback.push(`<b>${escapeHtml(clip(inbox.title, 120))}</b> · ${inbox.state}\n${escapeHtml(inbox.project)}`)
      }
    }
    if (!page.length) blocks.push({ type: "paragraph", text: `No ${heading.toLowerCase()} items.` })
    text = `<b>${heading}</b> · ${view.page + 1}/${pages}\n\n${fallback.join("\n\n") || `No ${heading.toLowerCase()} items.`}`
    if (pages > 1)
      keyboard.push([
        { text: "←", callback_data: this.missionData(view, "g", Math.max(0, view.page - 1)) },
        { text: `${view.page + 1}/${pages}`, callback_data: this.missionData(view, "g", view.page) },
        { text: "→", callback_data: this.missionData(view, "g", Math.min(pages - 1, view.page + 1)) },
      ])
    keyboard.push([
      { text: "← Mission", callback_data: this.missionData(view, "h") },
      { text: "↻ Refresh", callback_data: this.missionData(view, "r") },
    ])
    return { text, richMessage: { blocks, skip_entity_detection: true }, keyboard }
  }

  private async sendMission(message: TelegramMessage, section: MissionView["section"] = "home") {
    if (!message.from) return
    this.pruneDashboardViews()
    const view: MissionView = {
      token: randomId("mv", 8),
      chatId: message.chat.id,
      userId: message.from.id,
      ...(message.message_thread_id ? { threadId: message.message_thread_id } : {}),
      messageId: 0,
      revision: 0,
      section,
      page: 0,
      rich: this.richMessagesSupported !== false,
      expiresAt: Date.now() + 30 * 60_000,
    }
    let presentation = this.missionPresentation(view, this.hub.dashboardSnapshot())
    let sent: TelegramMessage | undefined
    if (view.rich) {
      try {
        sent = await this.api<TelegramMessage>("sendRichMessage", {
          chat_id: message.chat.id,
          ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
          rich_message: presentation.richMessage,
          reply_markup: { inline_keyboard: presentation.keyboard },
        })
        this.richMessagesSupported = true
      } catch (error) {
        if (!this.dashboardRichUnsupported(error)) throw error
        this.richMessagesSupported = false
        view.rich = false
        presentation = this.missionPresentation(view, this.hub.dashboardSnapshot())
      }
    }
    sent ??= await this.api<TelegramMessage>("sendMessage", {
      chat_id: message.chat.id,
      ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
      text: presentation.text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: presentation.keyboard },
    })
    view.messageId = sent.message_id
    this.missionViews.set(view.token, view)
  }

  private async missionCallback(callback: TelegramCallback) {
    const message = callback.message
    const parts = callback.data?.split(":") ?? []
    const view = parts[1] ? this.missionViews.get(parts[1]) : undefined
    if (
      !message ||
      !view ||
      view.expiresAt <= Date.now() ||
      !this.authorized(message.chat.id, callback.from.id, message.message_thread_id, "viewer") ||
      view.chatId !== message.chat.id ||
      view.userId !== callback.from.id ||
      view.threadId !== message.message_thread_id ||
      view.messageId !== message.message_id
    ) {
      await this.answerCallback(callback.id, "Mission Control expired or is not yours. Run /mission again.", true)
      return
    }
    if (Number(parts[2]) !== view.revision) {
      await this.answerCallback(callback.id, "Mission Control changed. Use the latest buttons.", true)
      return
    }
    const previous = { section: view.section, page: view.page, revision: view.revision }
    const operation = parts[3]
    if (operation === "h") view.section = "home"
    else if (operation === "p") view.section = "projects"
    else if (operation === "q") view.section = "queue"
    else if (operation === "i") view.section = "inbox"
    else if (operation === "g") view.page = Math.max(0, Number(parts[4]) || 0)
    else if (operation === "r") view.revision++
    else {
      await this.answerCallback(callback.id, "Invalid Mission Control action.", true)
      return
    }
    if (["h", "p", "q", "i"].includes(operation ?? "")) view.page = 0
    let presentation = this.missionPresentation(view, this.hub.dashboardSnapshot())
    try {
      if (view.rich)
        await this.api("editMessageText", {
          chat_id: message.chat.id,
          message_id: message.message_id,
          rich_message: presentation.richMessage,
          reply_markup: { inline_keyboard: presentation.keyboard },
        })
      else
        await this.api("editMessageText", {
          chat_id: message.chat.id,
          message_id: message.message_id,
          text: presentation.text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
          reply_markup: { inline_keyboard: presentation.keyboard },
        })
    } catch (error) {
      if (view.rich && this.dashboardRichUnsupported(error)) {
        this.richMessagesSupported = false
        view.rich = false
        presentation = this.missionPresentation(view, this.hub.dashboardSnapshot())
        try {
          await this.api("editMessageText", {
            chat_id: message.chat.id,
            message_id: message.message_id,
            text: presentation.text,
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: presentation.keyboard },
          })
        } catch (fallbackError) {
          view.section = previous.section
          view.page = previous.page
          view.revision = previous.revision
          throw fallbackError
        }
      } else if (!String(error).toLowerCase().includes("message is not modified")) {
        view.section = previous.section
        view.page = previous.page
        view.revision = previous.revision
        throw error
      }
    }
    await this.answerCallback(callback.id, operation === "r" ? "Mission Control refreshed" : "Updated")
  }

  private async callback(callback: TelegramCallback) {
    if (callback.data?.startsWith("m:")) {
      await this.missionCallback(callback)
      return
    }
    if (callback.data?.startsWith("v:")) {
      await this.dashboardCallback(callback)
      return
    }
    const chatId = callback.message?.chat.id
    if (!chatId || !this.authorized(chatId, callback.from.id, callback.message?.message_thread_id, "approver")) {
      await this.answerCallback(callback.id, "Not authorized.", true)
      return
    }
    const parts = callback.data?.split(":") ?? []
    const row = parts[1] ? this.store.getPendingByCallback(parts[1]) : null
    const messageRow = callback.message ? this.store.getPendingByMessage(chatId, callback.message.message_id) : null
    if (!row || row.identity !== messageRow?.identity || !["pending", "failed"].includes(row.state)) {
      await this.answerCallback(callback.id, "This request is no longer active.")
      return
    }
    if (parts[0] === "a" && parts[2] === "w") {
      const event = JSON.parse(row.event_json) as PermissionAsked
      const exact =
        event.always.map((pattern) => `<code>${escapeHtml(pattern)}</code>`).join("\n") ||
        "<i>No saved pattern supplied by OpenCode.</i>"
      await this.api("editMessageText", {
        chat_id: chatId,
        message_id: callback.message?.message_id,
        text: `⚠️ <b>Save OpenCode permission?</b>\n\nAction: <code>${escapeHtml(event.action)}</code>\n\nExact OpenCode rule:\n${exact}${event.always.includes("*") ? "\n\n🚨 <b>Wildcard: this rule is broad.</b>" : ""}`,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "⚠️ Confirm always allow", callback_data: `c:${row.callback_id}:y` }],
            [{ text: "← Back", callback_data: `c:${row.callback_id}:b` }],
          ],
        },
      })
      await this.answerCallback(callback.id, "Second confirmation required")
      return
    }
    if (parts[0] === "c" && parts[2] === "b") {
      await this.updatePending(row, "", true)
      await this.answerCallback(callback.id, "Cancelled")
      return
    }
    if (parts[0] === "a" && parts[2] === "f") {
      this.store.setDraft(row.identity, { mode: "reject_feedback" })
      await this.answerCallback(callback.id, "Reply to this message with rejection feedback.")
      return
    }
    let operation: "once" | "always" | "reject" | "answer" | "cancel" | undefined
    let data: { answers?: string[][] } | undefined
    if (parts[0] === "c" && parts[2] === "y") operation = "always"
    if (parts[0] === "a" && parts[2] === "o") operation = "once"
    if (parts[0] === "a" && parts[2] === "r") operation = "reject"
    if (parts[0] === "a" && parts[2] === "x") operation = "cancel"
    if (parts[0] === "q" && parts[2]) {
      const event = JSON.parse(row.event_json) as QuestionAsked
      const draft = questionDraft(row)
      const question = event.questions[draft.index]
      const option = question?.options[Number(parts[2])]
      if (option) {
        const selected = draft.answers[draft.index] ?? []
        if (question?.multiple) {
          draft.answers[draft.index] = selected.includes(option.label)
            ? selected.filter((label) => label !== option.label)
            : [...selected, option.label]
          this.store.setDraft(row.identity, draft)
          const updated = this.store.getPending(row.identity)
          if (updated) await this.updatePending(updated, "", true)
          await this.answerCallback(callback.id, selected.includes(option.label) ? "Removed" : "Selected")
          return
        }
        draft.answers[draft.index] = [option.label]
        draft.index += 1
        if (draft.index < event.questions.length) {
          this.store.setDraft(row.identity, draft)
          const updated = this.store.getPending(row.identity)
          if (updated) await this.updatePending(updated, "", true)
          await this.answerCallback(callback.id, "Next question")
          return
        }
        this.store.setDraft(row.identity, draft)
        const updated = this.store.getPending(row.identity)
        if (updated) await this.updatePending(updated, "Confirm before sending", true)
        await this.answerCallback(callback.id, "Review answers")
        return
      }
    }
    if (parts[0] === "d" && parts[2] === "y") {
      const event = JSON.parse(row.event_json) as QuestionAsked
      const draft = questionDraft(row)
      if (!draft.answers[draft.index]?.length) {
        await this.answerCallback(callback.id, "Select at least one option or reply with text.", true)
        return
      }
      draft.index += 1
      if (draft.index < event.questions.length) {
        this.store.setDraft(row.identity, draft)
        const updated = this.store.getPending(row.identity)
        if (updated) await this.updatePending(updated, "", true)
        await this.answerCallback(callback.id, "Next question")
        return
      }
      this.store.setDraft(row.identity, draft)
      const updated = this.store.getPending(row.identity)
      if (updated) await this.updatePending(updated, "Confirm before sending", true)
      await this.answerCallback(callback.id, "Review answers")
      return
    }
    if (parts[0] === "s" && parts[2] === "b") {
      const event = JSON.parse(row.event_json) as QuestionAsked
      const draft = questionDraft(row)
      draft.index = Math.max(0, event.questions.length - 1)
      this.store.setDraft(row.identity, draft)
      const updated = this.store.getPending(row.identity)
      if (updated) await this.updatePending(updated, "", true)
      await this.answerCallback(callback.id, "Edit the last answer")
      return
    }
    if (parts[0] === "s" && parts[2] === "y") {
      const draft = questionDraft(row)
      operation = "answer"
      data = { answers: draft.answers }
    }
    if (!operation) {
      await this.answerCallback(callback.id, "Invalid or stale action.", true)
      return
    }
    try {
      await this.answerCallback(callback.id, "Sending to the exact OpenCode TUI...")
    } catch (error) {
      this.log.warn("callback acknowledgement failed before dispatch", { error })
    }
    await this.updatePending(row, "⌛ Waiting for OpenCode confirmation")
    try {
      await this.hub.dispatch(row, operation, data)
    } catch (error) {
      await this.updatePending(row, `❌ ${clip(error, 300)}`, true)
    }
  }

  private async message(message: TelegramMessage) {
    const auth = this.authorized(message.chat.id, message.from?.id, message.message_thread_id, "viewer")
    if (!auth) return
    const text = message.text?.trim() ?? ""
    if (text.startsWith("/")) {
      const command = text.split(/\s/, 1)[0]?.split("@")[0]
      if (command === "/mission" || command === "/control") {
        await this.sendMission(message)
        return
      }
      if (command === "/projects" || command === "/queue" || command === "/inbox") {
        await this.sendMission(message, command === "/projects" ? "projects" : command === "/queue" ? "queue" : "inbox")
        return
      }
      if (command === "/dashboard" || command === "/sessions") {
        await this.sendDashboard(message)
        return
      }
      const nodes = this.store.listNodes()
      const tuis = this.store.listTuis()
      const pending = this.store.listPending()
      let response = ""
      if (command === "/start" || command === "/help")
        response =
          "<b>OpenCode Telegram</b>\n\n/mission /inbox /queue /projects /sessions /status /nodes /pending /whoami /help"
      else if (command === "/status")
        response = `<b>Healthy</b>\nVersion: <code>${VERSION}</code>\nProtocol: <code>${PROTOCOL_VERSION}</code>\nUptime: ${Math.round(this.hub.uptimeMs() / 1000)}s\nConnected nodes: ${this.hub.connectedNodeIds().length}\nActive TUIs: ${tuis.filter((tui) => tui.connected).length}\nPending: ${pending.length}`
      else if (command === "/nodes")
        response = nodes.length
          ? nodes
              .map(
                (node) => `${node.revoked ? "○" : "●"} ${escapeHtml(node.name)} <code>${node.id.slice(0, 12)}</code>`,
              )
              .join("\n")
          : "No enrolled nodes."
      else if (command === "/pending")
        response = pending.length
          ? pending.map((row) => `⚠ ${escapeHtml(row.kind)} <code>${row.request_id.slice(0, 12)}</code>`).join("\n")
          : "No pending requests."
      else if (command === "/whoami") response = `Chat: <code>${message.chat.id}</code>\nRole: <b>${auth.role}</b>`
      else if (command === "/mute") {
        if (!roleAllows(auth.role, "owner")) return
        this.store.setMuted("chat", String(message.chat.id), true)
        response = "Notifications muted for this chat. Commands remain available."
      } else if (command === "/unmute") {
        if (!roleAllows(auth.role, "owner")) return
        this.store.setMuted("chat", String(message.chat.id), false)
        response = "Notifications unmuted for this chat."
      }
      if (response)
        await this.api("sendMessage", {
          chat_id: message.chat.id,
          ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
          text: response,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        })
      return
    }
    const replied = message.reply_to_message
    if (!replied || !text || !roleAllows(auth.role, "approver")) return
    const row = this.store.getPendingByMessage(message.chat.id, replied.message_id)
    if (!row || !["pending", "failed"].includes(row.state)) return
    const rawDraft = row.draft_json ? (JSON.parse(row.draft_json) as { mode?: string }) : {}
    const operation = rawDraft.mode === "reject_feedback" ? "reject" : row.kind === "question" ? "answer" : undefined
    if (!operation) return
    if (operation === "answer") {
      const event = JSON.parse(row.event_json) as QuestionAsked
      const draft = questionDraft(row)
      const question = event.questions[draft.index]
      if (question?.custom === false) return
      if (question?.multiple) {
        draft.answers[draft.index] = [...(draft.answers[draft.index] ?? []), text]
        this.store.setDraft(row.identity, draft)
        const updated = this.store.getPending(row.identity)
        if (updated) await this.updatePending(updated, "", true)
        return
      }
      draft.answers[draft.index] = [text]
      draft.index += 1
      if (draft.index < event.questions.length) {
        this.store.setDraft(row.identity, draft)
        const updated = this.store.getPending(row.identity)
        if (updated) await this.updatePending(updated, "", true)
        return
      }
      this.store.setDraft(row.identity, draft)
      const updated = this.store.getPending(row.identity)
      if (updated) await this.updatePending(updated, "Confirm before sending", true)
      return
    }
    try {
      await this.updatePending(row, "⌛ Waiting for OpenCode confirmation")
      await this.hub.dispatch(row, operation, { message: text })
    } catch (error) {
      await this.updatePending(row, `❌ ${clip(error, 300)}`, true)
    }
  }

  private async poll() {
    let offset = this.store.telegramOffset()
    while (!this.controller.signal.aborted) {
      try {
        const updates = await this.api<TelegramUpdate[]>("getUpdates", {
          offset,
          timeout: this.config.telegram.pollTimeoutSeconds,
          allowed_updates: ["message", "callback_query"],
        })
        for (const update of updates) {
          try {
            if (update.callback_query) await this.callback(update.callback_query)
            if (update.message) await this.message(update.message)
          } catch (error) {
            if (!(error instanceof TelegramApiError) || error.code < 400 || error.code >= 500 || error.code === 429)
              throw error
            this.log.warn("telegram update rejected permanently", { update: update.update_id, error })
          }
          offset = Math.max(offset, update.update_id + 1)
          this.store.setTelegramOffset(offset)
        }
      } catch (error) {
        if (!this.controller.signal.aborted) {
          offset = this.store.telegramOffset()
          this.log.error("poll failed", { error, bot: this.botUsername })
          await sleep(2000, this.controller.signal).catch(() => undefined)
        }
      }
    }
  }
}
