// Manual end-to-end check against a REAL sshd (not part of the CI suite):
// rw_edit must (1) replace content atomically, (2) PRESERVE the original
// permission bits across the temp+rename swap, (3) leave no temp files.
if (!process.env.PROBE_HOST) { console.error('usage: PROBE_HOST=<host> [PROBE_PORT=22] [PROBE_USER=root] PROBE_PASS=<pass> node ' + process.argv[1]); process.exit(2) }
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const HOST = process.env.PROBE_HOST
const home = mkdtempSync(path.join(tmpdir(), 'dsh-remote-e2e-'))
const root = path.join(home, 'remote-workspaces')
mkdirSync(root, { recursive: true })
writeFileSync(path.join(root, 'machines.json'), JSON.stringify({
  list: [{ id: 'm-1', name: 'e2e', host: HOST, port: Number(process.env.PROBE_PORT || 22), username: process.env.PROBE_USER || 'root', password: process.env.PROBE_PASS }],
  currentId: 'm-1',
}))
const cwd = path.join(root, `${HOST}-root-22`, 'proj')
mkdirSync(cwd, { recursive: true })
writeFileSync(path.join(cwd, '.dsh-remote-meta.json'),
  JSON.stringify({ host: HOST, port: 22, username: 'root', remotePath: '/tmp/dsh-remote-e2e' }))

process.env.DSH_HOME = home
const { apply } = await import(`../../lib/index.js?e2e=${Math.random()}`)
const tools = new Map()
await apply({
  effect: () => {}, inject: () => {}, get: () => undefined,
  tools: { register: (t) => tools.set(t.name, t) },
  systemPrompt: { section: () => {} },
}, {
  host: '', port: 22, username: '', password: '', privateKeyPath: '', passphrase: '',
  workspace: '', shell: '', commandTimeoutMs: 15000, connectTimeoutMs: 10000,
  maxOutputChars: 10000, maxFileBytes: 100000, hostKeyMode: 'off',
  useAgent: false, keyboardInteractive: false, autoPush: false, auditLog: false,
  encoding: 'utf-8', updateMode: 'off', updateCheckIntervalMs: 0,
})

const exec = tools.get('rw_exec')
const edit = tools.get('rw_edit')
const ctx = { agent: { session: { header: { cwd } } } }
const run = (tool, args) => tool.execute(args, ctx)
// rw_exec answers { text }; a nonzero exit appends "[exit code: N]" — strip it.
const remote = (cmd, cwd = '/') =>
  run(exec, { command: cmd, cwd }).then((r) => String(r.text || '').replace(/\n\[exit code: \d+\]$/, '').trim())

let failed = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) failed = 1
}

try {
  await remote('mkdir -p /tmp/dsh-remote-e2e')

  // Case 1: executable script keeps +x across an edit.
  await remote("printf 'echo OLD\\n' > /tmp/dsh-remote-e2e/run.sh; chmod 755 /tmp/dsh-remote-e2e/run.sh")
  const before = await remote('stat -c %a /tmp/dsh-remote-e2e/run.sh')
  const r1 = await run(edit, { path: '/tmp/dsh-remote-e2e/run.sh', old_string: 'OLD', new_string: 'NEW' })
  const after = await remote('stat -c %a /tmp/dsh-remote-e2e/run.sh')
  const body = await remote('cat /tmp/dsh-remote-e2e/run.sh')
  check('edit reports success', /replaced 1/.test(r1.text || ''), String(r1.text || ''))
  check('content replaced', body === 'echo NEW', JSON.stringify(body))
  check('mode 755 preserved', before === '755' && after === '755', `before=${before} after=${after}`)

  // Case 2: 0600 secret stays 0600.
  await remote("printf 'token=AAA\\n' > /tmp/dsh-remote-e2e/secret.conf; chmod 600 /tmp/dsh-remote-e2e/secret.conf")
  await run(edit, { path: '/tmp/dsh-remote-e2e/secret.conf', old: 'AAA', new: 'BBB' })
  const mode600 = await remote('stat -c %a /tmp/dsh-remote-e2e/secret.conf')
  check('mode 600 preserved', mode600 === '600', `after=${mode600}`)

  // Case 3: no temp files left behind.
  const leftovers = await remote("ls /tmp/dsh-remote-e2e | grep -c 'dsh-remote-edit' || true")
  check('no temp files left', leftovers === '0', `count=${leftovers}`)
} catch (e) {
  console.error('E2E ERROR:', e.message)
  failed = 1
} finally {
  try { await remote('rm -rf /tmp/dsh-remote-e2e') } catch {}
  delete process.env.DSH_HOME
  rmSync(home, { recursive: true, force: true })
  process.exit(failed)
}
