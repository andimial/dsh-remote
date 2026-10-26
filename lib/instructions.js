// dsh-remote — remote instruction-file index (issue #68).
//
// The core instruction loader (@deepseek-ai/dsh-agent-instructions) discovers
// AGENTS.md through the LOCAL filesystem only: from two user-global roots plus
// the projectRoot→cwd ancestor chain. A remote session's cwd is the local
// MIRROR of the remote workspace, and that mirror stays empty until rw_sync —
// so a 20 KB AGENTS.md that governs the remote repo never enters the model's
// context, while the same file is auto-injected in a local session. File
// ACCESS was never the problem (rw_read_file reads it fine); what is missing
// is the model knowing it should.
//
// This module closes the gap on the plugin side, along the two cheapest axes
// the issue lists (the third — a remote ctx.fs provider — belongs to core):
//
//   1. INDEX in the system prompt: a shallow scan of the remote workspace
//      (root + at most two directory levels down, AGENTS.md / CLAUDE.md only)
//      is rendered into the dsh-remote prompt section as a path list with
//      headings, telling every new session the files exist and to read them
//      with rw_read_file before editing that tree. This is an INDEX, not a
//      second injection pipeline — the full text stays out of the prompt and
//      out of any parallel baseline, exactly as the issue demands.
//   2. MIRROR the found files into the local mirror at their relative paths
//      (three-way safe — a local edit is never clobbered, see below). A
//      root-level AGENTS.md then sits exactly where the CORE loader looks in
//      a local session, so the normal baseline/incremental machinery picks it
//      up unchanged; no plugin-side injection logic runs in parallel with it.
//
// Deliberate non-goals (the issue's "请不要做"):
//   - NO unbounded recursion of the remote root (multi-project roots like
//     /root would scan forever): the walk is depth- and count-capped.
//   - NO full-text injection from the plugin.

import { existsSync, mkdirSync, statSync, writeFileSync, utimesSync } from 'node:fs'
import path from 'node:path'
import { joinRemotePath, relPathUnder } from './paths.js'
import { loadSyncState, saveSyncState } from './sync.js'

/** File names treated as agent instruction files (compared case-insensitively;
 *  the mirrored copy keeps the remote's exact casing). */
export const INSTRUCTION_NAMES = ['agents.md', 'claude.md']

/** An instruction file bigger than this is indexed (path + note) but not read. */
export const INSTRUCTION_MAX_BYTES = 256 * 1024

/** Caps that keep the shallow scan shallow. */
export const INSTRUCTION_MAX_FILES = 20
export const INSTRUCTION_MAX_DIRS = 60
export const INSTRUCTION_MAX_DEPTH = 2 // 0 = workspace root, 1 = sub/, 2 = sub/sub/

/** Directories that never contain a project's governing instructions. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out',
  '.next', '.nuxt', '.cache', '.turbo', 'coverage', 'target', 'vendor',
])

export const isInstructionName = (name) => INSTRUCTION_NAMES.includes(String(name || '').toLowerCase())

/** Pull the first Markdown headings out of an instruction file, for the index. */
export function extractHeadings(text, max = 8) {
  const out = []
  for (const line of String(text || '').split('\n')) {
    const m = /^#{1,3}\s+(.+?)\s*#*\s*$/.exec(line)
    if (!m) continue
    out.push(m[1].slice(0, 60))
    if (out.length >= max) break
  }
  return out
}

/**
 * Shallow-scan a remote workspace for instruction files: the root directory
 * plus up to INSTRUCTION_MAX_DEPTH levels of subdirectories, matching
 * AGENTS.md / CLAUDE.md basenames. Bounded by INSTRUCTION_MAX_DIRS readdirs
 * and INSTRUCTION_MAX_FILES files; anything past the caps is silently
 * skipped (the index is a hint, not an inventory).
 *
 * @param {object} sftp - the promisified sftp surface (readdir/stat/readFile).
 * @param {string} remoteRoot - absolute remote workspace path (normalized).
 * @returns {Promise<Array<{rel: string, remote: string, size: number, mtime: number, content: Buffer|null, headings: string[]}>>}
 *   `content`/`headings` are null/empty for files over INSTRUCTION_MAX_BYTES.
 */
export async function scanInstructionFiles(sftp, remoteRoot, opts = {}) {
  const maxDepth = Math.max(0, Math.min(Number(opts.maxDepth ?? INSTRUCTION_MAX_DEPTH) || 0, 4))
  const maxDirs = Math.max(1, Number(opts.maxDirs ?? INSTRUCTION_MAX_DIRS) || INSTRUCTION_MAX_DIRS)
  const maxFiles = Math.max(1, Number(opts.maxFiles ?? INSTRUCTION_MAX_FILES) || INSTRUCTION_MAX_FILES)
  const files = []
  // Breadth-first so a wide root cannot push the walk deep before the shallow
  // (more commonly governing) files are seen.
  const queue = [{ dir: remoteRoot, depth: 0 }]
  let dirsScanned = 0
  while (queue.length && files.length < maxFiles && dirsScanned < maxDirs) {
    const { dir, depth } = queue.shift()
    dirsScanned++
    let entries = []
    try { entries = (await sftp.readdir(dir)) || [] } catch { continue }
    for (const e of entries) {
      const name = String(e.filename || '')
      if (!name || name === '.' || name === '..' || name.startsWith('.')) {
        // Hidden entries are skipped wholesale EXCEPT the names themselves
        // never start with a dot, so nothing is lost.
        continue
      }
      const isDir = !!(e.attrs && typeof e.attrs.isDirectory === 'function' && e.attrs.isDirectory())
      const isLink = !!(e.attrs && typeof e.attrs.isSymbolicLink === 'function' && e.attrs.isSymbolicLink())
      if (isDir) {
        // Symlinked dirs are not followed: the walk stays inside the workspace
        // tree and cannot loop through a link back to an ancestor.
        if (isLink) continue
        if (depth < maxDepth && !SKIP_DIRS.has(name.toLowerCase()) && queue.length + dirsScanned < maxDirs) {
          queue.push({ dir: joinRemotePath(dir, name), depth: depth + 1 })
        }
        continue
      }
      if (!isInstructionName(name)) continue
      const remote = joinRemotePath(dir, name)
      const rel = relPathUnder(remoteRoot, remote) || name
      let st = null
      try { st = await sftp.stat(remote) } catch { continue }
      const size = st && typeof st.size === 'number' ? st.size : 0
      const mtime = st && typeof st.mtime === 'number' ? st.mtime : 0
      let content = null
      let headings = []
      if (size <= INSTRUCTION_MAX_BYTES) {
        try {
          content = await sftp.readFile(remote)
          headings = extractHeadings(content.toString('utf8'))
        } catch { content = null }
      }
      files.push({ rel, remote, size, mtime, content, headings })
      if (files.length >= maxFiles) break
    }
  }
  return files
}

// The three-way keys mirror lib/sync.js exactly (size + whole-second mtime):
// a file this module places into the mirror must be indistinguishable from
// one rw_sync pulled, or the next sync would report a phantom conflict.
const keyOf = (size, mtime) => `${size}:${Math.floor(mtime || 0)}`
const localKeyOf = (st) => (st ? keyOf(st.size, st.mtimeMs / 1000) : null)

/**
 * Write scanned instruction files into the local mirror at their workspace-
 * relative paths, three-way safe against `.dsh-remote-sync-state.json`:
 *
 *   - local missing                        → write (+ align mtime, record state)
 *   - local identical to remote            → keep (record state if absent)
 *   - remote changed, local untouched (L==S) → write (a plain pull)
 *   - local edited (L!=S), remote unchanged → SKIP — a local edit is never
 *     clobbered; rw_sync surfaces it as a conflict like any other file
 *   - both changed / unknown local content → SKIP (rw_sync arbitrates)
 *
 * @returns {{written: string[], present: Set<string>}} rel paths written now,
 *   and every rel that exists locally afterwards (for the index's "mirrored"
 *   badge).
 */
export function syncInstructionsToMirror(files, mirrorDir) {
  const written = []
  const present = new Set()
  if (!mirrorDir || !Array.isArray(files) || !files.length) return { written, present }
  const state = loadSyncState(mirrorDir)
  let stateDirty = false
  for (const f of files) {
    if (!f || !f.rel || !f.content) continue
    const lp = path.join(mirrorDir, ...String(f.rel).split('/'))
    const rk = keyOf(f.size, f.mtime)
    const sk = state[f.rel] ? keyOf(state[f.rel].size, state[f.rel].mtime) : null
    let lk = null
    try { lk = existsSync(lp) ? localKeyOf(statSync(lp)) : null } catch { lk = null }
    if (lk === rk) {
      // Identical bytes in place already (same size AND mtime second) — only
      // make sure the snapshot knows about it.
      present.add(f.rel)
      if (!sk) { state[f.rel] = { size: f.size, mtime: f.mtime }; stateDirty = true }
      continue
    }
    const canWrite = lk === null || (sk !== null && rk !== sk && lk === sk)
    if (!canWrite) continue
    try {
      mkdirSync(path.dirname(lp), { recursive: true })
      writeFileSync(lp, f.content)
      // Align the local mtime to the remote's so the next rw_sync sees
      // L==R==S and skips the file instead of flagging a local modification.
      try { utimesSync(lp, new Date(f.mtime * 1000), new Date(f.mtime * 1000)) } catch { /* cosmetic */ }
      state[f.rel] = { size: f.size, mtime: f.mtime }
      stateDirty = true
      written.push(f.rel)
      present.add(f.rel)
    } catch { /* a mirror write failure must not break the index */ }
  }
  if (stateDirty) {
    try { saveSyncState(mirrorDir, state) } catch { /* best effort */ }
  }
  return { written, present }
}

/**
 * Render the prompt-section index of remote instruction files. Paths are
 * shown through `display` (the platform-aware display formatter), headings
 * give the model a content hint without injecting the full text.
 */
export function formatInstructionIndex(files, display = (p) => p) {
  const lines = files.slice(0, 10).map((f) => {
    const h = f.headings && f.headings.length ? ` (headings: ${f.headings.slice(0, 6).join(' / ')})` : ''
    const over = f.size > INSTRUCTION_MAX_BYTES ? ` (${Math.round(f.size / 1024)} KB)` : ''
    const mirrored = f.mirrored ? '; synced into the local mirror' : ''
    return `- ${display(f.remote)}${h}${over}${mirrored}`
  })
  return (
    'Remote instruction files found in this workspace (they govern how to work in their directories; '
    + 'root-level copies were synced into the local mirror, but nested ones are NOT auto-injected — '
    + 'read them with rw_read_file before editing that tree):\n'
    + lines.join('\n')
  )
}

/**
 * Per-process index of remote instruction scans, keyed by mirror directory.
 * Deduplicates in-flight scans, negative-caches failures for a minute (an
 * offline machine must not turn every prompt assembly into a connect
 * attempt), and never throws — the index is strictly best-effort.
 */
export function createInstructionIndex() {
  const cache = new Map() // resolvedMirrorDir → { scannedAt, files } | { failedAt }
  const inflight = new Map() // resolvedMirrorDir → Promise
  const RETRY_AFTER_MS = 60 * 1000

  const keyOfDir = (mirrorDir) => {
    try { return path.resolve(String(mirrorDir)) } catch { return String(mirrorDir || '') }
  }

  /**
   * Scan (or return the cached scan of) one mirror's remote workspace.
   * @param {{pool: {sftp: Function}, ws: string, mirrorDir: string, force?: boolean}} arg
   * @returns {Promise<{scannedAt: number, files: Array}|null>}
   */
  const refresh = ({ pool, ws, mirrorDir, force = false }) => {
    if (!pool || typeof pool.sftp !== 'function' || !ws || !mirrorDir) return Promise.resolve(null)
    const key = keyOfDir(mirrorDir)
    const cur = cache.get(key)
    if (!force && cur && cur.files) return Promise.resolve(cur)
    if (!force && cur && cur.failedAt && Date.now() - cur.failedAt < RETRY_AFTER_MS) return Promise.resolve(null)
    if (inflight.has(key)) return inflight.get(key)
    const job = (async () => {
      try {
        const sftp = await pool.sftp()
        const files = await scanInstructionFiles(sftp, ws)
        const synced = syncInstructionsToMirror(files, mirrorDir)
        const entry = {
          scannedAt: Date.now(),
          files: files.map((f) => ({
            rel: f.rel,
            remote: f.remote,
            size: f.size,
            headings: f.headings,
            mirrored: synced.present.has(f.rel),
          })),
        }
        cache.set(key, entry)
        return entry
      } catch {
        // Negative-cache: the machine may simply be offline; retry at most
        // once a minute, not once per prompt assembly.
        cache.set(key, { failedAt: Date.now() })
        return null
      } finally {
        inflight.delete(key)
      }
    })()
    inflight.set(key, job)
    return job
  }

  /** The cached index for a mirror, or null when unknown/failed. */
  const get = (mirrorDir) => {
    const e = cache.get(keyOfDir(mirrorDir))
    return e && e.files ? e : null
  }

  /** Fire-and-forget refresh for prompt-assembly time: starts a scan only
   *  when nothing is known about the mirror yet (recent failures included). */
  const note = ({ pool, ws, mirrorDir }) => {
    if (cache.has(keyOfDir(mirrorDir))) return
    refresh({ pool, ws, mirrorDir }).catch(() => { /* guarded inside */ })
  }

  return { refresh, get, note, _cache: cache }
}
