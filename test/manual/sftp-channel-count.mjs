// Manual probe: is the native backend leaking sftp subchannels server-side?
// Counts the sshd session channels via lsof on the sshd child PID.
if (!process.env.PROBE_HOST) { console.error('usage: PROBE_HOST=<host> [PROBE_PORT=22] [PROBE_USER=root] PROBE_PASS=<pass> node ' + process.argv[1]); process.exit(2) }
import { createPool } from '../../lib/pool.js'

const pool = createPool({
  host: process.env.PROBE_HOST, port: Number(process.env.PROBE_PORT || 22), username: process.env.PROBE_USER || 'root', password: process.env.PROBE_PASS,
  hostKeyMode: 'off', commandTimeoutMs: 5000, connectTimeoutMs: 8000,
})
const out = (r) => (typeof r === 'string' ? r : (r.stdout ?? r.text ?? '')).trim()

try {
  console.log('MaxSessions:', out(await pool.exec('sshd -T | grep -i maxsessions')))

  const surfaces = []
  for (let i = 0; i < 12; i++) surfaces.push(await pool.sftp())
  console.log('opened 12 concurrent surfaces ok')

  // Count open session channels on the sshd side: each sftp subsystem channel
  // holds an open fd pair in the sshd child handling our connection.
  const conns = out(await pool.exec("ss -tnp | grep sshd | grep -v 'sshd:' | head -5"))
  console.log('sshd connections:\n' + conns)

  const chan = out(await pool.exec("lsof -p $(pgrep -f 'sshd: root@' | head -1) 2>/dev/null | grep -c '' || echo n/a"))
  console.log('fd count of our sshd child:', chan)
} finally {
  await pool.close()
}
