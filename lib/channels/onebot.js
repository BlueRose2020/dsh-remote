/**
 * `onebot` transport — a personal QQ account exposed through the OneBot 11
 * protocol by a local client such as NapCatQQ, Lagrange.Core or LLOneBot.
 *
 * Unlike the official QQ bot platform, OneBot runs *your own* QQ account, so
 * the conversation looks exactly like WeChat's 文件传输助手: you talk to
 * yourself (QQ's 我的电脑 / a private chat with a second account / a
 * two-person group) and this process reads and answers it.
 *
 * Everything travels over one WebSocket: inbound events arrive as JSON frames
 * and outbound messages are `send_*_msg` actions on the same socket, so no
 * public endpoint, port-forward or tunnel is needed.
 *
 * Security posture: a group message is ignored unless its group id is listed in
 * `groupAllowFrom`, and a private message is ignored unless its sender is in
 * `privateAllowFrom` (an empty list means "any sender"). Senders are always
 * logged so the ids needed to lock it down are easy to find.
 *
 * @module dsh-plugin-remote/channels/onebot
 */
import WebSocket from 'ws'
import { copyFile, writeFile } from 'node:fs/promises'

/** Channel id used in configuration and status output. */
export const ID = 'onebot'

/** How long to wait for an action echo before failing the send. */
const DEFAULT_ACTION_TIMEOUT_MS = 15000

export class OneBotChannel {
  #config
  #logger
  /** Strips configured passwords out of anything logged. */
  #redact
  #socket = null
  #messageHandlers = new Set()
  #statusHandlers = new Set()
  #pending = new Map()
  #echoSeq = 0
  #reconnectTimer = null
  #disposed = false
  #state = 'stopped'
  #lastError = null
  #selfId = null
  #lastSender = null
  #autoTarget = null
  #counters = { sent: 0, received: 0 }
  #retryDelay

  /**
   * @param config - the `onebot:` config block.
   * @param deps - plugin logger, plus an optional `redact` used on inbound text
   *   before it is logged (an authorizing message *is* the password).
   */
  constructor(config, { logger, redact = null }) {
    this.#config = config
    this.#logger = logger
    this.#redact = typeof redact === 'function' ? redact : (value) => String(value ?? '')
    this.#retryDelay = Math.max(1000, config.reconnectMs)
  }

  get id() {
    return ID
  }

  get label() {
    return `QQ · OneBot (${this.#config.url})`
  }

  get ready() {
    return !this.#disposed && this.#state === 'ready' && this.#socket?.readyState === WebSocket.OPEN
  }

  get state() {
    return this.#state
  }

  get counters() {
    return { ...this.#counters }
  }

  /** Subscribe to inbound messages; returns a disposer. */
  onMessage(handler) {
    this.#messageHandlers.add(handler)
    return () => this.#messageHandlers.delete(handler)
  }

  /** Subscribe to transport state changes; returns a disposer. */
  onStatus(handler) {
    this.#statusHandlers.add(handler)
    return () => this.#statusHandlers.delete(handler)
  }

  statusSync() {
    return {
      id: ID,
      label: this.label,
      state: this.#state,
      ready: this.ready,
      detail: {
        url: this.#config.url,
        selfId: this.#selfId,
        lastSender: this.#lastSender,
        autoTarget: this.#autoTarget,
        privateAllowlist: this.#privateAllowlist(),
        lastError: this.#lastError,
        ...this.#counters,
      },
    }
  }

  async refreshStatus() {
    if (this.ready) {
      try {
        const info = await this.#action('get_login_info', {})
        if (info?.user_id !== undefined) this.#selfId = String(info.user_id)
        await this.#discoverTarget()
        this.#lastError = null
      } catch (error) {
        this.#lastError = String(error?.message ?? error)
      }
    }
    this.#publishStatus()
    return this.statusSync()
  }

  /**
   * Learn where unsolicited messages should go.
   *
   * `ownerId` wins when configured. Otherwise an account with exactly one
   * friend — the common setup for a dedicated control account — needs no
   * configuration at all: that friend is the target.
   */
  async #discoverTarget() {
    if (this.#config.ownerId) {
      this.#autoTarget = null
      return
    }
    try {
      const friends = await this.#action('get_friend_list', {})
      const list = Array.isArray(friends) ? friends : []
      if (list.length === 1) {
        const only = list[0]
        this.#autoTarget = {
          type: 'private',
          id: String(only.user_id ?? only.uin ?? ''),
          nickname: only.nickname ?? only.remark ?? null,
        }
        this.#logger?.info?.(
          `onebot: single friend detected (${this.#autoTarget.nickname ?? '?'} / ${this.#autoTarget.id}) — using it as the notification target`,
        )
      } else {
        this.#autoTarget = null
        if (list.length > 1) {
          this.#logger?.info?.(
            `onebot: ${list.length} friends found; set onebot.ownerId to pin the target, or send a message first`,
          )
        }
      }
    } catch (error) {
      // get_friend_list is optional in OneBot 11; falling back to last-sender
      // targeting is fine.
      this.#logger?.debug?.(`onebot: get_friend_list unavailable (${String(error?.message ?? error)})`)
    }
  }

  #publishStatus() {
    const snapshot = this.statusSync()
    for (const handler of this.#statusHandlers) {
      try {
        handler(snapshot)
      } catch (error) {
        this.#logger?.warn?.(`onebot status handler failed: ${String(error)}`)
      }
    }
  }

  /** Open the WebSocket (and keep it open). */
  async start() {
    this.#disposed = false
    this.#connect()
  }

  #connect() {
    if (this.#disposed) return
    this.#state = 'connecting'
    const headers = this.#config.accessToken
      ? { Authorization: `Bearer ${this.#config.accessToken}` }
      : undefined
    let socket
    try {
      socket = new WebSocket(this.#config.url, { headers })
    } catch (error) {
      this.#fail(error)
      return
    }
    this.#socket = socket

    socket.on('open', () => {
      this.#state = 'ready'
      this.#logger?.info?.(`onebot connected to ${this.#config.url}`)
      this.#publishStatus()
      void this.refreshStatus()
    })
    socket.on('message', (data) => this.#onFrame(data))
    socket.on('error', (error) => this.#fail(error))
    socket.on('close', (code) => {
      if (this.#disposed) return
      this.#state = 'stopped'
      this.#lastError = `socket closed (code ${String(code)})`
      this.#rejectPending(this.#lastError)
      this.#publishStatus()
      this.#scheduleReconnect()
    })
  }

  #fail(error) {
    this.#lastError = String(error?.message ?? error)
    this.#logger?.warn?.(`onebot socket error: ${this.#lastError}`)
    this.#state = 'failed'
    this.#rejectPending(this.#lastError)
    this.#publishStatus()
    this.#scheduleReconnect()
  }

  #scheduleReconnect() {
    if (this.#disposed || this.#reconnectTimer !== null) return
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null
      this.#connect()
    }, this.#retryDelay)
  }

  #onFrame(data) {
    let payload
    try {
      payload = JSON.parse(String(data))
    } catch {
      this.#logger?.warn?.('onebot sent a non-JSON frame')
      return
    }

    // Action echo?
    if (payload.echo !== undefined && this.#pending.has(payload.echo)) {
      const entry = this.#pending.get(payload.echo)
      this.#pending.delete(payload.echo)
      clearTimeout(entry.timer)
      if (payload.status === 'ok' || payload.retcode === 0) entry.resolve(payload.data ?? {})
      else entry.reject(new Error(`onebot action ${entry.action} failed: ${payload.message ?? payload.wording ?? payload.retcode}`))
      return
    }

    if (payload.post_type === 'meta_event') {
      if (payload.meta_event_type === 'lifecycle' && payload.self_id !== undefined) {
        this.#selfId = String(payload.self_id)
      }
      return
    }

    if (payload.post_type === 'message' || payload.post_type === 'message_sent') {
      this.#onMessageEvent(payload)
      return
    }
  }

  /**
   * Who may send commands, and why.
   *
   * An empty allowlist must not mean "anyone": this channel can run commands on
   * the machine. The list is therefore derived — explicit config first, then
   * the configured notification target (which is who you are), then the single
   * auto-discovered friend. Only when none of those exist is it left open, and
   * that case is logged loudly.
   * @returns the effective allowlist and which rule produced it.
   */
  #privateAllowlist() {
    const explicit = (this.#config.privateAllowFrom ?? []).map(String).filter((id) => id !== '')
    if (explicit.length > 0) return { list: explicit, source: 'privateAllowFrom' }
    if (this.#config.ownerId) return { list: [String(this.#config.ownerId)], source: 'ownerId' }
    if (this.#autoTarget !== null && this.#autoTarget.id) {
      return { list: [this.#autoTarget.id], source: 'the single friend' }
    }
    return { list: [], source: 'none' }
  }

  #onMessageEvent(event) {
    const selfId = event.self_id !== undefined ? String(event.self_id) : this.#selfId
    if (event.self_id !== undefined) this.#selfId = String(event.self_id)
    const senderId = event.user_id !== undefined ? String(event.user_id) : null
    const groupId = event.group_id !== undefined ? String(event.group_id) : null
    const isSelf = senderId !== null && selfId !== null && senderId === selfId

    if (event.post_type === 'message_sent') {
      // Some implementations echo our own sends here; never treat those as input.
      return
    }
    if (isSelf && !this.#config.acceptSelfMessages) return

    if (event.message_type === 'group') {
      const allowed = this.#config.groupAllowFrom.map(String)
      if (!allowed.includes(groupId)) {
        this.#logger?.info?.(`onebot: ignoring group message from ${groupId} (not in groupAllowFrom)`)
        return
      }
    } else {
      const { list, source } = this.#privateAllowlist()
      if (list.length > 0) {
        if (!list.includes(senderId)) {
          this.#logger?.warn?.(`onebot: ignoring private message from ${senderId} (allowlist from ${source}: ${list.join(', ')})`)
          return
        }
      } else {
        this.#logger?.warn?.(
          `onebot: running a command from ${senderId} with NO allowlist — set onebot.ownerId (or privateAllowFrom) to stop anyone who can message this account from controlling the machine`,
        )
      }
    }

    const text = renderMessage(event)
    const attachments = extractAttachments(event)
    // An attachment-only message carries no text, and it is exactly the message
    // the attachment collector is waiting for — so never drop it here.
    if (!text.trim() && attachments.length === 0) return
    this.#lastSender = {
      userId: senderId,
      groupId,
      messageType: event.message_type === 'group' ? 'group' : 'private',
      nickname: event.sender?.card || event.sender?.nickname || null,
    }
    this.#counters.received += 1
    this.#logger?.info?.(`onebot inbound from ${senderId ?? groupId}: ${this.#redact(text).slice(0, 80)}`)
    const message = {
      transport: ID,
      text,
      senderId,
      attachments,
      conversation: groupId !== null ? `group:${groupId}` : `private:${senderId ?? 'unknown'}`,
      raw: { message_id: event.message_id, time: event.time, message_type: event.message_type },
    }
    for (const handler of this.#messageHandlers) {
      try {
        handler(message)
      } catch (error) {
        this.#logger?.warn?.(`onebot message handler failed: ${String(error)}`)
      }
    }
  }

  /**
   * One action, with an answer or a timeout.
   *
   * A timeout on an OPEN socket is not "the server is slow" — it is a link that
   * is already dead (half-open TCP, a NapCat restart, a socket left behind by a
   * plugin reload). Leaving it open turns one lost message into a channel that
   * silently drops everything while still reporting `ready`, so the socket is
   * closed here and the normal reconnect path rebuilds it. That is the whole
   * difference between "a send failed once" and "reports stopped arriving and
   * nothing said so".
   */
  #action(action, params, timeoutMs = DEFAULT_ACTION_TIMEOUT_MS) {
    const socket = this.#socket
    if (socket === null || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('onebot socket is not connected'))
    }
    const echo = `dsh-${++this.#echoSeq}`
    const frame = JSON.stringify({ action, params, echo })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(echo)
        this.#lastError = `onebot action ${action} timed out after ${timeoutMs}ms`
        this.#logger?.warn?.(`${this.#lastError} — closing the socket so it reconnects`)
        this.#dropDeadSocket()
        reject(new Error(this.#lastError))
      }, timeoutMs)
      this.#pending.set(echo, { resolve, reject, timer, action })
      try {
        socket.send(frame)
      } catch (error) {
        clearTimeout(timer)
        this.#pending.delete(echo)
        this.#dropDeadSocket()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /** Close a socket that is open but no longer answering. */
  #dropDeadSocket() {
    if (this.#disposed) return
    const socket = this.#socket
    this.#socket = null
    this.#state = 'stopped'
    this.#rejectPending(this.#lastError ?? 'socket dropped')
    this.#publishStatus()
    try {
      socket?.terminate?.()
    } catch {
      try {
        socket?.close?.()
      } catch {
        /* already gone */
      }
    }
    this.#scheduleReconnect()
  }

  #rejectPending(reason) {
    for (const [, entry] of this.#pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error(reason))
    }
    this.#pending.clear()
  }

  /** Where an outbound message should go when the caller does not say. */
  #resolvedTarget(explicit) {
    if (explicit !== undefined && explicit !== null) return explicit
    const { ownerId, target } = this.#config
    if (target === 'group' && ownerId) return { type: 'group', id: String(ownerId) }
    if (target === 'private' && ownerId) return { type: 'private', id: String(ownerId) }
    if (this.#lastSender !== null) {
      return this.#lastSender.groupId !== null
        ? { type: 'group', id: this.#lastSender.groupId }
        : { type: 'private', id: this.#lastSender.userId }
    }
    if (this.#autoTarget !== null && this.#autoTarget.id) return this.#autoTarget
    if (ownerId) return { type: target === 'group' ? 'group' : 'private', id: String(ownerId) }
    return null
  }

  /**
   * Send one text message.
   * @param text - body.
   * @param options - optional explicit `{ type, id }` target.
   * @returns true when the OneBot server acknowledged the action.
   */
  async send(text, options = {}) {
    return this.#sendMessage([{ type: 'text', data: { text } }], options)
  }

  /**
   * Save one inbound attachment to a local path.
   *
   * NapCat and friends disagree about where the bytes are: some events carry a
   * `url`, others only a `file_id` that needs `get_file`/`get_image`, and the
   * answer to that may itself be a URL, a local path, or `base64://`. All shapes
   * are tried in order so the caller can just say "save it here".
   * @param attachment - an entry from {@link extractAttachments}.
   * @param targetPath - absolute destination file path.
   * @returns bytes written, or null when a local file was copied.
   */
  async downloadAttachment(attachment, targetPath) {
    const candidates = []
    if (attachment?.url) candidates.push(attachment.url)
    if (attachment?.fileId) {
      candidates.push(attachment.fileId)
      const action = attachment.kind === 'image' ? 'get_image' : 'get_file'
      try {
        const answer = await this.#action(action, { file: attachment.fileId })
        if (typeof answer?.base64 === 'string') candidates.push(`base64://${answer.base64}`)
        if (typeof answer?.url === 'string') candidates.push(answer.url)
        if (typeof answer?.file === 'string') candidates.push(answer.file)
      } catch (error) {
        this.#logger?.warn?.(`onebot ${action} failed: ${String(error?.message ?? error)}`)
      }
    }
    for (const candidate of candidates) {
      if (candidate.startsWith('base64://')) {
        const bytes = Buffer.from(candidate.slice('base64://'.length), 'base64')
        await writeFile(targetPath, bytes)
        return bytes.length
      }
      if (/^https?:\/\//i.test(candidate)) {
        try {
          const response = await fetch(candidate)
          if (!response.ok) continue
          const bytes = Buffer.from(await response.arrayBuffer())
          await writeFile(targetPath, bytes)
          return bytes.length
        } catch {
          continue
        }
      }
      // A local path the client already wrote (NapCat does this for files).
      try {
        await copyFile(candidate, targetPath)
        return null
      } catch {
        continue
      }
    }
    throw new Error(`无法获取附件内容（${attachment?.kind ?? 'unknown'} / ${attachment?.name ?? '未命名'}）`)
  }

  /**
   * Send one base64 PNG.
   * @param pngBase64 - raw base64 (no data: prefix).
   * @param options - optional `caption` and explicit `{ type, id }` target.
   * @returns true when the OneBot server acknowledged the action.
   */
  async sendImage(pngBase64, options = {}) {
    const segments = []
    if (options.caption) segments.push({ type: 'text', data: { text: `${options.caption}\n` } })
    segments.push({ type: 'image', data: { file: `base64://${pngBase64}` } })
    return this.#sendMessage(segments, options)
  }

  async #sendMessage(segments, options = {}) {
    if (!this.ready) {
      this.#lastError = 'onebot is not connected'
      return false
    }
    const destination = this.#resolvedTarget(options.target)
    if (destination === null || !destination.id) {
      this.#lastError = 'no OneBot target: set onebot.ownerId, add exactly one friend, or send a message first'
      this.#logger?.warn?.(this.#lastError)
      return false
    }
    try {
      if (destination.type === 'group') {
        await this.#action('send_group_msg', { group_id: Number(destination.id), message: segments })
      } else {
        await this.#action('send_private_msg', { user_id: Number(destination.id), message: segments })
      }
      this.#counters.sent += 1
      this.#lastError = null
      return true
    } catch (error) {
      this.#lastError = String(error?.message ?? error)
      this.#logger?.warn?.(`onebot send failed: ${this.#lastError}`)
      return false
    }
  }

  /** Close the socket and cancel reconnection. */
  async stop() {
    this.#disposed = true
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer)
      this.#reconnectTimer = null
    }
    this.#rejectPending('onebot channel stopped')
    const socket = this.#socket
    this.#socket = null
    this.#state = 'stopped'
    if (socket !== null && socket.readyState === WebSocket.OPEN) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          try {
            socket.terminate()
          } catch {
            /* already gone */
          }
          resolve()
        }, 1000)
        socket.once('close', () => {
          clearTimeout(timer)
          resolve()
        })
        try {
          socket.close()
        } catch {
          clearTimeout(timer)
          resolve()
        }
      })
    }
    this.#publishStatus()
  }
}

/**
 * Collect the downloadable, non-text parts of a OneBot message.
 *
 * Only `image` and `file` carry bytes worth keeping; everything else (face,
 * at, reply, json card) is either noise or already in `renderMessage`.
 * @param event - the OneBot message event.
 * @returns `{kind, name, fileId, url}` per attachment, in message order.
 */
export function extractAttachments(event) {
  if (!Array.isArray(event?.message)) return []
  const found = []
  for (const segment of event.message) {
    const type = segment?.type
    if (type !== 'image' && type !== 'file' && type !== 'record' && type !== 'video') continue
    const data = segment.data ?? {}
    const name = typeof data.name === 'string' && data.name.trim() !== ''
      ? data.name.trim()
      : (typeof data.file === 'string' && !data.file.startsWith('base64://') ? data.file.split(/[\\/]/).pop() : null)
    found.push({
      kind: type,
      name: name ?? null,
      fileId: typeof data.file_id === 'string' ? data.file_id : (typeof data.file === 'string' ? data.file : null),
      url: typeof data.url === 'string' && data.url !== '' ? data.url : null,
    })
  }
  return found
}

/**
 * Flatten a OneBot message (segment array or CQ string) into plain text.
 * @param event - the OneBot message event.
 * @returns readable text, with non-text segments named in brackets.
 */
export function renderMessage(event) {
  if (Array.isArray(event.message)) {
    return event.message
      .map((segment) => {
        if (segment?.type === 'text') return String(segment.data?.text ?? '')
        if (segment?.type === 'image') return '[图片]'
        if (segment?.type === 'face') return '[表情]'
        if (segment?.type === 'at') return `@${segment.data?.qq ?? ''}`
        return `[${segment?.type ?? 'unknown'}]`
      })
      .join('')
      .trim()
  }
  if (typeof event.raw_message === 'string') {
    return event.raw_message
      .replace(/\[CQ:image[^\]]*\]/g, '[图片]')
      .replace(/\[CQ:face[^\]]*\]/g, '[表情]')
      .replace(/\[CQ:at,qq=([^\]]*)\]/g, '@$1')
      .trim()
  }
  return ''
}

export default OneBotChannel
