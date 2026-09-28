/**
 * `wechat-local` transport — the local Windows WeChat 4.x client, driven
 * through the Python bridge (screen capture + Windows OCR to read, clipboard
 * paste to send).
 *
 * Owns the bridge process plus its two loops: a status loop that keeps the
 * login verdict fresh, and a poll loop that diffs 文件传输助手 for new
 * messages. Inbound messages are published through `onMessage`.
 *
 * @module dsh-plugin-remote/channels/wechat-local
 */
import { WeChatBridge, DEFAULT_BRIDGE_SCRIPT } from '../bridge.js'

/** Channel id used in configuration and status output. */
export const ID = 'wechat-local'

export class WeChatLocalChannel {
  #config
  #logger
  #bridge
  #messageHandlers = new Set()
  #statusHandlers = new Set()
  #timers = []
  #pollBusy = false
  #statusBusy = false
  #disposed = false

  #loggedIn = false
  #wechatRunning = false
  #notes = []
  #lastError = null
  #chatWindow = null
  #skipped = null
  #counters = { sent: 0, received: 0 }

  /**
   * @param config - the `wechat:` config block.
   * @param deps - plugin logger. (This transport never logs inbound text — the
   *   plugin's own trace does, already redacted — so it needs no redactor.)
   */
  constructor(config, { logger }) {
    this.#config = config
    this.#logger = logger
    this.#bridge = new WeChatBridge({
      pythonPath: config.pythonPath,
      scriptPath: config.bridgeScript && config.bridgeScript.length > 0
        ? config.bridgeScript
        : DEFAULT_BRIDGE_SCRIPT,
      logger,
      timeoutMs: config.requestTimeoutMs,
    })
  }

  get id() {
    return ID
  }

  get label() {
    return '微信 · 文件传输助手'
  }

  /** Whether notifications may be sent right now. */
  get ready() {
    return !this.#disposed && this.#bridge.state === 'ready' && this.#loggedIn
  }

  get state() {
    return this.#bridge.state
  }

  get counters() {
    return { ...this.#counters }
  }

  /** Subscribe to inbound messages; returns a disposer. */
  onMessage(handler) {
    this.#messageHandlers.add(handler)
    return () => this.#messageHandlers.delete(handler)
  }

  /** Subscribe to login/transport state changes; returns a disposer. */
  onStatus(handler) {
    this.#statusHandlers.add(handler)
    return () => this.#statusHandlers.delete(handler)
  }

  #publishStatus() {
    const snapshot = this.statusSync()
    for (const handler of this.#statusHandlers) {
      try {
        handler(snapshot)
      } catch (error) {
        this.#logger?.warn?.(`wechat status handler failed: ${String(error)}`)
      }
    }
  }

  /** Synchronous view of the last observed state. */
  statusSync() {
    return {
      id: ID,
      label: this.label,
      state: this.#bridge.state,
      ready: this.ready,
      detail: {
        wechatRunning: this.#wechatRunning,
        loggedIn: this.#loggedIn,
        chatWindow: this.#chatWindow,
        passive: this.#config.passive !== false,
        skipped: this.#skipped,
        scriptPath: this.#bridge.scriptPath,
        lastError: this.#lastError,
        notes: [...this.#notes],
        ...this.#counters,
      },
    }
  }

  /** Ask the bridge for a fresh status (and, first time, prove the chat renders). */
  async refreshStatus({ probeOcr = false } = {}) {
    if (this.#disposed) return this.statusSync()
    try {
      const result = await this.#bridge.request('status', { probeOcr })
      this.#wechatRunning = Boolean(result.wechatRunning)
      this.#loggedIn = Boolean(result.loggedIn)
      this.#notes = Array.isArray(result.notes) ? result.notes : []
      this.#chatWindow = result.chatWindow ?? null
      this.#lastError = null
    } catch (error) {
      this.#lastError = String(error?.message ?? error)
      this.#loggedIn = false
    }
    this.#publishStatus()
    return this.statusSync()
  }

  /**
   * Send one message to 文件传输助手.
   *
   * A failure is usually a closed chat window rather than a dead transport, so
   * one retry is attempted after asking the bridge to re-open the chat.
   * @param text - body.
   * @param options - `verify` also confirms the bubble rendered.
   * @returns true when the bridge accepted the send.
   */
  async send(text, { verify = false } = {}) {
    if (this.#disposed) return false
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.#bridge.request('send', { text, verify })
        this.#counters.sent += 1
        this.#lastError = null
        return true
      } catch (error) {
        this.#lastError = String(error?.message ?? error)
        if (attempt === 0) {
          this.#logger?.debug?.(`wechat send failed (${this.#lastError}); re-opening the chat and retrying`)
          try {
            await this.#bridge.request('reopen_chat', {}, 90000)
          } catch (reopenError) {
            this.#logger?.debug?.(`reopen_chat failed: ${String(reopenError?.message ?? reopenError)}`)
          }
          await new Promise((resolve) => setTimeout(resolve, 1500))
        }
      }
    }
    this.#logger?.warn?.(`wechat send failed: ${this.#lastError}`)
    return false
  }

  /**
   * Send one image (base64 PNG) into 文件传输助手.
   * @param pngBase64 - raw base64 without a data: prefix.
   * @param options - optional `caption`, sent as a text message first.
   * @returns true when the bridge accepted the paste.
   */
  async sendImage(pngBase64, options = {}) {
    if (this.#disposed) return false
    try {
      await this.#bridge.request('send_image', { png: pngBase64, caption: options.caption })
      this.#counters.sent += 1
      this.#lastError = null
      return true
    } catch (error) {
      this.#lastError = String(error?.message ?? error)
      this.#logger?.warn?.(`wechat image send failed: ${this.#lastError}`)
      return false
    }
  }

  /**
   * Capture the desktop (or one window) as base64 PNG through the bridge.
   * `maxWidth <= 0` keeps the native, pixel-exact capture.
   */
  async screenshot({ maxWidth = 0, windowTitle = null } = {}) {
    return this.#bridge.request('screenshot', { maxWidth, windowTitle })
  }

  /** Spawn the bridge and start both loops. */
  async start() {
    this.#disposed = false
    const started = await this.#bridge.start()
    if (!started) {
      this.#logger?.warn?.(`wechat bridge unavailable: ${this.#bridge.lastError ?? 'unknown error'}`)
      this.#publishStatus()
      return
    }
    await this.refreshStatus({ probeOcr: true })

    const pollTimer = setInterval(() => void this.#pollTick(), Math.max(1500, this.#config.pollIntervalMs))
    const statusTimer = setInterval(() => void this.#statusTick(), Math.max(10000, this.#config.statusIntervalMs))
    // A `stop()` that landed during the awaits above wins: its disposal must not
    // be undone by timers created just after it ran (they would never be cleared
    // and the channel would look stopped while still ticking).
    if (this.#disposed) {
      clearInterval(pollTimer)
      clearInterval(statusTimer)
      return
    }
    this.#timers = [pollTimer, statusTimer]
  }

  async #pollTick() {
    if (this.#disposed || this.#pollBusy || !this.#loggedIn) return
    this.#pollBusy = true
    try {
      // `passive` keeps the poll from navigating WeChat: it reads only what is
      // already on screen and reports a skip otherwise. Sending still needs the
      // window, but a background reader must never move the user's screen.
      const result = await this.#bridge.request('poll', { autoOpen: this.#config.passive !== true })
      const messages = Array.isArray(result.messages) ? result.messages : []
      this.#lastError = null
      if (result.skipped !== undefined) {
        this.#skipped = result.skipped
        return
      }
      this.#skipped = null
      for (const message of messages) {
        const text = String(message.text ?? '').trim()
        if (!text) continue
        this.#counters.received += 1
        this.#dispatch({ transport: ID, text, senderId: null, conversation: 'file-transfer-helper', raw: message })
      }
    } catch (error) {
      this.#lastError = String(error?.message ?? error)
      // A poll racing shutdown is expected, not a failure worth warning about.
      if (!this.#disposed) this.#logger?.warn?.(`wechat poll failed: ${this.#lastError}`)
    } finally {
      this.#pollBusy = false
    }
  }

  async #statusTick() {
    if (this.#disposed || this.#statusBusy) return
    this.#statusBusy = true
    try {
      await this.refreshStatus({ probeOcr: false })
    } finally {
      this.#statusBusy = false
    }
  }

  #dispatch(message) {
    for (const handler of this.#messageHandlers) {
      try {
        handler(message)
      } catch (error) {
        this.#logger?.warn?.(`wechat message handler failed: ${String(error)}`)
      }
    }
  }

  /** Stop the loops and the bridge process. */
  async stop() {
    this.#disposed = true
    for (const timer of this.#timers) clearInterval(timer)
    this.#timers = []
    await this.#bridge.stop()
    this.#loggedIn = false
    this.#publishStatus()
  }
}

export default WeChatLocalChannel
