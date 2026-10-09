// Tests for the host-side deploy task manager (high availability of the deploy
// flow: progress must survive the browser window closing).
//
// The guarantee under test: the deploy runs on the HOST detached from any
// request, every step's outcome is recorded as it happens, and a RE-ATTACH
// (new poll, second button click, reopened window) sees the live state instead
// of starting a concurrent npm into the same prefix.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DeployTasks } from '../lib/deploy-tasks.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A controllable step-runner factory: each call to `next()` finishes one step. */
function gatedTask(steps, gates) {
  return {
    run: (ctx) => new Promise((resolve, reject) => {
      let i = 0
      const step = async () => {
        if (i >= steps.length) return resolve({ ok: true })
        const s = steps[i]
        ctx.progress({ doneSteps: i, totalSteps: steps.length })
        try { await gates[i]() } catch (err) { return reject(err) }
        i++
        if (s.fail) return reject(Object.assign(new Error(s.fail), { detail: { steps: [{ id: s.id, ok: false }] } }))
        step()
      }
      step()
    }),
  }
}

test('a deploy task records steps as they complete and reaches done', async () => {
  const dt = new DeployTasks()
  const { run } = gatedTask(
    [{ id: 's1' }, { id: 's2' }, { id: 's3' }],
    [() => {}, () => {}, () => {}],
  )
  const { task, reused } = dt.start('m1', 'deploy h', run)
  assert.equal(reused, false)
  assert.equal(task.status, 'running')
  await sleep(30)
  assert.equal(task.status, 'done')
  assert.ok(task.result && task.result.ok)
  assert.ok(task.finishedAt, 'finishedAt is set')
})

test('a second start for the SAME machine RESUMES instead of restarting', async () => {
  // Two concurrent `npm --prefix` into one directory corrupt the tree — this is
  // the invariant that makes the resumed-click safe.
  const dt = new DeployTasks()
  let started = 0
  const slow = (ctx) => new Promise((resolve) => setTimeout(() => { started++; resolve({ ok: true }) }, 80))
  const first = dt.start('m1', 'deploy', slow)
  const second = dt.start('m1', 'deploy', slow)
  assert.equal(second.reused, true, 'the second start reuses')
  assert.equal(second.task, first.task, 'and it is the SAME task object')
  await sleep(120)
  assert.equal(started, 1, 'the work ran exactly once')
})

test('a FAILED task keeps its message AND structured step detail', async () => {
  const dt = new DeployTasks()
  const fail = () => Promise.reject(Object.assign(
    new Error('安装失败于「安装 dsh 到私有目录」'),
    { detail: { steps: [{ id: 'install', ok: false }], suggestInvestigate: true } },
  ))
  const { task } = dt.start('m1', 'deploy', fail)
  await sleep(20)
  assert.equal(task.status, 'failed')
  assert.match(task.error, /安装失败/)
  assert.ok(task.detail && task.detail.suggestInvestigate, 'the detail a resumed UI needs survives')
  assert.ok(task.detail.steps.length === 1)
})

test('a finished task can be replaced by a NEW start (re-deploy)', async () => {
  const dt = new DeployTasks()
  const { task: t1 } = dt.start('m1', 'deploy', () => Promise.resolve({ ok: true }))
  await sleep(20)
  assert.equal(t1.status, 'done')
  const { task: t2, reused } = dt.start('m1', 'deploy', () => Promise.resolve({ ok: true, again: true }))
  assert.equal(reused, false, 'a done task does not block a re-deploy')
  assert.notEqual(t2, t1)
  await sleep(20)
  assert.ok(t2.result.again)
})

test('cancel is cooperative and settles the task as cancelled', async () => {
  const dt = new DeployTasks()
  let finished = false
  const { task } = dt.start('m1', 'deploy', (ctx) => new Promise((resolve) => {
    const iv = setInterval(() => {
      if (ctx.cancelled) { clearInterval(iv); finished = true; resolve(null) }
    }, 5)
  }))
  assert.equal(dt.cancel('m1'), true)
  await sleep(40)
  assert.equal(task.status, 'cancelled')
  assert.equal(finished, true, 'the runner observed the cancellation')
  assert.equal(dt.cancel('m1'), false, 'cancelling a settled task is a no-op')
})

test('describe() carries everything a re-attached UI renders', () => {
  const dt = new DeployTasks()
  const { task } = dt.start('m1', 'deploy', () => Promise.resolve({ ok: true }))
  task.steps = [{ id: 'prepare', title: '准备', ok: true, code: 0, output: 'OK' }]
  task.current = '安装 dsh 到私有目录'
  const d = dt.describe(task)
  assert.equal(d.machineId, 'm1')
  assert.equal(d.status, 'running')
  assert.equal(d.current, '安装 dsh 到私有目录')
  assert.equal(d.steps.length, 1)
  assert.ok(d.startedAt)
  assert.equal(d.finishedAt, null, 'not finished yet')
})

test('tasks for DIFFERENT machines run in parallel (not single-flight)', async () => {
  // The shared TaskManager is one-at-a-time across everything (right for syncs
  // sharing one pool); deploys to different machines must NOT serialize.
  const dt = new DeployTasks()
  const order = []
  const mk = (name) => (ctx) => new Promise((resolve) => {
    order.push(name + ':start')
    setTimeout(() => { order.push(name + ':end'); resolve({ ok: true }) }, 40)
  })
  dt.start('m1', 'a', mk('a'))
  dt.start('m2', 'b', mk('b'))
  await sleep(80)
  assert.deepEqual(order, ['a:start', 'b:start', 'a:end', 'b:end'],
    'interleaved execution — no serialization')
})
