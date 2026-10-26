// Manual probe (NOT part of the test suite): does the native backend leak
// sftp subchannels on the server, and does the issue #65 fix let a pool
// recover after a forced stall?
if (!process.env.PROBE_HOST) { console.error('usage: PROBE_HOST=<host> [PROBE_PORT=22] [PROBE_USER=root] PROBE_PASS=<pass> node ' + process.argv[1]); process.exit(2) }
import { createPool } from '../../lib/pool.js'

const config = {
  host: process.env.PROBE_HOST, port: Number(process.env.PROBE_PORT || 22), username: process.env.PROBE_USER || 'root', password: process.env.PROBE_PASS,
  privateKeyPath: '', passphrase: '', hostKeyMode: 'off',
  commandTimeoutMs: 3000, connectTimeoutMs: 8000,
  useAgent: false, keyboardInteractive: false,
}
const pool = createPool(config)

const countRemote = async () => {
  const r = await pool.exec('ps -eo pid,etimes,comm | grep sftp-server | grep -v grep || true')
  const text = typeof r === 'string' ? r : (r.stdout ?? r.text ?? JSON.stringify(r))
  return text.trim().split('\n').filter(Boolean)
}

try {
  console.log('before:', await countRemote())

  // 15 sequential sftp() calls — beyond sshd MaxSessions=10 if channels leak.
  for (let i = 0; i < 15; i++) {
    const sftp = await pool.sftp()
    const st = await sftp.stat('/root')
    process.stdout.write(`call ${i + 1}: ok(size=${st.size}) `)
  }
  console.log()
  console.log('after 15 calls:', await countRemote())

  // Force a wedged operation: low timeout + a huge slow read is hard to stage;
  // instead emulate by shrinking timeout and stating through a stall is
  // unreliable over WAN — so just verify the surface closes on demand path:
  // two consecutive surfaces each fine, then invalidate() recovers.
  pool.invalidate()
  const sftp2 = await pool.sftp()
  await sftp2.readdir('/root')
  console.log('after invalidate + reopen: ok')
  console.log('final:', await countRemote())
} catch (e) {
  console.error('PROBE FAILED:', e.message)
  process.exitCode = 1
} finally {
  await pool.close()
}
