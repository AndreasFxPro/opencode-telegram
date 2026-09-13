import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

export function randomId(prefix: string, bytes = 18) {
  return `${prefix}_${randomBytes(bytes).toString("base64url")}`
}

export function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

export function safeEqualHash(value: string, expectedHash: string) {
  const actual = Buffer.from(sha256(value), "hex")
  const expected = Buffer.from(expectedHash, "hex")
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

export function clip(value: unknown, max: number) {
  const text = String(value ?? "").trim()
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`
}

export function redact(value: unknown) {
  return clip(value, 4096)
    .replace(/\b\d{8,12}:[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_BOT_TOKEN]")
    .replace(/\b(?:sk|ghp|oct_join|oct_node|oct_dash|local)_[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_SECRET]")
    .replace(/(authorization\s*[:=]\s*)(?:Bearer\s+)?\S+/gi, "$1[REDACTED]")
}

export function backoff(attempt: number, base = 500, cap = 30_000) {
  const ceiling = Math.min(cap, base * 2 ** Math.min(attempt, 10))
  return Math.floor(ceiling / 2 + Math.random() * (ceiling / 2))
}

export function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const abort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", abort, { once: true })
  })
}

export function createLogger(component: string, json = process.env.OPENCODE_TELEGRAM_LOG_FORMAT === "json") {
  function write(level: "INFO" | "WARN" | "ERROR", message: string, fields: Record<string, unknown> = {}) {
    const clean = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, redact(value)]))
    if (json) {
      console.log(JSON.stringify({ timestamp: new Date().toISOString(), level, component, message, ...clean }))
      return
    }
    const suffix = Object.entries(clean)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(" ")
    console.log(`${level} ${component} ${message}${suffix ? ` ${suffix}` : ""}`)
  }
  return {
    info: (message: string, fields?: Record<string, unknown>) => write("INFO", message, fields),
    warn: (message: string, fields?: Record<string, unknown>) => write("WARN", message, fields),
    error: (message: string, fields?: Record<string, unknown>) => write("ERROR", message, fields),
  }
}
export type Logger = ReturnType<typeof createLogger>
