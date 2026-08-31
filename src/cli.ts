#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir, hostname, platform } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  type Config,
  ConfigSchema,
  configPath,
  dataDir,
  loadConfig,
  loadSecrets,
  saveConfig,
  secretPath,
} from "./config.ts"
import { Hub } from "./hub.ts"
import { NodeService } from "./node.ts"
import { HubStore } from "./store.ts"
import { randomId } from "./util.ts"
import { MIN_OPENCODE_VERSION, PROTOCOL_VERSION, VERSION } from "./version.ts"

const args = process.argv.slice(2)
const command = args[0] ?? "help"
const INSTALL_SCRIPT_URL = `https://raw.githubusercontent.com/AndreasFxPro/opencode-telegram/v${VERSION}/install.sh`

function option(name: string) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function has(name: string) {
  return args.includes(name)
}

function run(executable: string, runArgs: string[], quiet = false) {
  return Bun.spawnSync([executable, ...runArgs], {
    stdout: quiet ? "pipe" : "inherit",
    stderr: quiet ? "pipe" : "inherit",
  })
}

function opencodeVersion() {
  const result = run("opencode", ["--version"], true)
  return result.success ? result.stdout?.toString().trim() : undefined
}

function versionAtLeast(actual: string, minimum: string) {
  const left = actual.split(/[.-]/).slice(0, 3).map(Number)
  const right = minimum.split(".").map(Number)
  for (let index = 0; index < 3; index++) {
    if ((left[index] ?? 0) > (right[index] ?? 0)) return true
    if ((left[index] ?? 0) < (right[index] ?? 0)) return false
  }
  return true
}

async function input(label: string, fallback?: string) {
  const answer = globalThis.prompt(`${label}${fallback ? ` [${fallback}]` : ""}:`)?.trim()
  return answer || fallback || ""
}

function requireSecureRemote(urlValue: string, insecureAllowed = false) {
  const url = new URL(urlValue)
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(url.hostname)
  if (url.protocol !== "https:" && !loopback && !insecureAllowed)
    throw new Error(`Refusing to send credentials over insecure non-loopback URL: ${url.origin}`)
}

async function telegramGetMe(apiBase: string, token: string) {
  requireSecureRemote(apiBase)
  const response = await fetch(`${apiBase}/bot${token}/getMe`)
  const body = (await response.json()) as { ok?: boolean; result?: { username?: string }; description?: string }
  if (!body.ok) throw new Error(`Telegram rejected the bot token: ${body.description ?? response.status}`)
  return body.result
}

async function detectChat(apiBase: string, token: string, challenge: string) {
  const response = await fetch(`${apiBase}/bot${token}/getUpdates`)
  const body = (await response.json()) as {
    ok?: boolean
    result?: Array<{
      message?: { chat?: { id?: number }; from?: { id?: number }; text?: string }
      callback_query?: { from?: { id?: number }; message?: { chat?: { id?: number } } }
    }>
  }
  return body.result
    ?.toReversed()
    .filter((update) => update.message?.text === `/start ${challenge}`)
    .map((update) => ({
      chatId: update.message?.chat?.id ?? update.callback_query?.message?.chat?.id,
      userId: update.message?.from?.id ?? update.callback_query?.from?.id,
    }))
    .find((identity) => identity.chatId !== undefined && identity.userId !== undefined)
}

async function installPlugin() {
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
  const releasePlugin = join(
    process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
    "opencode-telegram",
    "plugin",
  )
  const root =
    process.env.OPENCODE_TELEGRAM_PLUGIN_PATH ??
    (existsSync(join(sourceRoot, "package.json")) ? sourceRoot : releasePlugin)
  if (!existsSync(join(root, "package.json")))
    throw new Error(`TUI plugin package not found at ${root}. Re-run the release installer.`)
  const result = run("opencode", ["plugin", root, "--global", "--force"])
  if (!result.success)
    throw new Error(
      "OpenCode plugin installation failed. Run 'opencode plugin <project-directory> --global --force' for details.",
    )
}

const instructionStart = "<!-- opencode-telegram:managed:start -->"
const instructionEnd = "<!-- opencode-telegram:managed:end -->"
const managedInstruction = `${instructionStart}\nWhen execution cannot continue without user input, a decision, clarification, confirmation, or selection, use OpenCode's current structured question mechanism instead of only asking in prose.\n\nDo not use it for rhetorical questions or when execution can safely continue.\n${instructionEnd}`

function manageInstruction(install: boolean) {
  const path = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode", "AGENTS.md")
  mkdirSync(dirname(path), { recursive: true })
  const current = existsSync(path) ? readFileSync(path, "utf8") : ""
  const start = current.indexOf(instructionStart)
  const end = current.indexOf(instructionEnd)
  const without =
    start >= 0 && end >= start
      ? `${current.slice(0, start)}${current.slice(end + instructionEnd.length)}`.trim()
      : current.trim()
  const next = install
    ? `${without}${without ? "\n\n" : ""}${managedInstruction}\n`
    : `${without}${without ? "\n" : ""}`
  writeFileSync(path, next, { mode: 0o600 })
  console.log(`${install ? "Installed" : "Removed"} managed instruction in ${path}`)
}

async function setup() {
  const requested = args[1]?.startsWith("-") ? undefined : args[1]
  const mode = (requested ??
    option("--mode") ??
    (await input("Mode (standalone/hub/node)", "standalone"))) as Config["mode"]
  if (!["standalone", "hub", "node"].includes(mode)) throw new Error(`Unknown setup mode '${mode}'`)
  const installed = opencodeVersion()
  console.log(`OpenCode: ${installed ?? "not found"}`)
  if (mode !== "hub" && !installed) throw new Error("OpenCode is required on standalone and node machines")
  if (installed && !versionAtLeast(installed, MIN_OPENCODE_VERSION))
    throw new Error(`OpenCode ${installed} is too old for safe replies. Upgrade to >=${MIN_OPENCODE_VERSION}.`)

  const localPluginSecret = randomId("local", 32)
  let nodeId = randomId("node")
  let nodeCredential: string | undefined
  let enrolledNodeName: string | undefined
  let telegramBotToken: string | undefined
  let authorizedChats: Array<{ id: number; role: "owner" }> = []
  let authorizedUsers: Array<{ id: number; role: "owner" }> = []
  const apiBase = option("--telegram-api") ?? "https://api.telegram.org"
  let hubUrl = option("--hub") ?? "http://127.0.0.1:47620"

  if (mode === "standalone" || mode === "hub") {
    telegramBotToken = option("--bot-token") ?? process.env.TELEGRAM_BOT_TOKEN ?? (await input("Telegram bot token"))
    if (!telegramBotToken) throw new Error("Telegram bot token is required for hub and standalone modes")
    const bot = await telegramGetMe(apiBase, telegramBotToken)
    console.log(`Telegram bot: @${bot?.username ?? "unknown"}`)
    let chatId = Number(option("--chat-id") ?? 0)
    let userId = Number(option("--user-id") ?? 0)
    if (!chatId) {
      const challenge = randomId("pair", 6)
      console.log(`Send this exact message to the bot: /start ${challenge}`)
      await input("Ready")
      const identity = await detectChat(apiBase, telegramBotToken, challenge)
      chatId = identity?.chatId ?? 0
      userId = identity?.userId ?? 0
      if (chatId && userId) {
        const confirmed = (await input(`Authorize chat ${chatId} and user ${userId} as owner? (yes/no)`, "no"))
          .toLowerCase()
          .startsWith("y")
        if (!confirmed) throw new Error("Telegram owner authorization cancelled")
      }
    }
    if (!chatId || !userId)
      throw new Error("No Telegram chat/user detected. Send /start and rerun setup with --chat-id <id> --user-id <id>.")
    authorizedChats = [{ id: chatId, role: "owner" }]
    authorizedUsers = [{ id: userId, role: "owner" }]
  }

  if (mode === "node") {
    const enrollmentToken =
      option("--token") ?? process.env.OPENCODE_TELEGRAM_ENROLLMENT_TOKEN ?? (await input("Enrollment token"))
    if (!enrollmentToken) throw new Error("Enrollment token is required")
    hubUrl = option("--hub") ?? (await input("Hub URL"))
    if (!hubUrl) throw new Error("Hub URL is required")
    requireSecureRemote(hubUrl, has("--allow-insecure-hub"))
    const endpoint = new URL("/v1/enroll", hubUrl)
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: enrollmentToken }),
    })
    if (!response.ok) throw new Error(`Enrollment failed: ${await response.text()}`)
    const enrolled = (await response.json()) as { nodeId: string; credential: string; nodeName: string }
    nodeId = enrolled.nodeId
    nodeCredential = enrolled.credential
    enrolledNodeName = enrolled.nodeName
  }

  if (mode === "standalone") nodeCredential = randomId("oct_node", 32)
  const parsedHub = new URL(hubUrl)
  const wsProtocol = parsedHub.protocol === "https:" ? "wss:" : "ws:"
  const wsUrl = `${wsProtocol}//${parsedHub.host}/v1/node/ws`
  const config = ConfigSchema.parse({
    mode,
    hub: { listen: option("--listen") ?? "127.0.0.1:47620", publicUrl: hubUrl },
    node: {
      name: option("--name") ?? enrolledNodeName ?? hostname(),
      hubUrl: wsUrl,
      allowInsecureHub: has("--allow-insecure-hub"),
      localListen: "127.0.0.1:47621",
      queueLimit: 10000,
    },
    telegram: { apiBase, authorizedChats, authorizedUsers, pollTimeoutSeconds: 25 },
  })
  const secrets = {
    telegramBotToken,
    localPluginSecret,
    nodeId,
    nodeCredential,
  }
  saveConfig(config, secrets)
  if (mode === "standalone" && nodeCredential) {
    const store = new HubStore(join(dataDir(config), "hub.db"))
    store.ensureNode(nodeId, config.node.name, nodeCredential)
    store.close()
  }
  if (installed && mode !== "hub") await installPlugin()
  const addInstruction =
    has("--install-instruction") ||
    (!has("--no-instruction") &&
      (await input("Add the managed structured-question instruction? (yes/no)", "no")).toLowerCase().startsWith("y"))
  if (addInstruction) manageInstruction(true)
  console.log(`Configuration: ${configPath}`)
  console.log(`Secrets: ${secretPath} (0600)`)
  console.log(`Next: opencode-telegram ${mode}`)
}

async function runServices(mode: "hub" | "node" | "standalone") {
  const config = loadConfig()
  const secrets = loadSecrets()
  let hub: Hub | undefined
  let node: NodeService | undefined
  if (mode === "hub" || mode === "standalone") {
    hub = new Hub(config, secrets)
    await hub.start()
  }
  if (mode === "node" || mode === "standalone") {
    if (mode === "standalone" && secrets.nodeCredential && hub)
      hub.store.ensureNode(secrets.nodeId, config.node.name, secrets.nodeCredential)
    node = new NodeService(config, secrets)
    await node.start()
  }
  await new Promise<void>((resolve) => {
    const stop = () => resolve()
    process.once("SIGINT", stop)
    process.once("SIGTERM", stop)
  })
  await node?.stop()
  await hub?.stop()
}

function hubStore() {
  const config = loadConfig()
  return new HubStore(join(dataDir(config), "hub.db"))
}

async function nodeAdmin() {
  const operation = args[1]
  const store = hubStore()
  try {
    if (operation === "create") {
      const name = args[2] ?? (await input("Node name"))
      if (!name) throw new Error("Node name is required")
      const enrollment = store.createEnrollment(name)
      console.log(`Enrollment token:\n${enrollment.token}\n\nExpires: ${new Date(enrollment.expiresAt).toISOString()}`)
      const hubUrl = loadConfig().hub.publicUrl
      if (hubUrl) {
        try {
          requireSecureRemote(hubUrl)
          const installCommand = `(installer="$(mktemp)" && trap 'rm -f "$installer"' EXIT && curl -fsSL ${shellQuote(INSTALL_SCRIPT_URL)} -o "$installer" && OPENCODE_TELEGRAM_VERSION=${shellQuote(`v${VERSION}`)} OPENCODE_TELEGRAM_ENROLLMENT_TOKEN=${shellQuote(enrollment.token)} bash "$installer" setup node --hub ${shellQuote(hubUrl)})`
          console.log(`\nInstall and enroll ${name}:\n${installCommand}`)
        } catch (error) {
          console.log(`\nInstall command unavailable: ${String(error)}`)
        }
      }
      return
    }
    if (operation === "list") {
      for (const node of store.listNodes())
        console.log(`${node.revoked ? "revoked" : "active"}\t${node.id}\t${node.name}`)
      return
    }
    if (operation === "revoke") {
      if (!args[2] || !store.revokeNode(args[2])) throw new Error("Node not found")
      console.log(`Revoked ${args[2]}`)
      return
    }
    if (operation === "rename") {
      if (!args[2] || !args[3] || !store.renameNode(args[2], args[3])) throw new Error("Usage: node rename <id> <name>")
      console.log(`Renamed ${args[2]} to ${args[3]}`)
      return
    }
    throw new Error("Usage: node create <name> | node list | node revoke <id> | node rename <id> <name>")
  } finally {
    store.close()
  }
}

async function fetchHealth(url: string, authorization?: string) {
  try {
    const response = await fetch(url, {
      headers: authorization ? { authorization } : {},
      signal: AbortSignal.timeout(1500),
    })
    return response.ok ? ((await response.json()) as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

async function doctor() {
  const checks: Array<{ area: string; ok: boolean; detail: string }> = []
  let config: Config | undefined
  try {
    config = loadConfig()
    checks.push({ area: "Config", ok: true, detail: configPath })
  } catch (error) {
    checks.push({ area: "Config", ok: false, detail: String(error) })
  }
  let secrets: ReturnType<typeof loadSecrets> | undefined
  try {
    secrets = loadSecrets()
    const mode = statSync(secretPath).mode & 0o777
    checks.push({ area: "Security", ok: mode === 0o600, detail: `secret permissions ${mode.toString(8)}` })
  } catch (error) {
    checks.push({ area: "Security", ok: false, detail: String(error) })
  }
  const version = opencodeVersion()
  if (config?.mode !== "hub")
    checks.push({
      area: "OpenCode",
      ok: Boolean(version && versionAtLeast(version, MIN_OPENCODE_VERSION)),
      detail: version ?? "not found",
    })
  if (config && secrets) {
    const tuiConfigPath = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode", "tui.json")
    try {
      const tuiConfig = JSON.parse(readFileSync(tuiConfigPath, "utf8")) as { plugin?: string[] }
      const installedPlugin = tuiConfig.plugin?.some((plugin) => plugin.includes("opencode-telegram")) ?? false
      checks.push({
        area: "TUI plugin",
        ok: config.mode === "hub" || installedPlugin,
        detail:
          config.mode === "hub" ? "not required on hub-only host" : installedPlugin ? "configured" : "not configured",
      })
    } catch {
      checks.push({ area: "TUI plugin", ok: config.mode === "hub", detail: "OpenCode TUI config not found" })
    }
    if (config.mode !== "hub") {
      const local = await fetchHealth(`http://${config.node.localListen}/health`, `Bearer ${secrets.localPluginSecret}`)
      checks.push({
        area: "Node",
        ok: Boolean(local?.ok && local.hubConnected),
        detail: local ? JSON.stringify(local) : "local service unreachable",
      })
    }
    const hubUrl = config.hub.publicUrl
      ? new URL("/health", config.hub.publicUrl).toString()
      : `http://${config.hub.listen}/health`
    const hub = await fetchHealth(hubUrl)
    checks.push({ area: "Hub", ok: Boolean(hub?.ok), detail: hub ? JSON.stringify(hub) : "hub unreachable" })
    const secure =
      new URL(config.node.hubUrl).protocol === "wss:" ||
      ["localhost", "127.0.0.1", "::1"].includes(new URL(config.node.hubUrl).hostname)
    checks.push({
      area: "Transport",
      ok: secure,
      detail: secure ? "TLS or loopback" : "insecure non-loopback WebSocket",
    })
    if (secrets.telegramBotToken) {
      try {
        const me = await telegramGetMe(config.telegram.apiBase, secrets.telegramBotToken)
        checks.push({ area: "Telegram", ok: true, detail: `@${me?.username ?? "unknown"}` })
      } catch (error) {
        checks.push({ area: "Telegram", ok: false, detail: String(error) })
      }
    }
  }
  const result = { ok: checks.every((check) => check.ok), version: VERSION, protocolVersion: PROTOCOL_VERSION, checks }
  if (has("--json")) console.log(JSON.stringify(result, null, 2))
  else {
    for (const check of checks) console.log(`${check.ok ? "✓" : "✗"} ${check.area}: ${check.detail}`)
    console.log(`\nResult: ${result.ok ? "healthy" : "attention required"}`)
  }
  if (!result.ok) process.exitCode = 1
}

function commandParts() {
  const source = fileURLToPath(import.meta.url)
  return source.endsWith(".ts") ? [process.execPath, source] : [process.execPath]
}

function xml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
}

function systemdQuote(value: string) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function servicePath() {
  if (platform() === "darwin") return join(homedir(), "Library", "LaunchAgents", "dev.opencode.telegram.plist")
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd", "user", "opencode-telegram.service")
}

function serviceInstall() {
  const config = loadConfig()
  const target = servicePath()
  mkdirSync(dirname(target), { recursive: true })
  const parts = commandParts()
  if (platform() === "darwin") {
    writeFileSync(
      target,
      `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>dev.opencode.telegram</string><key>ProgramArguments</key><array>${[...parts, config.mode].map((arg) => `<string>${xml(arg)}</string>`).join("")}</array><key>EnvironmentVariables</key><dict><key>OPENCODE_TELEGRAM_CONFIG</key><string>${xml(configPath)}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>${xml(join(dataDir(config), "service.log"))}</string><key>StandardErrorPath</key><string>${xml(join(dataDir(config), "service.log"))}</string></dict></plist>\n`,
      { mode: 0o600 },
    )
    const result = run("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? 0}`, target])
    if (!result.success) throw new Error("launchd service installation failed")
  } else {
    writeFileSync(
      target,
      `[Unit]\nDescription=OpenCode Telegram companion\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nEnvironment=OPENCODE_TELEGRAM_CONFIG=${systemdQuote(configPath)}\nExecStart=${[...parts, config.mode].map(systemdQuote).join(" ")}\nRestart=on-failure\nRestartSec=2\nNoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=strict\nProtectHome=read-only\nReadWritePaths=${systemdQuote(dataDir(config))}\n\n[Install]\nWantedBy=default.target\n`,
      { mode: 0o600 },
    )
    if (!run("systemctl", ["--user", "daemon-reload"]).success) throw new Error("systemd daemon-reload failed")
    if (!run("systemctl", ["--user", "enable", "--now", "opencode-telegram.service"]).success)
      throw new Error("systemd service start failed")
  }
  console.log(`Installed ${target}`)
}

function serviceCommand(operation: string) {
  let result: ReturnType<typeof run> | undefined
  if (platform() === "darwin") {
    const domain = `gui/${process.getuid?.() ?? 0}`
    if (operation === "status") result = run("launchctl", ["print", `${domain}/dev.opencode.telegram`])
    else if (operation === "restart") result = run("launchctl", ["kickstart", "-k", `${domain}/dev.opencode.telegram`])
    else if (operation === "start") result = run("launchctl", ["kickstart", `${domain}/dev.opencode.telegram`])
    else if (operation === "stop") result = run("launchctl", ["kill", "SIGTERM", `${domain}/dev.opencode.telegram`])
  } else result = run("systemctl", ["--user", operation, "opencode-telegram.service"])
  if (!result?.success) throw new Error(`Service ${operation} failed`)
}

function help() {
  console.log(
    `opencode-telegram ${VERSION}\n\nUsage:\n  opencode-telegram setup [standalone|hub|node]\n  opencode-telegram standalone | hub | node\n  opencode-telegram status | doctor [--json] | test | logs\n  opencode-telegram node create|list|revoke|rename\n  opencode-telegram service install|start|stop|restart|status\n  opencode-telegram config show|validate\n  opencode-telegram instructions install|uninstall\n  opencode-telegram uninstall --yes\n  opencode-telegram version\n`,
  )
}

async function main() {
  if (command === "setup") return setup()
  if (command === "standalone" || command === "hub") return runServices(command)
  if (command === "node" && !["create", "list", "revoke", "rename"].includes(args[1] ?? "")) return runServices("node")
  if (command === "node") return nodeAdmin()
  if (command === "doctor" || command === "status") return doctor()
  if (command === "service") {
    if (args[1] === "install") return serviceInstall()
    return serviceCommand(args[1] ?? "status")
  }
  if (command === "logs")
    return platform() === "darwin"
      ? run("tail", ["-f", join(dataDir(loadConfig()), "service.log")])
      : run("journalctl", ["--user", "-u", "opencode-telegram.service", "-f"])
  if (command === "config") {
    if (args[1] === "show") return console.log(JSON.stringify(loadConfig(), null, 2))
    ConfigSchema.parse(JSON.parse(readFileSync(configPath, "utf8")))
    return console.log("Configuration is valid")
  }
  if (command === "instructions") {
    if (args[1] === "install") return manageInstruction(true)
    if (args[1] === "uninstall") return manageInstruction(false)
    throw new Error("Usage: instructions install|uninstall")
  }
  if (command === "test") {
    const config = loadConfig()
    const secrets = loadSecrets()
    const health = await fetchHealth(`http://${config.node.localListen}/health`, `Bearer ${secrets.localPluginSecret}`)
    if (!health) throw new Error("Node is unreachable. Start the service first.")
    return console.log("Node health check passed. Use /telegram-test in OpenCode to verify TUI registration.")
  }
  if (command === "uninstall") {
    if (!has("--yes")) throw new Error("Refusing to remove configuration without --yes")
    const installedService = servicePath()
    if (existsSync(installedService)) {
      if (platform() === "darwin") run("launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}`, installedService])
      else {
        run("systemctl", ["--user", "stop", "opencode-telegram.service"])
        run("systemctl", ["--user", "disable", "opencode-telegram.service"])
      }
      rmSync(installedService)
      if (platform() !== "darwin") run("systemctl", ["--user", "daemon-reload"])
    }
    rmSync(configPath, { force: true })
    rmSync(secretPath, { force: true })
    return console.log(
      "Service files and opencode-telegram configuration removed. OpenCode plugin configuration is preserved for manual review.",
    )
  }
  if (command === "version" || has("--version")) return console.log(VERSION)
  help()
}

main().catch((error) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
