import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { cloak, hint, turnsAway } from "./cloak.mjs"
import { sanitizeInputSchema } from "./tool-schema.mjs"
import { classifyUpstreamError } from "./upstream-error.mjs"
import { capMcpToolResultText } from "./mcp-server.mjs"
import { sweepStaleAgyArtifacts } from "./cleanup.mjs"
// index.mjs keeps these internal; load a copy that re-exports them (same
// approach as upstream test-compat.mjs).
const bridgeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-upgrade-enh-"))
const bridgeEntry = new URL("./index.mjs", import.meta.url)
let bridgeSource = fs.readFileSync(bridgeEntry, "utf8")
bridgeSource = bridgeSource.replace(/from "(\.\/[^"\n]+)"/g, (_, target) => `from ${JSON.stringify(new URL(target, bridgeEntry).href)}`)
bridgeSource = bridgeSource.replace('new URL("./package.json", import.meta.url)', JSON.stringify(new URL("./package.json", bridgeEntry).pathname))
bridgeSource += "\nexport { conversationKey, instructionsIdentity, stripVolatileSystem };\n"
fs.writeFileSync(path.join(bridgeDir, "bridge.mjs"), bridgeSource)
const { conversationKey, instructionsIdentity, stripVolatileSystem } = await import(new URL("file://" + path.join(bridgeDir, "bridge.mjs")).href)

test("S1: cloak.mjs neutralizes Hermes/Claude/Codex/RFC2119 triggers via ZWS without overwriting persona", () => {
  const sys = [
    "You are Hermes Agent, an intelligent AI assistant created by Nous Research.",
    "Built on Anthropic's Claude Agent SDK.",
    "RFC 2119 keywords: MUST, REQUIRED, SHALL.",
    "你是一位专业、聪敏而温柔的 AI 助手。",
  ].join("\n")
  assert.equal(turnsAway(sys), true)
  const cloaked = cloak(sys)
  assert.equal(turnsAway(cloaked), false)
  assert.ok(!cloaked.includes("You are an AI coding assistant"))
  assert.ok(cloaked.includes("你是一位专业、聪敏而温柔的 AI 助手。"))
  assert.equal(cloaked.replace(/\u200b/g, ""), sys)
  assert.ok(hint(sys).length > 0)
})

test("S1: sanitizeInputSchema downgrades non-RE2 pattern and adds items to bare arrays", () => {
  const cleaned = sanitizeInputSchema({
    type: "object",
    properties: {
      lookahead: { type: "string", pattern: "^(?!admin)[a-z]+$", description: "Username" },
      re2Ok: { type: "string", pattern: "^[a-z0-9_-]+$" },
      tags: { type: "array" },
    },
  })
  assert.equal(cleaned.properties.lookahead.pattern, undefined)
  assert.match(cleaned.properties.lookahead.description, /Username/)
  assert.match(cleaned.properties.lookahead.description, /pattern/i)
  assert.equal(cleaned.properties.re2Ok.pattern, "^[a-z0-9_-]+$")
  assert.ok(cleaned.properties.tags.items && typeof cleaned.properties.tags.items === "object")
})

test("S2: stripVolatileSystem + conversationKey preserve warm cache across Hermes/Claude volatile headers & reminder clocks", () => {
  const sysA = [
    "x-anthropic-billing-header: cc_version=2.1.70; cc_entrypoint=cli; cch=1234abcd;",
    "Core persona instructions.",
    "MEMORY (your personal notes) [48% — 1,056/2,200 chars]",
    "Fact 1",
    "USER PROFILE (who the user is) [80% - 1,100/1,375 chars]",
    "Fact 2",
    "Conversation started: Wednesday, November 11, 2026 (CST, UTC+08:00)",
    "Model: antigravity-bridge/gemini-4-argon",
    "Provider: magpie",
    "Platform: feishu",
  ].join("\n")

  const sysB = [
    "Core persona instructions.",
    "MEMORY (your personal notes) [53% – 1,166/2,200 chars]",
    "Fact 1",
    "USER PROFILE (who the user is) [84% — 1,158/1,375 chars]",
    "Fact 2",
    "Conversation started: Wednesday, November 11, 2026 09:55 PM",
    "Model: antigravity-bridge/gemini-4-carbon-high",
    "Provider: magpie",
    "Platform: ios",
    "Current datetime: 2026-11-11T21:55:00+08:00",
  ].join("\n")

  assert.equal(instructionsIdentity(sysA), instructionsIdentity(sysB))
  const msgA = [{ role: "user", content: "<system-reminder>\nCurrent date: 2026-11-11 20:00:00\n</system-reminder>\nAnalyze policy" }]
  const msgB = [{ role: "user", content: "<system-reminder>\nCurrent date: 2026-11-11 22:00:00\n</system-reminder>\nAnalyze policy" }]
  assert.equal(conversationKey({ system: sysA, messages: msgA }), conversationKey({ system: sysB, messages: msgB }))

  // Raw user clock outside <system-reminder> MUST stay significant
  assert.notEqual(
    conversationKey({ system: "Base", messages: [{ role: "user", content: "Current date: 2026-11-11" }] }),
    conversationKey({ system: "Base", messages: [{ role: "user", content: "Current date: 2026-11-12" }] }),
  )
})

test("S5a: capMcpToolResultText caps UTF-8 bytes <= limit cleanly on codepoint boundaries without mutating input", () => {
  const big = "头".repeat(2000) + "中".repeat(4000) + "尾".repeat(2000)
  const capped = capMcpToolResultText(big, 9500)
  assert.ok(Buffer.byteLength(capped, "utf8") <= 9500)
  assert.ok(!capped.includes("\uFFFD"), "no broken UTF-8 surrogate")
  assert.ok(capped.startsWith("头".repeat(200)))
  assert.ok(capped.endsWith("尾".repeat(200)))
  assert.match(capped, /Bridge omitted \d+ of \d+ UTF-8 bytes/)
  assert.equal(capMcpToolResultText("short text", 9500), "short text")
  assert.equal(capMcpToolResultText(big, 0), big)
})

test("S5b: cleanup.mjs protects shimDir, active workspaces, and {version:1,entries} sessions across accounts while sweeping >48h artifacts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-cleanup-test-"))
  try {
    const fakeTmp = path.join(root, "tmp")
    const stateDir = path.join(root, "state")
    const geminiDefault = path.join(root, "home", ".gemini")
    const geminiWork = path.join(root, "work", ".gemini")
    fs.mkdirSync(fakeTmp, { recursive: true })
    fs.mkdirSync(stateDir, { recursive: true })

    const shimDir = path.join(fakeTmp, "magpie-agy-bridge-shim-keep")
    const activeWs = path.join(fakeTmp, "magpie-agy-bridge-ws-active")
    const staleWs = path.join(fakeTmp, "magpie-agy-bridge-ws-stale")
    const recentWs = path.join(fakeTmp, "magpie-agy-bridge-ws-recent")
    for (const d of [shimDir, activeWs, staleWs, recentWs]) fs.mkdirSync(d, { recursive: true })

    const oldTime = new Date(Date.now() - 72 * 3600 * 1000)
    for (const d of [shimDir, activeWs, staleWs]) fs.utimesSync(d, oldTime, oldTime)

    // Write REAL { version: 1, entries: [...] } sessions.json schema
    const stateFile = path.join(stateDir, "sessions.json")
    fs.writeFileSync(stateFile, JSON.stringify({
      version: 1,
      entries: [{ key: "conv1", sessionId: "sess-disk-1", at: Date.now() }],
    }))

    for (const gdir of [geminiDefault, geminiWork]) {
      fs.mkdirSync(path.join(gdir, "antigravity-cli", "brain", "sess-disk-1"), { recursive: true })
      fs.mkdirSync(path.join(gdir, "antigravity-cli", "brain", "sess-mem-2"), { recursive: true })
      fs.mkdirSync(path.join(gdir, "antigravity-cli", "brain", "sess-stale-9"), { recursive: true })
      fs.mkdirSync(path.join(gdir, "antigravity-cli", "conversations"), { recursive: true })
      fs.writeFileSync(path.join(gdir, "antigravity-cli", "conversations", "sess-disk-1.pb"), "keep")
      fs.writeFileSync(path.join(gdir, "antigravity-cli", "conversations", "sess-stale-9.pb"), "drop")
      fs.writeFileSync(path.join(gdir, "antigravity-cli", "conversations", "conversation_summaries.db"), "keep-db")
      for (const p of [
        path.join(gdir, "antigravity-cli", "brain", "sess-disk-1"),
        path.join(gdir, "antigravity-cli", "brain", "sess-mem-2"),
        path.join(gdir, "antigravity-cli", "brain", "sess-stale-9"),
        path.join(gdir, "antigravity-cli", "conversations", "sess-disk-1.pb"),
        path.join(gdir, "antigravity-cli", "conversations", "sess-stale-9.pb"),
        path.join(gdir, "antigravity-cli", "conversations", "conversation_summaries.db"),
      ]) {
        fs.utimesSync(p, oldTime, oldTime)
      }
    }

    const stats = sweepStaleAgyArtifacts({
      stateFile,
      shimDir,
      activeWorkspaces: [activeWs],
      activeSessionIds: ["sess-mem-2"],
      geminiDirs: [geminiDefault, geminiWork],
      tmpDir: fakeTmp,
      maxAgeMs: 48 * 3600 * 1000,
    })

    assert.equal(fs.existsSync(shimDir), true, "shimDir protected even >48h")
    assert.equal(fs.existsSync(activeWs), true, "activeWs protected even >48h")
    assert.equal(fs.existsSync(recentWs), true, "recentWs protected (<48h)")
    assert.equal(fs.existsSync(staleWs), false, "staleWs swept")
    for (const gdir of [geminiDefault, geminiWork]) {
      assert.equal(fs.existsSync(path.join(gdir, "antigravity-cli", "brain", "sess-disk-1")), true)
      assert.equal(fs.existsSync(path.join(gdir, "antigravity-cli", "brain", "sess-mem-2")), true)
      assert.equal(fs.existsSync(path.join(gdir, "antigravity-cli", "brain", "sess-stale-9")), false)
      assert.equal(fs.existsSync(path.join(gdir, "antigravity-cli", "conversations", "sess-disk-1.pb")), true)
      assert.equal(fs.existsSync(path.join(gdir, "antigravity-cli", "conversations", "sess-stale-9.pb")), false)
      assert.equal(fs.existsSync(path.join(gdir, "antigravity-cli", "conversations", "conversation_summaries.db")), true)
    }
    assert.ok(stats.removedTmp >= 1 && stats.removedBrains >= 2 && stats.removedPbs >= 2)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test("S5c: classifyUpstreamError detects UNAUTHENTICATED / HTTP 401", () => {
  const c = classifyUpstreamError("generating and executing: UNAUTHENTICATED (code 401): Request had invalid authentication credentials.")
  assert.equal(c.category, "unauthenticated")
  assert.equal(c.reasonCode, "AGY_ERROR_UNAUTHENTICATED")
  assert.equal(c.retryable, false)
})

test.after(() => {
  setTimeout(() => process.exit(process.exitCode || 0), 30)
})
