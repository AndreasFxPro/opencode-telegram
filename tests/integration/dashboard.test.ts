import { afterEach, expect, test } from "bun:test"
import { join } from "node:path"
import { Hub } from "../../src/hub.ts"
import type { SessionTelemetry } from "../../src/protocol.ts"
import { metadata, temporaryDirectory, testConfig, testSecrets } from "../helpers.ts"

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const item of cleanup.splice(0).reverse()) await item()
})

test("dashboard serves a data-free shell and authenticates snapshots", async () => {
  const temp = temporaryDirectory()
  cleanup.push(temp.remove)
  const port = 51000 + Math.floor(Math.random() * 500)
  const config = testConfig(temp.path, port, port + 600)
  config.dashboard.enabled = true
  config.dashboard.retentionHours = 1
  const secrets = { ...testSecrets(), dashboardToken: "oct_dash_abcdefghijklmnopqrstuvwxyz0123456789" }
  const hub = new Hub(config, secrets, join(temp.path, "hub.db"))
  hub.store.ensureNode(secrets.nodeId, "node-<unsafe>", secrets.nodeCredential ?? "")
  const meta = { ...metadata(), project: "<script>project</script>" }
  hub.store.registerTui(secrets.nodeId, meta)
  const telemetry: SessionTelemetry = {
    sessionId: "session-test",
    capture: "full",
    title: "<img src=x onerror=alert(1)>",
    status: "busy",
    updatedAt: Date.now(),
    cost: 0.123,
    tokens: { input: 100, output: 20, reasoning: 5, cacheRead: 40, cacheWrite: 2 },
    todos: [{ content: "Do work", status: "in_progress", priority: "high" }],
    activities: [{ id: "activity-1", type: "thought", title: "Thought", detail: "Private detail" }],
  }
  hub.store.upsertSessionTelemetry(secrets.nodeId, meta.instanceId, telemetry)
  const project = hub.store.createMissionProject({
    key: "unsafe-project",
    name: "<script>Mission</script>",
    description: "Prioritize & verify",
    priority: "urgent",
  })
  const work = hub.store.createMissionWorkItem({
    projectId: project.id,
    title: "Review <unsafe> work",
    description: "Needs operator attention",
    priority: "high",
  })
  hub.store.transitionMissionWorkItem(work.id, "ready")
  hub.store.transitionMissionWorkItem(work.id, "blocked")
  hub.store.upsertSessionTelemetry(secrets.nodeId, meta.instanceId, {
    ...telemetry,
    sessionId: "session-expired",
    updatedAt: telemetry.updatedAt - 2 * 60 * 60_000,
  })
  hub.store.db
    .query("UPDATE session_telemetry SET updated_at=? WHERE session_id='session-expired'")
    .run(Date.now() - 2 * 60 * 60_000)
  await hub.start()
  cleanup.push(() => hub.stop())
  const base = `http://127.0.0.1:${port}`
  const shell = await fetch(`${base}/dashboard`)
  const shellText = await shell.text()
  expect(shell.status).toBe(200)
  expect(shell.headers.get("content-security-policy")).not.toContain("unsafe-inline")
  expect(shellText).not.toContain("Private detail")
  expect(shellText).not.toContain(secrets.dashboardToken)
  const unauthorized = await fetch(`${base}/v1/dashboard/snapshot`)
  expect(unauthorized.status).toBe(401)
  expect(unauthorized.headers.get("cache-control")).toBe("no-store")
  const wrongMethod = await fetch(`${base}/v1/dashboard/snapshot`, {
    method: "POST",
    headers: { authorization: `Bearer ${secrets.dashboardToken}` },
  })
  expect(wrongMethod.status).toBe(405)
  const response = await fetch(`${base}/v1/dashboard/snapshot`, {
    headers: { authorization: `Bearer ${secrets.dashboardToken}` },
  })
  const body = (await response.json()) as {
    sessions: Array<Record<string, unknown>>
    totals: { sessions: number }
    missionControl: {
      totals: { projects: number; blocked: number; inbox: number }
      projects: Array<Record<string, unknown>>
      workItems: Array<Record<string, unknown>>
      inbox: Array<Record<string, unknown>>
    }
  }
  expect(response.status).toBe(200)
  expect(body.totals.sessions).toBe(1)
  expect(body.sessions[0]).toMatchObject({
    title: telemetry.title,
    project: meta.project,
    directory: meta.directory,
    capture: "full",
  })
  expect(body.missionControl.totals).toMatchObject({ projects: 1, blocked: 1, inbox: 1 })
  expect(body.missionControl.projects[0]).toMatchObject({ name: "<script>Mission</script>", activeWork: 1 })
  expect(body.missionControl.workItems[0]).toMatchObject({ title: "Review <unsafe> work", state: "blocked" })
  expect(body.missionControl.inbox[0]).toMatchObject({ kind: "blocked_work", state: "blocked" })
  const serialized = JSON.stringify(body)
  expect(serialized).not.toContain("credential_hash")
  expect(serialized).not.toContain(secrets.nodeCredential)
})

test("disabled dashboard returns not found", async () => {
  const temp = temporaryDirectory()
  cleanup.push(temp.remove)
  const port = 51500 + Math.floor(Math.random() * 400)
  const config = testConfig(temp.path, port, port + 500)
  const hub = new Hub(config, testSecrets(), join(temp.path, "hub.db"))
  hub.store.upsertSessionTelemetry(testSecrets().nodeId, "instance-test", {
    sessionId: "session-private",
    capture: "metadata",
    status: "idle",
    updatedAt: Date.now(),
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    todos: [],
    activities: [],
  })
  await hub.start()
  cleanup.push(() => hub.stop())
  expect((await fetch(`http://127.0.0.1:${port}/dashboard`)).status).toBe(404)
  expect(hub.store.listSessionTelemetry()).toHaveLength(0)
})

test("dashboard rejects plaintext non-loopback public URLs", async () => {
  const temp = temporaryDirectory()
  cleanup.push(temp.remove)
  const config = testConfig(temp.path, 51950, 51951)
  config.hub.publicUrl = "http://hub.example.com"
  config.dashboard.enabled = true
  const hub = new Hub(
    config,
    { ...testSecrets(), dashboardToken: "oct_dash_abcdefghijklmnopqrstuvwxyz0123456789" },
    join(temp.path, "hub.db"),
  )
  await expect(hub.start()).rejects.toThrow("require HTTPS")
  hub.store.close()
})

test("dashboard rejects a directly exposed listener behind an HTTPS public URL", async () => {
  const temp = temporaryDirectory()
  cleanup.push(temp.remove)
  const config = testConfig(temp.path, 51952, 51953)
  config.hub.listen = "0.0.0.0:51952"
  config.hub.publicUrl = "https://hub.example.com"
  config.dashboard.enabled = true
  const hub = new Hub(
    config,
    { ...testSecrets(), dashboardToken: "oct_dash_abcdefghijklmnopqrstuvwxyz0123456789" },
    join(temp.path, "hub.db"),
  )
  await expect(hub.start()).rejects.toThrow("loopback-only")
  hub.store.close()
})
