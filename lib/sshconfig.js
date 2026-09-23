// dsh-remote — ~/.ssh/config reading and OpenSSH alias resolution (issue #38).
//
// ## Why this module exists
//
// A saved machine can be an ALIAS from the user's ssh config: the registry keeps
// `{ host: '<alias>', useSshConfig: true }` and NOTHING else — no HostName, no
// user, no port, no key path. Every connect resolves that alias against
// `~/.ssh/config` as it is RIGHT NOW, which is what VSCode Remote-SSH does with
// the same file: editing the config (a new jump host, a rotated IdentityFile, a
// different port) is picked up without re-importing anything into the plugin.
//
// ## What is read
//
// Host / HostName / User / Port / IdentityFile / ProxyJump / ProxyCommand.
// `IdentityFile` is imported as a PATH reference only — the plugin never opens
// key material (v0.5.5 policy).
//
// ## OpenSSH semantics implemented
//
//   • `Host a b` / `Host *.example.com` / `Host !x *.y` pattern lists, evaluated
//     with `*` and `?` wildcards, case-insensitively (see hostBlockMatches).
//   • first-obtained-value-wins ACROSS all matching blocks, not first-block-wins:
//     ssh_config(5) — "for each parameter, the first obtained value will be used".
//   • `Include` directives, globbed, expanded in place, relative to ~/.ssh
//     (falling back to the including file's directory), depth- and cycle-limited.
//   • backslash line continuations.
//
// The module is pure (I/O is injectable), so it is unit-testable without a real
// home directory — see test/sshconfig.test.js.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** Default location of the user's ssh config. */
export const sshConfigPath = () => path.join(homedir(), '.ssh', 'config')

/** Directory `Include` paths are resolved against (ssh_config(5)). */
export const sshConfigDir = () => path.join(homedir(), '.ssh')

/** Parameters the resolver cares about, lowercase (as parsed). */
const KNOWN_PARAMS = new Set([
  'hostname', 'user', 'port', 'identityfile', 'proxyjump', 'proxycommand', 'identitiesonly',
])

/** Read the user's ~/.ssh/config text, Includes expanded ('' when absent). */
export function readSshConfigText(filePath = sshConfigPath()) {
  return loadSshConfigText(filePath)
}

/**
 * Read an ssh config file and expand its `Include` directives in place.
 *
 * Relative includes resolve against `~/.ssh` first (ssh_config(5)) and then
 * against the including file's directory, because real-world configs use both.
 * A missing or unreadable include is skipped: one broken line must not hide the
 * rest of the config.
 *
 * @param {string} [filePath] - the config file (default ~/.ssh/config).
 * @param {object} [io] - injectable filesystem hooks (tests).
 * @param {(p: string) => string} [io.readFile]
 * @param {(p: string) => boolean} [io.exists]
 * @param {(p: string) => string[]} [io.listDir]
 * @param {number} [io.maxDepth]
 * @returns {string} the expanded config text ('' when nothing could be read).
 */
export function loadSshConfigText(filePath = sshConfigPath(), io = {}) {
  const readFile = io.readFile || ((p) => readFileSync(p, 'utf8'))
  const listDir = io.listDir || ((p) => readdirSync(p))
  return expandFile(filePath, { readFile, listDir, maxDepth: io.maxDepth ?? 3, depth: 0, seen: new Set() })
}

function expandFile(file, state) {
  let text
  try {
    text = state.readFile(file)
  } catch {
    return ''
  }
  if (typeof text !== 'string') return ''
  if (state.depth >= state.maxDepth) return text
  const out = []
  for (const line of joinContinuations(text)) {
    const patterns = matchInclude(line)
    if (!patterns) { out.push(line); continue }
    for (const pattern of patterns) {
      for (const included of expandIncludePath(pattern, path.dirname(file), state.listDir)) {
        const key = path.resolve(included)
        if (state.seen.has(key)) continue
        state.seen.add(key)
        const child = expandFile(included, { ...state, depth: state.depth + 1 })
        if (child.trim()) out.push(child)
      }
    }
  }
  return out.join('\n')
}

/** The value tokens of `Include <pattern> [pattern...]`, or null. */
function matchInclude(line) {
  const m = String(line).match(/^\s*include\s+(.+?)\s*$/i)
  if (!m) return null
  return splitValue(m[1])
}

/** Expand one include pattern.
 *
 *  ssh_config(5): a relative path is relative to `~/.ssh`. The including file's
 *  own directory is tried only when that yields nothing — which is what makes
 *  the plugin able to read a config the user pointed it at elsewhere, without
 *  double-resolving (and double-reading) the normal `~/.ssh` case.
 */
function expandIncludePath(pattern, callerDir, listDir) {
  const raw = stripQuotes(pattern)
  if (!raw) return []
  if (path.isAbsolute(raw)) return globFiles(raw, listDir).sort()
  if (raw.startsWith('~')) return globFiles(path.join(homedir(), raw.replace(/^~[\\/]?/, '')), listDir).sort()
  const primary = globFiles(path.join(sshConfigDir(), raw), listDir)
  if (primary.length) return primary.sort()
  if (callerDir && path.resolve(callerDir) !== path.resolve(sshConfigDir())) {
    return globFiles(path.join(callerDir, raw), listDir).sort()
  }
  return []
}

/** Files matching a path whose basename may contain `*` / `?` (one level). */
function globFiles(target, listDir) {
  const base = path.basename(target)
  if (!/[*?]/.test(base)) return [target]
  const dir = path.dirname(target)
  let entries
  try {
    entries = listDir(dir)
  } catch {
    return []
  }
  const re = globRegex(base)
  return entries
    .filter((name) => re.test(name))
    .map((name) => path.join(dir, name))
}

/** Join lines ending in a backslash (ssh config line continuation). */
function joinContinuations(text) {
  const lines = []
  let pending = ''
  for (const raw of String(text).split('\n')) {
    const line = pending + raw
    if (/\\\s*$/.test(line) && !/\\\\\s*$/.test(line)) {
      pending = line.replace(/\\\s*$/, ' ') + ' '
      continue
    }
    pending = ''
    lines.push(line)
  }
  if (pending) lines.push(pending)
  return lines
}

/** Config lines with continuations joined — the form every parser consumes. */
const configLines = (text) => joinContinuations(text)

/** Split a parameter value into whitespace-separated tokens, honoring quotes. */
export function splitValue(value) {
  return (String(value || '').match(/"[^"]*"|'[^']*'|\S+/g) || [])
    .map(stripQuotes)
    .filter((token) => token !== '')
}

const stripQuotes = (s) => String(s || '').replace(/^"(.*)"$/s, '$1').replace(/^'(.*)'$/s, '$1')

/**
 * Parse OpenSSH config text into Host BLOCKS, preserving pattern lists.
 * @param {string} text
 * @returns {Array<{patterns: string[], values: Record<string, string|number>, line: number}>}
 */
export function parseHostBlocks(text) {
  const blocks = []
  let current = null
  const lines = configLines(text)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^(\S+)\s+(.*)$/)
    if (!m) continue
    const key = m[1].toLowerCase()
    const value = m[2].trim()
    if (key === 'host') {
      current = { patterns: splitValue(value), values: {}, line: i + 1 }
      blocks.push(current)
      continue
    }
    if (!current || !KNOWN_PARAMS.has(key)) continue
    // First value wins inside a block too (a repeated parameter is ignored).
    if (Object.prototype.hasOwnProperty.call(current.values, key)) continue
    current.values[key] = key === 'port' ? (Number(value) || value) : stripQuotes(value)
  }
  return blocks
}

/**
 * Legacy block list: one entry per `Host` line, flattened to the fields the
 * import UI shows. Kept stable for the existing importer + tests.
 * @returns {Array<{host: string, hostName: string, user: string, port: number, identityFile: string, proxyJump: string}>}
 */
export function parseSshConfig(text) {
  const entries = []
  let cur = null
  for (const raw of configLines(text)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^(\S+)\s+(.*)$/)
    if (!m) continue
    const key = m[1].toLowerCase()
    const val = m[2].trim()
    if (key === 'host') {
      cur = { host: stripQuotes(val), hostName: '', user: '', port: 22, identityFile: '', proxyJump: '' }
      entries.push(cur)
      continue
    }
    if (!cur) continue
    if (key === 'hostname' && !cur.hostName) cur.hostName = stripQuotes(val)
    else if (key === 'user' && !cur.user) cur.user = stripQuotes(val)
    else if (key === 'port' && cur.port === 22) cur.port = Number(val) || 22
    else if (key === 'identityfile' && !cur.identityFile) cur.identityFile = stripQuotes(val)
    else if (key === 'proxyjump' && !cur.proxyJump) cur.proxyJump = stripQuotes(val)
  }
  return entries
}

/** Entries a user can actually import: concrete aliases (skip wildcards). */
export function importableEntries(text) {
  return parseSshConfig(text).filter((e) => {
    if (!e.host || e.host.includes('*') || e.host.includes('!') || e.host.includes(',')) return false
    return e.hostName || e.user || e.port !== 22 || e.identityFile || e.proxyJump
  })
}

/**
 * Every concrete (non-wildcard) alias the config defines, with the effective
 * values after OpenSSH first-wins resolution — the list the import UI offers.
 * @param {string} text
 * @returns {Array<{alias: string, hostName: string, user: string, port: number, identityFile: string, proxyJump: string, proxyCommand: string}>}
 */
export function listAliases(text) {
  const seen = new Set()
  const out = []
  for (const block of parseHostBlocks(text)) {
    for (const pattern of block.patterns) {
      if (!pattern || /[*?!]/.test(pattern) || seen.has(pattern)) continue
      seen.add(pattern)
      out.push(resolveSshHost(pattern, text))
    }
  }
  return out.sort((a, b) => compareText(a.alias, b.alias))
}

/** Glob match for ssh host patterns (`*`, `?`), case-insensitive. */
export function globMatch(pattern, value) {
  return globRegex(pattern).test(String(value || ''))
}

function globRegex(pattern) {
  let re = ''
  for (const ch of String(pattern || '')) {
    if (ch === '*') re += '.*'
    else if (ch === '?') re += '.'
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`, 'i')
}

/**
 * Whether a `Host` pattern list applies to a name: any positive pattern matches
 * AND no negated (`!`) pattern does.
 * @param {string[]|string} patterns
 * @param {string} name
 */
export function hostBlockMatches(patterns, name) {
  const list = Array.isArray(patterns) ? patterns : splitValue(patterns)
  const negative = list.filter((p) => p.startsWith('!')).map((p) => p.slice(1))
  const positive = list.filter((p) => !p.startsWith('!'))
  if (negative.some((p) => globMatch(p, name))) return false
  return positive.some((p) => globMatch(p, name))
}

/**
 * Effective configuration for one alias, with OpenSSH first-wins semantics.
 *
 * `hostName` falls back to the alias itself (ssh's own behaviour), so a block
 * that only sets `User`/`IdentityFile` still yields a connectable host.
 *
 * @param {string} alias
 * @param {string} text - FULL config text (Include-expanded).
 * @returns {{alias: string, matched: boolean, hostName: string, user: string, port: number, identityFile: string, proxyJump: string, proxyCommand: string, identitiesOnly: string}}
 */
export function resolveSshHost(alias, text) {
  const name = String(alias || '').trim()
  const out = {
    alias: name,
    matched: false,
    hostName: '',
    user: '',
    port: 0,
    identityFile: '',
    proxyJump: '',
    proxyCommand: '',
    identitiesOnly: '',
  }
  if (!name) return out
  for (const block of parseHostBlocks(text)) {
    if (!hostBlockMatches(block.patterns, name)) continue
    out.matched = true
    // first obtained value wins, ACROSS blocks in file order
    for (const [key, value] of Object.entries(block.values)) {
      if (key === 'hostname') { if (!out.hostName) out.hostName = String(value) }
      else if (key === 'user') { if (!out.user) out.user = String(value) }
      else if (key === 'port') { if (!out.port) out.port = Number(value) || 0 }
      else if (key === 'identityfile') { if (!out.identityFile) out.identityFile = String(value) }
      else if (key === 'proxyjump') { if (!out.proxyJump) out.proxyJump = String(value) }
      else if (key === 'proxycommand') { if (!out.proxyCommand) out.proxyCommand = String(value) }
      else if (key === 'identitiesonly') { if (!out.identitiesOnly) out.identitiesOnly = String(value) }
    }
  }
  if (!out.hostName) out.hostName = name
  return out
}

/**
 * Resolve an alias from a config FILE (Include-expanded) or from given text.
 * @param {string} alias
 * @param {{file?: string, text?: string, io?: object}} [opts]
 */
export function resolveSshAlias(alias, opts = {}) {
  const text = opts.text !== undefined ? String(opts.text) : loadSshConfigText(opts.file || sshConfigPath(), opts.io || {})
  return resolveSshHost(alias, text)
}

/** Expand a leading `~` in an ssh config path (IdentityFile). */
export function expandHome(p) {
  const s = String(p || '')
  if (!s.startsWith('~')) return s
  if (s === '~') return homedir()
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(homedir(), s.slice(2))
  return s
}

/**
 * Split a ProxyJump value into hops: `[user@]host[:port]`, comma-separated, and
 * `none` meaning "no jump".
 * @param {string} value
 * @returns {Array<{user: string, host: string, port: number}>}
 */
export function parseProxyJump(value) {
  const raw = String(value || '').trim()
  if (!raw || /^none$/i.test(raw)) return []
  return raw.split(',').map((hop) => hop.trim()).filter(Boolean).map((hop) => {
    const m = hop.match(/^(?:([^@]+)@)?([^:[\] ]+)(?::(\d+))?$/)
    if (!m) return { user: '', host: hop, port: 0 }
    return { user: m[1] || '', host: m[2], port: Number(m[3]) || 0 }
  })
}

/**
 * Connect target for an ssh-config alias: the shape the plugin's pool expects.
 *
 * `ProxyJump` maps onto the plugin's single jump host. A multi-hop chain cannot
 * be represented by one `proxy`, so the FIRST hop is used and `warnings` says so
 * — silently connecting through the wrong path would be worse. `ProxyCommand`
 * (an arbitrary local command) is reported but never executed.
 *
 * @param {string} alias
 * @param {object} [opts]
 * @param {string} [opts.text] - config text (else the real file is read).
 * @param {string} [opts.file]
 * @param {object} [opts.io]
 * @returns {{alias: string, matched: boolean, host: string, port: number, username: string, privateKeyPath: string, proxy: object|undefined, proxyJump: string, warnings: string[]}}
 */
export function sshAliasTarget(alias, opts = {}) {
  const text = opts.text !== undefined ? String(opts.text) : loadSshConfigText(opts.file || sshConfigPath(), opts.io || {})
  const resolved = resolveSshHost(alias, text)
  const warnings = []
  let proxy
  const hops = parseProxyJump(resolved.proxyJump)
  if (hops.length > 1) {
    warnings.push(`ProxyJump has ${hops.length} hops; dsh-remote supports one jump host — using the first (${hops[0].host}).`)
  }
  if (hops.length) {
    const hop = hops[0]
    const hopResolved = resolveSshHost(hop.host, text)
    proxy = {
      host: hopResolved.hostName || hop.host,
      port: hop.port || hopResolved.port || 22,
      username: hop.user || hopResolved.user || '',
      privateKeyPath: hopResolved.identityFile ? expandHome(hopResolved.identityFile) : '',
      passphrase: '',
      password: '',
    }
  } else if (resolved.proxyCommand) {
    warnings.push('ProxyCommand is not supported by dsh-remote (no jump host was applied).')
  }
  return {
    alias,
    matched: resolved.matched,
    host: resolved.hostName || alias,
    port: resolved.port || 22,
    username: resolved.user || '',
    privateKeyPath: resolved.identityFile ? expandHome(resolved.identityFile) : '',
    proxy,
    proxyJump: resolved.proxyJump,
    warnings,
  }
}

/**
 * Effective connect identity for a saved machine.
 *
 * A machine in ALIAS mode (`useSshConfig: true`, `host` = the alias) inherits
 * everything from ~/.ssh/config; a field the user filled in explicitly still
 * wins. "Explicitly" cannot be distinguished from "form default" for the two
 * fields that have defaults (port 22, user `root`), so those inherit unless they
 * differ from the default — stated in the settings UI.
 *
 * @param {object} machine
 * @param {{text?: string, file?: string, io?: object}} [opts]
 * @returns {{alias: string, matched: boolean, host: string, port: number, username: string, privateKeyPath: string, proxy: object|undefined, warnings: string[]}|null}
 *   null when the machine is not in alias mode.
 */
export function resolveMachineSshConfig(machine, opts = {}) {
  if (!machine || !machine.useSshConfig) return null
  const alias = String(machine.host || '').trim()
  if (!alias) return null
  const target = sshAliasTarget(alias, opts)
  const warnings = [...target.warnings]
  if (!target.matched) warnings.push(`no ~/.ssh/config block matches "${alias}" — using the name itself.`)
  const port = machine.port && Number(machine.port) !== 22 ? Number(machine.port) : target.port
  const username = machine.username && machine.username !== 'root' ? String(machine.username) : (target.username || machine.username || '')
  const privateKeyPath = machine.privateKeyPath ? String(machine.privateKeyPath) : target.privateKeyPath
  const proxy = machine.proxy && machine.proxy.host ? machine.proxy : target.proxy
  return {
    alias,
    matched: target.matched,
    host: target.host,
    port: Number(port) || 22,
    username: String(username || ''),
    privateKeyPath,
    proxy,
    warnings,
  }
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}
