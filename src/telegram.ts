import type { Config } from "./config.ts"
import type { BridgeEvent, PermissionAsked, QuestionAsked, Role, SessionTelemetry } from "./protocol.ts"
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
    description: string,
  ) {
    super(`Telegram API ${code}: ${description}`)
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
  expiresAt: number
}

type InlineKeyboard = Array<Array<{ text: string; callback_data: string }>>

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
  private botUsername = ""

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
      throw new TelegramApiError(body.error_code, `${method}: ${body.description}`)
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
    const event = this.visibleEvent(JSON.parse(row.event_json) as PermissionAsked | QuestionAsked)
    const draft = row.kind === "question" ? questionDraft(row) : undefined
    const text =
      row.kind === "permission"
        ? renderPermission(event as PermissionAsked)
        : renderQuestion(event as QuestionAsked, undefined, draft?.index, draft?.answers)
    for (const auth of this.config.telegram.authorizedChats) {
      if (this.store.isMuted("chat", String(auth.id))) continue
      if (existing.some((message) => message.chat_id === auth.id && message.thread_id === (auth.threadId ?? null)))
        continue
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

  private dashboardPresentation(view: DashboardView, snapshot: DashboardSnapshot) {
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
      return { text, keyboard }
    }
    if (!selected)
      return {
        text: "<b>Session unavailable</b>\n\nIt expired or is no longer retained.",
        keyboard: [
          [{ text: "← Sessions", callback_data: this.dashboardData(view, "l") }],
          [{ text: "↻ Refresh", callback_data: this.dashboardData(view, "r") }],
        ] satisfies InlineKeyboard,
      }
    const title = escapeHtml(clip(selected.title || selected.sessionId, 80))
    let text = ""
    if (view.mode === "activity") {
      const activities = selected.activities.slice(-6).reverse()
      const heading = `<b>Activity</b> · ${title}`
      const blocks: string[] = []
      for (const activity of activities) {
        const block = `<b>${escapeHtml(clip(activity.title, 60))}</b>${activity.status ? ` · ${escapeHtml(clip(activity.status, 32))}` : ""}${activity.detail ? `\n<code>${escapeHtml(clip(activity.detail, 220))}</code>` : ""}`
        if (`${heading}\n\n${[...blocks, block].join("\n\n")}`.length > 3600) break
        blocks.push(block)
      }
      text = `${heading}\n\n${blocks.join("\n\n") || "No captured activity."}`
    } else if (view.mode === "todos") {
      const heading = `<b>Todos</b> · ${title}`
      const lines: string[] = []
      for (const todo of selected.todos.slice(0, 12)) {
        const line = `${todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "◐" : "○"} ${escapeHtml(clip(todo.content, 240))}`
        if (`${heading}\n\n${[...lines, line].join("\n")}`.length > 3600) break
        lines.push(line)
      }
      text = `${heading}\n\n${lines.join("\n") || "No captured todos."}`
    } else {
      const tokens = selected.tokens
      const model = [selected.provider, selected.model].filter(Boolean).join("/") || "unknown"
      const effectiveStatus = selected.connected ? selected.status : "offline"
      text = `<b>${title}</b>\n\n${!selected.connected ? "○" : selected.status === "busy" ? "◐" : "●"} <b>${escapeHtml(effectiveStatus)}</b> · ${escapeHtml(clip(selected.nodeName, 60))}\nProject: <code>${escapeHtml(clip(selected.project, 60))}</code>${selected.directory ? `\nPath: <code>${escapeHtml(clip(selected.directory, 100))}</code>` : ""}\nAgent: <code>${escapeHtml(clip(selected.agent || "unknown", 40))}</code>\nModel: <code>${escapeHtml(clip(model, 60))}</code>\n\nTokens: <b>${Math.round(tokens.input + tokens.output).toLocaleString("en-US")}</b> · In ${Math.round(tokens.input).toLocaleString("en-US")} · Out ${Math.round(tokens.output).toLocaleString("en-US")}\nCache read: ${Math.round(tokens.cacheRead).toLocaleString("en-US")} · Reasoning: ${Math.round(tokens.reasoning).toLocaleString("en-US")}\nCost: <b>$${selected.cost.toFixed(4)}</b> · Capture: <code>${selected.capture}</code>\nUpdated ${this.dashboardAge(selected.updatedAt)}.`
    }
    const keyboard: InlineKeyboard = [
      [
        { text: `Activity ${selected.activities.length}`, callback_data: this.dashboardData(view, "a") },
        { text: `Todos ${selected.todos.length}`, callback_data: this.dashboardData(view, "t") },
      ],
      [
        { text: "Overview", callback_data: this.dashboardData(view, "d") },
        { text: "↻ Refresh", callback_data: this.dashboardData(view, "r") },
      ],
      [{ text: "← Sessions", callback_data: this.dashboardData(view, "l") }],
    ]
    return { text, keyboard }
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
      expiresAt: Date.now() + 30 * 60_000,
    }
    const presentation = this.dashboardPresentation(view, snapshot)
    const sent = await this.api<TelegramMessage>("sendMessage", {
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
      selectedKey: view.selectedKey,
    }
    const operation = parts[3]
    let snapshot: DashboardSnapshot | undefined
    if (operation === "l") {
      delete view.selectedKey
      view.mode = "detail"
    } else if (operation === "p") view.page = Math.max(0, Number(parts[4]) || 0)
    else if (operation === "o") {
      const key = view.keys[Number(parts[4])]
      if (key) view.selectedKey = key
      else delete view.selectedKey
      view.mode = "detail"
    } else if (operation === "a") view.mode = "activity"
    else if (operation === "t") view.mode = "todos"
    else if (operation === "d") view.mode = "detail"
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
    const presentation = this.dashboardPresentation(view, snapshot)
    try {
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
        if (previous.selectedKey) view.selectedKey = previous.selectedKey
        else delete view.selectedKey
        throw error
      }
    }
    await this.answerCallback(callback.id, operation === "r" ? "Dashboard refreshed" : "Updated")
  }

  private async callback(callback: TelegramCallback) {
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
      if (command === "/dashboard" || command === "/sessions") {
        await this.sendDashboard(message)
        return
      }
      const nodes = this.store.listNodes()
      const tuis = this.store.listTuis()
      const pending = this.store.listPending()
      let response = ""
      if (command === "/start" || command === "/help")
        response = "<b>OpenCode Telegram</b>\n\n/dashboard /status /nodes /sessions /pending /whoami /help"
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
