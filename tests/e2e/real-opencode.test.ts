import { expect, test } from "bun:test"

const enabled = process.env.OPENCODE_REAL_E2E === "1"

test.skipIf(!enabled)("real OpenCode TUI permission reply resumes the originating session", async () => {
  const harness = process.env.OPENCODE_REAL_E2E_HARNESS
  expect(harness, "Set OPENCODE_REAL_E2E_HARNESS to the audited interactive harness command").toBeTruthy()
  const processResult = Bun.spawnSync(["bash", "-lc", harness ?? "false"], { stdout: "inherit", stderr: "inherit" })
  expect(processResult.exitCode).toBe(0)
})
