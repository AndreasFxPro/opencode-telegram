import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Config, ConfigSchema, type Secrets } from "../src/config.ts"
import type { PermissionAsked, TuiMetadata } from "../src/protocol.ts"

export function temporaryDirectory() {
  const path = mkdtempSync(join(tmpdir(), "opencode-telegram-"))
  return { path, remove: () => rmSync(path, { recursive: true, force: true }) }
}

export function testConfig(path: string, hubPort = 48920, nodePort = 48921): Config {
  return ConfigSchema.parse({
    mode: "standalone",
    dataDir: path,
    hub: { listen: `127.0.0.1:${hubPort}`, publicUrl: `http://127.0.0.1:${hubPort}` },
    node: { name: "test-node", hubUrl: `ws://127.0.0.1:${hubPort}/v1/node/ws`, localListen: `127.0.0.1:${nodePort}` },
    telegram: { authorizedChats: [], authorizedUsers: [] },
  })
}

export function testSecrets(): Secrets {
  return {
    localPluginSecret: "local_abcdefghijklmnopqrstuvwxyz0123456789",
    nodeId: "node_abcdefghijklmnopqrstuvwxyz",
    nodeCredential: "oct_node_abcdefghijklmnopqrstuvwxyz0123456789",
  }
}

export function metadata(instanceId = "tui_test_12345678"): TuiMetadata {
  return {
    instanceId,
    sessionId: "session-test",
    rootSessionId: "session-test",
    project: "project",
    directory: "/tmp/project",
    worktree: "/tmp/project",
    branch: "main",
    pid: 1234,
    hostname: "test-host",
    opencodeVersion: "1.18.23",
    pluginVersion: "0.1.0",
    startedAt: Date.now(),
    location: { directory: "/tmp/project" },
    capabilities: {
      permissionReply: true,
      savedPermission: true,
      questionReply: true,
      questionReject: true,
      sessionExecutionEvents: true,
      pendingSync: true,
      workspaceRouting: true,
      locationRouting: true,
      sessionHierarchy: true,
    },
  }
}

export function permission(instanceId = "tui_test_12345678"): PermissionAsked {
  return {
    type: "permission.asked",
    eventId: `evt_${crypto.randomUUID()}`,
    emittedAt: Date.now(),
    instanceId,
    sessionId: "session-test",
    rootSessionId: "session-test",
    location: { directory: "/tmp/project" },
    requestId: "permission-test",
    action: "bash",
    patterns: ["bun test"],
    always: ["bun test"],
  }
}

export async function eventually(check: () => boolean | Promise<boolean>, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await Bun.sleep(25)
  }
  throw new Error("Condition was not met before timeout")
}
