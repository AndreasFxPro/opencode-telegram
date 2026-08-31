import { describe, expect, test } from "bun:test"
import { dashboardAsset } from "../src/dashboard.ts"
import { renderPermission } from "../src/telegram.ts"
import { clip, escapeHtml, redact, safeEqualHash, sha256 } from "../src/util.ts"
import { permission } from "./helpers.ts"

describe("security boundaries", () => {
  test("escapes model-controlled Telegram HTML", () => {
    const text = renderPermission({ ...permission(), action: "<b>fake approval</b>", patterns: ["x & y"] })
    expect(text).toContain("&lt;b&gt;fake approval&lt;/b&gt;")
    expect(text).toContain("x &amp; y")
  })

  test("redacts common credentials from logs", () => {
    expect(redact("authorization: Bearer secret-value")).not.toContain("secret-value")
    expect(redact("123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabc")).toContain("REDACTED")
    expect(redact("oct_dash_abcdefghijklmnopqrstuvwxyz")).toBe("[REDACTED_SECRET]")
    expect(redact("local_abcdefghijklmnopqrstuvwxyz")).toBe("[REDACTED_SECRET]")
  })

  test("constant-time hash comparison validates local secrets", () => {
    expect(safeEqualHash("secret", sha256("secret"))).toBeTrue()
    expect(safeEqualHash("other", sha256("secret"))).toBeFalse()
  })

  test("clips long callback-visible content", () => {
    expect(clip("x".repeat(100), 20)).toHaveLength(20)
    expect(escapeHtml('"<&')).toBe("&quot;&lt;&amp;")
  })

  test("dashboard shell keeps credentials out of storage and uses a strict CSP", async () => {
    const page = dashboardAsset("/dashboard")
    const script = dashboardAsset("/dashboard/app.js")
    if (!page || !script) throw new Error("Dashboard assets missing")
    expect(page.headers.get("content-security-policy")).not.toContain("unsafe-inline")
    expect(page.headers.get("x-frame-options")).toBe("DENY")
    const source = await script.text()
    expect(source).not.toContain("innerHTML")
    expect(source).not.toContain("localStorage")
    expect(source).not.toContain("sessionStorage")
    expect(source).toContain("textContent")
    expect(source).toContain("s.title||s.sessionId")
    expect(source).toContain("Dashboard token expired or was rotated")
  })
})
