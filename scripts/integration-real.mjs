#!/usr/bin/env node
// dsh-remote — real-machine integration test (opt-in, NOT part of npm test).
//
// Drives the plugin's apply() with a mocked cordis ctx against a REAL SSH host:
// every route, tool, the TOFU guard, the audit log, port forwarding and the
// conflict-aware sync all run against live ssh2 + SFTP. This is the
// "verify third-party callback contracts against the real runtime" gate the
// dev standards demand (the v0.6.7 bug class: unit mocks hid a real contract).
//
// Usage (both HOME and DSH_HOME must be SCRATCH dirs — the plugin writes its
// data root under DSH_HOME and migrates legacy data from ~/.dsh):
//
//   HOME=$(mktemp -d) DSH_HOME=$(mktemp -d) \
//     DSH_IT_MACHINES=$HOME/.dsh/remote-workspaces/machines.json \
//     node scripts/integration-real.mjs
//
// Credentials: DSH_IT_MACHINES points at a machines.json (defaults to the
// real DSH home's), or set DSH_IT_HOST/PORT/USERNAME/PASSWORD directly.
import { EventEmitter } from 'node:events'
import { readFileSync, existsSync, mkdirSync, writeFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { apply } from '../lib/index.js'

const HOME = homedir()
const MACHINES = process.env.DSH_IT_MACHINES || path.join(HOME, '.dsh', 'remote-workspaces', 'machines.json')

function loadMachine() {
  if (process.env.DSH_IT_HOST) {
    return {
      host: process.env.DSH_IT_HOST,
      port: Number(process.env.DSH_IT_PORT) || 22,
      username: process.env.DSH_IT_USERNAME || 'root',
      password: process.env.DSH_IT_PASSWORD || '',
      privateKeyPath: process.env.DSH_IT_KEY || '',
      passphrase: process.env.DSH_IT_KEY_PASSPHRASE || '',
      workspace: process.env.DSH_IT_WORKSPACE || '',
    }
  }
  const j = JSON.parse(readFileSync(MACHINES, 'utf8'))
  const m = (j.list || []).find((x) => x.id === j.currentId) || (j.list || [])[0]
  if (!m) throw new Error(`no machine in ${MACHINES}`)
  return m
}

// ── mocked ctx ────────────────────────────────────────────────────────────
function makeCtx() {
  const tools = []
  const commands = []
  const promptSections = []
  const routes = []
  const effects = []
  const toolsSvc = { register: (t) => tools.push(t) }
  const systemPrompt = { section: (s) => promptSections.push(s) }
  const commandsSvc = { register: (c) => commands.push(c) }
  const webServer = { register: (r) => { routes.push(r); return () => {} } }
  // Stand-in for @deepseek-ai/dsh-file-reference-local: dsh-remote WRAPS this
  // service (issue #39), so its answer is the "local session" control sample.
  const originalList = (agent, query) => Promise.resolve([{ path: 'LOCAL-ONLY.txt', kind: 'file' }])
  const fileReferences = { list: originalList }
  // Capture the plugin's own warnings: a swallowed @ listing failure would look
  // exactly like "the remote tree is empty", which is the bug under test.
  const warnings = []
  const logger = {
    warn: (...parts) => warnings.push(parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')),
    info: () => {}, debug: () => {}, error: (...parts) => warnings.push(parts.join(' ')),
  }
  const ctx = {
    get(name) {
      if (name === 'tools') return toolsSvc
      if (name === 'systemPrompt') return systemPrompt
      if (name === 'webServer') return webServer
      if (name === 'commands') return commandsSvc
      if (name === 'fileReferences') return fileReferences
      if (name === 'logger') return logger
      return undefined
    },
    effect(fn) { effects.push(fn) },
    inject(names, callback) { if (names.every((name) => this.get(name))) callback(this) },
  }
  // The plugin accesses injected services as ctx properties (cordis inject).
  ctx.tools = toolsSvc
  ctx.systemPrompt = systemPrompt
  ctx.webServer = webServer
  ctx.commands = commandsSvc
  ctx.fileReferences = fileReferences
  return { ctx, tools, commands, promptSections, routes, effects, fileReferences, originalList, warnings }
}

/** Dispatch a route handler with a fake req/res; body fed via events. */
async function dispatch(routes, method, url, body) {
  const pathname = url.split('?')[0]
  const route = routes.find((r) => r.path === pathname)
  if (!route) return { status: 404, json: null }
  const req = new EventEmitter()
  req.method = method
  req.url = url
  const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v }, end(b) { this.body = b } }
  const p = route.handler(req, res)
  queueMicrotask(() => {
    if (body !== undefined) req.emit('data', JSON.stringify(body))
    req.emit('end')
  })
  await p
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null }
}

let pass = 0
let fail = 0
const skipped = []
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✔ ${name}`) }
  else { fail++; console.log(`  ✘ ${name}${extra ? ' — ' + extra : ''}`) }
}
function skip(name, why) { skipped.push(name); console.log(`  ⤷ SKIP ${name} (${why})`) }

async function toolExec(tool, name, args) {
  const t = tool.find((x) => x.name === name)
  if (!t) throw new Error('tool not found: ' + name)
  return t.execute(args || {})
}

async function freePort() {
  return new Promise((res) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) })
  })
}

const SCRATCH = '/tmp/dsh-remote-it-' + Date.now()

async function main() {
  const machine = loadMachine()
  const config = {
    host: machine.host, port: machine.port || 22, username: machine.username || 'root',
    password: machine.password || '', privateKeyPath: machine.privateKeyPath || '', passphrase: machine.passphrase || '',
    workspace: machine.workspace || '', commandTimeoutMs: 20000, connectTimeoutMs: 15000,
    maxOutputChars: 200000, maxFileBytes: 52428800, hostKeyMode: 'accept-new',
    useAgent: false, keyboardInteractive: false, autoPush: false, auditLog: true, encoding: 'utf-8',
    fileReference: true, fileReferenceMaxResults: 20, fileReferenceMaxEntries: 3000, fileReferenceTimeoutMs: 4000,
  }
  console.log(`\n== dsh-remote real-machine integration (${config.username}@${config.host}:${config.port}, workspace ${config.workspace || '<none>'}) ==\n`)

  // Seed the scratch registry with this machine, the way the settings page (or
  // a previous run) would: session-bound pools resolve their credentials from
  // the registry, so an empty one would leave every mirror-bound tool with no
  // credentials at all.
  {
    const root = path.join(process.env.DSH_HOME, 'remote-workspaces')
    mkdirSync(root, { recursive: true })
    const rec = {
      id: 'it-machine',
      name: machine.name || machine.host,
      host: config.host,
      port: config.port,
      username: config.username,
      password: config.password || '',
      privateKeyPath: config.privateKeyPath || '',
      passphrase: config.passphrase || '',
      workspace: config.workspace || '',
    }
    writeFileSync(path.join(root, 'machines.json'), JSON.stringify({ list: [rec], currentId: rec.id }, null, 2))
  }

  const { ctx, tools, commands, promptSections, routes, effects, fileReferences, originalList, warnings } = makeCtx()
  await apply(ctx, config)

  const tool = tools
  // 1. status route
  {
    const { status, json } = await dispatch(routes, 'GET', '/dsh-remote/status')
    check('GET /status', status === 200 && json && json.host === config.host, JSON.stringify(json && json.host))
    check('status exposes workspace + machines + forwards + auditEnabled', json && json.workspace === config.workspace && Array.isArray(json.machines) && Array.isArray(json.forwards) && typeof json.auditEnabled === 'boolean')
  }
  // 2. real SSH connect via test-connect (TOFU records the host key)
  {
    const { status, json } = await dispatch(routes, 'POST', '/dsh-remote/test-connect', {
      host: config.host, port: config.port, username: config.username, password: config.password,
      privateKeyPath: config.privateKeyPath, passphrase: config.passphrase,
    })
    check('test-connect (real SSH + TOFU)', status === 200 && json && json.ok === true && typeof json.latencyMs === 'number' && json.latencyMs >= 0, json && json.error)
    const kh = path.join(process.env.DSH_HOME, 'remote-workspaces', 'known_hosts.json')
    check('TOFU recorded the host key', existsSync(kh) && JSON.stringify(readFileSync(kh, 'utf8')).includes(`${config.host}:${config.port}`))
  }
  // 3. rw_info tool
  {
    const r = await toolExec(tool, 'rw_info')
    check('rw_info text', typeof r.text === 'string' && r.text.includes(config.host) && r.text.includes('workspace'), r.text.slice(0, 120))
  }
  // 4. home resolution
  {
    const { json } = await dispatch(routes, 'POST', '/dsh-remote/home')
    check('/dsh-remote/home (exec echo ~)', json && json.ok === true && typeof json.home === 'string' && json.home.startsWith('/'), json && json.home)
  }
  // 5. real SFTP listing of the workspace
  {
    const { status, json } = await dispatch(routes, 'GET', '/dsh-remote/ls?path=' + encodeURIComponent(config.workspace || '/'))
    check('ls workspace (real SFTP readdir)', status === 200 && Array.isArray(json && json.items) && json.items.length > 0, json && json.error)
    check('ls items carry size/mtime/type', json && json.items.every((it) => 'size' in it && 'mtime' in it && it.type))
  }
  // 6. read a real file
  {
    const { json } = await dispatch(routes, 'POST', '/dsh-remote/read', { path: '/etc/hostname', maxBytes: 4096 })
    check('read /etc/hostname (live SFTP read)', json && json.ok === true && json.binary === false && typeof json.content === 'string' && json.content.trim().length > 0, json && json.error)
  }
  // 7. write + optimistic lock (scratch file on the remote)
  {
    const p1 = SCRATCH + '.txt'
    let r = await dispatch(routes, 'POST', '/dsh-remote/write', { path: p1, content: 'hello v1' })
    check('write new file', r.status === 200 && r.json && r.json.ok === true, r.json && r.json.error)
    r = await dispatch(routes, 'POST', '/dsh-remote/read', { path: p1 })
    check('write round-trips', r.json && r.json.content === 'hello v1')
    r = await dispatch(routes, 'POST', '/dsh-remote/write', { path: p1, content: 'stale', expectedMtime: 1 })
    check('write with WRONG expectedMtime → 409', r.status === 409, 'status=' + r.status)
    const stm = await toolExec(tool, 'rw_stat', { path: p1 })
    const mtimeMatch = stm.text.match(/mtime: ([\d-]+T[\d:]+)/)
    const epoch = mtimeMatch ? Math.floor(new Date(mtimeMatch[1] + 'Z').getTime() / 1000) : null
    check('rw_stat parses mtime', epoch != null && epoch > 0, stm.text.slice(0, 80))
    r = await dispatch(routes, 'POST', '/dsh-remote/write', { path: p1, content: 'hello v2', expectedMtime: epoch })
    check('write with CORRECT expectedMtime → 200', r.status === 200 && r.json && r.json.ok === true, r.json && r.json.error)
    r = await dispatch(routes, 'POST', '/dsh-remote/read', { path: p1 })
    check('optimistic-lock write round-trips', r.json && r.json.content === 'hello v2')
    r = await dispatch(routes, 'POST', '/dsh-remote/fs', { op: 'remove', path: p1 })
    check('fs remove cleans the scratch file', r.status === 200 && r.json && r.json.ok === true, r.json && r.json.error)
  }
  // 8. big-file preview (fastGet head path)
  {
    const pBig = SCRATCH + '-big.txt'
    await dispatch(routes, 'POST', '/dsh-remote/write', { path: pBig, content: 'A'.repeat(300 * 1024) })
    const { json } = await dispatch(routes, 'POST', '/dsh-remote/read', { path: pBig, maxBytes: 2048 })
    check('big-file preview: truncated head, not fully buffered', json && json.ok === true && json.truncated === true && json.content.length <= 2200, json && json.error)
    check('big-file preview reports real size', json && json.size === 300 * 1024)
    await dispatch(routes, 'POST', '/dsh-remote/fs', { op: 'remove', path: pBig })
  }
  // 9. fs ops: mkdir → rename → remove
  {
    const d1 = SCRATCH + '-dir'
    const d2 = SCRATCH + '-dir-renamed'
    await dispatch(routes, 'POST', '/dsh-remote/fs', { op: 'mkdir', path: d1 })
    const ls = await dispatch(routes, 'GET', '/dsh-remote/ls?path=' + encodeURIComponent('/tmp'))
    check('fs mkdir visible in ls', ls.json && ls.json.items.some((it) => it.name === path.basename(d1)))
    await dispatch(routes, 'POST', '/dsh-remote/fs', { op: 'rename', path: d1, dest: d2 })
    const ls2 = await dispatch(routes, 'GET', '/dsh-remote/ls?path=' + encodeURIComponent('/tmp'))
    check('fs rename visible in ls', ls2.json && ls2.json.items.some((it) => it.name === path.basename(d2)))
    const rm = await dispatch(routes, 'POST', '/dsh-remote/fs', { op: 'remove', path: d2 })
    check('fs remove dir', rm.status === 200 && rm.json && rm.json.ok === true, rm.json && rm.json.error)
  }
  // 10. rw_edit (create → edit → verify) with real SFTP
  {
    const p = SCRATCH + '-edit.txt'
    await toolExec(tool, 'rw_write_file', { path: p, content: 'alpha\nbeta\ngamma' })
    const e = await toolExec(tool, 'rw_edit', { path: p, old: 'beta', new: 'BETA' })
    check('rw_edit replaces', e && e.ok === true, e && e.text)
    const rd = await toolExec(tool, 'rw_read_file', { path: p, startLine: 1, endLine: 3 })
    check('rw_edit result visible', rd.text.includes('BETA') && !rd.text.includes('\tbeta'), rd.text.slice(0, 80))
    const bad = await toolExec(tool, 'rw_edit', { path: p, old: 'zzz', new: 'x' }).catch((err) => err)
    check('rw_edit missing-text errors', bad instanceof Error && /not found/.test(bad.message), bad.message)
    await dispatch(routes, 'POST', '/dsh-remote/fs', { op: 'remove', path: p })
  }
  // 11. rw_search (SFTP walk) on /etc
  {
    const r = await toolExec(tool, 'rw_search', { pattern: '^root:', path: '/etc', maxMatches: 5 })
    check('rw_search finds /etc/passwd root line', r.text.includes('/etc/passwd:1:') || /passwd/.test(r.text), r.text.slice(0, 100))
  }
  // 12. rw_read_file paging + encoding
  {
    const r = await toolExec(tool, 'rw_read_file', { path: '/etc/hostname', startLine: 1, endLine: 1 })
    check('rw_read_file paging', r.text.startsWith('     1\t'), r.text.slice(0, 40))
  }
  // 13. dry-run sync (no writes) on the workspace
  {
    const r = await toolExec(tool, 'rw_sync', { dryRun: true, depth: 1, maxFiles: 5 })
    check('rw_sync dryRun says WOULD', /WOULD download/.test(r.text), r.text.slice(0, 120))
  }
  // 14. real bounded sync of a small dir (switch workspace to /root, sync, restore)
  {
    const orig = config.workspace
    await toolExec(tool, 'rw_pick_workspace', { path: '/root' })
    const r = await toolExec(tool, 'rw_sync', { depth: 2, maxFiles: 20 })
    const files = (r.text.match(/Downloaded (\d+) file/) || [])[1]
    const mirror = path.join(process.env.DSH_HOME, 'remote-workspaces', `${config.host}-root-${config.port}`, 'root')
    // `/root` is often unreadable for a non-root login (mode 0700): 0 files is
    // then the correct answer, not a regression — assert the mirror instead only
    // when the remote directory actually had something to download.
    if (Number(files) >= 1) {
      check('rw_sync real download', true)
      check('mirror populated on disk', existsSync(mirror) && readdir_nonempty(mirror), mirror)
    } else {
      skip('rw_sync real download', `the remote dir yielded no files (${r.text.split('\n')[0].slice(0, 80)})`)
    }
    const p2 = await toolExec(tool, 'rw_push', { dryRun: true, maxFiles: 20 })
    check('rw_push dryRun says WOULD', /WOULD upload/.test(p2.text), p2.text.slice(0, 120))
    await toolExec(tool, 'rw_pick_workspace', { path: orig })
  }
  // 15. port forwarding: local tunnel to the remote's own sshd
  {
    const port = await freePort()
    const def = await dispatch(routes, 'POST', '/dsh-remote/forwards', { action: 'define', listenPort: port, targetHost: '127.0.0.1', targetPort: config.port, direction: 'local', autoStart: false })
    check('forward define', def.status === 200 && def.json && def.json.ok === true, def.json && def.json.error)
    const id = def.json.forward.id
    const st = await dispatch(routes, 'POST', '/dsh-remote/forwards', { action: 'start', id })
    check('forward start (real ssh2 forwardOut)', st.status === 200 && st.json.forwards.find((f) => f.id === id).active === true, st.json && st.json.error)
    const banner = await new Promise((resolve) => {
      const s = net.connect(port, '127.0.0.1', () => {})
      let buf = ''
      s.on('data', (d) => { buf += d.toString(); if (buf.includes('\n')) { s.destroy(); resolve(buf.trim()) } })
      s.on('error', () => resolve(''))
      setTimeout(() => { try { s.destroy() } catch {}; resolve(buf.trim()) }, 5000)
    })
    check('local forward reaches the remote sshd (SSH-2.0 banner)', banner.startsWith('SSH-'), JSON.stringify(banner.slice(0, 30)))
    await dispatch(routes, 'POST', '/dsh-remote/forwards', { action: 'stop', id })
    await dispatch(routes, 'POST', '/dsh-remote/forwards', { action: 'remove', id })
    // reverse forward (environment-dependent: needs AllowTcpForwarding on the remote)
    const rport = await freePort()
    const rd = await dispatch(routes, 'POST', '/dsh-remote/forwards', { action: 'define', listenPort: rport, targetHost: '127.0.0.1', targetPort: 22, direction: 'reverse', autoStart: false })
    const rst = await dispatch(routes, 'POST', '/dsh-remote/forwards', { action: 'start', id: rd.json.forward.id })
    if (rst.status === 200 && rst.json.forwards.find((f) => f.id === rd.json.forward.id).active) {
      check('reverse forward start (openssh_forwardIn)', true)
      await dispatch(routes, 'POST', '/dsh-remote/forwards', { action: 'stop', id: rd.json.forward.id })
    } else {
      skip('reverse forward', '远端 sshd 不允许反向转发（AllowTcpForwarding）: ' + ((rst.json && rst.json.error) || 'active=false'))
    }
    await dispatch(routes, 'POST', '/dsh-remote/forwards', { action: 'remove', id: rd.json.forward.id })
  }
  // 16. forget-key → reconnect re-records (TOFU lifecycle)
  {
    const fk = await dispatch(routes, 'POST', '/dsh-remote/forget-key')
    check('forget-key', fk.status === 200 && fk.json && fk.json.ok === true)
    const kh = path.join(process.env.DSH_HOME, 'remote-workspaces', 'known_hosts.json')
    check('known_hosts cleared', existsSync(kh) && !JSON.stringify(readFileSync(kh, 'utf8')).includes(`${config.host}:${config.port}`))
    const rc = await dispatch(routes, 'POST', '/dsh-remote/test-connect', { host: config.host, port: config.port, username: config.username, password: config.password, privateKeyPath: config.privateKeyPath, passphrase: config.passphrase })
    check('reconnect after forget-key re-records', rc.status === 200 && rc.json && rc.json.ok === true && JSON.stringify(readFileSync(kh, 'utf8')).includes(`${config.host}:${config.port}`), rc.json && rc.json.error)
  }
  // 17. audit log + ssh-config + tasks + commands + prompt
  {
    const a = await dispatch(routes, 'GET', '/dsh-remote/audit?limit=50')
    check('audit log has entries', a.status === 200 && a.json.lines.length > 0, 'count=' + (a.json && a.json.lines.length))
    check('audit lines carry host+op', a.json.lines.every((l) => l.includes('@') && l.includes('|')), a.json.lines[0])
    const sc = await dispatch(routes, 'GET', '/dsh-remote/ssh-config')
    check('ssh-config route', sc.status === 200 && sc.json && typeof sc.json.present === 'boolean', sc.json && sc.json.error)
    const tk = await dispatch(routes, 'GET', '/dsh-remote/tasks')
    check('tasks route', tk.status === 200 && Array.isArray(tk.json && tk.json.tasks))
    const tnf = await dispatch(routes, 'GET', '/dsh-remote/task?id=nope')
    check('unknown task → 404', tnf.status === 404)
    const cmd = commands[0].handler({})
    check('/remote command', cmd && cmd.kind === 'success' && cmd.text.includes(config.host), cmd && cmd.text.slice(0, 80))
    // (the system-prompt section is session-scoped: it is asserted in section 18
    // with a real mirror cwd, because with no promptContext it is intentionally
    // empty — a local session must get no remote section at all.)
  }
  // 18. remote `@` completion (issue #39) against the REAL host
  //
  // A remote session's cwd is its local MIRROR directory — which is deliberately
  // EMPTY here — so `@` must be answered from the remote tree over SFTP while a
  // local session keeps the harness's own provider untouched.
  {
    const base = 'at-completion'
    const mirrorDir = path.join(process.env.DSH_HOME, 'remote-workspaces', `${config.host}-${config.username}-${config.port}`, base)
    mkdirSync(mirrorDir, { recursive: true })
    writeFileSync(path.join(mirrorDir, '.dsh-remote-meta.json'), JSON.stringify({ host: config.host, port: config.port, username: config.username, remotePath: config.workspace }))
    const remoteAgent = { session: { header: { cwd: mirrorDir } } }
    check('the @ overlay replaced ctx.fileReferences.list', fileReferences.list !== originalList)

    // The system-prompt section is session-scoped: with this mirror cwd it must
    // describe the REMOTE root and the `@` namespace.
    const promptText = promptSections[0].text({ agent: remoteAgent })
    check('system prompt names the remote workspace', typeof promptText === 'string' && promptText.includes(config.workspace), promptText.slice(0, 100))
    check('system prompt explains the @ namespace', promptText.includes('@path') && promptText.includes('rw_read_file'), promptText.slice(0, 200))
    check('a LOCAL session gets no remote prompt section', promptSections[0].text({ agent: { session: { header: { cwd: tmpdir() } } } }) === '')

    const rootLs = await dispatch(routes, 'GET', '/dsh-remote/ls?path=' + encodeURIComponent(config.workspace))
    const rootNames = ((rootLs.json && rootLs.json.items) || []).filter((it) => !it.name.startsWith('.')).map((it) => it.name)
    const listed = await fileReferences.list(remoteAgent, '')
    check('@ lists the REMOTE tree, not the empty local mirror', listed.length > 0, `remote entries=${rootNames.length}, candidates=${listed.length}, mirror files=${readdirSync(mirrorDir).length}`)
    check('@ candidates are workspace-relative paths', listed.every((c) => c.path && !c.path.startsWith('/') && c.path !== '.dsh-remote-meta.json'), JSON.stringify(listed.slice(0, 3)))
    check('@ includes a real remote entry', listed.some((c) => rootNames.includes(c.path.replace(/\/$/, ''))), JSON.stringify(listed.slice(0, 5)))

    // Drill into a real remote directory (the `@"dir/` continuation flow).
    const aDir = listed.find((c) => c.kind === 'directory')
    if (aDir) {
      const sub = await dispatch(routes, 'GET', '/dsh-remote/ls?path=' + encodeURIComponent(`${String(config.workspace).replace(/\/+$/, '')}/${aDir.path}`))
      const subNames = ((sub.json && sub.json.items) || []).map((it) => it.name)
      const drilled = await fileReferences.list(remoteAgent, aDir.path + '/')
      check('@ drills into a remote subdirectory', drilled.every((c) => c.path.startsWith(aDir.path + '/')), JSON.stringify(drilled.slice(0, 3)))
      if (subNames.length) check('@ drill returns that directory\'s children', drilled.length > 0, `${aDir.path}: remote=${subNames.length} candidates=${drilled.length}`)
    } else {
      skip('@ drill', 'the workspace root has no subdirectory to drill into')
    }

    // A bare query is fuzzy over the whole remote tree (bounded traversal).
    const needle = (rootNames.find((n) => n.length >= 3) || '').slice(0, 3)
    if (needle) {
      const fuzzy = await fileReferences.list(remoteAgent, needle)
      const lower = needle.toLowerCase()
      check('@ fuzzy query searches the remote tree', fuzzy.length > 0 && fuzzy.every((c) => c.path.length > 0), `${needle} → ${JSON.stringify(fuzzy.slice(0, 3).map((c) => c.path))}`)
      check('@ fuzzy hits are remote entries, not the local mirror', fuzzy.some((c) => c.path.toLowerCase().includes(lower)), `${needle} → ${JSON.stringify(fuzzy.slice(0, 5).map((c) => c.path))}`)
    } else {
      skip('@ fuzzy query', 'no remote entry long enough for a needle')
    }

    // The control sample: a LOCAL session must still be served by the harness.
    const localAgent = { session: { header: { cwd: tmpdir() } } }
    const local = await fileReferences.list(localAgent, '')
    check('local session keeps the harness provider (delegation intact)', local.length === 1 && local[0].path === 'LOCAL-ONLY.txt', JSON.stringify(local))

    // rc_* tools must accept the workspace-relative paths `@` produces.
    const relRead = await toolExec(tool, 'rw_list_dir', { path: aDir ? aDir.path : '' })
    check('rw_list_dir accepts a workspace-relative path', typeof relRead.text === 'string' && !/not found|error/i.test(relRead.text.slice(0, 200)), relRead.text.slice(0, 100))
  }
  // 19. ~/.ssh/config ALIAS over a REAL connection (issue #38)
  //
  // The machine exists ONLY as an alias in a scratch ~/.ssh/config: host, port,
  // user and key come from that file at connect time, and the registry must keep
  // nothing but the alias name.
  {
    const home = mkdtempSync(path.join(tmpdir(), 'dsh-remote-it-home-'))
    mkdirSync(path.join(home, '.ssh'), { recursive: true })
    writeFileSync(path.join(home, '.ssh', 'config'), [
      'Host it-alias',
      `  HostName ${config.host}`,
      `  Port ${config.port}`,
      `  User ${config.username}`,
      config.privateKeyPath ? `  IdentityFile ${config.privateKeyPath}` : '',
    ].filter(Boolean).join('\n') + '\n')
    const savedHome = process.env.HOME
    const savedProfile = process.env.USERPROFILE
    process.env.HOME = home
    process.env.USERPROFILE = home
    // The resolver memoises the config text for ~2s (so one request resolving
    // several machines reads the file once) — outwait it after switching homes.
    await new Promise((r) => setTimeout(r, 2100))
    try {
      const connect = tool.find((t) => t.name === 'rw_connect')
      let connectErr = null
      await connect.execute({ host: 'it-alias', useSshConfig: true, save: true }).catch((e) => { connectErr = e })
      check('rw_connect connects through a ~/.ssh/config alias', !connectErr, connectErr && connectErr.message)
      const st = await dispatch(routes, 'GET', '/dsh-remote/status')
      check('the alias resolved to the real host/port', st.json.host === config.host && Number(st.json.port) === Number(config.port), JSON.stringify({ host: st.json.host, port: st.json.port, user: st.json.username }))
      const reg = JSON.parse(readFileSync(path.join(process.env.DSH_HOME, 'remote-workspaces', 'machines.json'), 'utf8'))
      const rec = reg.list.find((m) => m.host === 'it-alias')
      check('the registry kept the alias, not a copy of the resolved values', !!rec && rec.useSshConfig === true && !JSON.stringify(rec).includes(config.host), JSON.stringify(rec))
    } finally {
      if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome
      if (savedProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedProfile
      rmSync(home, { recursive: true, force: true })
    }
  }
  // 20. cleanup effects (plugin stop) must not throw
  {
    let threw = false
    try {
      // The mock registry stores the factories cordis would call; cordis then
      // calls whatever disposer each factory RETURNS, so do both here.
      for (const e of effects) {
        const disposer = e()
        if (typeof disposer === 'function') disposer()
      }
    } catch (err) { threw = true; console.log('  effect threw:', err.message) }
    check('plugin disposers run cleanly', !threw)
    check('the @ overlay is removed on dispose (ctx.fileReferences restored)', fileReferences.list === originalList)
  }

  if (warnings.length) {
    console.log(`\n-- plugin warnings (${warnings.length}) --`)
    for (const w of warnings.slice(0, 20)) console.log('   ' + w)
  }
  console.log(`\n== RESULT: ${pass} passed, ${fail} failed${skipped.length ? ', ' + skipped.length + ' skipped (' + skipped.join('; ') + ')' : ''} ==`)
  process.exit(fail ? 1 : 0)
}

function readdir_nonempty(dir) {
  try {
    return readdirSync(dir).filter((n) => !n.startsWith('.dsh-remote-')).length > 0
  } catch { return false }
}

main().catch((err) => {
  console.error('\nintegration FAILED:', err && err.stack || err)
  process.exit(1)
})
