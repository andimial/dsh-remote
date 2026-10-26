// Probe: does surface.rename() overwrite an EXISTING destination on this sshd?
if (!process.env.PROBE_HOST) { console.error('usage: PROBE_HOST=<host> [PROBE_PORT=22] [PROBE_USER=root] PROBE_PASS=<pass> node ' + process.argv[1]); process.exit(2) }
import { createPool } from '../../lib/pool.js'

const pool = createPool({
  host: process.env.PROBE_HOST, port: Number(process.env.PROBE_PORT || 22), username: process.env.PROBE_USER || 'root', password: process.env.PROBE_PASS,
  hostKeyMode: 'off', commandTimeoutMs: 10000, connectTimeoutMs: 10000,
})
const out = (r) => (r.stdout || '').trim()
try {
  await pool.exec('rm -rf /tmp/rename-probe && mkdir -p /tmp/rename-probe')
  const sftp = await pool.sftp()
  await sftp.writeFile('/tmp/rename-probe/a.tmp', 'AAA')
  await sftp.writeFile('/tmp/rename-probe/b.txt', 'BBB')
  try {
    await sftp.rename('/tmp/rename-probe/a.tmp', '/tmp/rename-probe/b.txt')
    console.log('rename over existing: OK')
  } catch (e) {
    console.log('rename over existing: FAILED —', e.message)
  }
  console.log('b.txt now:', out(await pool.exec('cat /tmp/rename-probe/b.txt 2>/dev/null; ls /tmp/rename-probe')))
  const ver = out(await pool.exec('ssh -V 2>&1 || sshd -V 2>&1 || true'))
  console.log('ssh version:', ver)
  const ext = out(await pool.exec("grep -i 'openssh' /etc/ssh/sshd_config | head -1; sshd -T 2>/dev/null | head -0; dpkg -l openssh-server 2>/dev/null | tail -1"))
  console.log('server pkg:', ext)
} finally {
  await pool.exec('rm -rf /tmp/rename-probe').catch(() => {})
  await pool.close()
}
