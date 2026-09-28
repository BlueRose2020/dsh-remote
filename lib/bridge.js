/**
 * Child-process manager for the Python WeChat bridge.
 *
 * The bridge speaks newline-delimited JSON on stdin/stdout. Requests are
 * serialized (the bridge takes a lock anyway) and each one carries a numeric
 * id echoed on the reply, so a slow OCR command can never be confused with the
 * next one. stderr is forwarded to the plugin logger for diagnosis.
 *
 * @module dsh-remote/bridge
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
export const DEFAULT_BRIDGE_SCRIPT = join(HERE, '..', 'bridge', 'wechat_bridge.py')

/** Cap on buffered stderr kept for diagnostics. */
const STDERR_TAIL_LINES = 40

/**
 * One request/response session with the Python bridge process.
 *
 * Lifecycle: `start()` spawns lazily and is idempotent; `stop()` settles every
 * pending request instead of leaving callers hanging. A crash marks the bridge
 * `failed`, and the next `request()` restarts it, so a killed Python process
 * self-heals on the following poll tick.
 */
export class WeChatBridge {
  #pythonPath
  #scriptPath
  #logger
  #timeoutMs
  #child = null
  #buffer = ''
  #nextId = 1
  #pending = new Map()
  #chain = Promise.resolve()
  #stderrTail = []
  #state = 'stopped'
  #lastError = null

  /**
   * @param options - python executable, bridge script path, logger, timeout.
   */
  constructor({ pythonPath = 'python', scriptPath = DEFAULT_BRIDGE_SCRIPT, logger, timeoutMs = 45000 } = {}) {
    this.#pythonPath = pythonPath
    this.#scriptPath = scriptPath
    this.#logger = logger
    this.#timeoutMs = timeoutMs
  }

  /** Current lifecycle state: `stopped` | `ready` | `failed`. */
  get state() {
    return this.#state
  }

  /** PID of the live child process, or null. Useful for diagnostics and tests. */
  get childPid() {
    return this.#child?.pid ?? null
  }

  /** Last transport-level failure, for status reporting. */
  get lastError() {
    return this.#lastError
  }

  /** Tail of the bridge's stderr, newest last. */
  get stderrTail() {
    return [...this.#stderrTail]
  }

  /** Resolved absolute path of the bridge script actually in use. */
  get scriptPath() {
    return this.#scriptPath
  }

  /** Whether the configured script exists on disk. */
  scriptExists() {
    return existsSync(this.#scriptPath)
  }

  /**
   * Spawn the bridge if it is not already running.
   * @returns true when the child process is live.
   */
  async start() {
    if (this.#child !== null && this.#child.exitCode === null && !this.#child.killed) return true
    if (!this.scriptExists()) {
      this.#state = 'failed'
      this.#lastError = `bridge script not found: ${this.#scriptPath}`
      return false
    }
    const script = isAbsolute(this.#scriptPath) ? this.#scriptPath : resolve(this.#scriptPath)
    let child
    try {
      child = spawn(this.#pythonPath, ['-u', script], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        // Keep Python from scattering __pycache__ into the plugin's own source tree.
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      })
    } catch (error) {
      this.#state = 'failed'
      this.#lastError = `cannot spawn ${this.#pythonPath}: ${String(error)}`
      return false
    }
    this.#child = child
    this.#buffer = ''
    this.#stderrTail = []
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.#onStdout(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => this.#onStderr(chunk))
    child.on('error', (error) => {
      if (this.#child !== child) return // superseded, or intentionally stopped
      this.#state = 'failed'
      this.#lastError = `bridge process error: ${String(error)}`
      this.#logger?.warn?.(`wechat bridge process error: ${String(error)}`)
      this.#rejectAll(this.#lastError)
    })
    child.on('exit', (code) => {
      // A deliberate `stop()` clears `#child` before the child dies; without
      // this guard its exit would overwrite 'stopped' with 'failed' and the
      // plugin would report a crash that never happened.
      if (this.#child !== child) return
      this.#state = 'failed'
      this.#lastError = `bridge exited with code ${String(code)}`
      this.#logger?.warn?.(`wechat bridge exited (code ${String(code)})`)
      this.#child = null
      this.#rejectAll(this.#lastError)
    })
    const ok = await this.#handshake()
    this.#state = ok ? 'ready' : 'failed'
    return ok
  }

  /** Send one command and resolve with its `result` payload. */
  async request(cmd, payload = {}, timeoutMs = this.#timeoutMs) {
    if (this.#child === null) {
      const started = await this.start()
      if (!started) throw new Error(this.#lastError ?? 'wechat bridge unavailable')
    }
    // Serialize: the Python side holds a lock, so queuing here keeps ordering
    // deterministic and stops a timeout from desynchronizing the stream.
    const run = this.#chain.then(() => this.#dispatch(cmd, payload, timeoutMs))
    this.#chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async #dispatch(cmd, payload, timeoutMs) {
    const child = this.#child
    if (child === null || child.exitCode !== null) throw new Error(this.#lastError ?? 'wechat bridge is not running')
    const id = this.#nextId++
    const line = `${JSON.stringify({ id, cmd, ...payload })}\n`
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        rejectPromise(new Error(`wechat bridge timed out after ${timeoutMs}ms on '${cmd}'`))
      }, timeoutMs)
      this.#pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer, cmd })
      try {
        child.stdin.write(line)
      } catch (error) {
        clearTimeout(timer)
        this.#pending.delete(id)
        rejectPromise(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  async #handshake() {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.request('ping', {}, 20000)
        return true
      } catch (error) {
        if (attempt === 2) {
          this.#lastError = String(error?.message ?? error)
          this.#logger?.warn?.(`wechat bridge handshake failed: ${this.#lastError}`)
          return false
        }
        await new Promise((r) => setTimeout(r, 500))
      }
    }
    return false
  }

  #onStdout(chunk) {
    this.#buffer += chunk
    let index = this.#buffer.indexOf('\n')
    while (index >= 0) {
      const line = this.#buffer.slice(0, index).trim()
      this.#buffer = this.#buffer.slice(index + 1)
      if (line) this.#onLine(line)
      index = this.#buffer.indexOf('\n')
    }
  }

  #onLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      this.#logger?.warn?.(`wechat bridge emitted a non-JSON line: ${line.slice(0, 200)}`)
      return
    }
    const entry = this.#pending.get(message.id)
    if (entry === undefined) {
      this.#logger?.warn?.(`wechat bridge replied to unknown request ${String(message.id)}`)
      return
    }
    this.#pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.ok === true) entry.resolve(message.result ?? {})
    else {
      const detail = message.error ?? {}
      const error = new Error(detail.message ?? 'wechat bridge command failed')
      error.code = detail.code
      entry.reject(error)
    }
  }

  #onStderr(chunk) {
    const text = String(chunk)
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trimEnd()
      if (!trimmed) continue
      this.#stderrTail.push(trimmed)
      if (this.#stderrTail.length > STDERR_TAIL_LINES) this.#stderrTail.shift()
      this.#logger?.debug?.(`wechat bridge: ${trimmed}`)
    }
  }

  #rejectAll(reason) {
    for (const [, entry] of this.#pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error(reason))
    }
    this.#pending.clear()
  }

  /** Ask the child to exit, then make sure it is gone. */
  async stop() {
    const child = this.#child
    this.#child = null
    this.#state = 'stopped'
    this.#rejectAll('wechat bridge stopped')
    if (child === null || child.exitCode !== null) return
    try {
      child.stdin.write(`${JSON.stringify({ id: 0, cmd: 'shutdown' })}\n`)
    } catch {
      /* the pipe is already gone; kill below handles it */
    }
    await new Promise((resolvePromise) => {
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          /* already exited */
        }
        resolvePromise()
      }, 1500)
      child.once('exit', () => {
        clearTimeout(timer)
        resolvePromise()
      })
    })
  }
}
