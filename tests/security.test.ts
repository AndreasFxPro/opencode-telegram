import { describe, expect, test } from "bun:test"
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
  })

  test("constant-time hash comparison validates local secrets", () => {
    expect(safeEqualHash("secret", sha256("secret"))).toBeTrue()
    expect(safeEqualHash("other", sha256("secret"))).toBeFalse()
  })

  test("clips long callback-visible content", () => {
    expect(clip("x".repeat(100), 20)).toHaveLength(20)
    expect(escapeHtml('"<&')).toBe("&quot;&lt;&amp;")
  })
})
