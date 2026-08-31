import { afterEach, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { ConfigSchema } from "../src/config.ts"
import { temporaryDirectory } from "./helpers.ts"

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
    "curl -fsSL 'https://raw.githubusercontent.com/AndreasFxPro/opencode-telegram/v0.2.0/install.sh' -o \"$installer\"",
  )
  expect(output).toContain("OPENCODE_TELEGRAM_VERSION='v0.2.0' OPENCODE_TELEGRAM_ENROLLMENT_TOKEN='oct_join_")
  expect(output).toContain("bash \"$installer\" setup node --hub 'https://hub.example.com'")
  expect(output).not.toContain("--token")
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
