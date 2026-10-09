// dsh-remote — host-side deploy task manager.
//
// WHY THIS EXISTS: `install` used to be a single long HTTP request (npm can
// legitimately take minutes). If the browser tab closed — or the fetch was
// cancelled — the RESPONSE was lost and, with it, every trace of what the
// deploy did: the user could not see the progress again, could not tell whether
// it succeeded, and clicking the button again would start a SECOND concurrent
// npm install into the same prefix. High availability here means:
//
//   · the deploy runs on the HOST, not tied to any request lifecycle;
//   · every step's outcome is recorded as it happens;
//   · the UI can re-attach at any time and see the live state;
//   · a second click while one is running RE-ATTACHES instead of restarting;
//   · the result (including the machine's webAttachCommand) is recorded even
//     if no client ever polls for it.
//
// One deploy per machine at a time — npm --prefix into the same directory from
// two processes corrupts the tree. A NEW request for a machine that already has
// a running or finished deploy returns the EXISTING task (resume semantics);
// `force: true` starts a fresh one after the previous is finished.

/** A deploy task's lifecycle: queued → running → done | failed | cancelled. */
export class DeployTasks {
  constructor() {
    /** @type {Map<string, object>} machineId → task */
    this.byMachine = new Map()
    /** @type {Map<string, object>} taskId → task (for stable polling) */
    this.byId = new Map()
    this.nextId = 1
  }

  /**
   * The task for a machine, if one exists in ANY state.
   * @returns {object|null}
   */
  forMachine(machineId) {
    return this.byMachine.get(String(machineId || '')) || null
  }

  get(id) {
    return this.byId.get(String(id || '')) || null
  }

  /**
   * Start a deploy for a machine, unless one is already running.
   *
   * @param {string} machineId
   * @param {Function} fn - async (ctx) => result. ctx = { progress(patch) }.
   * @returns {{task: object, reused: boolean}} the task plus whether it already
   *   existed (caller reports "resumed" so the UI does not claim a fresh start).
   */
  start(machineId, label, fn) {
    const mid = String(machineId || '')
    const existing = this.byMachine.get(mid)
    if (existing && (existing.status === 'queued' || existing.status === 'running')) {
      return { task: existing, reused: true }
    }
    const id = `deploy-${this.nextId++}`
    const task = {
      id,
      machineId: mid,
      kind: 'deploy',
      label: String(label || ''),
      status: 'queued',
      // Steps are appended as they finish; `steps` is what the UI renders.
      steps: [],
      // The current in-flight step, so a re-attached UI can show "正在安装…"
      // rather than a stale list with no hint that more is coming.
      current: '',
      progress: {},
      result: null,
      error: null,
      startedAt: null,
      finishedAt: null,
      cancelled: false,
    }
    this.byMachine.set(mid, task)
    this.byId.set(id, task)
    // Deliberately NOT queued through the shared TaskManager: that one is
    // single-flight across ALL tasks (one sync at a time), while deploys to
    // DIFFERENT machines must run in parallel.
    task.status = 'running'
    task.startedAt = new Date().toISOString()
    const ctx = {
      progress: (p) => { task.progress = { ...task.progress, ...p } },
      get cancelled() { return !!task.cancelled },
    }
    Promise.resolve()
      .then(() => fn(ctx))
      .then((result) => {
        task.result = result || null
        task.status = task.cancelled ? 'cancelled' : 'done'
      })
      .catch((err) => {
        task.error = String((err && err.message) || err)
        // A step-level failure carries the step list (and hints) as structured
        // data so the UI can render exactly what the old single-response flow
        // rendered — re-attaching must lose nothing.
        if (err && err.detail && typeof err.detail === 'object') task.detail = err.detail
        task.status = task.cancelled ? 'cancelled' : 'failed'
      })
      .finally(() => {
        task.current = ''
        task.finishedAt = new Date().toISOString()
      })
    return { task, reused: false }
  }

  /** Cooperative cancel (a running npm step still finishes; later steps stop). */
  cancel(machineId) {
    const t = this.byMachine.get(String(machineId || ''))
    if (!t) return false
    if (t.status === 'queued' || t.status === 'running') {
      t.cancelled = true
      return true
    }
    return false
  }

  /** Serializable view for the UI. */
  describe(t) {
    if (!t) return null
    return {
      id: t.id,
      machineId: t.machineId,
      kind: t.kind,
      status: t.status,           // queued | running | done | failed | cancelled
      steps: t.steps,             // [{id,title,ok,code,output}]
      current: t.current,         // in-flight step title ('' when none)
      progress: t.progress,
      result: t.result,
      error: t.error,
      detail: t.detail || null,
      startedAt: t.startedAt,
      finishedAt: t.finishedAt,
    }
  }

  list() {
    return [...this.byMachine.values()].map((t) => this.describe(t))
  }
}
