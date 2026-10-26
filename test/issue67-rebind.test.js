// Issue #67 — "the machine's IP changed; don't make me recreate every workspace".
//
// A workspace mirror binds to its machine through the `.dsh-remote-meta.json`
// written at pick time: session routing (bindingFor), pool keying and the
// sidebar badges ALL read the identity from that file. When the user edits a
// saved machine's host/user/port (settings UI or rw_connect with overrides),
// the mirrors used to stay glued to the old address — every session kept
// dialling the dead IP, and the only way out was a brand-new workspace
// (re-sync included).
//
// The fix rebinds in place: the machines update route rewrites every meta
// that matched the OLD identity. These tests pin that behaviour through the
// production route, against a real temp DSH_HOME.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

function makeHome() {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-remote-rebind-'))
  const root = path.join(home, 'remote-workspaces')
  mkdirSync(root, { recursive: true })
  const machines = [
    { id: 'm-a', name: 'box-a', host: '10.0.0.1', port: 22, username: 'dev', password: 'pw' },
    { id: 'm-b', name: 'box-b', host: '10.0.0.2', port: 22, username: 'ops', password: 'pw' },
  ]
  writeFileSync(path.join(root, 'machines.json'), JSON.stringify({ list: machines, currentId: 'm-a' }))
  return { home, root }
}

/** Seed one mirror of machine A and one of machine B, with content inside. */
function seedMirrors(root) {
  const aDir = path.join(root, '10.0.0.1-dev-22', 'proj')
  const bDir = path.join(root, '10.0.0.2-ops-22', 'proj')
  mkdirSync(aDir, { recursive: true })
  mkdirSync(bDir, { recursive: true })
  writeFileSync(path.join(aDir, '.dsh-remote-meta.json'), JSON.stringify({ host: '10.0.0.1', port: 22, username: 'dev', remotePath: '/srv/proj', createdAt: '2026-01-01T00:00:00Z' }))
  writeFileSync(path.join(aDir, 'keep.txt'), 'local work that must survive the rebind')
  writeFileSync(path.join(bDir, '.dsh-remote-meta.json'), JSON.stringify({ host: '10.0.0.2', port: 22, username: 'ops', remotePath: '/srv/proj', createdAt: '2026-01-01T00:00:00Z' }))
  return { aDir, bDir }
}

function makeCtx() {
  const routes = new Map()
  const ctx = {
    effect: () => {},
    inject(names, callback) { if (names.every((name) => this.get(name))) callback(this) },
    get: (k) => (k === 'webServer' ? { register: (r) => { routes.set(r.path, r); return () => {} } } : undefined),
    tools: { register: () => {} },
    systemPrompt: { section: () => {} },
  }
  return { ctx, routes }
}

const CONFIG = {
  host: '', port: 22, username: '', password: '', privateKeyPath: '', passphrase: '',
  workspace: '', shell: '', commandTimeoutMs: 1500, connectTimeoutMs: 1200,
  maxOutputChars: 10000, maxFileBytes: 100000, hostKeyMode: 'off',
  useAgent: false, keyboardInteractive: false, autoPush: false, auditLog: false,
  encoding: 'utf-8', updateMode: 'off', updateCheckIntervalMs: 0,
}

async function loadPlugin(home) {
  process.env.DSH_HOME = home
  // Issue #50's machines route would otherwise write marker-tagged Host blocks
  // into the REAL ~/.ssh/config on identity edits — isolate that too (the env
  // override in lib/sshconfig.js resolves the config path per call).
  process.env.DSH_REMOTE_SSH_CONFIG = path.join(home, '.ssh', 'config')
  const mod = await import(`../lib/index.js?rebind=${Math.random()}`)
  const { ctx, routes } = makeCtx()
  await mod.apply(ctx, { ...CONFIG })
  return { routes }
}

async function postMachines(routes, body) {
  const route = routes.get('/dsh-remote/machines')
  assert.ok(route, 'route /dsh-remote/machines must be registered')
  const req = Readable.from([Buffer.from(JSON.stringify(body))])
  req.method = 'POST'
  req.url = '/dsh-remote/machines'
  const res = {
    statusCode: 0,
    payload: '',
    setHeader() {},
    end(chunk) { this.payload += chunk == null ? '' : String(chunk) },
  }
  await route.handler(req, res)
  return { status: res.statusCode, json: JSON.parse(res.payload) }
}

const readMeta = (dir) => JSON.parse(readFileSync(path.join(dir, '.dsh-remote-meta.json'), 'utf8'))

test('editing a machine\'s host rebinds its mirrors and keeps local content', async (t) => {
  const { home, root } = makeHome()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const { aDir, bDir } = seedMirrors(root)
  const { routes } = await loadPlugin(home)

  const r = await postMachines(routes, {
    action: 'update', id: 'm-a', name: 'box-a',
    host: '10.0.0.99', port: 22, username: 'dev',
  })
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
  assert.equal(r.json.reboundMirrors, 1, 'exactly machine A\'s mirror must move')

  const meta = readMeta(aDir)
  assert.equal(meta.host, '10.0.0.99', 'the mirror now dials the new address')
  assert.equal(meta.username, 'dev')
  assert.equal(meta.remotePath, '/srv/proj', 'the remote root is untouched')
  assert.ok(meta.reboundAt, 'the rebind is stamped for later diagnostics')
  assert.equal(readFileSync(path.join(aDir, 'keep.txt'), 'utf8'), 'local work that must survive the rebind')
  assert.equal(existsSync(aDir), true, 'the mirror directory is NOT renamed away from live sessions')

  const other = readMeta(bDir)
  assert.equal(other.host, '10.0.0.2', 'another machine\'s mirror is untouched')
})

test('editing only the display name rebinds nothing', async (t) => {
  const { home, root } = makeHome()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const { aDir } = seedMirrors(root)
  const { routes } = await loadPlugin(home)

  const r = await postMachines(routes, {
    action: 'update', id: 'm-a', name: 'renamed',
    host: '10.0.0.1', port: 22, username: 'dev',
  })
  assert.equal(r.status, 200)
  assert.equal(r.json.reboundMirrors, undefined, 'identity unchanged → no rebind reported')
  assert.equal(readMeta(aDir).host, '10.0.0.1')
})

test('a username change is an identity change too (matching is host+port+user)', async (t) => {
  const { home, root } = makeHome()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const { aDir } = seedMirrors(root)
  const { routes } = await loadPlugin(home)

  const r = await postMachines(routes, {
    action: 'update', id: 'm-a', name: 'box-a',
    host: '10.0.0.1', port: 22, username: 'deploy',
  })
  assert.equal(r.status, 200)
  assert.equal(r.json.reboundMirrors, 1)
  const meta = readMeta(aDir)
  assert.equal(meta.username, 'deploy')
  assert.equal(meta.host, '10.0.0.1')
})

test('adding a NEW machine never steals existing mirrors', async (t) => {
  const { home, root } = makeHome()
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const { aDir } = seedMirrors(root)
  const { routes } = await loadPlugin(home)

  const r = await postMachines(routes, {
    action: 'add', name: 'fresh', host: '10.0.0.50', port: 22, username: 'dev',
  })
  assert.equal(r.status, 200)
  assert.equal(r.json.reboundMirrors, undefined)
  assert.equal(readMeta(aDir).host, '10.0.0.1', 'machine A\'s mirror stays bound to A')
})
