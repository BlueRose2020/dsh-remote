/**
 * Tiny durable state for the remote-channel plugin.
 *
 * Only the pieces that must survive a DSH restart live here — above all the
 * target session, because after a restart no agent is live and "auto" has
 * nothing to resolve, which would silently break remote control.
 *
 * Deliberately a plain JSON file with best-effort semantics: a missing or
 * corrupt file must never stop the plugin from loading.
 *
 * @module dsh-remote/state-store
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Where the state file lives: `$DSH_HOME/storages/remote-channel.json`, falling
 * back to `~/.dsh` when `DSH_HOME` is unset.
 * @returns an absolute path.
 */
export function defaultStateFile() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  return join(home, 'storages', 'remote-channel.json')
}

export class StateStore {
  #file
  #logger
  #data = {}

  /**
   * @param options - `file` overrides the location, `logger` receives warnings.
   */
  constructor({ file = defaultStateFile(), logger } = {}) {
    this.#file = file
    this.#logger = logger
  }

  get file() {
    return this.#file
  }

  /** Read the file, tolerating absence and corruption. */
  load() {
    try {
      const raw = readFileSync(this.#file, 'utf8')
      const parsed = JSON.parse(raw)
      this.#data = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.#logger?.warn?.(`ignoring unreadable state file ${this.#file}: ${String(error?.message ?? error)}`)
      }
      this.#data = {}
    }
    return this.#data
  }

  /** @returns the current value for `key`, or undefined. */
  get(key) {
    return this.#data[key]
  }

  /**
   * Merge `patch` into the stored object and flush it.
   * @param patch - keys to write.
   * @returns true when the write succeeded.
   */
  save(patch) {
    this.#data = { ...this.#data, ...patch }
    try {
      mkdirSync(dirname(this.#file), { recursive: true })
      writeFileSync(this.#file, `${JSON.stringify(this.#data, null, 2)}\n`, 'utf8')
      return true
    } catch (error) {
      this.#logger?.warn?.(`could not persist state to ${this.#file}: ${String(error?.message ?? error)}`)
      return false
    }
  }
}
