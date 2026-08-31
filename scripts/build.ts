import { mkdirSync } from "node:fs"

mkdirSync("dist/opencode", { recursive: true })
const cli = await Bun.build({
  entrypoints: ["src/cli.ts"],
  outdir: "dist",
  target: "bun",
  format: "esm",
  minify: false,
  external: ["@opencode-ai/plugin", "@opencode-ai/plugin/tui", "@opencode-ai/sdk/v2"],
})
if (!cli.success) throw new AggregateError(cli.logs, "CLI build failed")
const tui = await Bun.build({
  entrypoints: ["src/opencode/tui.ts"],
  outdir: "dist/opencode",
  target: "bun",
  format: "esm",
  minify: false,
  external: ["@opencode-ai/plugin/tui", "@opencode-ai/sdk/v2"],
})
if (!tui.success) throw new AggregateError(tui.logs, "TUI build failed")
console.log("Built dist/cli.js and dist/opencode/tui.js")
