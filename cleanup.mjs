import fs from "node:fs"
import os from "node:os"
import path from "node:path"

function latestTreeMtimeMs(dirPath) {
  let latest = 0
  try {
    latest = fs.statSync(dirPath).mtimeMs
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      try {
        const childStat = fs.lstatSync(path.join(dirPath, entry.name))
        if (childStat.mtimeMs > latest) latest = childStat.mtimeMs
      } catch {}
    }
  } catch {}
  return latest
}

function readProtectedDiskSessionIds(stateFile) {
  const ids = new Set()
  if (!stateFile) return ids
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"))
    const entries = Array.isArray(parsed?.entries)
      ? parsed.entries
      : (parsed && typeof parsed === "object" ? Object.values(parsed) : [])
    for (const entry of entries) {
      if (entry && typeof entry.sessionId === "string" && entry.sessionId) {
        ids.add(entry.sessionId)
      }
    }
  } catch {}
  return ids
}

export function sweepStaleAgyArtifacts({
  stateFile = null,
  shimDir = null,
  activeWorkspaces = [],
  activeSessionIds = [],
  geminiDirs = [],
  tmpDir = os.tmpdir(),
  maxAgeMs = 48 * 3600 * 1000,
  now = Date.now(),
} = {}) {
  const stats = { removedTmp: 0, removedBrains: 0, removedPbs: 0 }
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) return stats
  const cutoff = now - maxAgeMs

  const protectedTmp = new Set(
    [shimDir, ...activeWorkspaces]
      .filter((p) => typeof p === "string" && p.length > 0)
      .map((p) => path.resolve(p)),
  )

  try {
    for (const entry of fs.readdirSync(tmpDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("magpie-agy-bridge-")) continue
      const full = path.resolve(tmpDir, entry.name)
      if (protectedTmp.has(full)) continue
      const mtime = latestTreeMtimeMs(full)
      if (mtime > 0 && mtime < cutoff) {
        try {
          fs.rmSync(full, { recursive: true, force: true })
          stats.removedTmp++
        } catch {}
      }
    }
  } catch {}

  const protectedSessions = readProtectedDiskSessionIds(stateFile)
  for (const id of activeSessionIds) {
    if (typeof id === "string" && id) protectedSessions.add(id)
  }

  const uniqueGeminiDirs = [...new Set(geminiDirs.filter(Boolean).map((d) => path.resolve(d)))]
  for (const gdir of uniqueGeminiDirs) {
    const brainRoot = path.join(gdir, "antigravity-cli", "brain")
    try {
      for (const entry of fs.readdirSync(brainRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        if (protectedSessions.has(entry.name)) continue
        const full = path.join(brainRoot, entry.name)
        const mtime = latestTreeMtimeMs(full)
        if (mtime > 0 && mtime < cutoff) {
          try {
            fs.rmSync(full, { recursive: true, force: true })
            stats.removedBrains++
          } catch {}
        }
      }
    } catch {}

    const convRoot = path.join(gdir, "antigravity-cli", "conversations")
    try {
      for (const entry of fs.readdirSync(convRoot, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".pb")) continue
        const sessionId = entry.name.slice(0, -3)
        if (!sessionId || protectedSessions.has(sessionId)) continue
        const full = path.join(convRoot, entry.name)
        try {
          const st = fs.statSync(full)
          if (st.mtimeMs < cutoff) {
            fs.rmSync(full, { force: true })
            stats.removedPbs++
          }
        } catch {}
      }
    } catch {}
  }

  return stats
}

export function startCleanupScheduler(getSnapshot, intervalMs = 6 * 3600 * 1000) {
  const hoursRaw = process.env.AGY_BRIDGE_CLEANUP_MAX_AGE_HOURS
  const hours = hoursRaw === undefined || hoursRaw === "" ? 48 : Number(hoursRaw)
  if (!Number.isFinite(hours) || hours <= 0) return null
  const maxAgeMs = hours * 3600 * 1000
  const run = () => {
    try {
      const snap = getSnapshot()
      sweepStaleAgyArtifacts({ ...snap, maxAgeMs })
    } catch {}
  }
  const initial = setTimeout(run, 30_000)
  initial.unref?.()
  const periodic = setInterval(run, intervalMs)
  periodic.unref?.()
  return { initial, periodic }
}
