import { afterEach, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ConfigSchema, SecretsSchema } from "../src/config.ts"
import { HubStore } from "../src/store.ts"
import { temporaryDirectory, testSecrets } from "./helpers.ts"

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const remove of cleanup.splice(0)) remove()
})

test("node create prints a single-command installer with the one-time token", async () => {
  const temp = temporaryDirectory()
  cleanup.push(temp.remove)
  const configPath = join(temp.path, "config.json")
  const config = ConfigSchema.parse({
    mode: "hub",
    dataDir: temp.path,
    hub: { listen: "127.0.0.1:47620", publicUrl: "https://hub.example.com" },
  })
  writeFileSync(configPath, JSON.stringify(config))
  const child = Bun.spawn([process.execPath, "src/cli.ts", "node", "create", "machine-a"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, OPENCODE_TELEGRAM_CONFIG: configPath },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [output, error, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(error).toBe("")
  expect(exitCode).toBe(0)
  expect(output).toContain("Install and enroll machine-a:")
  expect(output).toContain(
    "curl -fsSL 'https://raw.githubusercontent.com/AndreasFxPro/opencode-telegram/v0.4.0/install.sh' -o \"$installer\"",
  )
  expect(output).toContain("OPENCODE_TELEGRAM_VERSION='v0.4.0' OPENCODE_TELEGRAM_ENROLLMENT_TOKEN='oct_join_")
  expect(output).toContain("bash \"$installer\" setup node --hub 'https://hub.example.com'")
  expect(output).not.toContain("--token")
})

test("dashboard CLI enables access and configures capture without exposing other secrets", async () => {
  const temp = temporaryDirectory()
  cleanup.push(temp.remove)
  const configPath = join(temp.path, "config.json")
  const secretPath = join(temp.path, "secrets.json")
  const config = ConfigSchema.parse({
    mode: "hub",
    dataDir: temp.path,
    hub: { listen: "127.0.0.1:47620", publicUrl: "https://hub.example.com" },
  })
  const secrets = SecretsSchema.parse(testSecrets())
  writeFileSync(configPath, JSON.stringify(config))
  writeFileSync(secretPath, JSON.stringify(secrets), { mode: 0o600 })
  const run = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, "src/cli.ts", ...args], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, OPENCODE_TELEGRAM_CONFIG: configPath },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [output, error, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(error).toBe("")
    expect(exitCode).toBe(0)
    return output
  }
  const enabled = await run("dashboard", "enable")
  expect(enabled).toContain("https://hub.example.com/dashboard")
  expect(enabled).toContain("oct_dash_")
  await run("dashboard", "capture", "full")
  const savedConfig = ConfigSchema.parse(JSON.parse(readFileSync(configPath, "utf8")))
  const savedSecrets = SecretsSchema.parse(JSON.parse(readFileSync(secretPath, "utf8")))
  expect(savedConfig.dashboard).toMatchObject({ enabled: true, capture: "full" })
  expect(savedSecrets.dashboardToken).toStartWith("oct_dash_")
  expect(savedSecrets.nodeCredential).toBe(secrets.nodeCredential)
  const store = new HubStore(join(temp.path, "hub.db"))
  store.upsertSessionTelemetry(secrets.nodeId, "instance-test", {
    sessionId: "session-private",
    capture: "metadata",
    status: "idle",
    updatedAt: Date.now(),
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    todos: [],
    activities: [],
  })
  store.close()
  await run("dashboard", "disable")
  const disabledConfig = ConfigSchema.parse(JSON.parse(readFileSync(configPath, "utf8")))
  const disabledSecrets = SecretsSchema.parse(JSON.parse(readFileSync(secretPath, "utf8")))
  expect(disabledConfig.dashboard.enabled).toBeFalse()
  expect(disabledSecrets.dashboardToken).toBeUndefined()
  const disabledStore = new HubStore(join(temp.path, "hub.db"))
  expect(disabledStore.listSessionTelemetry()).toHaveLength(0)
  disabledStore.close()
})

test("dashboard CLI refuses plaintext remote access", async () => {
  const temp = temporaryDirectory()
  cleanup.push(temp.remove)
  const configPath = join(temp.path, "config.json")
  writeFileSync(
    configPath,
    JSON.stringify(
      ConfigSchema.parse({
        mode: "hub",
        dataDir: temp.path,
        hub: { listen: "0.0.0.0:47620", publicUrl: "http://hub.example.com" },
      }),
    ),
  )
  writeFileSync(join(temp.path, "secrets.json"), JSON.stringify(SecretsSchema.parse(testSecrets())), { mode: 0o600 })
  const child = Bun.spawn([process.execPath, "src/cli.ts", "dashboard", "enable"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, OPENCODE_TELEGRAM_CONFIG: configPath },
    stdout: "pipe",
    stderr: "pipe",
  })
  const error = await new Response(child.stderr).text()
  expect(await child.exited).toBe(1)
  expect(error).toContain("Refusing to send credentials over insecure non-loopback URL")
})

test("dashboard CLI enables collection without hosting on node mode", async () => {
  const temp = temporaryDirectory()
  cleanup.push(temp.remove)
  const configPath = join(temp.path, "config.json")
  writeFileSync(configPath, JSON.stringify(ConfigSchema.parse({ mode: "node", dataDir: temp.path })))
  writeFileSync(join(temp.path, "secrets.json"), JSON.stringify(SecretsSchema.parse(testSecrets())), { mode: 0o600 })
  const child = Bun.spawn([process.execPath, "src/cli.ts", "dashboard", "enable"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, OPENCODE_TELEGRAM_CONFIG: configPath },
    stdout: "pipe",
    stderr: "pipe",
  })
  const output = await new Response(child.stdout).text()
  expect(await child.exited).toBe(0)
  expect(output).toContain("telemetry enabled for this node")
  const config = ConfigSchema.parse(JSON.parse(readFileSync(configPath, "utf8")))
  const secrets = SecretsSchema.parse(JSON.parse(readFileSync(join(temp.path, "secrets.json"), "utf8")))
  expect(config.dashboard.enabled).toBeTrue()
  expect(secrets.dashboardToken).toBeUndefined()
})

test("Mission Control CLI manages durable projects and work state", async () => {
  const temp = temporaryDirectory()
  cleanup.push(temp.remove)
  const configPath = join(temp.path, "config.json")
  writeFileSync(
    configPath,
    JSON.stringify(ConfigSchema.parse({ mode: "hub", dataDir: temp.path, hub: { listen: "127.0.0.1:47620" } })),
  )
  const run = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, "src/cli.ts", ...args], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, OPENCODE_TELEGRAM_CONFIG: configPath },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [output, error, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(error).toBe("")
    expect(exitCode).toBe(0)
    return output
  }
  const project = JSON.parse(
    await run("mission", "project", "add", "bridge", "Telegram Bridge", "--priority", "high", "--json"),
  ) as { id: string }
  const work = JSON.parse(
    await run(
      "mission",
      "work",
      "add",
      "bridge",
      "Ship control plane",
      "--description",
      "Durable queue",
      "--acceptance",
      "Visible in all views",
      "--json",
    ),
  ) as { id: string }
  expect(project.id).toStartWith("prj_")
  expect(work.id).toStartWith("wrk_")
  expect(await run("mission", "work", "set", work.id, "ready")).toContain(`${work.id} -> ready`)
  expect(await run("mission", "work", "attach", work.id, "node-a:session-a")).toContain("node-a:session-a")
  const listed = await run("mission", "work", "list", "--project", "bridge", "--state", "ready")
  expect(listed).toContain("bridge\tShip control plane")
})

test("dashboard CLI formats an IPv6 loopback URL", async () => {
  const temp = temporaryDirectory()
  cleanup.push(temp.remove)
  const configPath = join(temp.path, "config.json")
  writeFileSync(
    configPath,
    JSON.stringify(ConfigSchema.parse({ mode: "hub", dataDir: temp.path, hub: { listen: "::1:47620" } })),
  )
  writeFileSync(join(temp.path, "secrets.json"), JSON.stringify(SecretsSchema.parse(testSecrets())), { mode: 0o600 })
  const child = Bun.spawn([process.execPath, "src/cli.ts", "dashboard", "enable"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, OPENCODE_TELEGRAM_CONFIG: configPath },
    stdout: "pipe",
    stderr: "pipe",
  })
  const output = await new Response(child.stdout).text()
  expect(await child.exited).toBe(0)
  expect(output).toContain("http://[::1]:47620/dashboard")
})

test("installer has valid Bash syntax", async () => {
  const child = Bun.spawn(["bash", "-n", "install.sh"], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  })
  const error = await new Response(child.stderr).text()
  expect(await child.exited).toBe(0)
  expect(error).toBe("")
})
