export {}

const packageFile = (await import("../package.json")) as {
  default: { bin?: Record<string, string>; exports?: Record<string, unknown>; main?: string }
}
if (packageFile.default.main || packageFile.default.exports?.["."])
  throw new Error("Root export would be misdetected by OpenCode as a server plugin")
if (packageFile.default.bin?.["opencode-telegram"] !== "./dist/cli.js") throw new Error("CLI bin is not distributable")

const builtPath = "../dist/opencode/tui.js"
const loaded = (await import(builtPath)) as { default?: { id?: unknown; tui?: unknown } }
const plugin = loaded.default

if (plugin?.id !== "opencode-telegram" || typeof plugin.tui !== "function")
  throw new Error("Invalid TUI package export")
console.log("Package smoke test passed")
