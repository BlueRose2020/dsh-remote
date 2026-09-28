/**
 * `remote-channel` — drive DeepSeek Harness from a chat app you already carry.
 *
 * Several transports are built in and can run at the same time; every one of
 * them both pushes and receives:
 *
 *  - `wechat-local`  the Windows WeChat 4.x client, read through screen capture
 *                    plus Windows OCR and written through the clipboard.
 *  - `onebot`        your own QQ account, exposed by a local NapCatQQ /
 *                    Lagrange.Core / LLOneBot instance over the OneBot 11
 *                    protocol (WebSocket, no public endpoint required).
 *
 * While enabled the plugin:
 *
 *  1. Detects whether the transport is usable (WeChat process/login, OneBot
 *     socket) and keeps re-checking, so a later login is picked up live.
 *  2. Pushes a message whenever the harness needs a human: an `agent/error`, a
 *     pending `ask_user_question`, or an approval prompt.
 *  3. Reads inbound messages back and turns them into prompts on the active
 *     session, i.e. remote control from the phone, plus `#status` / `#stop`
 *     style built-ins.
 *  4. Registers `remote_notify` / `remote_status` so an agent can report by
 *     itself.
 *
 * @module dsh-plugin-remote
 */
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WeChatLocalChannel } from './channels/wechat-local.js'
import { OneBotChannel } from './channels/onebot.js'
import { captureScreen, listMonitors } from './desktop.js'
import { renderTextImage } from './text-image.js'
import { StateStore } from './state-store.js'

/**
 * A short hash of this file, printed once at startup.
 *
 * "Did the running instance actually pick up my edit?" is otherwise unanswerable
 * from outside: Node caches ESM modules by URL and DSH also buffers its own
 * stdout, so the only trustworthy evidence is the process telling you which bytes
 * it read. `tools/verify-live.py` hashes the file on disk and looks for this value
 * in the server log — same value means the live process is running this revision.
 */
const BUILD_ID = (() => {
  try {
    const self = fileURLToPath(import.meta.url)
    return createHash('sha1').update(readFileSync(self)).digest('hex').slice(0, 10)
  } catch {
    return 'unknown'
  }
})()

/** Stable Loader identity. */
export const name = 'remote-channel'

/** How many sessions one `#tree` card draws before it summarises the rest. */
const TREE_NODE_LIMIT = 40
/** How many numbered turn boundaries `#marks` / `#fork` keep. */
const FORK_MARK_LIMIT = 40

/** Directory holding the avatar shipped with the plugin. */
const AVATAR_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'avatars')

/** The avatar stamped on every card unless the operator chooses another one. */
const BUNDLED_AVATAR = join(AVATAR_DIR, 'default.png')

/**
 * Every word the dispatcher treats as a built-in command.
 *
 * The authorization gate needs it to tell "someone typed a command before
 * authorizing" (explain, do not count as a wrong password) from "someone typed
 * a password" (check it). `tools/onebot-e2e.mjs` reads the dispatcher's own
 * `matchesCommand([...])` lists and fails when a word is missing here, so this
 * set cannot silently drift from the real command table.
 *
 * Exported for that test only: it is data, not behaviour, and the loader ignores
 * every export except `name`, `inject`, `apply` and `Config`.
 */
export const COMMAND_WORDS = new Set([
  'help', 'h', '帮助', '?', '？',
  'status', 's', 'st', '状态',
  'marks', 'mk', '回合',
  'fork', 'fk', '分叉',
  'channels', 'c', '通道',
  'img', 'i', 'image', '出图', '图片',
  'again', 're', 'resend', '重发', '再来一次',
  'reply', 'rp', '回', '回复', '答它',
  'mode', 'modes', 'm', '模式', '列表',
  'deliver', 'delivery', '投递', '投递方式', '发送方式', 'queue', 'steer',
  'perm', 'p', 'permission', 'permissions', '权限',
  'file', 'f', '附件',
  'list', 'ls', 'start', '开始', 'cancel', 'end', 'done', '完成', '结束', '放弃',
  'rename', 'rn', '重命名', '改名',
  'on', 'o', '开启', '打开',
  'off', 'x', '关闭',
  'switch', '切换通道',
  'sessions', 'se', '会话',
  'tree', 'tr', '树', '会话树',
  'use', 'u', '切换',
  'ws', 'w', 'workspace', '工作区',
  'fix', 'repair', 'rejoin', '修复', '整理',
  'new', 'n', '新建',
  'shot', 'sh', 'screenshot', '截图', '截屏',
  'clear', 'cl', '自动', 'unpin',
  'stop', 'k', '停止',
  'lock', '上锁', '锁定',
  'auth', 'login', 'pass', 'password', '授权', '密码',
  '答', 'answer', '自定义', '提交', '交卷', 'submit', 'done', 'ok', '完成',
  '上一题', 'prev', 'previous', '上题', '上', '下一题', 'next', '下题', '下',
  '>', '》', '<', '《',
  'cancel', '取消',
])

/** No hard service dependency: everything optional is resolved lazily. */
export const inject = []

/** Plugin configuration. */
export const Config = z.object({
  /** Master switch; the loader row's `disabled` flag is the other one. */
  enabled: z.boolean().default(true),
  /** Send a "connected" message when a transport first becomes ready. */
  announceOnReady: z.boolean().default(true),
  /** Enabled transports: `wechat-local` and/or `onebot`. */
  transports: z.array(z.string()).default(['wechat-local']),

  /** Notify on `agent/error`. */
  notifyOnError: z.boolean().default(true),
  /** Notify when an agent asks the user a question. */
  notifyOnQuestion: z.boolean().default(true),
  /** Notify when an approval prompt is raised. */
  notifyOnApproval: z.boolean().default(true),
  /** Notify when a turn finishes (noisy; off by default). */
  notifyOnTurnEnd: z.boolean().default(false),

  /** Turn inbound chat messages into session prompts. */
  remoteControl: z.boolean().default(true),
  /** Push the agent's answer back to the chat when a turn ends. */
  reportOnTurnEnd: z.boolean().default(true),
  /**
   * Report only turns this plugin triggered. Keeps a user who is chatting in
   * the web UI from being spammed on their phone with their own conversation.
   */
  reportOnlyRemoteTurns: z.boolean().default(true),
  /** Attach a desktop screenshot to every turn report (heavy; off by default). */
  reportWithScreenshot: z.boolean().default(false),
  /** Per-report character budget (the answer is truncated past this). */
  reportMaxChars: z.number().default(1500),
  /** Only report turns belonging to this session; empty means every root session. */
  reportOnlyTargetSession: z.boolean().default(true),
  /**
   * Longest edge of a screenshot, in px. `0` (the default) means **no scaling**:
   * a capture is a pixel-exact BitBlt of the screen DC, and every downscale is
   * what turns snapped text into a blur once a phone renders it. Lower it only
   * when payload size matters more than legibility.
   */
  screenshotMaxWidth: z.number().default(0),
  /**
   * Which display a screenshot captures: `primary` (default — the main screen is
   * the sharpest thing to put on a phone), `all` for every screen side by side,
   * or a 1-based display number. `#shot screen <值>` changes it from chat.
   */
  screenshotMonitor: z.string().default('primary'),
  /** Allow screenshot capture at all. */
  screenshots: z.boolean().default(true),
  /** `auto` prefers the plugin-side capture, `channel` uses the transport's. */
  screenshotProvider: z.union([z.const('auto'), z.const('channel')]).default('auto'),
  /** Python used by the desktop screenshot helper. */
  pythonPath: z.string().default('python'),
  /**
   * Answer informational commands (`#status`, `#channels`, …) with a rendered
   * PNG card instead of raw text: a phone chat shows proportional text badly,
   * and both transports can already deliver images. `#img off` switches back.
   */
  imageReplies: z.boolean().default(true),
  /** Longest edge (px) of a rendered card. */
  imageMaxWidth: z.number().default(900),
  /**
   * Avatar drawn in the card header; empty uses the bundled one next to the
   * plugin. Set to `-` to draw no avatar at all.
   */
  avatar: z.string().default(''),
  /** Sign the cards: a nickname and an optional one-line signature. */
  nickname: z.string().default(''),
  signature: z.string().default(''),
  /**
   * How an inbound message enters the target session: `queue` waits for the
   * running turn to finish, `steer` injects into it. `#mode` switches at runtime.
   */
  messageMode: z.union([z.const('queue'), z.const('steer')]).default('queue'),
  /**
   * The one **administrator password**: it both unlocks the danger preset
   * (`danger-full-access`) from the chat and gates every chat command. Empty
   * means "no gate, and no remote full access".
   *
   * Prefer the settings card: there the field is a schema `secret`, so the value
   * never rides a response and the card can only write it. This composition value
   * is the fallback for deployments without a settings provider (and for tests),
   * and it sits in the profile patch in clear text — so it is the lesser option.
   */
  fullAccessPassword: z.string().default(''),
  /** Alias for `fullAccessPassword`; the settings value wins over both. */
  accessPassword: z.string().default(''),
  /**
   * Where the administrator password is demanded.
   *
   * `off` (default) asks for it **only where permission is at stake** — the
   * danger preset (`#perm f`). Ordinary commands need no password, which is what
   * "it is my phone and my chat" deserves. `all` additionally gates every
   * command, for the case where the phone itself may be in someone else's hands;
   * `#auth` then shows the state and `#lock` drops the grant.
   *
   * A boolean is accepted too, because YAML parses a bare `off`/`on` as `false`/
   * `true`: a config file that says `accessGate: off` must mean "off", not
   * "failed validation".
   */
  accessGate: z.union([z.const('off'), z.const('all'), z.boolean()]).default('off'),
  /** How long an authorized sender stays authorized; `0` = until DSH restarts. */
  accessTtlMinutes: z.number().default(0),
  /** Wrong-password attempts before a cool-down; `0` disables the cool-down. */
  accessMaxFailures: z.number().default(5),
  /**
   * Also render one-line command receipts as cards. Off by default: a card per
   * acknowledgement is noise on a phone. Turn it on to make *every* reply follow
   * `#img`, exactly like reports and `#status`.
   */
  richAcks: z.boolean().default(false),
  /**
   * Named **working modes**: each one is a bundle of behaviour plus the command
   * words it accepts, so a phone can switch between "everything" and a narrow
   * daily view without reconfiguring anything. `#mode <名字>` switches.
   *
   * `commands` is a whitelist of command words exactly as they are typed
   * (`status`, `s`, `ws`, `1` …); empty means "no restriction". The mode switch
   * itself, `#help` and `#auth` are always available, so a mode can never lock
   * the operator out.
   */
  modes: z.array(z.object({
    name: z.string(),
    label: z.string().default(''),
    description: z.string().default(''),
    commands: z.array(z.string()).default([]),
    imageReplies: z.boolean(),
    richAcks: z.boolean(),
    messageMode: z.union([z.const('queue'), z.const('steer')]),
    /**
     * A small form the mode wants the operator to fill in.
     *
     * Declared here by whoever wrote the mode; the config page renders it and
     * stores the answers in `modeData`. `type` picks the control (`text` is a
     * multi-line box), `options` turns it into a select, `default` seeds it.
     */
    fields: z.array(z.object({
      key: z.string(),
      label: z.string().default(''),
      type: z.union([
        z.const('string'), z.const('text'), z.const('bool'),
        z.const('number'), z.const('select'),
      ]).default('string'),
      placeholder: z.string().default(''),
      help: z.string().default(''),
      options: z.array(z.string()).default([]),
      rows: z.number().default(4),
      default: z.union([z.string(), z.number(), z.boolean()]),
    })).default([]),
    /**
     * Text injected into the system prompt while this mode is active.
     *
     * `{{field}}` is replaced with that field's value, so a persona mode writes
     * `你现在扮演：{{persona}}` and the operator's text arrives with it.
     */
    prompt: z.string().default(''),
  })).default([]),
  /**
   * Whether a chat reply may answer an `ask_user_question` prompt. On (default)
   * the chat and the Web question surface are raced, so answering from a phone
   * works while the desktop stays untouched; off restores notify-only.
   */
  answerQuestionsFromChat: z.boolean().default(true),
  /** Where `#file` downloads land; empty means `$DSH_HOME/downloads`. */
  downloadsDir: z.string().default(''),
  /** Day folders older than this are pruned when a capture starts. */
  attachmentRetentionDays: z.number().default(7),
  /** Total size cap for the downloads tree, in MB; oldest files go first. */
  attachmentMaxTotalMB: z.number().default(500),
  /** Override the durable state file; empty means `$DSH_HOME/storages/remote-channel.json`. */
  stateFile: z.string().default(''),
  /** Built-in commands use this prefix; ordinary text is forwarded directly. */
  commandPrefix: z.string().default('#'),
  /** `auto` targets the most recently active root session; or a session id. */
  targetSession: z.string().default('auto'),
  /** Per-message character budget for anything sent out. */
  maxMessageChars: z.number().default(1200),
  /** Suppress an identical outbound message repeated within this window. */
  dedupeMs: z.number().default(45000),
  /** Reply in the chat with an acknowledgement per handled command. */
  replyAcks: z.boolean().default(true),
  /**
   * Tell the agent it has a remote audience, so it reports milestones itself
   * through `remote_notify` instead of staying silent until the turn ends.
   */
  agentAwareness: z.boolean().default(true),
  /** Also ping every N tool calls during a remote turn; 0 disables it. */
  progressEveryToolCalls: z.number().default(0),
  /** Refuse commands beyond this many per minute; 0 disables the guard. */
  maxCommandsPerMinute: z.number().default(20),
  /**
   * Append-only JSONL trace of inbound messages, command dispatch and reply
   * outcomes. Empty disables it.
   *
   * Worth turning on while setting a transport up: you are not at the machine
   * to read the console, and DSH buffers its own stdout, so without this a
   * swallowed command or a failed reply is simply invisible.
   */
  debugLog: z.string().default(''),

  /** Windows WeChat 4.x transport settings. */
  wechat: z.object({
    pythonPath: z.string().default('python'),
    bridgeScript: z.string().default(''),
    pollIntervalMs: z.number().default(5000),
    statusIntervalMs: z.number().default(60000),
    requestTimeoutMs: z.number().default(45000),
    /**
     * Never let a *background poll* navigate or raise WeChat. True means the
     * reader only looks at what is already on screen, so someone using the
     * machine is never interrupted; sending still needs the window.
     */
    passive: z.boolean().default(true),
  }),

  /** OneBot 11 transport settings (personal QQ via NapCatQQ / Lagrange). */
  onebot: z.object({
    url: z.string().default('ws://127.0.0.1:3001'),
    accessToken: z.string().default(''),
    /**
     * Where notifications are delivered: your own QQ number for a private
     * chat, or the group number when `target` is `group`. Empty means "reply
     * to whoever spoke last".
     */
    ownerId: z.string().default(''),
    target: z.union([z.const('private'), z.const('group')]).default('private'),
    /** Accept messages whose sender is this account itself (QQ 我的电脑). */
    acceptSelfMessages: z.boolean().default(true),
    /** Allowed private senders; empty means any sender. */
    privateAllowFrom: z.array(z.string()).default([]),
    /** Allowed group ids; empty means every group is ignored. */
    groupAllowFrom: z.array(z.string()).default([]),
    reconnectMs: z.number().default(5000),
  }),
})

/** Short human label for a session id. */
function shortId(id) {
  const text = String(id ?? '')
  const parts = text.split('-')
  return parts.length >= 3 ? `${parts[0]}-${parts[1]}` : text.slice(0, 16)
}

/** Render an unknown thrown value as one line. */
function describeError(error) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)?.slice(0, 500) ?? String(error)
  } catch {
    return String(error)
  }
}

/** Truncate with an explicit marker so the far end knows text was dropped. */
function clamp(text, max) {  const value = String(text ?? '')
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(0, max - 20))}\n…（已截断 ${value.length - max + 20} 字）`
}

/**
 * Make sure a directory exists, creating parents as needed. *
 * Naming a directory that does not exist yet is how a workspace is *created*
 * from the phone (`#ws D:\new\project`), so this is a feature, not a repair
 * step. It runs before the workspace registry sees the path, because the
 * registry only accepts directories that are already there.
 * @param path - the directory path a person typed.
 * @returns true when it had to be created.
 * @throws when the value is empty or an existing file sits in the way.
 */
function ensureDirectory(path) {
  const target = String(path ?? '').trim()
  if (target === '') throw new Error('空路径')
  if (existsSync(target)) return false
  mkdirSync(target, { recursive: true })
  return true
}

/**
 * Collapse whitespace so OCR artefacts like `#statu S` still match `status`.
 * @param text - raw inbound text.
 * @returns lowercase text with every space removed.
 */
function compact(text) {
  return String(text ?? '').replace(/[\s\u3000]+/g, '').toLowerCase()
}

/** Levenshtein distance, used only for short command words. */
function editDistance(a, b) {
  const rows = a.length + 1
  const cols = b.length + 1
  let previous = Array.from({ length: cols }, (_, j) => j)
  for (let i = 1; i < rows; i += 1) {
    const current = [i]
    for (let j = 1; j < cols; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
    previous = current
  }
  return previous[cols - 1]
}

/**
 * Match one compacted command token against candidate spellings.
 * @param token - compacted user input.
 * @param candidates - accepted literal spellings.
 * @returns true on an exact hit or a close enough OCR-damaged one.
 */
function matchesCommand(token, candidates) {
  for (const candidate of candidates) {
    if (token === candidate) return true
    if (token.length >= 3 && candidate.length >= 3) {
      const ratio = 1 - editDistance(token, candidate) / Math.max(token.length, candidate.length)
      if (ratio >= 0.75) return true
    }
  }
  return false
}

/**
 * Build the enabled transports.
 * @param config - resolved plugin configuration.
 * @param logger - plugin logger.
 * @returns channel instances, in configuration order.
 */
function buildChannels(config, logger, redact = null) {
  const channels = []
  for (const requested of config.transports) {
    const id = String(requested).trim().toLowerCase()
    if (id === 'wechat-local' || id === 'wechat') {
      channels.push(new WeChatLocalChannel(config.wechat, { logger, redact }))
    } else if (id === 'onebot' || id === 'qq') {
      channels.push(new OneBotChannel(config.onebot, { logger, redact }))
    } else {
      logger.warn(`unknown transport ${JSON.stringify(requested)} — expected 'wechat-local' or 'onebot'`)
    }
  }
  return channels
}

/**
 * Wire the transports into one Cordis context.
 * @param ctx - the plugin's context.
 * @param config - validated plugin configuration.
 */
export function apply(ctx, config) {
  const logger = ctx.logger('remote-channel')
  // Filled in once the secrets are resolvable (the settings provider may not be
  // mounted yet), and handed to the transports: they log inbound text at info
  // level, and that text is a password exactly once per authorization.
  const redactSecretsRef = { current: (value) => String(value ?? '') }
  const channels = buildChannels(config, logger, (text) => redactSecretsRef.current(text))

  // Durable bits: the target session has to survive a restart, because after
  // one no agent is live and "auto" would resolve to nothing.
  const store = new StateStore({
    ...(config.stateFile && config.stateFile !== '' ? { file: config.stateFile } : {}),
    logger,
  })
  const persisted = store.load()

  const state = {
    /**
     * Master switch. `#off` deliberately only silences the *work* (forwarding,
     * reports, notifications) and leaves the transports listening, because a
     * switch you can only flip at the PC is useless when you are away from it.
     * A hard stop is `enabled: false` in the config or `#channel <id> off`.
     */
    enabled: typeof persisted.enabled === 'boolean' ? persisted.enabled : config.enabled,
    /** Transports explicitly switched off; still constructed, but stopped. */
    disabledChannels: new Set(
      Array.isArray(persisted.disabledChannels) ? persisted.disabledChannels.map((id) => String(id)) : [],
    ),
    /** Answer informational commands with a rendered card; `#img` switches it. */
    imageReplies: typeof persisted.imageReplies === 'boolean' ? persisted.imageReplies : config.imageReplies !== false,
    /** How an inbound message enters the target session; `#mode` switches it. */
    messageMode: persisted.messageMode === 'steer' || persisted.messageMode === 'queue'
      ? persisted.messageMode
      : config.messageMode,
    /**
     * The active working mode's name. Not persisted: a restart starts in the
     * default mode, so a narrow mode cannot silently survive into a session
     * where the operator expects everything to work.
     */
    mode: 'default',
    /**
     * Which display `#shot` and report screenshots capture: `primary`, `all`, or
     * a 1-based display number. Remembered across restarts, and the reason the
     * default is the main screen: a two-monitor strip is unreadable on a phone.
     */
    shotMonitor: typeof persisted.shotMonitor === 'string' && persisted.shotMonitor.trim() !== ''
      ? persisted.shotMonitor.trim()
      : (config.screenshotMonitor || 'primary'),
    /**
     * Numbered turn boundaries, newest last: `{n, sessionId, atSeq, at, label}`.
     *
     * A phone cannot point at a position in a transcript, so every report names
     * the turn it came from (`回合 #n`) and `#fork n` cuts the session there.
     */
    turnMarks: Array.isArray(persisted.turnMarks) ? persisted.turnMarks.slice(-FORK_MARK_LIMIT) : [],
    startedAt: Date.now(),
    lastActiveSessionId: null,
    /** Explicitly chosen session; overrides every heuristic until cleared. */
    pinnedSessionId: typeof persisted.pinnedSessionId === 'string' && persisted.pinnedSessionId !== ''
      ? persisted.pinnedSessionId
      : undefined,
    /** Explicitly chosen default workspace path for `#new`. */
    pinnedWorkspace: typeof persisted.pinnedWorkspace === 'string' && persisted.pinnedWorkspace !== ''
      ? persisted.pinnedWorkspace
      : null,
    /**
     * The session that spoke to the operator last.
     *
     * A report or a notification is a *push*: the operator reads one and then
     * wants to answer **that** session. With several open, finding its number and
     * running `#use` first is the whole friction, so the speaker is remembered
     * and `#reply <话>` can address it directly. Persisted, because the report the
     * operator is answering may have arrived before a restart.
     */
    lastSpeakerId: typeof persisted.lastSpeakerId === 'string' && persisted.lastSpeakerId !== ''
      ? persisted.lastSpeakerId
      : undefined,
    /** When that session last spoke, for "刚刚 / 12 分钟前". */
    lastSpeakerAt: typeof persisted.lastSpeakerAt === 'number' ? persisted.lastSpeakerAt : null,
    /** Last session a command was routed to; the post-restart fallback. */
    lastTargetSessionId: typeof persisted.lastTargetSessionId === 'string' && persisted.lastTargetSessionId !== ''
      ? persisted.lastTargetSessionId
      : null,
    /** Per-session count of turns this plugin started, so only those report. */
    pendingRemoteTurns: new Map(),
    /**
     * The most recent thing this plugin sent as an answer — a command card or a
     * turn report. `#again` re-sends it, rendered the way the *current* setting
     * asks for, which is how a phone recovers a card it never got.
     */
    lastAnswer: null,
    /**
     * Chat-side authorization. Keyed per conversation (`onebot:private:123`), and
     * deliberately **in memory**: a restarted process asks for the password again,
     * because "the gate silently reopened after a crash" is the one failure mode
     * an authorization feature must not have.
     */
    authorized: new Map(),
    /**
     * The question an `ask_user_question` call is blocked on, per session, plus
     * the partial answers collected from the chat. In memory by design: it is the
     * live promise of a live tool call, meaningless after a restart.
     */
    pendingQuestions: new Map(),
    lastError: null,
    sentCount: 0,
    receivedCount: 0,
    forwardedCount: 0,
    reportedCount: 0,
  }

  /** Persist the choices that must outlive the process. */
  function rememberTarget() {
    store.save({
      enabled: state.enabled,
      disabledChannels: [...state.disabledChannels],
      imageReplies: state.imageReplies,
      lastSpeakerId: state.lastSpeakerId ?? null,
      lastSpeakerAt: state.lastSpeakerAt,
      messageMode: state.messageMode,
      shotMonitor: state.shotMonitor,
      turnMarks: state.turnMarks.slice(-FORK_MARK_LIMIT),
      pinnedSessionId: state.pinnedSessionId ?? null,
      pinnedWorkspace: state.pinnedWorkspace,
      lastTargetSessionId: state.lastTargetSessionId,
      // Recorded so a restart helper can relaunch DSH from the SAME directory:
      // the server's `process.cwd()` decides which workspace and session set
      // the GUI shows, so restarting from elsewhere silently changes it.
      serverCwd: process.cwd(),
      updatedAt: new Date().toISOString(),
    })
  }

  /**
   * Append one structured trace line, synchronously so it survives a crash and
   * a buffered stdout. A no-op unless `debugLog` is configured.
   */
  const debug = config.debugLog && config.debugLog !== ''
    ? (event, data = {}) => {
      try {
        mkdirSync(dirname(config.debugLog), { recursive: true })
        appendFileSync(config.debugLog, `${JSON.stringify({ t: new Date().toISOString(), event, ...data })}\n`, 'utf8')
      } catch {
        /* diagnostics must never break the feature they observe */
      }
    }
    : () => {}

  if (channels.length === 0) {
    logger.warn('no usable transport configured; set `transports: [wechat-local]` or `[onebot]`')
  }

  /** Per-channel dedupe of identical outbound bodies. */
  const recentSends = new Map()

  /** Timestamps of recently handled commands, for the flood guard. */
  const commandTimes = []

  /**
   * Whether one transport is currently allowed to carry traffic.
   *
   * Switched-off transports stay constructed (`#on`-able) but are stopped, so
   * they neither send nor deliver — and are skipped everywhere below.
   * @param channel - the transport to test.
   * @returns true when it may send and receive.
   */
  function channelOn(channel) {
    return !state.disabledChannels.has(channel.id)
  }

  function anyReady() {
    return channels.some((channel) => channel.ready && channelOn(channel))
  }

  /**
   * Resolve a transport by the name a person would type.
   * @param name - compacted token (`qq`, `wechat`, `onebot`, ...).
   * @returns the channel, or undefined.
   */
  function channelByName(name) {
    const aliases = {
      qq: 'onebot',
      onebot: 'onebot',
      q: 'onebot',
      wechat: 'wechat-local',
      wx: 'wechat-local',
      wechatlocal: 'wechat-local',
      微信: 'wechat-local',
    }
    const id = aliases[name] ?? name
    return channels.find((channel) => channel.id === id)
  }

  /**
   * Switch one transport on or off at runtime and persist the choice.
   * @param channel - the transport.
   * @param on - desired state.
   */
  async function setChannelOn(channel, on) {
    if (on) state.disabledChannels.delete(channel.id)
    else state.disabledChannels.add(channel.id)
    rememberTarget()
    debug('channel-toggle', { transport: channel.id, on })
    mirrorToSettings(channel.id, on)
    if (on) {
      try {
        await channel.start()
      } catch (error) {
        logger.warn(`starting ${channel.id} failed: ${describeError(error)}`)
      }
    } else {
      try {
        await channel.stop()
      } catch (error) {
        logger.warn(`stopping ${channel.id} failed: ${describeError(error)}`)
      }
    }
  }

  /** The default mode: everything, no restrictions. */
  const DEFAULT_MODE = {
    name: 'default',
    label: '工作',
    description: '全部命令（默认）',
    commands: [],
    /**
     * No form and no prompt. Spelled out rather than left off: `modeList()` hands
     * this object straight to the schema mirror and the prompt renderer, and a
     * missing key there is a crash, not a default.
     */
    fields: [],
    prompt: '',
  }

  /** Every mode this deployment offers, default first. */
  function modeList() {
    const configured = Array.isArray(config.modes) ? config.modes : []
    const seen = new Set([DEFAULT_MODE.name])
    const modes = [DEFAULT_MODE]
    for (const entry of configured) {
      const name = typeof entry?.name === 'string' ? entry.name.trim() : ''
      if (name === '' || seen.has(compact(name))) continue
      seen.add(compact(name))
      modes.push({
        name,
        label: typeof entry.label === 'string' && entry.label !== '' ? entry.label : name,
        description: typeof entry.description === 'string' ? entry.description : '',
        commands: Array.isArray(entry.commands) ? entry.commands.map((word) => compact(word)) : [],
        imageReplies: typeof entry.imageReplies === 'boolean' ? entry.imageReplies : undefined,
        richAcks: typeof entry.richAcks === 'boolean' ? entry.richAcks : undefined,
        messageMode: entry.messageMode === 'steer' || entry.messageMode === 'queue' ? entry.messageMode : undefined,
        fields: Array.isArray(entry.fields)
          ? entry.fields
            .filter((field) => typeof field?.key === 'string' && field.key.trim() !== '')
            .map((field) => ({
              key: field.key.trim(),
              label: typeof field.label === 'string' && field.label !== '' ? field.label : field.key.trim(),
              type: ['string', 'text', 'bool', 'number', 'select'].includes(field.type) ? field.type : 'string',
              placeholder: typeof field.placeholder === 'string' ? field.placeholder : '',
              help: typeof field.help === 'string' ? field.help : '',
              options: Array.isArray(field.options) ? field.options.map((option) => String(option)) : [],
              rows: Number.isFinite(field.rows) && field.rows > 0 ? Math.min(24, Math.round(field.rows)) : 4,
              default: field.default,
            }))
          : [],
        prompt: typeof entry.prompt === 'string' ? entry.prompt : '',
      })
    }
    return modes
  }

  /** The active mode, falling back to the default when the name no longer exists. */
  function activeMode() {
    return modeList().find((mode) => compact(mode.name) === compact(state.mode)) ?? DEFAULT_MODE
  }

  /**
   * Words that belong to the *answer* protocol, not to the command table.
   *
   * While a question is blocked, these must keep reaching `handlePendingAnswer`
   * even though they are prefixed — `#1` picks an option, `#submit` hands in the
   * form, `#> ` turns the page. Everything else that is a known command is let
   * through to the dispatcher, so a blocked turn no longer makes `#status`,
   * `#use` or `#reply` unusable.
   */
  const ANSWER_PROTOCOL_WORDS = new Set([
    '>', '》', '<', '《', 'next', '下一题', '下题', '下', 'prev', 'previous',
    '上一题', '上题', '上', '提交', '交卷', 'submit', 'done', 'ok', '完成',
    '答', 'answer', '自定义', '说',
  ])

  /** Commands that always work, whatever the mode says. */
  const MODE_ESCAPE_WORDS = new Set(['mode', 'modes', '模式', 'help', 'h', '帮助', '?', '？', 'auth', 'lock'])

  /**
   * Whether the active mode accepts this command word.
   *
   * Only *known* command words are checked: anything else is prose, which is what
   * a restricted mode usually exists to pass through to the session.
   */
  function modeAllows(word) {
    const mode = activeMode()
    if (!Array.isArray(mode.commands) || mode.commands.length === 0) return true
    if (MODE_ESCAPE_WORDS.has(word)) return true
    return mode.commands.includes(word)
  }

  /** Parse a settings JSON blob that is supposed to be an object. */
  function parseJsonObject(text) {
    if (typeof text !== 'string' || text.trim() === '') return {}
    try {
      const parsed = JSON.parse(text)
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch (error) {
      debug('bad-json-setting', { message: describeError(error) })
      return {}
    }
  }

  /**
   * One mode's field values: what the operator saved, with the schema's defaults
   * filled in, so a template never prints `undefined`.
   * @param name - the mode's name.
   * @returns a plain object of field values.
   */
  function modeValues(name) {
    const stored = parseJsonObject(settingsScope?.get?.()?.modeData)?.[compact(name)] ?? {}
    const mode = modeList().find((entry) => compact(entry.name) === compact(name))
    const values = {}
    for (const field of mode?.fields ?? []) {
      const value = stored[field.key]
      if (value !== undefined) {
        values[field.key] = value
        continue
      }
      values[field.key] = field.default ?? (field.type === 'bool' ? false : '')
    }
    // Keep anything stored that the schema no longer declares: a mode author who
    // renames a field must not silently lose the text the operator typed.
    return { ...stored, ...values }
  }

  /**
   * The active mode's text for the system prompt, with `{{field}}` filled in.
   *
   * Recomputed per assembly, so editing 人设 in the config page changes the very
   * next turn — no restart, no re-pin.
   * @returns the text, or an empty string when the mode has none.
   */
  function modePromptText() {
    const mode = activeMode()
    const template = typeof mode.prompt === 'string' ? mode.prompt : ''
    if (template.trim() === '') return ''
    const values = modeValues(mode.name)
    const filled = template.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_match, key) => {
      const value = values[key]
      if (value === undefined || value === null) return ''
      return typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value)
    })
    return filled.trim()
  }

  /**
   * The reply format in force: `#img`'s preference, unless the mode pins one.
   *
   * A mode's overrides are resolved on *every read* rather than copied into
   * `state` when the mode is applied. A cached copy is how a config reload, a
   * `#img`, or a mode switch silently stops taking effect — and the operator only
   * finds out when a reply arrives in the wrong shape.
   * @returns whether informational replies should be rendered as a card.
   */
  function imageRepliesOn() {
    const pinned = activeMode().imageReplies
    return typeof pinned === 'boolean' ? pinned : state.imageReplies
  }

  /** Whether even a one-line receipt is rendered as a card (`richAcks`). */
  function richAcksOn() {
    const pinned = activeMode().richAcks
    return typeof pinned === 'boolean' ? pinned : config.richAcks === true
  }

  /** How an inbound message enters the session: `steer` or `queue`. */
  function deliveryMode() {
    return activeMode().messageMode ?? state.messageMode
  }

  /** Switch the working mode: a named bundle of behaviour + command surface. */
  function applyMode(mode) {
    state.mode = mode.name
    // Nothing to copy: the overridable behaviours are read through
    // `imageRepliesOn` / `richAcksOn` / `deliveryMode`, so a stale copy cannot
    // survive a switch.
    // Keep the card's mode buttons in step without giving the client a vote.
    mirrorFieldToSettings('modes', modeList().map((entry) => entry.name).join(','))
    mirrorFieldToSettings('mode', mode.name)
  }

  // ------------------------------------------------------- settings surface
  /**
   * The three switches, published to the DSH Settings UI.
   *
   * The Host is the single writer: the chat commands write here and the watcher
   * below applies whatever lands, so the card in Settings and `#channels` in the
   * chat can never disagree. Without a settings provider (offline tests, a
   * deployment that mounts none) everything still works — the durable state file
   * remains the only source.
   */
  const SETTINGS_NS = 'remote-channel'
  /** Which settings field governs which transport. */
  const TRANSPORT_FIELD = { 'wechat-local': 'wechat', onebot: 'qq' }

  /**
   * Owner scope for the settings namespace, assigned once the settings service
   * exists.
   *
   * `ctx.inject` and not a plain `ctx.get`: the settings provider is composed
   * separately from this plugin, so at `apply()` time it may simply not be there
   * yet — reading it eagerly registered nothing and the Settings card then never
   * appeared anywhere. Deferring also ties the registration to this plugin's
   * fiber, which is what removes the namespace again on unload.
   */
  let settingsScope = null

  ctx.inject(['settings'], (injected) => {
    try {
      const provider = injected.settings ?? injected.get('settings')
      settingsScope = provider.register(SETTINGS_NS, z.object({
        /** Master switch: off silences forwarding, reports and notifications. */
        enabled: z.boolean().default(true),
        /** The Windows WeChat client transport. */
        wechat: z.boolean().default(true),
        /** The QQ transport (OneBot over a local NapCat WebSocket). */
        qq: z.boolean().default(true),
        /**
         * The administrator password, write-only. One secret covers both jobs:
         * it gates every chat command, and it is what `#perm f` asks for.
         */
        fullAccessPassword: z.string().role('secret').default(''),

        /** Purely presentational: who the cards are from. */
        nickname: z.string().default(''),
        signature: z.string().default(''),
        avatar: z.string().default(''),
        /**
         * An avatar uploaded from the browser panel, as a `data:` URL.
         *
         * The settings service carries values, not files, and the card renderer
         * is a separate process that needs a path — so the panel downsizes the
         * picture in the browser and this field carries it, with the host caching
         * it to a real file (`cacheUploadedAvatar`). Empty means "use `avatar`".
         */
        avatarData: z.string().default(''),
        /**
         * Informational replies as a card, and how a forwarded message enters the
         * session — mirrored so the config page can offer them next to the
         * switches. `#img` / `#deliver` write the same two fields.
         */
        imageReplies: z.boolean().default(true),
        deliverMode: z.string().default('queue'),
        /**
         * The pinned remote target, mirrored so the browser can both *see* it and
         * *set* it: the web session tree is clickable and this field is the write
         * path, exactly as `#use` is the phone's. One field, one writer, so the
         * two surfaces cannot disagree.
         */
        pinSessionId: z.string().default(''),
        /** Read-only mirror: what the pinned session is called. */
        pinLabel: z.string().default(''),
        /** Read-only mirror: the session that spoke last (`#reply` targets it). */
        speakerLabel: z.string().default(''),
        /**
         * Per-mode field values as JSON: `{ "<mode>": { "<key>": value } }`.
         *
         * One JSON blob rather than a field per mode: the schema belongs to the
         * mode author, so a fixed settings schema cannot describe it — and this
         * keeps "add a field in the profile" a config edit with no code change.
         */
        modeData: z.string().default(''),
        /**
         * What the browser half reported about itself on its last load: which
         * stylesheet revision the *document* is carrying, whether the tag had to be
         * refreshed, and when. Verified against the UI-preview tool and the server
         * log; nothing reads it but the trace below.
         */
        uiProbe: z.string().default(''),
        /** Read-only mirror of every mode's field schema, as JSON, for the page. */
        modeSchema: z.string().default('[]'),
        /** Active working mode, written by `#mode` and by the profile panel. */
        mode: z.string().default('default'),
        /** Read-only mirror of the available mode names, for the panel buttons. */
        modes: z.string().default('default'),
      }), {
        // What a field falls back to when the user clears it in the UI.
        base: {
          enabled: config.enabled !== false,
          wechat: config.transports.some((entry) => String(entry).toLowerCase().startsWith('wechat')),
          qq: config.transports.some((entry) => String(entry).toLowerCase() === 'onebot'),
          fullAccessPassword: config.fullAccessPassword,
          nickname: config.nickname,
          signature: config.signature,
          avatar: config.avatar,
          avatarData: '',
          imageReplies: config.imageReplies !== false,
          deliverMode: config.messageMode,
          pinSessionId: '',
          pinLabel: '',
          speakerLabel: '',
          modeData: '',
          modeSchema: '[]',
          uiProbe: '',
          mode: 'default',
          modes: 'default',
        },
        applies: 'live',
      })
      debug('settings-registered', { namespace: SETTINGS_NS })
      logger.info(`settings namespace ${SETTINGS_NS} registered — card shows in Settings → 插件`)
      void applySettings(settingsScope.get())
      // Publish the mode list (the panel's buttons) and the mode this process is
      // really running, so the panel opens in step with the chat. `mode` is not
      // persisted, so a restart resets both to `default`.
      mirrorFieldToSettings('modes', modeList().map((entry) => entry.name).join(','))
      mirrorFieldToSettings('mode', state.mode)
      mirrorFieldToSettings('imageReplies', state.imageReplies)
      mirrorFieldToSettings('deliverMode', state.messageMode)
      // The page renders one tab per mode, including each mode's own form; the
      // schema travels as JSON because it is authored in the profile, not here.
      mirrorFieldToSettings('modeSchema', JSON.stringify(modeList().map((entry) => ({
        name: entry.name,
        label: entry.label,
        description: entry.description,
        fields: entry.fields,
        hasPrompt: typeof entry.prompt === 'string' && entry.prompt.trim() !== '',
        // What this mode *pins*, so the page can say "this switch is overridden
        // here" instead of showing a control that appears to do nothing.
        pins: {
          imageReplies: typeof entry.imageReplies === 'boolean' ? entry.imageReplies : null,
          richAcks: typeof entry.richAcks === 'boolean' ? entry.richAcks : null,
          messageMode: entry.messageMode ?? null,
        },
      }))))
      ctx.effect(() => settingsScope.watch((next) => applySettings(next)))
    } catch (error) {
      settingsScope = null
      debug('settings-registration-failed', { message: describeError(error) })
      logger.warn(`settings namespace ${SETTINGS_NS} unavailable: ${describeError(error)}`)
    }
  })

  /** Push one channel's new state into the settings document, when there is one. */
  function mirrorToSettings(channelId, on) {
    const field = TRANSPORT_FIELD[channelId]
    if (field === undefined || settingsScope === null) return
    if (settingsScope.get()?.[field] === on) return
    void Promise.resolve(settingsScope.update({ [field]: on }))
      .catch((error) => logger.warn(`settings write failed: ${describeError(error)}`))
  }

  /** Push the master switch into the settings document, when there is one. */
  function mirrorMasterToSettings(on) {
    if (settingsScope === null) return
    if (settingsScope.get()?.enabled === on) return
    void Promise.resolve(settingsScope.update({ enabled: on }))
      .catch((error) => logger.warn(`settings write failed: ${describeError(error)}`))
  }

  /**
   * Pin the remote target, and mirror it so the browser's session tree follows
   * whatever the chat does (`#use`, `#reply`, `#new`, `#fork`).
   * @param sessionId - the session to pin.
   * @param label - its human label when the caller already knows it.
   * @returns the label that was mirrored, when one could be resolved.
   */
  async function setPinnedTarget(sessionId, label = null) {
    state.pinnedSessionId = sessionId
    state.lastActiveSessionId = sessionId
    state.lastTargetSessionId = sessionId
    rememberTarget()
    mirrorFieldToSettings('pinSessionId', sessionId)
    let shown = label
    if (shown === null || shown === undefined) {
      const described = await describeSession(sessionId)
      shown = described === null ? null : sessionLabel(described)
    }
    if (typeof shown === 'string' && shown !== '') mirrorFieldToSettings('pinLabel', shown)
    return shown
  }

  /**
    * Presentational profile: what the cards are signed with.
    *
    * Settings win over the composition values, and both may be empty — an empty
    * nickname simply disappears from the footer instead of printing a placeholder.
    */
  function profile() {
    const values = settingsScope?.get?.() ?? {}
    return {
      nickname: typeof values.nickname === 'string' && values.nickname !== ''
        ? values.nickname
        : (typeof config.nickname === 'string' ? config.nickname : ''),
      signature: typeof values.signature === 'string' && values.signature !== ''
        ? values.signature
        : (typeof config.signature === 'string' ? config.signature : ''),
    }
  }

  /** The last UI probe seen, so only a *change* is traced. */
  let lastUiProbe = ''

  /** Push one scalar preference into the settings document, when there is one. */
  function mirrorFieldToSettings(field, value) {
    if (settingsScope === null) return
    if (settingsScope.get()?.[field] === value) return
    void Promise.resolve(settingsScope.update({ [field]: value }))
      .catch((error) => logger.warn(`settings write failed: ${describeError(error)}`))
  }

  /**
   * Apply one settings section to the live transports.
   * @param values - the resolved section, or undefined before the first read.
   */
  async function applySettings(values) {
    if (values === null || typeof values !== 'object') return
    state.enabled = values.enabled !== false
    rememberTarget()
    // The panel has mode buttons; the chat has `#mode`. Both land here, so the
    // two surfaces cannot disagree — an unknown name is ignored rather than
    // throwing away the running mode.
    if (typeof values.mode === 'string' && compact(values.mode) !== compact(state.mode)) {
      const wanted = modeList().find((mode) => compact(mode.name) === compact(values.mode))
      if (wanted !== undefined) {
        applyMode(wanted)
        debug('settings-mode', { mode: wanted.name })
      }
    }
    if (typeof values.avatarData === 'string') cacheUploadedAvatar(values.avatarData)
    if (typeof values.uiProbe === 'string' && values.uiProbe !== '' && values.uiProbe !== lastUiProbe) {
      lastUiProbe = values.uiProbe
      debug('ui-probe', { probe: values.uiProbe })
    }
    if (typeof values.imageReplies === 'boolean' && values.imageReplies !== state.imageReplies) {
      state.imageReplies = values.imageReplies
      rememberTarget()
      debug('settings-image-replies', { on: values.imageReplies })
    }
    if ((values.deliverMode === 'queue' || values.deliverMode === 'steer')
      && values.deliverMode !== state.messageMode) {
      state.messageMode = values.deliverMode
      rememberTarget()
      debug('settings-deliver-mode', { mode: values.deliverMode })
    }
    // The web session tree pins a target by writing this field; the chat does it
    // with `#use` / `#reply`. The compare-and-skip is what keeps the two from
    // fighting: when the chat is the writer, the mirror already matches.
    if (typeof values.pinSessionId === 'string' && values.pinSessionId !== (state.pinnedSessionId ?? '')) {
      if (values.pinSessionId === '') {
        state.pinnedSessionId = undefined
        debug('settings-unpin')
      } else {
        state.pinnedSessionId = values.pinSessionId
        state.lastActiveSessionId = values.pinSessionId
        state.lastTargetSessionId = values.pinSessionId
        debug('settings-pin', { sessionId: values.pinSessionId })
      }
      rememberTarget()
    }
    for (const channel of channels) {
      const field = TRANSPORT_FIELD[channel.id]
      if (field === undefined) continue
      const on = values[field] !== false
      if (on === channelOn(channel)) continue
      debug('settings-apply', { transport: channel.id, on })
      await setChannelOn(channel, on)
    }
  }

  /**
   * One transport's readiness in the operator's language.
   *
   * `snapshot.state` is the *bridge* state, not readiness — a WeChat bridge with
   * no logged-in client reports `state: 'ready'` and `ready: false`, and printing
   * the state alone reads as "就绪" while nothing can actually be delivered.
   * @param snapshot - the channel's synchronous status.
   * @returns the label.
   */
  function describeReadiness(snapshot) {
    if (snapshot.ready) return '就绪'
    return `未就绪（${snapshot.state}）`
  }

  /**
   * Why the last read came back empty, when the transport reports a reason.
   *
   * Passive WeChat reading only ever sees the conversation that is already on
   * screen, so "it is not receiving" is usually this line rather than a dead
   * bridge — worth surfacing in the chat instead of only in the logs.
   * @param snapshot - the channel's synchronous status.
   * @returns a suffix for the channel line, or an empty string.
   */
  function skipNote(snapshot) {
    const skipped = snapshot.detail?.skipped
    if (skipped === undefined || skipped === null || skipped === '') return ''
    return `（上一次读取被跳过：${String(skipped)}）`
  }

  // ------------------------------------------------------- permission presets
  /** The sandbox mode that means "full file access, no approval prompts". */
  const DANGEROUS_SANDBOX = 'danger-full-access'
  /** Wrong-password bookkeeping for the danger preset, per process. */
  const passwordFailures = { count: 0, lockedUntil: 0 }

  function permissionService() {
    return ctx.get('permissionPresets')
  }

  /**
   * The password that unlocks the danger preset.
   *
   * It IS the administrator password — one secret, two jobs (gating every command
   * and unlocking full access) — because "remember which password is which" is a
   * bad thing to ask of someone holding a phone.
   * @returns the expected password, or '' when none is configured.
   */
  function expectedFullAccessPassword() {
    return expectedAccessPassword()
  }

  /**
   * The administrator password; `''` means "nothing is protected".
   *
   * Settings first, composition second, and `accessPassword` is honoured as a
   * config alias so one password can be configured either way.
   */
  function expectedAccessPassword() {
    const fromSettings = settingsScope?.get?.()?.fullAccessPassword
    if (typeof fromSettings === 'string' && fromSettings !== '') return fromSettings
    if (typeof config.accessPassword === 'string' && config.accessPassword !== '') return config.accessPassword
    return typeof config.fullAccessPassword === 'string' ? config.fullAccessPassword : ''
  }

  // ------------------------------------------------------------ authorization
  /** Wrong-password bookkeeping; reset on every success. */
  const authFailures = { count: 0, pausedUntil: 0 }
  /** Last time each conversation was told it needs a password. */
  const authHints = new Map()

  /**
   * Identity an authorization is granted to: one conversation, one channel.
   *
   * Not the sender alone: in a group, "who typed it" would let one member
   * authorize the whole group (and the group's other members then drive the
   * machine), so the grant is bound to the conversation the message came from.
   */
  function senderKeyOf(channel, message) {
    const who = message?.senderId ?? message?.conversation ?? 'default'
    return `${channel.id}:${who}`
  }

  /** Milliseconds an authorization lasts; `0` means "until DSH restarts". */
  function accessTtlMs() {
    const minutes = Number(config.accessTtlMinutes)
    return Number.isFinite(minutes) && minutes > 0 ? minutes * 60000 : 0
  }

  function accessPasswordIsSet() {
    return expectedAccessPassword() !== ''
  }

  /**
   * Whether ordinary commands are gated at all.
   *
   * The password always guards the danger preset; this decides whether it *also*
   * stands in front of every command. Default `off`: the operator's own chat is
   * not a hostile channel, and asking for a password to read `#status` is
   * friction with no threat model behind it.
   */
  function accessGateIsOpen() {
    // `all` (or a YAML `on`) opens it; `off` and a YAML `false` leave it closed.
    const gate = config.accessGate
    return (gate === 'all' || gate === true) && accessPasswordIsSet()
  }

  /**
   * Strip configured passwords out of anything headed for a log.
   *
   * The operator's own message *is* the password when they authorize, and both
   * the debug trace and the transports' info lines would otherwise record it in
   * clear text — in a file the README tells people to share when debugging.
   */
  function redactSecrets(text) {
    let out = String(text ?? '')
    for (const secret of [expectedAccessPassword(), expectedFullAccessPassword()]) {
      if (secret === '' || !out.includes(secret)) continue
      out = out.split(secret).join('***')
    }
    return out
  }
  // Now that it exists, wire it into the transports' own logging.
  redactSecretsRef.current = redactSecrets

  /** Whether this conversation may run commands right now. */
  function isAuthorized(channel, message) {
    if (!accessGateIsOpen()) return true
    const key = senderKeyOf(channel, message)
    const granted = state.authorized.get(key)
    if (granted === undefined) return false
    if (granted !== 0 && Date.now() > granted) {
      state.authorized.delete(key)
      return false
    }
    return true
  }

  function grantAccess(channel, message) {
    const ttl = accessTtlMs()
    state.authorized.set(senderKeyOf(channel, message), ttl === 0 ? 0 : Date.now() + ttl)
    authFailures.count = 0
    authFailures.pausedUntil = 0
  }

  /**
   * The password a message is *offering*, when it is shaped like an attempt.
   *
   * Three accepted spellings, because the operator types them on a phone:
   *   `#<password>`  the bare form (`#+<password>` is tolerated)
   *   `#auth <password>` / `#授权 <password>`
   * @returns the offered password, or `null` when this is not an attempt.
   */
  function passwordOffered(body) {    const explicit = /^(?:auth|login|pass|password|授权|密码)\s+(.+)$/i.exec(body.trim())
    if (explicit !== null) return explicit[1].trim()
    const bare = body.trim().replace(/^\+/, '')
    if (bare === '') return null
    if (/\s/.test(bare)) return null // a phrase is a command/answer, not a password
    // A built-in command word is never treated as a password: sending `#status`
    // before authorizing should explain itself, not burn an attempt.
    if (COMMAND_WORDS.has(compact(bare))) return null
    return bare
  }

  /**
   * The gate in front of every command.
   *
   * Returns true when the message was consumed by authorization (authorized,
   * refused, or answered with a hint) and must not reach the dispatcher.
   */
  async function gateAccess(channel, message, { body = '', prefixed = true } = {}) {
    if (!accessGateIsOpen()) return false
    if (isAuthorized(channel, message)) return false
    const expected = expectedAccessPassword()
    const key = senderKeyOf(channel, message)
    const now = Date.now()
    if (now < authFailures.pausedUntil) {
      const seconds = Math.ceil((authFailures.pausedUntil - now) / 1000)
      await replyTo(channel, `【DSH】密码错太多次，${seconds} 秒后再试。`)
      return true
    }
    // A message without the command prefix is never a password attempt: the
    // operator's ordinary chatter must not burn attempts.
    const offered = prefixed ? passwordOffered(body) : null
    if (offered !== null && offered === expected) {
      grantAccess(channel, message)
      const ttl = accessTtlMs()
      debug('access-granted', { key, ttlMinutes: ttl === 0 ? 'until-restart' : ttl / 60000 })
      await replyTo(channel, [
        '【DSH】已授权 ✓',
        ttl === 0
          ? '本次运行内不再验证（DSH 重启或发 #lock 需要重新授权）。'
          : `接下来 ${Math.round(ttl / 60000)} 分钟内不再验证。`,
        `现在可以发指令了，例如 ${config.commandPrefix || ''}status。`,
      ].join('\n'))
      return true
    }
    if (offered !== null) {
      // Never log the candidate itself: the trace file is a plain-text artifact.
      authFailures.count += 1
      const limit = Number(config.accessMaxFailures)
      if (Number.isFinite(limit) && limit > 0 && authFailures.count >= limit) {
        authFailures.count = 0
        authFailures.pausedUntil = now + 60000
        debug('access-paused', { key, seconds: 60 })
        await replyTo(channel, '【DSH】密码不对，已连错多次 —— 暂停 60 秒再试。')
        return true
      }
      debug('access-rejected', { key, attempt: authFailures.count })
      await replyTo(channel, `【DSH】密码不对（第 ${authFailures.count} 次）。`)
      return true
    }
    // No password in the message at all: explain, but do not turn a chatty
    // sender into a spam loop. A *command* word always gets the explanation —
    // someone typing `#status` deserves an answer, not silence.
    const isCommandWord = prefixed && COMMAND_WORDS.has(compact(body))
    const lastHint = authHints.get(key) ?? 0
    if (!isCommandWord && now - lastHint < 60000) return true
    authHints.set(key, now)
    debug('access-required', { key })
    await replyTo(channel, [
      '【DSH】需要先授权：把密码连在 # 后面发一次，例如 #<password>。',
      '（现在发的这条不是密码形式，所以没有执行。）',
    ].join('\n'))
    return true
  }

  /** Whether a preset grants unapproved full file access. */
  function presetIsDangerous(service, name) {
    try {
      return service.resolve(name)?.sandbox === DANGEROUS_SANDBOX
    } catch {
      return /danger|full/i.test(name)
    }
  }

  /** `标签（名字）` for one preset, falling back to the raw name. */
  function presetLabel(service, name) {
    try {
      const option = service.optionOf(name)
      const label = option?.label ?? name
      return label === name ? name : `${label}（${name}）`
    } catch {
      return name
    }
  }

  /** One-letter shorthands a phone can type: read-only / write-ish / full. */
  const PRESET_SHORTHAND = {
    r: /read|^ro$/i,
    w: /write|edit|accept|workspace/i,
    f: /full|danger|yolo/i,
  }

  /**
   * Resolve a preset the way a chat types it: exact name, unique prefix, or one
   * of the `r` / `w` / `f` shorthands (`#perm f <password>`).
   * @param service - the permission preset service.
   * @param requested - compacted user input.
   * @returns the preset name, or undefined.
   */
  function resolvePresetName(service, requested) {
    const names = service.names
    if (names.includes(requested)) return requested
    const pattern = PRESET_SHORTHAND[requested]
    if (pattern !== undefined) {
      const hit = names.find((candidate) => pattern.test(candidate))
      if (hit !== undefined) return hit
      // Table order keeps r/w/f meaningful even for unusual preset tables.
      const index = requested === 'r' ? 0 : (requested === 'w' ? 1 : names.length - 1)
      return names[index]
    }
    const matches = names.filter((candidate) => candidate.toLowerCase().startsWith(requested))
    return matches.length === 1 ? matches[0] : undefined
  }

  /** The last answer this plugin pushed, so `#again` can re-render it. */
  let lastReport = null

  /** One line per transport, for `#channels`. */
  function channelLines() {
    const lines = ['【DSH 通道】', `总开关：${state.enabled ? '开启' : '关闭（发 #on 打开）'}`]
    for (const channel of channels) {
      const snapshot = channel.statusSync()
      const stateText = channelOn(channel) ? describeReadiness(snapshot) : '已停用'
      lines.push(`· ${snapshot.label} [${snapshot.id}]：${stateText}${skipNote(snapshot)}`)
    }
    lines.push('', '用法：#switch qq off / #switch wechat on（也可直接发 #qq off、#wechat on）')
    return lines.join('\n')
  }

  /**
   * Send to every ready transport, suppressing immediate duplicates per channel.
   * @param text - message body.
   * @param options - `force` bypasses the dedupe window.
   * @returns true when at least one transport accepted the message.
   */
  async function broadcast(text, { force = false } = {}) {
    if (!state.enabled) return false
    const body = clamp(text, config.maxMessageChars)
    if (!body.trim()) return false
    const now = Date.now()
    const digest = createHash('sha1').update(body).digest('hex')
    for (const [key, timestamp] of recentSends) {
      if (now - timestamp > config.dedupeMs * 4) recentSends.delete(key)
    }
    let delivered = false
    for (const channel of channels) {
      if (!channel.ready || !channelOn(channel)) continue
      const key = `${channel.id}:${digest}`
      const previous = recentSends.get(key)
      if (!force && previous !== undefined && now - previous < config.dedupeMs) continue
      recentSends.set(key, now)
      const ok = await channel.send(body)
      if (ok) {
        delivered = true
        state.sentCount += 1
      } else {
        // Keep the transport's own reason: "every transport rejected the send"
        // with no cause attached is what makes this failure mode expensive.
        state.lastError = channel.statusSync?.().detail?.lastError ?? `${channel.id} refused the send`
      }
    }
    return delivered
  }

  /**
   * Draw one reply as a card and deliver it.
   *
   * Split out of the two reply paths so neither can recurse into the other, and
   * so "no card" is a return value rather than an exception. A failure here is
   * never the end of the story: every caller falls back to plain text, because a
   * card is a nicety and never the reason a command goes unanswered.
   * @returns true when the transport accepted the image.
   */
  async function sendCard(channel, body) {
    if (typeof channel.sendImage !== 'function') return false
    try {
      const card = await renderTextImage({
        text: body,
        maxWidth: config.imageMaxWidth,
        pythonPath: config.pythonPath,
        avatar: avatarPath(),
        footer: cardFooter(),
      })
      const ok = await channel.sendImage(card.png, { caption: null })
      if (ok) {
        state.sentCount += 1
        debug('reply-image', {
          transport: channel.id,
          chars: body.length,
          width: card.width,
          height: card.height,
        })
        return true
      }
      debug('reply-image-refused', { transport: channel.id })
    } catch (error) {
      debug('reply-image-failed', { transport: channel.id, message: describeError(error) })
      logger.warn(`card render failed on ${channel.id}, answering with text: ${describeError(error)}`)
    }
    return false
  }

  /** Deliver one reply as plain text on the transport a command arrived from. */
  async function sendPlain(channel, body) {
    // Table rows are tab-separated for the card renderer; in a chat a tab
    // collapses to nothing, so expand it into a readable gap instead.
    const flat = body.includes('\t') ? body.replace(/\t/g, '  ') : body
    const ok = await channel.send(flat, { force: true })
    // A reply that cannot be delivered used to vanish silently, which looks
    // exactly like "the plugin ignored my command".
    if (!ok) logger.warn(`reply on ${channel.id} was not delivered: ${channel.statusSync?.().detail?.lastError ?? 'unknown'}`)
    debug('reply', { transport: channel.id, ok, chars: flat.length, head: flat.slice(0, 40) })
    return ok
  }

  /**
   * Reply on the transport the command arrived from.
   *
   * With `richAcks` on, even a one-line receipt is drawn as a card, so *every*
   * reply follows `#img` the way reports and `#status` already do. Off by
   * default: a card per acknowledgement is noise on a phone.
   */
  async function replyTo(channel, text) {
    const body = clamp(text, config.maxMessageChars)
    if (!body.trim()) return false
    // Only a *rendered* reply becomes the `#again` target: a one-line receipt is
    // not something anyone needs re-sent, and letting it overwrite the report
    // would make `#again` hand back the receipt of the command itself.
    if (richAcksOn() && imageRepliesOn()
      && await sendCard(channel, body)) {
      state.lastAnswer = { text: body, at: Date.now() }
      return true
    }
    return sendPlain(channel, body)
  }

  /**
   * Answer an *informational* command, as a rendered card when we can.
   *
   * A phone chat renders a multi-line status badly — proportional fonts, awkward
   * wrapping — while the same text drawn as a small card reads at a glance. Any
   * failure (no Pillow, no font, a transport that cannot carry images) falls back
   * to plain text.
   * @param channel - the transport to answer on.
   * @param text - the reply body.
   * @returns true when something was delivered.
   */
  async function replyRich(channel, text) {
    const body = clamp(text, config.maxMessageChars)
    if (!body.trim()) return false
    state.lastAnswer = { text: body, at: Date.now() }
    if (imageRepliesOn() && await sendCard(channel, body)) return true
    return sendPlain(channel, body)
  }

  /**
   * The card footer: `昵称 · 签名 · 时间`, with the parts that are set.
   *
   * Both fields are optional and empty by default, because a footer that says
   * `undefined · undefined` is worse than no footer at all.
   */
  function cardFooter() {
    const { nickname, signature } = profile()
    const stamp = new Date().toLocaleString('zh-CN', { hour12: false })
    return [nickname, signature, stamp].filter((part) => part !== '').join(' · ')
  }

  /** Where an avatar uploaded from the browser panel is cached. */
  function uploadedAvatarFile() {
    return join(dirname(store.file), 'remote-channel-avatar.png')
  }

  /** Whether the cached upload is known to be on disk yet. */
  let uploadedAvatarReady = false
  /** The upload last written, so a settings echo does not rewrite the file. */
  let uploadedAvatarHash = ''

  /**
   * Write a `data:` image URL from the profile panel out as a real file.
   *
   * `settings` only stores values, and the card renderer runs as a separate
   * Python process, so the browser downsizes the picked picture and this turns it
   * back into bytes beside the state file. The format is sniffed from the content
   * downstream, which is why the `.png` suffix is only a name: the panel sends
   * JPEG, PNG or WebP, whichever the browser produced.
   * @param dataUrl - `data:image/...;base64,...`, or '' to drop the upload.
   */
  function cacheUploadedAvatar(dataUrl) {
    const text = typeof dataUrl === 'string' ? dataUrl.trim() : ''
    if (text === '') {
      // Cleared in the panel: fall back to the configured/bundled avatar instead
      // of leaving a stale picture on every card.
      if (!uploadedAvatarReady) return
      uploadedAvatarReady = false
      uploadedAvatarHash = ''
      try {
        rmSync(uploadedAvatarFile(), { force: true })
        debug('avatar-upload-cleared')
      } catch (error) {
        debug('avatar-upload-clear-failed', { message: describeError(error) })
      }
      return
    }
    const match = /^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(text)
    if (match === null) {
      debug('avatar-upload-rejected', { chars: text.length })
      logger.warn('the avatar from the settings panel is not a data: image URL; ignored')
      return
    }
    if (match[2] === uploadedAvatarHash) return
    try {
      const file = uploadedAvatarFile()
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, Buffer.from(match[2], 'base64'))
      uploadedAvatarHash = match[2]
      uploadedAvatarReady = true
      debug('avatar-uploaded', { format: match[1], chars: match[2].length })
      logger.info(`avatar uploaded from the settings panel (${match[1]}) → ${file}`)
    } catch (error) {
      debug('avatar-upload-failed', { message: describeError(error) })
    }
  }

  /**
   * The avatar to stamp on a card, or null for a header without one.
   *
   * An upload from the panel wins over the configured path, because that is the
   * most recent thing the operator chose and the only one they can see in the UI.
   * The bundled avatar is the final fallback, so a checkout and a packaged install
   * show the same identity.
   */
  function avatarPath() {
    const configured = typeof config.avatar === 'string' ? config.avatar.trim() : ''
    if (configured === '-') return null
    if (!uploadedAvatarReady && existsSync(uploadedAvatarFile())) uploadedAvatarReady = true
    if (uploadedAvatarReady) return uploadedAvatarFile()
    if (configured !== '') return configured
    return BUNDLED_AVATAR
  }

  /**
   * Push an *unprompted* message (`#push`-style reports) to every transport.
   *
   * Unlike `replyRich`, which answers on the transport a command came from, this
   * has no originating channel, so the card is rendered once and fanned out —
   * and the text form stays the fallback whenever rendering or an image-capable
   * transport is missing.
   * @param text - the report body.
   * @returns true when at least one transport accepted it.
   */
  async function broadcastRich(text, { force = true } = {}) {
    const body = clamp(text, config.maxMessageChars)
    if (!body.trim()) return false
    state.lastAnswer = { text: body, at: Date.now() }
    const targets = channels.filter((channel) => channel.ready && channelOn(channel))
    if (targets.length === 0) return false
    if (imageRepliesOn() && targets.some((channel) => typeof channel.sendImage === 'function')) {
      try {
        const card = await renderTextImage({
          text: body,
          maxWidth: config.imageMaxWidth,
          pythonPath: config.pythonPath,
          avatar: avatarPath(),
          footer: cardFooter(),
        })
        let delivered = await broadcastImage(card.png, { caption: null })
        // A transport that cannot carry images still gets the words.
        const textOnly = targets.filter((channel) => typeof channel.sendImage !== 'function')
        for (const channel of textOnly) {
          if (await channel.send(body, { force })) {
            delivered = true
            state.sentCount += 1
          }
        }
        if (delivered) {
          debug('broadcast-image', { chars: body.length, width: card.width, height: card.height })
          return true
        }
      } catch (error) {
        debug('broadcast-image-failed', { message: describeError(error) })
        logger.warn(`card render failed, sending text: ${describeError(error)}`)
      }
    }
    const ok = await broadcast(body, { force })
    if (!ok) {
      // A fan-out that delivered nothing used to be a bare `false`, which reads
      // identically for "no channel", "channel off" and "the socket is dead".
      // Log which one it was: this is the failure the operator notices last and
      // needs explained first.
      debug('broadcast-failed', {
        enabled: state.enabled,
        channels: channels.map((channel) => `${channel.id}:${channel.ready ? 'ready' : channel.state ?? 'not-ready'}${channelOn(channel) ? '' : '/off'}`),
        lastError: state.lastError,
      })
    }
    return ok
  }

  /** Send an image on every ready transport that can carry one. */
  async function broadcastImage(pngBase64, { caption = null, only = null } = {}) {
    let delivered = false
    for (const channel of channels) {
      if (!channel.ready || typeof channel.sendImage !== 'function') continue
      if (!channelOn(channel)) continue
      if (only !== null && channel !== only) continue
      const ok = await channel.sendImage(pngBase64, { caption })
      if (ok) {
        delivered = true
        state.sentCount += 1
      }
    }
    return delivered
  }

  /**
   * Capture the desktop for a report image.
   *
   * The plugin-side helper is tried first so screenshots work regardless of
   * which transports are enabled; a transport that can capture more cheaply
   * (the WeChat bridge, which can also target one window) is the fallback.
   */
  async function takeScreenshot(options) {
    if (config.screenshots !== true) return null
    let monitor = options?.monitor ?? state.shotMonitor
    // A remembered display number can outlive the monitor (undocked laptop,
    // unplugged screen). Falling back to the main screen beats "capture failed".
    if (/^[1-9]\d?$/.test(String(monitor)) && options?.windowTitle == null) {
      const monitors = await availableMonitors()
      if (monitors.length > 0 && !monitors.some((m) => m.index === Number(monitor))) {
        logger.warn(`screen ${monitor} is gone; falling back to the main display`)
        monitor = 'primary'
      }
    }
    if (config.screenshotProvider !== 'channel') {
      try {
        return await captureScreen({
          maxWidth: options?.maxWidth ?? config.screenshotMaxWidth,
          windowTitle: options?.windowTitle ?? null,
          monitor,
          pythonPath: config.pythonPath,
        })
      } catch (error) {
        logger.warn(`desktop screenshot failed: ${describeError(error)}`)
      }
    }
    for (const channel of channels) {
      if (typeof channel.screenshot !== 'function' || !channel.ready) continue
      try {
        return await channel.screenshot(options)
      } catch (error) {
        logger.warn(`screenshot via ${channel.id} failed: ${describeError(error)}`)
      }
    }
    return null
  }

  /**
   * Remember which session most recently spoke to the operator.
   *
   * Called from every push that names a session (reports, notifications), so
   * `#reply` has something to address. The label is mirrored for the panel, which
   * shows "刚刚发言" next to the session it belongs to.
   * @param agent - the agent whose message just went out.
   */
  function noteSpeaker(agent) {
    if (agent === undefined || agent === null || typeof agent.id !== 'string' || agent.id === '') return
    state.lastSpeakerId = agent.id
    state.lastSpeakerAt = Date.now()
    rememberTarget()
    mirrorFieldToSettings('speakerLabel', sourceLabelFor(agent) ?? '')
    debug('last-speaker', { sessionId: agent.id })
  }

  /**
   * Fire-and-forget notification used by the event hooks.
   *
   * It goes through the same renderer as everything else, so progress pings,
   * error reports and approval prompts obey `#img` too. When the notification
   * knows which agent it is about, that agent's `工作区 - 会话名` rides the first
   * line — the operator is usually looking at two or three sessions at once.
   */
  function notify(headline, detail, agent = null) {
    noteSpeaker(agent)
    const source = sourceLabelFor(agent)
    const body = source === null
      ? `【DSH·${headline}】\n${detail}`
      : `【DSH·${headline}】${source}\n${detail}`
    void broadcastRich(body).catch(() => undefined)
  }

  // --------------------------------------------------------- session wiring
  function agentsService() {
    return ctx.get('agents')
  }

  function sessionControllerService() {
    return ctx.get('sessionController')
  }

  /** The workspace the target session lives in, when it can be read. */
  function targetWorkspacePath() {
    const agents = agentsService()
    const sessionId = resolveTargetSession()
    if (agents === undefined || sessionId === undefined) return null
    const agent = agents.get(sessionId)
    return agent?.session?.header?.cwd ?? null
  }

  /** Last path segment, for a readable workspace name. */
  function basename(path) {
    if (typeof path !== 'string' || path.trim() === '') return null
    const parts = path.replace(/[\\/]+$/, '').split(/[\\/]+/)
    const last = parts[parts.length - 1]
    return last === undefined || last === '' ? null : last
  }

  /**
   * Whether two directory strings mean the same folder.
   *
   * Windows paths are case-insensitive and the same directory arrives spelled
   * several ways (`D:\x\`, `D:/x`), so a raw string compare would miss the
   * project that is already registered — and the session would land in 未分组
   * while a duplicate project got created beside it.
   * @returns true when both name the same directory.
   */
  function samePath(left, right) {
    if (typeof left !== 'string' || typeof right !== 'string') return false
    const normalize = (value) => value.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
    return normalize(left) === normalize(right)
  }

  /**
   * Latest `session/title` in a log — the durable, human-chosen session name.
   *
   * Titles are log events (`{data: {title, source, messageSeqs}}`) and latest
   * wins, exactly like the title projection the web UI reads.
   * @param events - a live session's snapshot or an inspected durable log.
   * @returns the newest non-empty title, or null.
   */
  function titleFromEvents(events) {
    if (!Array.isArray(events)) return null
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]
      if (event?.type !== 'session/title') continue
      const title = event.data?.title
      if (typeof title === 'string' && title.trim() !== '') return title.trim()
    }
    return null
  }

  /**
   * Title of a live session, without replaying its whole log when the
   * `sessionTitle` service can answer directly.
   * @param agent - a live agent.
   * @returns the current title, or null.
   */
  function liveSessionTitle(agent) {
    try {
      const snapshot = ctx.get('sessionTitle')?.get?.(agent?.session)
      if (typeof snapshot?.title === 'string' && snapshot.title.trim() !== '') return snapshot.title.trim()
    } catch {
      // Fall through to the log fold: an unmounted or unhappy service must not
      // cost us the title.
    }
    try {
      return titleFromEvents(agent?.session?.snapshotEvents?.())
    } catch {
      return null
    }
  }

  /**
   * Everything the operator needs to recognise one session: its name, the
   * workspace it works in, and whether an agent is live.
   *
   * A live agent's session is read straight out of memory; a closed one goes
   * through `sessionController.inspect`, which replays the durable log without
   * resuming anything.
   * @param sessionId - session to describe.
   * @returns the description, or null when there is no session at all.
   */
  async function describeSession(sessionId) {
    if (sessionId === undefined || sessionId === null || sessionId === '') return null
    const agent = agentsService()?.get(sessionId)
    if (agent !== undefined) {
      return {
        id: sessionId,
        live: true,
        cwd: agent.session?.header?.cwd ?? null,
        title: liveSessionTitle(agent),
        status: agent.status ?? null,
      }
    }
    const controller = sessionControllerService()
    if (controller === undefined || typeof controller.inspect !== 'function') {
      return { id: sessionId, live: false, cwd: null, title: null, status: null }
    }
    try {
      const inspection = await controller.inspect(sessionId, AbortSignal.timeout(5000))
      return {
        id: sessionId,
        live: false,
        cwd: inspection?.header?.cwd ?? null,
        title: titleFromEvents(inspection?.events),
        status: null,
      }
    } catch (error) {
      logger.debug?.(`inspect(${sessionId}) failed: ${describeError(error)}`)
      return { id: sessionId, live: false, cwd: null, title: null, status: null }
    }
  }

  /**
   * One-line session identity for chat replies: `订单服务（orders）`.
   *
   * Falls back to the workspace folder, then to the short id, so a reply is
   * never just an opaque `session-xxxx` again.
   * @param described - a `describeSession` result, or null.
   * @returns the label.
   */
  function sessionLabel(described) {
    if (described === null) return '（无会话）'
    const title = described.title ?? basename(described.cwd) ?? '未命名会话'
    const folder = basename(described.cwd)
    return described.title !== null && described.title !== undefined && folder !== null && folder !== described.title
      ? `${title}（${folder}）`
      : title
  }

  function resolveTargetSession() {
    const agents = agentsService()
    if (state.pinnedSessionId !== undefined) return state.pinnedSessionId
    if (config.targetSession !== 'auto') return config.targetSession
    if (agents === undefined) return state.lastTargetSessionId ?? undefined
    if (state.lastActiveSessionId !== null && agents.get(state.lastActiveSessionId) !== undefined) {
      return state.lastActiveSessionId
    }
    const roots = agents.roots()
    const last = roots[roots.length - 1]
    if (last !== undefined) return last.id
    // Nothing live: fall back to where the last command went, so remote
    // control still works right after a DSH restart with no open session.
    return state.lastTargetSessionId ?? undefined
  }

  /** Live top-level sessions, newest last. */
  function liveSessions() {
    const agents = agentsService()
    if (agents === undefined) return []
    return agents.roots()
  }

  /**
   * Pull the last assistant text out of a session log.
   *
   * A `SessionEvent` is `{ type, seq, time, data }` — the payload lives under
   * `data`, not inline. `assistant/message`'s data carries `message`, whose
   * `content` is the block array.
   * @param session - the agent's session.
   * @returns the plain text of the newest assistant message, or null.
   */
  function lastAssistantText(session) {
    let events
    try {
      events = session?.snapshotEvents?.()
    } catch {
      return null
    }
    if (!Array.isArray(events)) return null
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]
      if (event?.type !== 'assistant/message') continue
      const payload = event.data ?? event
      const blocks = payload?.message?.content
      if (!Array.isArray(blocks)) continue
      const text = blocks
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('')
        .trim()
      if (text !== '') return text
    }
    return null
  }

  ctx.effect(() => {
    const stopStatus = ctx.on('agent/status', ({ agent, status }) => {
      if (status !== 'running') return
      const agents = agentsService()
      if (agents === undefined) return
      if (agents.roots().includes(agent)) state.lastActiveSessionId = agent.id
    })
    return () => stopStatus()
  })

  // ------------------------------------------------------- report the answer
  ctx.effect(() => {
    if (!config.reportOnTurnEnd) return () => {}
    return ctx.on('agent/turn-stopping', ({ agent }) => {
      const agents = agentsService()
      if (agents === undefined || !agents.roots().includes(agent)) return
      if (config.reportOnlyTargetSession) {
        const target = resolveTargetSession()
        if (target !== undefined && target !== agent.id) {
          debug('report-skipped', { sessionId: agent.id, why: 'not-the-target-session' })
          return
        }
      }
      const pending = state.pendingRemoteTurns.get(agent.id) ?? 0
      if (config.reportOnlyRemoteTurns && pending <= 0) {
        // The deliberate "you started this turn at the computer" case. It is
        // logged, because from the chat it is indistinguishable from a broken
        // report — and "why did that answer not arrive?" needs an answer.
        debug('report-skipped', { sessionId: agent.id, why: 'turn-not-started-from-chat' })
        return
      }
      if (pending > 0) {
        if (pending === 1) state.pendingRemoteTurns.delete(agent.id)
        else state.pendingRemoteTurns.set(agent.id, pending - 1)
      }
      const text = lastAssistantText(agent.session)
      if (text === null) return
      state.reportedCount += 1
      debug('report', { sessionId: agent.id, chars: text.length })
      // Deliberately not awaited: this listener runs inside the awaited turn
      // boundary, and delivering a report must not hold the turn open.
      void (async () => {
        // `工作区 - 会话名`, so a report says which session is talking before the
        // body: with several workspaces open that is the first thing the operator
        // needs and the last thing they can infer.
        const name = sourceLabelFor(agent) ?? sessionNameOf(agent)
        // Answering a report is the one action the operator wants immediately, and
        // with several sessions open "which number is this one" is the friction.
        // The hint only appears when it can actually be useful.
        noteSpeaker(agent)
        const replyHint = liveSessions().length > 1
          ? `\n\n回它：${config.commandPrefix}reply <话>`
          : ''
        // The turn number is what makes `#fork <n>` possible from a phone: it
        // turns the chat history the operator already has into addressing.
        const mark = [...state.turnMarks].reverse().find((entry) => entry.sessionId === agent.id)
        const stamp = mark === undefined ? '' : `\n\n回合 #${mark.n}（要在这里分叉就发 #fork ${mark.n}）`
        // `broadcastRich` honours the `#img` setting for reports too, so a long
        // answer arrives as a readable card rather than a wall of phone text.
        const report = `【DSH 汇报】${name}\n\n${clamp(text, config.reportMaxChars)}${stamp}${replyHint}`
        // Remembered so `#again` can re-render the same answer in whatever
        // format the operator switched to.
        lastReport = { text: report, sessionId: agent.id, at: Date.now() }
        await broadcastRich(report)
        if (config.reportWithScreenshot && config.screenshots) {
          const shot = await takeScreenshot({ maxWidth: config.screenshotMaxWidth })
          if (shot !== null) await broadcastImage(shot.png, { caption: `【DSH 截图】${shot.width}×${shot.height}` })
        }
      })().catch(() => undefined)
    })
  })

  // ------------------------------------------------- answering ask_user_question
  /**
   * `ask_user_question` blocks the turn until a human answers. The Web client
   * answers it through the question surface; this makes the chat a *second*
   * answerer by racing the two, so a question can be answered from a phone
   * without the desktop being touched — and whichever side answers first wins.
   *
   * The chat protocol mirrors the Web pager:
   *   `#1`        choose option 1 of the current question
   *   `<text>`     a custom answer for the current question
   *   `#>` `#<`   next / previous question        `#q2` jump to question 2
   *   `#submit`   submit now (unanswered items become `{selected: []}`)
   */
  const QUESTION_HELP = (p) =>
    `选 ${p}1 · 自定义 <text> · 切题 ${p}> ${p}< · 交卷 ${p}submit`

  /** One question, rendered the way the chat shows it. */
  function questionText(entry, { note = null } = {}) {
    const total = entry.questions.length
    const question = entry.questions[entry.cursor]
    const lines = []
    if (note !== null) lines.push(note, '')
    lines.push(`题 ${entry.cursor + 1}/${total}：${question.question}`)
    const detail = typeof question.detail === 'string' ? question.detail.trim() : ''
    if (detail !== '') lines.push('', clamp(detail, 500))
    const options = Array.isArray(question.options) ? question.options : []
    if (options.length > 0) {
      lines.push('')
      options.forEach((option, index) => {
        const description = typeof option.description === 'string' && option.description !== ''
          ? ` — ${option.description}`
          : ''
        lines.push(`${index + 1}) ${option.label}${description}`)
      })
      if (question.multiSelect === true) lines.push('（多选：可以回 #1 3 这样的多个编号）')
    }
    const answered = [...entry.answers.keys()].length
    lines.push('', `${QUESTION_HELP(config.commandPrefix)}　（已答 ${answered}/${total}）`)
    return lines.join('\n')
  }

  /** The answer batch the tool is waiting for, in the original question order. */
  function pendingAnswer(entry) {
    return {
      answers: entry.questions.map((question) => {
        const answer = entry.answers.get(question.id)
        if (answer === undefined) return { id: question.id, selected: [] }
        if (answer.custom !== undefined) {
          // Single-select: `custom` overrides `selected`; multi-select: it may
          // supplement the chosen labels. Match what the Web surface emits.
          return question.multiSelect === true
            ? { id: question.id, selected: answer.selected, custom: answer.custom }
            : { id: question.id, selected: [], custom: answer.custom }
        }
        return { id: question.id, selected: answer.selected }
      }),
    }
  }

  function pendingKeyOf(request) {
    return request?.agent?.id ?? '__unscoped__'
  }

  /** The question a chat message should act on. */
  function currentPending() {
    const target = resolveTargetSession()
    if (target !== undefined && state.pendingQuestions.has(target)) return state.pendingQuestions.get(target)
    if (state.pendingQuestions.size === 1) return [...state.pendingQuestions.values()][0]
    return undefined
  }

  /** Register a pending question and wait for either side to answer it. */
  function beginPending(request) {
    const entry = {
      key: pendingKeyOf(request),
      request,
      questions: Array.isArray(request.questions) ? request.questions : [],
      cursor: 0,
      answers: new Map(),
      at: Date.now(),
      aborted: false,
    }
    entry.promise = new Promise((resolve) => { entry.resolve = resolve })
    const signal = request.signal
    if (signal !== undefined && typeof signal.addEventListener === 'function') {
      entry.onAbort = () => {
        entry.aborted = true
        entry.resolve(ABORTED)
      }
      signal.addEventListener('abort', entry.onAbort)
    }
    state.pendingQuestions.set(entry.key, entry)
    return entry
  }

  function endPending(entry) {
    state.pendingQuestions.delete(entry.key)
    const signal = entry.request?.signal
    if (entry.onAbort !== undefined && typeof signal?.removeEventListener === 'function') {
      signal.removeEventListener('abort', entry.onAbort)
    }
  }

  /** Short "what just happened" line for the ack that follows an answer. */
  function answerNote(question, answer) {
    const options = Array.isArray(question.options) ? question.options : []
    if (answer.custom !== undefined) return `已记下自定义回答：${clamp(answer.custom, 80)}`
    const labels = answer.selected.map((label) => {
      const index = options.findIndex((option) => option.label === label)
      return index >= 0 ? `${index + 1}) ${label}` : label
    })
    return `已选中：${labels.join('、')}`
  }

  /**
   * Consume one chat message as an answer to the pending question.
   * @returns true when the message was consumed (so it must not be forwarded).
   */
  async function handlePendingAnswer(entry, body, channel) {
    const token = compact(body)
    const p = config.commandPrefix
    const question = entry.questions[entry.cursor]
    // -- pager
    if (token === '' ) {
      await replyRich(channel, questionText(entry))
      return true
    }
    if (matchesCommand(token, ['>', '》', 'next', '下一题', '下题', '下'])) {
      entry.cursor = Math.min(entry.questions.length - 1, entry.cursor + 1)
      await replyRich(channel, questionText(entry))
      return true
    }
    if (matchesCommand(token, ['<', '《', 'prev', 'previous', '上一题', '上题', '上'])) {
      entry.cursor = Math.max(0, entry.cursor - 1)
      await replyRich(channel, questionText(entry))
      return true
    }
    const jump = /^(?:题|q|p)(\d{1,2})$/.exec(token)
    if (jump !== null) {
      const wanted = Number(jump[1])
      if (wanted < 1 || wanted > entry.questions.length) {
        await replyTo(channel, `【DSH】只有 ${entry.questions.length} 题。`)
        return true
      }
      entry.cursor = wanted - 1
      await replyRich(channel, questionText(entry))
      return true
    }
    const forced = /^(?:答|answer|自定义|说)\s+([\s\S]+)$/i.exec(body.trim())
    const submitNow = matchesCommand(token, ['提交', '交卷', 'submit', 'done', 'ok', '完成'])
    if (submitNow) {
      entry.resolve(pendingAnswer(entry))
      endPending(entry)
      await replyRich(channel, [
        '【DSH 已交卷】',
        ...entry.questions.map((item) => {
          const answer = entry.answers.get(item.id)
          if (answer === undefined) return `· ${item.question} → （跳过）`
          return `· ${item.question} → ${answer.custom !== undefined ? answer.custom : answer.selected.join('、')}`
        }),
      ].join('\n'))
      return true
    }
    if (forced !== null) {
      return applyAnswer(entry, { custom: forced[1].trim() }, channel)
    }
    // -- numbered choice, when the numbers name real options
    const options = Array.isArray(question.options) ? question.options : []
    const numbers = body.trim().split(/[\s,，、]+/).filter((piece) => piece !== '')
    const allNumbers = numbers.length > 0 && numbers.every((piece) => /^\d{1,2}$/.test(piece))
    if (allNumbers) {
      const picked = numbers.map(Number)
      const valid = picked.every((index) => index >= 1 && index <= options.length)
      if (valid) {
        const selected = (question.multiSelect === true ? picked : picked.slice(0, 1))
          .map((index) => options[index - 1].label)
        return applyAnswer(entry, { selected }, channel)
      }
      // An out-of-range number is not a choice: the operator typed something, so
      // it is treated as the custom answer, exactly as requested.
    }
    if (body.trim() === '') {
      await replyRich(channel, questionText(entry))
      return true
    }
    return applyAnswer(entry, { custom: body.trim() }, channel)
  }

  /** Record one answer, then advance, submit, or keep asking. */
  async function applyAnswer(entry, answer, channel) {
    const question = entry.questions[entry.cursor]
    entry.answers.set(question.id, answer)
    const note = answerNote(question, answer)
    if (entry.answers.size >= entry.questions.length) {
      entry.resolve(pendingAnswer(entry))
      endPending(entry)
      debug('question-answered', { questions: entry.questions.length, where: 'chat' })
      await replyRich(channel, [
        '【DSH 已交卷】',
        ...entry.questions.map((item) => {
          const recorded = entry.answers.get(item.id)
          if (recorded === undefined) return `· ${item.question} → （跳过）`
          return `· ${item.question} → ${recorded.custom !== undefined ? recorded.custom : recorded.selected.join('、')}`
        }),
      ].join('\n'))
      return true
    }
    // Mirror the Web surface: a choice advances to the next question at once.
    const nextUnanswered = entry.questions.findIndex((item, index) => index > entry.cursor && !entry.answers.has(item.id))
    if (nextUnanswered >= 0) entry.cursor = nextUnanswered
    else {
      const anyUnanswered = entry.questions.findIndex((item) => !entry.answers.has(item.id))
      if (anyUnanswered >= 0) entry.cursor = anyUnanswered
    }
    debug('question-progress', { answered: entry.answers.size, of: entry.questions.length })
    await replyRich(channel, questionText(entry, { note }))
    return true
  }

  /** Tell the operator a question is waiting, on every ready transport. */
  function announceQuestion(request) {
    const total = Array.isArray(request.questions) ? request.questions.length : 0
    if (total === 0) return
    // A question is the session asking the operator something, so it counts as
    // "this one just spoke": `#reply` after a question reaches the session that
    // asked it, which is what makes answering from a phone a one-liner.
    noteSpeaker(request.agent)
    const first = request.questions[0]
    const lines = [
      `【DSH·需要你回答】${sourceLabelFor(request.agent) ?? '会话：未知'}`,
      '',
      `题 1/${total}：${first.question}`,
    ]
    const options = Array.isArray(first.options) ? first.options : []
    options.forEach((option, index) => lines.push(`${index + 1}) ${option.label}`))
    lines.push('', QUESTION_HELP(config.commandPrefix))
    void broadcastRich(lines.join('\n')).catch(() => undefined)
  }

  /** Sentinel meaning "the chat side did not answer". */
  const ABORTED = Symbol('aborted')
  /** A promise that never settles, for "keep waiting" in a race. */
  const NEVER = new Promise(() => {})

  /**
   * Whether a rejected downstream answerer means "nobody is listening".
   *
   * `dsh-user-questions` rejects with `NO_PROVIDER` when no answerer accepted the
   * request, which is the normal case with no browser attached.
   */
  function isNoAnswerer(error) {
    if (error === undefined || error === null) return false
    if (error.code === 'NO_PROVIDER') return true
    return /no user-questions answerer/i.test(String(error.message ?? error))
  }

  // ------------------------------------------------------------ problem pings
  ctx.effect(() => {
    const disposers = []

    // Optional mechanical progress ping for long remote turns. Off by default:
    // the agent is asked to report its own milestones via `remote_notify`, and
    // this is the safety net when it forgets.
    if (config.progressEveryToolCalls > 0) {
      const counts = new Map()
      disposers.push(ctx.on('tools/result', (exec) => {
        const agent = exec?.agent
        if (agent === undefined || agent === null) return
        const target = resolveTargetSession()
        if (target !== undefined && target !== agent.id) return
        if ((state.pendingRemoteTurns.get(agent.id) ?? 0) <= 0) return
        const count = (counts.get(agent.id) ?? 0) + 1
        counts.set(agent.id, count)
        if (count % config.progressEveryToolCalls !== 0) return
        notify('进度', [
          `已执行 ${count} 个工具调用`,
          `最近：${String(exec.name ?? '未知工具')}`,
        ].join('\n'), agent)
      }))
      disposers.push(ctx.on('agent/turn-stopping', ({ agent }) => counts.delete(agent.id)))
    }

    if (config.notifyOnError) {
      disposers.push(ctx.on('agent/error', ({ agent, turn, step, error }) => {
        notify('执行出错', [
          `位置：第 ${turn} 轮 / 第 ${step} 步`,
          describeError(error),
          '',
          `回复 ${config.commandPrefix || ''}status 查看状态，${config.commandPrefix || ''}stop 停止当前任务。`,
        ].join('\n'), agent)
      }))
    }

    if (config.notifyOnQuestion) {
      disposers.push(ctx.on('user-questions/request', async (request, next) => {
        try {
          announceQuestion(request)
        } catch (error) {
          logger.warn(`question notification failed: ${describeError(error)}`)
        }
        // Not able (or not asked) to answer from chat: behave exactly as before
        // and let the Web question surface own the request.
        if (!state.enabled || config.answerQuestionsFromChat === false) return next()
        const entry = beginPending(request)
        // The Web answerer stays live *concurrently*: `next()` is started now and
        // raced against the chat, so answering at the computer still works.
        const downstream = Promise.resolve().then(() => next())
        const outcome = downstream.then(
          (answer) => ({ kind: 'answer', answer }),
          (error) => ({ kind: 'error', error }),
        )
        try {
          const winner = await Promise.race([
            entry.promise.then((answer) => ({ kind: 'chat', answer })),
            outcome.then((result) => {
              if (result.kind === 'answer') return result
              // "Nobody is listening on the Web side" must NOT end the wait —
              // that is exactly when the chat is the only answerer. Any other
              // rejection (the user closed the Web panel) is a real cancellation
              // and has to propagate.
              if (isNoAnswerer(result.error)) return NEVER
              throw result.error
            }),
          ])
          if (winner.kind === 'answer') return winner.answer
          if (winner.answer === ABORTED) {
            // The turn was cancelled: settle the tool call as aborted rather than
            // resolve it with a fabricated answer.
            throw new Error('ask_user_question was aborted before the user answered')
          }
          debug('question-answered', { from: 'chat' })
          return winner.answer
        } finally {
          endPending(entry)
          void downstream.catch(() => undefined)
        }
      }))
    }

    if (config.notifyOnApproval) {
      disposers.push(ctx.on('approval/request', async (request, next) => {
        try {
          const agent = request.agent
          notify('需要授权', [
            `操作：${request.toolName ?? '未知工具'}`,
            request.reason ? `原因：${request.reason}` : '',
            '',
            '注意：授权只能在电脑端确认。',
          ].filter(Boolean).join('\n'), agent)
        } catch (error) {
          logger.warn(`approval notification failed: ${describeError(error)}`)
        }
        return next()
      }))
    }

    if (config.notifyOnTurnEnd) {
      disposers.push(ctx.on('agent/turn-stopping', ({ agent, turn }) => {
        notify('本轮结束', `第 ${turn} 轮已结束，等待下一步指令。`, agent)
      }))
    }

    return () => {
      for (const dispose of disposers) dispose()
    }
  })

  // --------------------------------------------------------- inbound control
  /**
   * The `#help` body.
   *
   * Tab-separated, three columns: `命令 ⇥ 短写 ⇥ 说明`. The card renderer draws a
   * run of such lines as one aligned table (monospace for the first two columns,
   * so `#status` and `#s` start at exactly the same x on every row) — and without
   * colour, because the columns *are* the layout. Arguments and options live in
   * the description so the first column stays a clean list of command names.
   */
  /**
   * Drop the help rows the active mode does not offer.
   *
   * A restricted mode exists so the phone can ask "what can I do here" and get a
   * short answer, so the table follows the mode: a row survives when at least one
   * command in its first column is allowed. Prose lines (section headers, the
   * closing hint) carry no tab and always stay.
   * @param lines - the assembled help lines.
   * @returns the visible subset.
   */
  function modeVisibleHelp(lines) {
    const mode = activeMode()
    if (!Array.isArray(mode.commands) || mode.commands.length === 0) return lines
    const p = config.commandPrefix
    return lines.filter((line) => {
      if (!line.includes('\t')) return true
      const words = line.split('\t')[0].split('/')
        .map((part) => compact(part.trim().split(/\s+/)[0] ?? '').replace(p, ''))
        .filter((word) => word !== '')
      if (words.length === 0) return true
      return words.some((word) => modeAllows(word))
    })
  }

  function helpText() {
    const p = config.commandPrefix
    const TAB = '\t'
    /** One table row: command, shorthand, description. */
    const row = (command, shorthand, description) =>
      `${command === '' ? '' : p + command}${TAB}${shorthand === '' ? '' : p + shorthand}${TAB}${description}`
    const mode = activeMode()
    const lines = [
      `【DSH 远程指令】${mode.name === DEFAULT_MODE.name
        ? ''
        : ` · 模式「${mode.label}」（${p}mode default 换回全部）`}`,
      '## 会话',
      row('status', 's', '会话名 / 工作区 / 状态'),
      row('sessions', 'ls', '列出活动会话（含已关闭的，按最近活动排序）'),
      row('tree', 'tr', '会话分叉树 + 工作区树（出图更好看）'),
      row('reply', 'rp', '回刚刚给我发消息的那个会话：<话>，不带话就切过去'),
      row('use', 'u', '切换目标会话：<n|name>'),
      row('new', 'n', '在选定工作区新建会话：[path]'),
      row('clear', 'cl', '取消锁定（跟随最近活跃会话）'),
      row('rename', 'rn', '重命名：[ws] <name>'),
      '## 工作区',
      row('ws', 'w', '列出工作区 / 选定：<n|name|path>'),
      row('ws new', '', '新建一个工作区并选定：<name|path>'),
      row('ws fix', '', '把「未分组」里目录已属于某工作区的会话挂回去'),
      '## 控制',
      row('stop', 'k', '停止当前会话正在跑的任务'),
      row(`on / ${p}off`, 'o / x', '总开关（关=不转发不汇报，但仍接指令）'),
      row('channels', 'c', '通道（微信/QQ）开关与就绪状态'),
      row('switch', '', '通道开关：qq|wechat on|off（关正在用的要加 force）'),
      row('img', 'i', '回复出图还是纯文字：on|off（默认出图）'),
      row('mode', 'm', '看/切换工作模式：<名字>（不同模式命令不同）'),
      row('deliver', '', '派活排队还是插入：queue|steer'),
      row('perm', 'p', '看/切换权限：r 只读 · w 标准 · f 完全（要密码）'),
      row('again', 're', '按当前形式重发上一条（漏看时用）'),
      '## 截图与附件',
      row('shot', 'sh', '截屏：默认主屏，可选 2|all|window'),
      row('shot screen', '', '看或改默认截哪块屏'),
      row('file start', 'f', '收附件（仅 QQ），下一条消息连附件一起发'),
      '## 分叉与授权',
      row('marks', 'mk', '列出可分叉的回合编号'),
      row('fork', 'fk', '从那一回合分叉并切过去：<n>'),
      row('auth', '', '看管理员密码与指令门状态'),
      row('lock', '', '锁回去（指令门开着时才有用）'),
      row('help', 'h', '本帮助'),
      '## 提问怎么答',
      `选 ${p}1 · 自定义 <text> · 切题 ${p}> ${p}< · 跳题 ${p}q2 · 交卷 ${p}submit`,
      '',
      '直接发一句话 → 作为用户消息进当前会话（无需前缀）',
      p.length > 0 ? `（不带 ${p} 的消息会被忽略）` : '（任意消息都会转发）',
    ]
    return modeVisibleHelp(lines).join('\n')
  }

  /**
   * The workspace list, as table rows: `序号 ⇥ 名字 ⇥ 状态`, then the path on a
   * continuation row. Same shape as the session list on purpose: two lists that
   * look alike are two lists you can read the same way.
   */
  /**
   * Sessions the sidebar shows under 未分组 but whose directory **is** a project.
   *
   * Membership is an explicit account (`sessionIds`), not a consequence of the
   * directory: a session created outside the Host's `workspaceId` path sits in
   * the right folder and still shows as ungrouped. That is a fixable state, so
   * the list reports it instead of leaving the operator to wonder.
   */
  async function ungroupedButKnown() {
    const registry = ctx.get('workspaceRegistry')
    const controller = sessionControllerService()
    if (registry === undefined || controller === undefined || typeof controller.list !== 'function') return []
    let projects = []
    let items = []
    try {
      projects = registry.list()
      const value = await controller.list({}, AbortSignal.timeout(8000))
      items = value?.items ?? []
    } catch {
      return []
    }
    const known = new Set()
    for (const project of projects) {
      const ids = project.sessionIds
      if (Array.isArray(ids)) for (const id of ids) known.add(id)
    }
    return items.filter((item) => typeof item?.sessionId === 'string'
      && !known.has(item.sessionId)
      && typeof item.cwd === 'string'
      && projects.some((project) => samePath(project.path, item.cwd)))
      .map((item) => ({ sessionId: item.sessionId, cwd: item.cwd }))
  }

  async function workspaceLines() {
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined) return ['工作区服务不可用。']
    let workspaces = []
    try {
      workspaces = registry.list()
    } catch (error) {
      return [`读取工作区失败：${describeError(error)}`]
    }
    if (workspaces.length === 0) return ['（还没有任何工作区）']
    const current = targetWorkspacePath()
    const lines = []
    workspaces.forEach((workspace, index) => {
      const marks = []
      if (samePath(workspace.path, current)) marks.push('← 当前会话所在')
      if (samePath(workspace.path, state.pinnedWorkspace)) marks.push('★已选定')
      const count = Array.isArray(workspace.sessionIds) ? ` (${workspace.sessionIds.length})` : ''
      lines.push(`${index + 1}\t${workspace.title}${count}\t${marks.join(' · ')}`)
      lines.push(`\t\t${workspace.path}`)
    })
    const homeless = await ungroupedButKnown()
    if (homeless.length > 0) {
      lines.push('', `有 ${homeless.length} 个会话目录属于上面的工作区，却还挂在「未分组」里。`)
      lines.push(`发 ${config.commandPrefix}ws fix 把它们挂回去。`)
    }
    if (state.pinnedWorkspace !== null) lines.push('', `#new 将使用：${state.pinnedWorkspace}`)
    return lines
  }

  /**
   * Live sessions merged with recently persisted ones.
   *
   * Live agents are listed first because they are what "派活" can act on
   * immediately; persisted-but-closed sessions follow so an older conversation
   * can still be re-attached by pinning it. Inside each group the *most recently
   * active* comes first, which is what makes the numbering match "which one was I
   * just talking to" — the question the list is really answering.
   */
  async function sessionEntries() {
    const entries = liveSessions().map((agent) => ({
      id: agent.id,
      cwd: agent.session?.header?.cwd ?? null,
      title: liveSessionTitle(agent),
      live: true,
      agent,
    }))
    const seen = new Set(entries.map((entry) => entry.id))
    const controller = sessionControllerService()
    if (controller !== undefined && typeof controller.list === 'function') {
      try {
        const value = await controller.list({}, AbortSignal.timeout(8000))
        const recent = (value?.items ?? [])
          // Guard the shape: an entry without a usable id would otherwise be
          // listed and then pinned as `undefined`.
          .filter((item) => typeof item?.sessionId === 'string' && item.sessionId !== '')
          .filter((item) => !seen.has(item.sessionId) && item.origin !== 'subagent')
          .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
          .slice(0, 12)
        for (const item of recent) {
          // The list carries cached projection values, so a closed session's
          // name is free here — no log replay needed.
          const projected = item.projections?.values?.title
          entries.push({
            id: item.sessionId,
            cwd: item.cwd ?? null,
            title: typeof projected === 'string' && projected.trim() !== '' ? projected.trim() : null,
            live: false,
            updatedAt: item.updatedAt,
          })
        }
      } catch (error) {
        logger.debug?.(`listing persisted sessions failed: ${describeError(error)}`)
      }
    }
    // Stable, so two sessions with the same activity time keep their group order.
    return entries
      .map((entry, index) => ({ entry, index, at: sessionActivityAt(entry) }))
      .sort((left, right) => {
        if (left.entry.live !== right.entry.live) return left.entry.live ? -1 : 1
        const delta = (right.at ?? 0) - (left.at ?? 0)
        return delta !== 0 ? delta : left.index - right.index
      })
      .map((wrapped) => ({ ...wrapped.entry, activityAt: wrapped.at }))
  }

  /**
   * The session list, as table rows: `序号 ⇥ 名字 ⇥ 状态 · 工作区`.
   *
   * One row per session (plus a continuation row for the directory, which has to
   * be there: two sessions in one workspace are indistinguishable by name) and
   * no raw ids — a phone reader needs "which one", not a uuid. The rows are
   * tab-separated because the card renderer draws a run of them as one aligned
   * table.
   */
  async function sessionLines({ compact = false } = {}) {
    const entries = await sessionEntries()
    if (entries.length === 0) return ['（没有可用会话）用 #new [path] 开一个。']
    const target = resolveTargetSession()
    const rows = []
    entries.forEach((entry, index) => {
      const marks = []
      if (entry.id === target) marks.push('← 当前目标')
      if (entry.id === state.pinnedSessionId && entry.id !== target) marks.push('★已锁定')
      if (entry.id === state.lastSpeakerId) marks.push('刚发过言')
      if (!entry.live) marks.push('已关闭')
      else if (entry.agent?.status === 'running') marks.push('运行中')
      const when = relativeTime(entry.activityAt)
      if (when !== '') marks.push(when)
      const name = entry.title ?? basename(entry.cwd) ?? '未命名会话'
      const workspace = basename(entry.cwd)
      const status = marks.join(' · ')
      const detail = workspace !== null && workspace !== name
        ? [status, workspace].filter(Boolean).join(' · ')
        : status
      rows.push(`${index + 1}\t${name}\t${detail}`)
      // The path row is what makes a flat list usable and a *tree* card twice as
      // long: inside the tree the workspace name is already in the status column.
      if (!compact && entry.cwd !== null) rows.push(`\t\t${entry.cwd}`)
    })
    return rows
  }

  /**
   * Every session as a node, keyed by id.
   *
   * Two sources, merged: live agents (which carry `parentSession` in memory and
   * must never be missing from the tree) and the durable list projection (which
   * knows the closed ones and their titles). Neither alone is enough — a closed
   * forked branch exists only in the projection, and a live subagent may not be
   * listed at all.
   * @returns a Map of id to node.
   */
  async function sessionNodes() {
    const nodes = new Map()
    const put = (id, patch) => {
      const previous = nodes.get(id) ?? { id }
      nodes.set(id, { ...previous, ...patch })
    }
    for (const agent of liveSessions()) {
      put(agent.id, {
        label: liveSessionTitle(agent),
        cwd: agent.session?.header?.cwd ?? null,
        parentId: agent.session?.header?.parentSession,
        live: true,
        status: agent.status ?? null,
        activityAt: sessionActivityAt({ agent }),
      })
    }
    const controller = sessionControllerService()
    if (controller !== undefined && typeof controller.list === 'function') {
      try {
        const value = await controller.list({}, AbortSignal.timeout(8000))
        for (const item of value?.items ?? []) {
          if (typeof item?.sessionId !== 'string' || item.sessionId === '') continue
          const previous = nodes.get(item.sessionId)
          const projected = item.projections?.values?.title
          put(item.sessionId, {
            label: previous?.label
              ?? (typeof projected === 'string' && projected.trim() !== '' ? projected.trim() : null),
            cwd: previous?.cwd ?? item.cwd ?? null,
            parentId: previous?.parentId ?? item.parentSessionId,
            origin: previous?.origin ?? item.origin,
            live: previous?.live ?? false,
            status: previous?.status ?? null,
            activityAt: previous?.activityAt
              ?? (typeof item.updatedAt === 'number' ? item.updatedAt : null),
          })
        }
      } catch (error) {
        debug('tree-list-failed', { message: describeError(error) })
      }
    }
    for (const node of nodes.values()) {
      if (typeof node.label !== 'string' || node.label.trim() === '') {
        node.label = basename(node.cwd) ?? node.id.replace(/^session-/, '').slice(0, 8)
      }
    }
    return nodes
  }

  /** `#3 · ● 运行中 · 2 分钟前 · 分叉 · ← 当前` for one tree row. */
  function treeMarks(node, indexOf) {
    const marks = []
    // The `#use` number comes first: the whole point of the tree on a phone is
    // "see it, then switch to it", and the eye scans the right column for that.
    const index = indexOf.get(node.id)
    if (index !== undefined) marks.push(`${config.commandPrefix}${index}`)
    // `× 已关闭` rather than `· 已关闭`: the separator is already a `·`, so a mark
    // that starts with one renders as a stray double dot.
    if (!node.live) marks.push('× 已关闭')
    else if (node.status === 'running') marks.push('● 运行中')
    else marks.push('○ 空闲')
    const when = relativeTime(node.activityAt)
    if (when !== '') marks.push(when)
    if (node.origin === 'subagent') marks.push('子代理')
    else if (node.parentId !== undefined) marks.push('分叉')
    if (node.id === resolveTargetSession()) marks.push('← 当前')
    else if (node.id === state.lastSpeakerId) marks.push('刚发过言')
    return marks.join(' · ')
  }

  /** Children first-by-recency, then by name, so a tree does not shuffle. */
  function treeOrder(list) {
    return [...list].sort((left, right) => {
      const delta = (right.activityAt ?? 0) - (left.activityAt ?? 0)
      return delta !== 0 ? delta : String(left.label).localeCompare(String(right.label))
    })
  }

  /**
   * The lineage tree: `├─`/`└─` nesting under whoever the session came from.
   *
   * `parentSession` is set by `#fork` *and* by the subagent runner, so one walk
   * answers "who came from whom" — the question a flat list of names cannot.
   * @param nodes - the `sessionNodes` map.
   * @param indexOf - session id to its `#use` number.
   * @returns tab-separated rows.
   */
  function lineageTreeLines(nodes, indexOf) {
    const children = new Map()
    const roots = []
    for (const node of nodes.values()) {
      if (node.parentId !== undefined && nodes.has(node.parentId)) {
        const list = children.get(node.parentId) ?? []
        list.push(node)
        children.set(node.parentId, list)
      } else {
        roots.push(node)
      }
    }
    const lines = []
    let drawn = 0
    let skipped = 0
    const walk = (node, prefix, isLast, depth) => {
      if (drawn >= TREE_NODE_LIMIT) {
        skipped += 1
        return
      }
      drawn += 1
      const branch = depth === 0 ? '' : (isLast ? '└─ ' : '├─ ')
      lines.push(`${prefix}${branch}${clamp(node.label, 22)}\t${treeMarks(node, indexOf)}`)
      const kids = treeOrder(children.get(node.id) ?? [])
      kids.forEach((kid, index) => {
        walk(kid, depth === 0 ? '' : `${prefix}${isLast ? '   ' : '│  '}`, index === kids.length - 1, depth + 1)
      })
    }
    treeOrder(roots).forEach((root, index) => {
      const all = treeOrder(roots)
      walk(root, '', index === all.length - 1, 0)
    })
    if (skipped > 0) lines.push(`\t（还有 ${skipped} 个没画，发 ${config.commandPrefix}sessions 看列表）`)
    return lines.length === 0 ? ['（还没有会话）'] : lines
  }

  /**
   * The workspace tree: which sessions live where.
   *
   * Grouping, not lineage: the same sessions, but answered from the workspace's
   * point of view. A session the registry does not know about is listed under
   * 「未分组」 rather than dropped, because that is exactly the case the operator
   * needs to see (and `#ws fix` repairs).
   * @param nodes - the `sessionNodes` map.
   * @param indexOf - session id to its `#use` number.
   * @returns tab-separated rows.
   */
  async function workspaceTreeLines(nodes, indexOf) {
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined || typeof registry.list !== 'function') return ['（工作区服务不可用）']
    let workspaces = []
    try {
      workspaces = await registry.list()
    } catch (error) {
      debug('tree-workspaces-failed', { message: describeError(error) })
      return ['（工作区列表读取失败）']
    }
    const lines = []
    const claimed = new Set()
    const rowOf = (node, prefix, isLast) =>
      `${prefix}${isLast ? '└─ ' : '├─ '}${clamp(node.label, 22)}\t${treeMarks(node, indexOf)}`
    for (const workspace of workspaces) {
      const ids = (Array.isArray(workspace.sessionIds) ? workspace.sessionIds : [])
        .filter((id) => nodes.has(id))
      if (ids.length === 0) continue
      const label = typeof workspace.title === 'string' && workspace.title.trim() !== ''
        ? workspace.title.trim()
        : (basename(workspace.path) ?? '工作区')
      lines.push(`${label}/`)
      const members = ids.map((id) => nodes.get(id)).filter((node) => node !== undefined)
      // Nest a member's own children under it, one level: a fork or a subagent
      // belongs to the same workspace, and showing it flat would read as a
      // sibling.
      const memberIds = new Set(members.map((node) => node.id))
      const top = treeOrder(members.filter((node) => node.parentId === undefined || !memberIds.has(node.parentId)))
      top.forEach((node, index) => {
        claimed.add(node.id)
        const last = index === top.length - 1
        lines.push(rowOf(node, '', last))
        const kids = treeOrder([...nodes.values()].filter((kid) => kid.parentId === node.id))
        kids.forEach((kid, kidIndex) => {
          claimed.add(kid.id)
          lines.push(rowOf(kid, last ? '   ' : '│  ', kidIndex === kids.length - 1))
        })
      })
    }
    const stray = treeOrder([...nodes.values()].filter((node) => !claimed.has(node.id) && node.parentId === undefined))
    if (stray.length > 0) {
      lines.push('未分组/')
      stray.forEach((node, index) => lines.push(rowOf(node, '', index === stray.length - 1)))
    }
    return lines.length === 0 ? ['（还没有会话）'] : lines
  }

  /**
   * The picker: the numbered sessions, most recently active first.
   *
   * Same numbering as `#sessions`, because the numbers *are* the interface — the
   * trees below reuse them, so `#use 3` means the same session in every view.
   */
  async function recencyLines(entries, nodes) {
    if (entries.length === 0) return ['（没有可用会话）']
    const target = resolveTargetSession()
    const rows = []
    entries.forEach((entry, index) => {
      const marks = []
      if (entry.id === target) marks.push('← 当前')
      if (entry.id === state.lastSpeakerId) marks.push('刚发过言')
      if (!entry.live) marks.push('已关闭')
      else if (entry.agent?.status === 'running') marks.push('运行中')
      const when = relativeTime(entry.activityAt)
      if (when !== '') marks.push(when)
      const node = nodes.get(entry.id)
      const name = entry.title ?? node?.label ?? basename(entry.cwd) ?? '未命名会话'
      const workspace = basename(entry.cwd)
      const detail = workspace !== null && workspace !== name
        ? [...marks, workspace].join(' · ')
        : marks.join(' · ')
      rows.push(`${index + 1}\t${name}\t${detail}`)
    })
    return rows
  }

  /** Both trees plus the picker, as one card body. */
  async function treeText(entries) {
    const nodes = await sessionNodes()
    const indexOf = new Map(entries.map((entry, index) => [entry.id, index + 1]))
    const prefix = config.commandPrefix
    return [
      '【DSH 会话树】',
      '',
      `## 最近活跃（发 ${prefix}use <编号> 切过去）`,
      ...(await recencyLines(entries, nodes)),
      '',
      '## 会话分叉（谁从哪来）',
      ...lineageTreeLines(nodes, indexOf),
      '',
      '## 工作区 → 会话',
      ...(await workspaceTreeLines(nodes, indexOf)),
      '',
      `${prefix}use <编号> 切目标 · ${prefix}reply <话> 回刚发言的 · ${prefix}marks 看回合`,
    ].join('\n')
  }

  /**
   * Screen selector for `#shot`.
   *
   * `null` means "not a screen selector" (i.e. the argument is a window title),
   * which is what keeps `#shot 记事本` working while `#shot 2` means display 2.
   * @param token - compacted argument.
   * @param words - alias table for the spelled-out selectors.
   * @returns `'primary' | 'all' | '<n>' | null`.
   */
  function resolveShotTarget(token, words) {
    const value = String(token ?? '').trim().toLowerCase()
    if (value === '') return null
    if (words[value] !== undefined) return words[value]
    // Display numbers start at 1; `0` is not a display, so it stays a title.
    if (/^[1-9]\d?$/.test(value)) return value
    return null
  }

  /** How a screen selector reads to a human. */
  function describeShotTarget(target) {
    const value = String(target ?? '').trim()
    if (value === 'all') return '全部屏幕'
    if (/^[1-9]\d?$/.test(value)) return `第 ${value} 个显示器`
    return '主屏'
  }

  /**
   * The displays this machine currently has, cached briefly.
   *
   * Enumerating spawns the Python helper, so it is worth a short TTL: a monitor
   * number is validated against this list, which is what turns "没有第 9 个显示器"
   * into a sentence instead of a failed capture.
   */
  let monitorCache = { at: 0, value: [] }
  async function availableMonitors() {
    const now = Date.now()
    if (now - monitorCache.at < 30000 && monitorCache.value.length > 0) return monitorCache.value
    const monitors = await listMonitors({ pythonPath: config.pythonPath })
    // Only cache a real answer: a failed probe must be retried, not remembered.
    if (monitors.length > 0) monitorCache = { at: now, value: monitors }
    return monitors
  }

  /** `1=1920x1080, 2=2560x1440`, for a reply that has to list the options. */
  function monitorSummary(monitors) {
    return monitors.map((m) => `${m.index}=${m.width}×${m.height}${m.primary ? '(主屏)' : ''}`).join('，')
  }

  /** Resolve `#use` / `#ws` integer arguments against a list. */
  /**
   * Resolve `#use` / `#ws` arguments: an index, an id/path prefix, or a name.
   *
   * The name form is what a phone actually has: nobody types
   * `D:\work\projects\orders` while standing in a queue, but `#ws orders` is
   * natural. Matching is exact-first, then substring, and a substring that hits
   * several entries resolves to nothing so the caller can list the candidates
   * instead of silently picking one.
   * @param list - candidates.
   * @param argument - the raw argument.
   * @param keyOf - the id/path of an entry.
   * @param nameOf - optional human name of an entry.
   * @returns the chosen entry, or undefined.
   */
  function pickByIndexOrPrefix(list, argument, keyOf, nameOf = null) {
    const token = String(argument ?? '').trim()
    if (token === '') return undefined
    const asIndex = Number(token)
    if (Number.isSafeInteger(asIndex) && asIndex >= 1 && asIndex <= list.length) return list[asIndex - 1]
    const lowered = token.toLowerCase()
    const matches = list.filter((item) => String(keyOf(item)).toLowerCase().startsWith(lowered))
    if (matches.length === 1) return matches[0]
    if (nameOf === null) return undefined
    const names = list.map((item) => String(nameOf(item) ?? ''))
    const exact = list.filter((item, index) => names[index].toLowerCase() === lowered)
    if (exact.length === 1) return exact[0]
    const contains = list.filter((item, index) => names[index].toLowerCase().includes(lowered))
    return contains.length === 1 ? contains[0] : undefined
  }

  /** Candidates that a name lookup could not disambiguate, for the reply. */
  function ambiguousNames(list, argument, nameOf) {
    const lowered = String(argument ?? '').trim().toLowerCase()
    if (lowered === '') return []
    return list
      .filter((item) => String(nameOf(item) ?? '').toLowerCase().includes(lowered))
      .map((item) => String(nameOf(item) ?? ''))
  }

  /** `名字（工作区）`, for any reply that has to name a session. */
  function sessionNameOf(agent) {
    return liveSessionTitle(agent)
      ?? basename(agent?.session?.header?.cwd)
      ?? '未命名会话'
  }

  /**
   * `工作区 - 会话名`, the one line every pushed message starts with.
   *
   * With several workspaces open, "which one is talking" is the first thing the
   * operator needs and the last thing they can infer — so a report or a
   * notification carries it above the body rather than making them ask.
   * @param agent - the agent the message came from.
   * @returns the label, or null when the agent is unknown.
   */
  function sourceLabelFor(agent) {
    if (agent === undefined || agent === null) return null
    const workspace = basename(agent.session?.header?.cwd)
    const session = liveSessionTitle(agent)
    if (workspace !== null && session !== null && workspace !== session) return `${workspace} - ${session}`
    return workspace ?? session ?? null
  }

  /** The same label for a session id that has no live agent (a closed session). */
  function sourceLabelForSession(sessionId) {
    if (sessionId === undefined || sessionId === null) return null
    const agent = agentsService()?.get(sessionId)
    if (agent !== undefined) return sourceLabelFor(agent)
    return state.pinnedWorkspace === null ? null : basename(state.pinnedWorkspace)
  }

  /**
   * `刚刚 / 12 分钟前 / 3 小时前 / 2 天前`.
   *
   * The session list is about *recency* — "which one was I just talking to" is
   * the question a phone asks — and an absolute timestamp makes the reader do the
   * subtraction. Empty when there is nothing trustworthy to print.
   * @param ms - epoch milliseconds, or null.
   * @returns the phrase, or an empty string.
   */
  function relativeTime(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return ''
    const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000))
    if (seconds < 60) return '刚刚'
    const minutes = Math.round(seconds / 60)
    if (minutes < 60) return `${minutes} 分钟前`
    const hours = Math.round(minutes / 60)
    if (hours < 24) return `${hours} 小时前`
    return `${Math.round(hours / 24)} 天前`
  }

  /**
   * When a session was last active, in epoch milliseconds.
   *
   * `updatedAt` is a *list projection* field, so a live agent does not have one —
   * and the live agent is exactly the session whose recency matters. The newest
   * event in its in-memory log is the honest answer.
   * @param entry - one `sessionEntries` row.
   * @returns epoch milliseconds, or null.
   */
  function sessionActivityAt(entry) {
    if (typeof entry?.updatedAt === 'number' && entry.updatedAt > 0) return entry.updatedAt
    if (entry?.agent === undefined) return null
    let events
    try {
      events = entry.agent.session?.snapshotEvents?.()
    } catch {
      return null
    }
    if (!Array.isArray(events) || events.length === 0) return null
    const last = events[events.length - 1]
    if (typeof last?.time === 'number') return last.time
    const parsed = Date.parse(String(last?.time ?? ''))
    return Number.isFinite(parsed) ? parsed : null
  }

  /** `AgentStatus` is `'idle' | 'running'`; show it in the operator's language. */
  const STATUS_LABELS = { idle: '空闲', running: '运行中' }

  async function statusText() {
    const target = resolveTargetSession()
    const agents = agentsService()
    const described = await describeSession(target)
    const lines = [
      '【DSH 状态】',
      state.enabled ? '' : '⚠ 插件当前是关闭状态（只接控制指令，不转发/不汇报）——发 #on 打开',
      '',
      `会话名：${sessionLabel(described)}${state.pinnedSessionId !== undefined ? ' ★已锁定' : ''}`,
      `工作区：${described?.cwd ?? '（未知）'}`,
      `状态：${described === null
        ? '（无目标会话）'
        : (described.live
            ? (STATUS_LABELS[described.status] ?? described.status ?? '在线')
            : '未运行（下次派活会自动恢复）')}`,
      `投递方式：${deliveryMode() === 'steer' ? '插入（steer）' : '排队（queue）'} · 回复形式：${imageRepliesOn() ? '图片卡片' : '纯文字'}`,
      `模式：${activeMode().label}（${activeMode().name}）${activeMode().commands.length === 0 ? ' · 全部命令' : ` · ${activeMode().commands.length} 条命令`}`,
      `汇报：${config.reportOnTurnEnd
        ? (config.reportOnlyRemoteTurns ? '只汇报「从聊天派活」的轮次' : '目标会话的每一轮都汇报')
        : '已关闭'}`,
      `累计：发出 ${state.sentCount} · 收到 ${state.receivedCount} · 转发 ${state.forwardedCount} · 汇报 ${state.reportedCount}`,
      '',
    ]
    // More than one open session is exactly when a remote command can land
    // somewhere the operator did not mean, so say so instead of letting the
    // reply look like it went to "the" session.
    const live = liveSessions()
    if (live.length > 1) {
      lines.push(`注意：现在有 ${live.length} 个会话开着，指令只会进上面这一个。`, '其它：')
      for (const other of live) {
        if (other.id === target) continue
        const name = liveSessionTitle(other) ?? basename(other.session?.header?.cwd) ?? '未命名会话'
        const workspace = basename(other.session?.header?.cwd)
        // Same table shape as `#sessions`: the name, then where it lives.
        lines.push(workspace !== null && workspace !== name ? `${name}\t${workspace}` : `${name}\t`)
      }
      lines.push('发 #sessions 看全部，发 #use <序号> 换目标（会锁定），#clear 解除锁定。', '')
    }
    if (described?.live === true) {
      const agent = agents?.get(described.id)
      const last = agent === undefined ? null : lastAssistantText(agent.session)
      if (last !== null) lines.push('最近一条回答：', clamp(last, 300), '')
    }
    for (const channel of channels) {
      const snapshot = channel.statusSync()
      const on = channelOn(channel)
      lines.push(`· ${snapshot.label} [${snapshot.id}]：${on ? describeReadiness(snapshot) : '已停用'}${on ? skipNote(snapshot) : ''}`)
      const allow = snapshot.detail?.privateAllowlist
      if (allow !== undefined) {
        lines.push(`    可发指令者：${allow.list.length > 0 ? `${allow.list.join(', ')}（来自 ${allow.source}）` : '⚠ 未限制，任何能给该账号发消息的人都能操控'}`)
      }
      const notes = snapshot.detail?.notes
      if (Array.isArray(notes)) for (const note of notes) lines.push(`    ${note}`)
      if (snapshot.id === 'wechat-local' && snapshot.detail?.wechatRunning === false) {
        lines.push('    → 需要你自己打开微信并登录（插件不会替你启动它）')
      }
      if (snapshot.detail?.lastError) lines.push(`    错误：${snapshot.detail.lastError}`)
    }
    lines.push(accessGateIsOpen()
      ? `授权：已开启（所有指令要密码）· 已授权 ${state.authorized.size} 个对话（发 ${config.commandPrefix}lock 锁回去）`
      : (accessPasswordIsSet()
        ? `授权：只有完全权限要密码（${config.commandPrefix}perm f），普通指令不校验`
        : `授权：没设管理员密码 —— 完全权限在远程打不开（${config.commandPrefix}auth 看详情）`))
    return lines.join('\n')
  }

  async function handleCommand(message, channel) {
    const text = String(message.text ?? '').trim()
    const incoming = Array.isArray(message.attachments) ? message.attachments : []
    const prefix = config.commandPrefix
    const prefixed = prefix.length === 0 || text.startsWith(prefix)
    // Authorization comes before *everything*, including attachments: a
    // conversation that has not presented the password must not be able to
    // write a file into the downloads directory, and must not be able to make
    // the plugin reveal its own state. The offered password is compared here,
    // before the tracing below, so it never reaches the debug log.
    if (await gateAccess(channel, message, {
      body: prefixed && prefix.length > 0 ? text.slice(prefix.length).trim() : text,
      prefixed,
    })) return
    // A restricted working mode narrows the command surface, but must never
    // swallow prose: only words this plugin actually knows are refused, and
    // anything else still reaches the session as a prompt.
    if (prefixed && text !== '') {
      const body = prefix.length === 0 ? text : text.slice(prefix.length).trim()
      const headWord = compact(body.split(/\s+/)[0] ?? '')
      if (COMMAND_WORDS.has(headWord) && !modeAllows(headWord)) {
        const mode = activeMode()
        const allowed = mode.commands.filter((word) => COMMAND_WORDS.has(word))
        await replyTo(channel, [
          `【DSH】当前模式「${mode.label}」没有这条命令。`,
          allowed.length > 0 ? `可用：${allowed.map((word) => `${prefix}${word}`).join(' ')}` : '',
          '',
          `换回全功能：${prefix}mode default（或 ${prefix}mode 看全部模式）`,
        ].filter(Boolean).join('\n'))
        return
      }
    }
    // Attachments are handled before anything else: a file arrives with no text
    // (so the prefix gate would drop it) and it is never a command.
    if (incoming.length > 0) {
      if (!state.enabled) {
        await replyTo(channel, '【DSH】插件当前是关闭状态，先把附件放一边了 —— 发 #on 打开再重发。')
        return
      }
      if (capture === null) {
        await replyTo(channel, [
          `【DSH】收到 ${incoming.length} 个文件，但现在没在收集。`,
          `先发 ${config.commandPrefix}file start，然后发文件；下一条消息会连附件一起发过去。`,
        ].join('\n'))
        return
      }
      try {
        const saved = await collectAttachments(message, channel)
        capture.files.push(...saved)
        await replyTo(channel, [
          `【DSH】已收下 ${saved.length} 个文件（本次共 ${capture.files.length} 个）：`,
          ...saved.map((file) => `· ${file.name}${file.size ? `（${humanSize(file.size)}）` : ''}`),
          '',
          '收完后直接发送任务，附件会跟着一起进会话。',
        ].join('\n'))
      } catch (error) {
        debug('attachment-failed', { message: describeError(error) })
        await replyTo(channel, `【DSH】保存附件失败：${describeError(error)}`)
      }
      return
    }
    if (!text) return
    // A pending `ask_user_question` owns the conversation: while the turn is
    // blocked on it, the message is an answer (or a pager move), never a new
    // prompt — forwarding one would only queue behind the blocked turn forever.
    //
    // This sits *before* the prefix gate on purpose. The hint the phone shows is
    // `选 1 · 自定义 <text>`, i.e. "just type it", and a phone keyboard produces
    // exactly that: no `#`. The prefix stays optional here, and a bare `2` still
    // picks option 2 rather than answering the literal string "2".
    const pendingQuestion = currentPending()
    if (pendingQuestion !== undefined) {
      const stripped = prefixed ? text.slice(prefix.length).trim() : text
      const headWord = compact(stripped.split(/\s+/)[0] ?? '')
      // A *prefixed, known* command is not an answer: `#stop` stops the run, and
      // `#status` / `#use` / `#reply` / `#help` keep working while the turn is
      // blocked — being unable to switch sessions because a question is pending
      // is exactly the friction this plugin exists to remove. Bare text (and the
      // numbered/pager/submit words) still goes to the answer protocol.
      const isCommand = prefixed && COMMAND_WORDS.has(headWord) && !ANSWER_PROTOCOL_WORDS.has(headWord)
      if (!isCommand && await handlePendingAnswer(pendingQuestion, stripped, channel)) return
      if (isCommand) debug('question-command-escape', { head: redactSecrets(headWord) })
    }
    // Cheap flood guard: a runaway sender must not queue unbounded work.
    if (config.maxCommandsPerMinute > 0) {
      const now = Date.now()
      commandTimes.push(now)
      while (commandTimes.length > 0 && now - commandTimes[0] > 60000) commandTimes.shift()
      if (commandTimes.length > config.maxCommandsPerMinute) {
        logger.warn(`rate limit hit (${commandTimes.length}/min); dropping ${JSON.stringify(redactSecrets(text).slice(0, 40))}`)
        if (commandTimes.length === config.maxCommandsPerMinute + 1) {
          await replyTo(channel, `【DSH】消息过于频繁（每分钟上限 ${config.maxCommandsPerMinute} 条），已限流。`)
        }
        return
      }
    }
    const body = prefixed && prefix.length > 0 ? text.slice(prefix.length).trim() : text
    // The prefix belongs to built-in controls, not to conversation. Ordinary
    // text goes straight to the selected session and can never accidentally
    // become a command just because it says "status", "stop", etc.
    if (!prefixed) {
      debug('prompt', {
        transport: channel.id,
        body: redactSecrets(body).slice(0, 120),
      })
      if (!state.enabled) {
        await replyTo(channel, `【DSH】插件已关闭，发 ${prefix}on 打开。`)
        return
      }
      if (config.remoteControl !== true) return
      const sessionController = ctx.get('sessionController')
      if (sessionController === undefined) {
        await replyTo(channel, '【DSH】远程控制不可用：sessionController 服务未挂载。')
        return
      }
      const sessionId = resolveTargetSession()
      if (sessionId === undefined) {
        await replyTo(channel, '【DSH】没有可用的活动会话，请先在网页端打开一个会话。')
        return
      }
      await deliverToSession(sessionId, body, channel, { asTarget: true })
      return
    }
    const token = compact(body)
    const [head, ...rest] = body.split(/\s+/)
    const argument = rest.join(' ').trim()
    // `#授权 <password>` carries the secret in the argument, so redact both halves.
    debug('command', {
      transport: channel.id,
      head: redactSecrets(head),
      argument: redactSecrets(argument),
      body: redactSecrets(body).slice(0, 120),
    })

    if (matchesCommand(token, ['help', 'h', '帮助', '?', '？'])) {
      await replyRich(channel, helpText())
      return
    }
    if (matchesCommand(token, ['status', 's', 'st', '状态'])) {
      for (const other of channels) await other.refreshStatus?.()
      await replyRich(channel, await statusText())
      return
    }
    // `#auth` / `#lock`: the chat-side half of the authorization gate. A bare
    // `#auth` is a status question; `#lock` drops this conversation's grant.
    if (matchesCommand(token, ['auth', 'login', 'pass', 'password', '授权', '密码'])) {
      const lines = ['【DSH 授权】']
      if (!accessPasswordIsSet()) {
        lines.push('管理员密码：没设')
        lines.push('', '没密码时完全权限在远程打不开（安全默认）。')
        lines.push('去 设置 →「插件」→「远程通道」→ 管理员密码 设一个。')
        lines.push('设好之后：普通指令照旧不用密码，#perm f 才要。')
        await replyRich(channel, lines.join('\n'))
        return
      }
      lines.push('管理员密码：已设')
      lines.push(`指令门：${accessGateIsOpen() ? '开（所有指令都要先授权）' : '关（只有 #perm f 要密码）'}`)
      if (accessGateIsOpen()) {
        lines.push(`本对话：${isAuthorized(channel, message) ? '已授权' : '未授权'}`)
        lines.push(`有效期：${accessTtlMs() === 0 ? '本次运行内' : `${Math.round(accessTtlMs() / 60000)} 分钟`}`)
        lines.push('', `首次授权：把密码连在 # 后面发一次（例如 ${prefix}<password>）。`)
        lines.push(`锁回去：${prefix}lock`)
      } else {
        lines.push('', `完全权限：${prefix}perm f ${prefix}<password>`)
        lines.push('要连普通指令也校验，把配置项 accessGate 设成 all。')
      }
      await replyRich(channel, lines.join('\n'))
      return
    }
    if (matchesCommand(token, ['lock', '上锁', '锁定'])) {
      if (!accessGateIsOpen()) {
        await replyTo(channel, [
          accessPasswordIsSet()
            ? '【DSH】指令门是关的，普通指令本来就不用密码。'
            : '【DSH】还没设管理员密码，没什么可锁的。',
          `完全权限（${prefix}perm f）始终要管理员密码。`,
        ].join('\n'))
        return
      }
      state.authorized.delete(senderKeyOf(channel, message))
      debug('access-locked', { key: senderKeyOf(channel, message) })
      await replyTo(channel, `【DSH】已锁回 🔒 下一条指令要先发一次密码（${prefix}<password>）。`)
      return
    }
    // Numbered turn boundaries and forking: the phone-side answer to "fork from
    // *here*" without scrolling a transcript.
    if (matchesCommand(compact(head), ['marks', 'mk', '回合'])) {
      const target = resolveTargetSession()
      const marks = state.turnMarks.filter((mark) => mark.sessionId === target)
      if (marks.length === 0) {
        await replyTo(channel, `【DSH】还没有记录到回合。等这个会话跑完一轮（或发 ${prefix}status 看看目标是谁）。`)
        return
      }
      const lines = ['【DSH 回合】', `当前会话：${sessionLabel(await describeSession(target))}`, '']
      for (const mark of marks.slice(-10).reverse()) {
        const when = new Date(mark.at).toLocaleString('zh-CN', { hour12: false })
        lines.push(`#${mark.n} · ${when}`)
        if (mark.label !== '') lines.push(`    ${mark.label}`)
      }
      lines.push('', `分叉：${prefix}fork <编号>`)
      await replyRich(channel, lines.join('\n'))
      return
    }
    if (matchesCommand(compact(head), ['fork', 'fk', '分叉'])) {
      const controller = sessionControllerService()
      if (controller === undefined || typeof controller.fork !== 'function') {
        await replyTo(channel, '【DSH】会话服务不支持分叉。')
        return
      }
      const target = resolveTargetSession()
      if (target === undefined) {
        await replyTo(channel, '【DSH】没有目标会话。')
        return
      }
      const requested = compact(argument).replace(/^#/, '')
      let mark
      if (requested === '') {
        mark = [...state.turnMarks].reverse().find((entry) => entry.sessionId === target)
      } else {
        const wanted = Number(requested)
        mark = state.turnMarks.find((entry) => entry.n === wanted)
        if (mark !== undefined && mark.sessionId !== target) {
          await replyTo(channel, `【DSH】回合 #${wanted} 属于别的会话，先 ${prefix}use 切过去再分叉。`)
          return
        }
      }
      if (mark === undefined) {
        await replyTo(channel, `【DSH】找不到这个回合。先发 ${prefix}marks 看有哪些。`)
        return
      }
      try {
        const created = await controller.fork({ sessionId: mark.sessionId, atSeq: mark.atSeq })
        const forked = created?.sessionId
        if (typeof forked !== 'string' || forked === '') throw new Error('会话服务没有返回 sessionId')
        const described = await describeSession(forked)
        await setPinnedTarget(forked, described === null ? null : sessionLabel(described))
        debug('forked', { from: mark.sessionId, atSeq: mark.atSeq, n: mark.n, to: forked })
        await replyTo(channel, [
          `【DSH】已从回合 #${mark.n} 分叉，并切到新会话：`,
          `《${sessionLabel(described)}》`,
          `工作区：${described?.cwd ?? '（未知）'}`,
          '',
          '新会话带着那一刻的上下文，之后的指令都会进它。',
        ].join('\n'))
      } catch (error) {
        await replyTo(channel, `【DSH】分叉失败：${describeError(error)}`)
      }
      return
    }
    if (matchesCommand(compact(head), ['channels', 'c', '通道'])) {
      for (const other of channels) await other.refreshStatus?.()
      await replyRich(channel, channelLines())
      return
    }
    // Reply format: a rendered card (default) or plain text.
    if (matchesCommand(compact(head), ['img', 'i', 'image', '出图', '图片'])) {
      const wanted = compact(argument)
      const on = ['on', '开', '开启', '1', '图片', 'card'].includes(wanted)
      const off = ['off', '关', '关闭', '0', '文字', 'text'].includes(wanted)
      if (!on && !off) {
        const pinned = activeMode().imageReplies
        await replyTo(channel, [
          `【DSH】当前回复形式：${imageRepliesOn() ? '图片卡片' : '纯文字'}`,
          typeof pinned === 'boolean' ? `（当前模式「${activeMode().label}」固定了回复形式，这个开关要换了模式才生效。）` : '',
          `用法：${prefix}img on（出图） / ${prefix}img off（纯文字）`,
        ].filter(Boolean).join('\n'))
        return
      }
      state.imageReplies = on
      rememberTarget()
      mirrorFieldToSettings('imageReplies', on)
      debug('image-replies', { on })
      await replyTo(channel, [
        `【DSH】回复形式已切换为：${on ? '图片卡片' : '纯文字'}。`,
        typeof activeMode().imageReplies === 'boolean'
          ? `（当前模式「${activeMode().label}」固定了回复形式，实际仍按模式走。）`
          : '',
      ].filter(Boolean).join('\n'))
      return
    }
    // Re-send the last answer, rendered per the *current* `#img` setting. This is
    // the recovery path for a card that arrived while the phone was locked, or
    // that was sent before the operator switched between card and plain text.
    if (matchesCommand(compact(head), ['again', 're', 'resend', '重发', '再来一次'])) {
      if (state.lastAnswer === null) {
        await replyTo(channel, `【DSH】还没有可重发的内容。`)
        return
      }
      const when = new Date(state.lastAnswer.at).toLocaleString('zh-CN', { hour12: false })
      const original = state.lastAnswer.text
      // In card mode the render already marks it; in text mode a one-line tag is
      // what keeps an identical message from looking like a duplicate bug.
      const stamped = imageRepliesOn() ? original : `${original}\n\n（重发 · ${when}）`
      debug('resend', { chars: original.length, asImage: imageRepliesOn() })
      const ok = await replyRich(channel, stamped)
      // Resending must not change what the *next* resend says.
      state.lastAnswer = { text: original, at: state.lastAnswer.at }
      if (!ok) await replyTo(channel, `【DSH】重发失败，稍后再试。`)
      return
    }
    // Working modes: a named bundle of behaviour + the commands that exist in it.
    if (matchesCommand(compact(head), ['mode', 'modes', 'm', '模式'])) {
      const modes = modeList()
      const current = activeMode()
      const wanted = compact(argument)
      if (wanted === '' || matchesCommand(wanted, ['list', 'ls', '列表'])) {
        await replyRich(channel, [
          '【DSH 工作模式】',
          ...modes.map((mode) => {
            const mark = mode.name === current.name ? '← 当前' : ''
            const count = mode.commands.length === 0 ? '全部命令' : `${mode.commands.length} 条命令`
            return `${mode.name}\t${mode.label} · ${count}\t${mark}`
          }),
          '',
          current.description === '' ? '' : current.description,
          `切换：${prefix}mode <名字>`,
          '自定义模式写在 profile 补丁的 modes 里（见 README）。',
        ].filter((line) => line !== '').join('\n'))
        return
      }
      const found = modes.find((mode) => compact(mode.name) === wanted || compact(mode.label) === wanted)
      if (found === undefined) {
        await replyTo(channel, [
          `【DSH】没有这个模式：${argument}`,
          `现有：${modes.map((mode) => mode.name).join(' / ')}`,
        ].join('\n'))
        return
      }
      applyMode(found)
      debug('working-mode', { mode: found.name, commands: found.commands.length })
      await replyTo(channel, [
        `【DSH】已切到模式「${found.label}」`,
        found.description === '' ? '' : found.description,
        found.commands.length === 0
          ? '命令：全部'
          : `命令：${found.commands.map((word) => `${prefix}${word}`).join(' ')}`,
        found.commands.length === 0 || found.commands.includes('mode') ? '' : `换回来：${prefix}mode default`,
      ].filter(Boolean).join('\n'))
      return
    }
    // Delivery mode: wait for the running turn, or inject into it. (`#mode` used
    // to mean this; it means "working mode" now, so it lives under `#deliver`.)
    if (matchesCommand(compact(head), ['deliver', 'delivery', '投递', '投递方式', '发送方式',
      'queue', 'steer'])) {
      const wanted = compact(argument) === '' ? compact(head) : compact(argument)
      const queue = ['queue', '排队', '等待', 'q', 'deliver'].includes(wanted)
      const steer = ['steer', '插入', '打断', 's'].includes(wanted)
      if (!queue && !steer) {
        await replyTo(channel, [
          `【DSH】当前投递方式：${deliveryMode() === 'steer' ? '插入（steer）' : '排队（queue）'}`,
          `用法：${prefix}deliver queue（排队） / ${prefix}deliver steer（插入）`,
          `也可以直接发 ${prefix}queue / ${prefix}steer。`,
          '',
          '排队：等这一轮跑完再处理，回答会晚但不会打断。',
          '插入：立刻塞进正在跑的那一轮；目标会话没在跑时会自动退回排队。',
        ].join('\n'))
        return
      }
      state.messageMode = steer ? 'steer' : 'queue'
      rememberTarget()
      mirrorFieldToSettings('deliverMode', state.messageMode)
      debug('message-mode', { mode: state.messageMode })
      await replyTo(channel, `【DSH】投递方式已切换为：${steer ? '插入（steer）' : '排队（queue）'}。`)
      return
    }
    // Permission presets. The danger preset asks for a password *here* rather
    // than an approval at the machine: the operator's command plus the password
    // IS the confirmation, so nothing has to be clicked on the desktop.
    if (matchesCommand(compact(head), ['perm', 'p', 'permission', 'permissions', '权限'])) {
      const service = permissionService()
      if (service === undefined) {
        await replyTo(channel, '【DSH】权限服务不可用（这个部署没挂 permissionPresets）。')
        return
      }
      const agent = agentsService()?.get(resolveTargetSession())
      const session = agent?.session
      if (session === undefined) {
        await replyTo(channel, `【DSH】目标会话没有在运行，改不了权限。先派个活或 ${prefix}new 开一个。`)
        return
      }
      const parts = argument.split(/\s+/).filter((piece) => piece !== '')
      const requested = parts.length === 0 ? '' : compact(parts[0])
      if (requested === '') {
        const dangerous = service.names.filter((name) => presetIsDangerous(service, name))
        const lines = [
          '【DSH 权限】',
          `当前：${presetLabel(service, service.current(session))}`,
          '',
          ...service.names.map((name) => `· ${presetLabel(service, name)}`),
          '',
          '简写：r 只读 · w 可写 · f 完全权限（例：perm f <password>）',
        ]
        if (dangerous.length > 0) {
          lines.push(`${dangerous[0]} 需要密码：${prefix}perm ${dangerous[0]} <password>`)
        }
        lines.push(expectedFullAccessPassword() === ''
          ? '⚠ 还没设置完全权限密码 —— 在 设置 →「插件」→「远程通道」里设。'
          : '完全权限密码已设置。')
        await replyRich(channel, lines.join('\n'))
        return
      }
      // `r` / `w` / `f` shorthands, resolved against the names this deployment
      // actually advertises, so a renamed preset table still works.
      const name = resolvePresetName(service, requested)
      if (name === undefined) {
        await replyTo(channel, `【DSH】没有这个预设：${parts[0]}\n可选：${service.names.join(' / ')}`)
        return
      }
      let spec
      try {
        spec = service.resolve(name)
      } catch (error) {
        await replyTo(channel, `【DSH】读取预设失败：${describeError(error)}`)
        return
      }
      if (presetIsDangerous(service, name)) {
        if (Date.now() < passwordFailures.lockedUntil) {
          const minutes = Math.ceil((passwordFailures.lockedUntil - Date.now()) / 60000)
          await replyTo(channel, `【DSH】密码错误次数过多，${minutes} 分钟后再试。`)
          return
        }
        const expected = expectedFullAccessPassword()
        if (expected === '') {
          await replyTo(channel, `【DSH】没有设置完全权限密码，远程打不开 ${name}。\n请在 设置 →「插件」→「远程通道」里设一个（只写不可读）。`)
          return
        }
        const supplied = parts.slice(1).join(' ').trim()
        if (supplied === '' || supplied !== expected) {
          passwordFailures.count += 1
          if (passwordFailures.count >= 5) {
            passwordFailures.count = 0
            passwordFailures.lockedUntil = Date.now() + 10 * 60 * 1000
          }
          debug('perm-password-rejected', { sessionId: session.id, supplied: supplied !== '' })
          await replyTo(channel, `【DSH】密码不对。用法：${prefix}perm ${name} <password>`)
          return
        }
        passwordFailures.count = 0
        debug('perm-password-accepted', { sessionId: session.id })
      }
      try {
        service.set(session, name)
      } catch (error) {
        await replyTo(channel, `【DSH】切换权限失败：${describeError(error)}`)
        return
      }
      debug('perm-switched', { sessionId: session.id, preset: name })
      await replyTo(channel, [
        `【DSH】权限已切换到 ${presetLabel(service, name)}。`,
        spec?.description ? spec.description : '',
        `沙箱：${spec?.sandbox ?? '?'} · 审批：${spec?.approval ?? '?'}`,
      ].filter(Boolean).join('\n'))
      return
    }
    // Attachment capture: `#file start` … send files … `#file end`.
    if (matchesCommand(compact(head), ['file', 'f', '附件'])) {
      const action = compact(argument)
      if (action === '' || matchesCommand(action, ['list', 'ls', 'status'])) {
        const lines = ['【DSH 附件】']
        if (capture === null) {
          lines.push('当前没有在收集。')
        } else {
          lines.push(`收集中（开始于 ${new Date(capture.startedAt).toLocaleTimeString('zh-CN', { hour12: false })}），已收 ${capture.files.length} 个：`)
          for (const file of capture.files) lines.push(`· ${file.name}${file.size ? `（${humanSize(file.size)}）` : ''}`)
        }
        lines.push('', `保存位置：${downloadsRoot()}`, `用法：${prefix}file start / ${prefix}file list / ${prefix}file clear`)
        await replyRich(channel, lines.join('\n'))
        return
      }
      if (matchesCommand(action, ['start', '开始'])) {
        const pruned = pruneDownloads()
        capture = { startedAt: Date.now(), sessionId: resolveTargetSession() ?? null, files: [] }
        debug('capture-start', { sessionId: capture.sessionId, pruned: pruned.removed })
        await replyTo(channel, [
          '【DSH】开始收集附件。现在把文件发过来；',
          '收完后直接发送任务（比如“把这份简历投了”），附件会跟着一起进会话。',
          `保存到：${downloadsRoot()}`,
          pruned.removed > 0 ? `（顺手清理了 ${pruned.removed} 个过期文件）` : '',
        ].filter(Boolean).join('\n'))
        return
      }
      if (matchesCommand(action, ['clear', 'cancel', '取消', '放弃'])) {
        const dropped = capture === null ? 0 : capture.files.length
        capture = null
        await replyTo(channel, `【DSH】已放弃本次收集（${dropped} 个文件留在磁盘上，没有被交给会话）。`)
        return
      }
      if (matchesCommand(action, ['end', 'done', '完成', '结束'])) {
        // Kept as an explicit "send them now, with no message" escape hatch —
        // the normal flow needs no terminator at all.
        if (capture === null || capture.files.length === 0) {
          capture = null
          await replyTo(channel, `【DSH】没有收到任何附件。用法：${prefix}file start → 发文件 → 发一条 ${prefix}消息`)
          return
        }
        const sessionId = capture.sessionId ?? resolveTargetSession()
        const files = capture.files
        capture = null
        const controller = sessionControllerService()
        if (controller === undefined || sessionId === null || sessionId === undefined) {
          await replyTo(channel, '【DSH】没有可用会话，附件已保存在磁盘上，但没有交给任何人。')
          return
        }
        const body = [
          `用户通过聊天发来 ${files.length} 个附件，已保存到本机：`,
          ...files.map((file, index) => `${index + 1}. ${file.path}${file.size ? `（${humanSize(file.size)}）` : ''}`),
          '',
          '请查看这些文件（用你的文件读取工具打开上面的路径）。',
        ].join('\n')
        try {
          await controller.prompt({
            requestId: `wechat-file-${Date.now()}`,
            sessionId,
            mode: deliveryMode(),
            content: [{ type: 'text', text: body }],
            clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          }, AbortSignal.timeout(45000))
          state.forwardedCount += 1
          const described = await describeSession(sessionId)
          debug('capture-end', { sessionId, files: files.length })
          await replyTo(channel, [
            `【DSH】已把 ${files.length} 个附件交给《${sessionLabel(described)}》。`,
            `工作区：${described?.cwd ?? '（未知）'}`,
            '',
            ...files.map((file) => `· ${file.path}`),
          ].join('\n'))
        } catch (error) {
          await replyTo(channel, `【DSH】转交附件失败（文件仍在磁盘上）：${describeError(error)}`)
        }
        return
      }
      await replyTo(channel, `【DSH】用法：${prefix}file start / ${prefix}file end / ${prefix}file list / ${prefix}file clear`)
      return
    }
    // Rename the session (default) or its workspace (`#rename ws <名字>`). Both
    // are display names: the session title is the label every reply uses, and the
    // workspace title is what the web sidebar shows.
    if (matchesCommand(compact(head), ['rename', 'rn', '重命名', '改名'])) {
      const parts = argument.split(/\s+/).filter((piece) => piece !== '')
      const wantsWorkspace = parts.length > 1 && ['ws', 'w', 'workspace', '工作区'].includes(compact(parts[0]))
      const title = (wantsWorkspace ? parts.slice(1) : parts).join(' ').trim()
      if (title === '') {
        await replyTo(channel, [
          `【DSH】用法：`,
          `${prefix}rename <新名字>          重命名当前会话`,
          `${prefix}rename ws <新名字>       重命名当前工作区`,
          '',
          `当前会话：${sessionLabel(await describeSession(resolveTargetSession()))}`,
        ].join('\n'))
        return
      }
      const sessionId = resolveTargetSession()
      if (sessionId === undefined) {
        await replyTo(channel, '【DSH】没有目标会话。')
        return
      }
      if (!wantsWorkspace) {
        const controller = sessionControllerService()
        if (controller === undefined || typeof controller.rename !== 'function') {
          await replyTo(channel, '【DSH】会话服务不支持重命名。')
          return
        }
        try {
          const result = await controller.rename({ sessionId, title })
          debug('renamed-session', { sessionId, title })
          await replyTo(channel, `【DSH】会话已重命名为《${result?.title ?? title}》。`)
        } catch (error) {
          await replyTo(channel, `【DSH】重命名会话失败：${describeError(error)}`)
        }
        return
      }
      const described = await describeSession(sessionId)
      const cwd = described?.cwd ?? null
      const registry = ctx.get('workspaceRegistry')
      const controller = ctx.get('workspaceController')
      if (controller === undefined || typeof controller.rename !== 'function') {
        await replyTo(channel, '【DSH】工作区服务不支持重命名。')
        return
      }
      let row
      try {
        const rows = registry?.list?.() ?? []
        const wanted = String(cwd ?? '').replace(/[\\/]+$/, '').toLowerCase()
        row = rows.find((workspace) => String(workspace.path ?? '').replace(/[\\/]+$/, '').toLowerCase() === wanted)
      } catch {
        row = undefined
      }
      if (row === undefined) {
        await replyTo(channel, `【DSH】找不到当前会话所在的工作区记录（${cwd ?? '未知目录'}）。`)
        return
      }
      try {
        const result = await controller.rename({ workspaceId: row.id, title })
        debug('renamed-workspace', { workspaceId: row.id, title })
        await replyTo(channel, `【DSH】工作区已重命名为《${result?.workspace?.title ?? title}》。`)
      } catch (error) {
        await replyTo(channel, `【DSH】重命名工作区失败：${describeError(error)}`)
      }
      return
    }
    // The master switch. `#off` is deliberately a *quiet* switch, not a kill
    // switch: the transports keep listening, so this very channel still works
    // and an operator away from the PC can always turn it back on.
    if (matchesCommand(token, ['on', 'o', '开启', '打开'])) {
      state.enabled = true
      rememberTarget()
      mirrorMasterToSettings(true)
      debug('master-switch', { on: true })
      await replyTo(channel, [
        '【DSH】已打开：转发指令、汇报、通知全部恢复。',
        `通道状态：`,
        ...channelLines().split('\n').slice(2, -2),
      ].join('\n'))
      return
    }
    if (matchesCommand(token, ['off', 'x', '关闭'])) {
      state.enabled = false
      rememberTarget()
      mirrorMasterToSettings(false)
      debug('master-switch', { on: false })
      await replyTo(channel, [
        '【DSH】已关闭：不再转发指令、不再汇报、不再发通知。',
        '通道仍然连着（故意的），所以你随时发 #on 就能开回来 ——',
        '否则你在外面就再也叫不醒我了。要彻底停掉就在电脑上改配置或关掉 NapCat。',
      ].join('\n'))
      return
    }
    // Per-transport switch: `#switch qq off`, `#switch wechat on`, `#qq off`.
    {
      const headToken = compact(head)
      const isSwitch = matchesCommand(headToken, ['switch', '切换通道'])
      const isShorthand = ['qq', 'onebot', 'q', 'wechat', 'wx', '微信'].includes(headToken)
      if (isSwitch || isShorthand) {
        const parts = (isSwitch ? argument.split(/\s+/) : [headToken, ...argument.split(/\s+/)])
          .map((piece) => compact(piece))
          .filter((piece) => piece !== '')
        const target = channelByName(parts[0] ?? '')
        const action = parts[1] ?? ''
        const force = parts.includes('force') || parts.includes('!')
        const wantsOn = ['on', '开', '开启', '打开', 'enable', '1'].includes(action)
        const wantsOff = ['off', '关', '关闭', 'disable', '0'].includes(action)
        if (target === undefined || (!wantsOn && !wantsOff)) {
          await replyTo(channel, [
            `【DSH】用法：#switch <qq|wechat> <on|off>`,
            '',
            channelLines(),
          ].join('\n'))
          return
        }
        if (wantsOff && target === channel && !force) {
          await replyTo(channel, [
            `【DSH】这条指令就是从「${target.statusSync().label}」进来的 —— 关掉它，你在这一侧就联系不上我了。`,
            '要关请从另一个通道发同一条指令，或者加 force（#switch qq off force），也可以直接在电脑上改配置。',
          ].join('\n'))
          return
        }
        // Confirm *before* stopping: the transport being switched off may be
        // the one carrying this very command, and an acknowledgement nobody can
        // read is worse than none.
        const snapshot = target.statusSync()
        if (wantsOff) {
          await replyTo(channel, [
            `【DSH】${snapshot.label} 已停用。`,
            target === channel ? '（就是你刚才用的这条通道 —— 这边接下来收不到消息了，要开回来请从另一个通道发。）' : '',
          ].filter(Boolean).join('\n'))
          await setChannelOn(target, false)
          return
        }
        await setChannelOn(target, true)
        await replyTo(channel, `【DSH】${snapshot.label} 已开启。\n\n${channelLines()}`)
        return
      }
    }
    if (!state.enabled) {
      await replyTo(channel, `【DSH】插件现在是关闭状态，只响应 #on / #off / #status / #channels / #switch / #help。\n发 ${prefix}on 打开。`)
      return
    }
    if (matchesCommand(compact(head), ['sessions', 'ls', 'se', '会话'])) {
      await replyRich(channel, [
        '【会话】',
        ...(await sessionLines()),
        '',
        `按最近活动排序。发 ${prefix}use <序号|名字> 切过去（会锁定）；`,
        `回刚刚给你发消息的那个：${prefix}reply <话>；已关闭的会在派活时自动恢复。`,
      ].join('\n'))
      return
    }
    // `#reply`: answer the session that spoke last — the phone-side equivalent of
    // clicking "reply" on a notification. With `话` it is a one-off message that
    // leaves the target alone; bare, it retargets to that session.
    if (matchesCommand(compact(head), ['reply', 'rp', '回', '回复', '答它'])) {
      const speaker = state.lastSpeakerId
      const described = speaker === undefined ? null : await describeSession(speaker)
      if (speaker === undefined || described === null) {
        await replyTo(channel, [
          '【DSH】还没有会话给我发过汇报，所以不知道「刚刚那个」是谁。',
          `先发 ${prefix}sessions 看有哪些会话，用 ${prefix}use <序号> 切过去。`,
        ].join('\n'))
        return
      }
      const label = sessionLabel(described)
      const said = argument.trim()
      if (said === '') {
        await setPinnedTarget(speaker, label)
        await replyTo(channel, [
          `【DSH】目标已切到刚刚发言的《${label}》。`,
          described.cwd === null ? '' : `工作区：${described.cwd}`,
          `之后的消息都进它；带着话发（${prefix}reply <话>）就只回它一次、不改目标。`,
        ].filter((line) => line !== '').join('\n'))
        return
      }
      debug('reply-to-speaker', { sessionId: speaker, chars: said.length })
      await deliverToSession(speaker, said, channel, { asTarget: false })
      return
    }
    if (matchesCommand(compact(head), ['tree', 'tr', '树', '会话树'])) {
      await replyRich(channel, await treeText(await sessionEntries()))
      return
    }
    if (matchesCommand(compact(head), ['use', 'u', '切换'])) {
      if (argument === '') {
        await replyRich(channel, [
          `【DSH】用法：${prefix}use <序号|名字|id前缀>`,
          '',
          ...(await sessionLines()),
        ].join('\n'))
        return
      }
      const entries = await sessionEntries()
      const chosen = pickByIndexOrPrefix(entries, argument, (entry) => entry.id,
        (entry) => entry.title ?? basename(entry.cwd) ?? '')
      if (chosen !== undefined) {
        await setPinnedTarget(chosen.id, chosen.title ?? basename(chosen.cwd) ?? null)
        await replyTo(channel, `【DSH】已切换到会话《${chosen.title ?? basename(chosen.cwd) ?? '未命名会话'}》\n    ${chosen.cwd ?? ''}`)
        return
      }
      // A full session id is accepted directly; the prompt path resumes it.
      if (/^[0-9a-f][0-9a-f-]{15,}$/i.test(argument)) {
        await setPinnedTarget(argument)
        await replyTo(channel, `【DSH】已锁定会话 ${argument}\n    （若该会话不存在，派活时会报错）`)
        return
      }
      await replyRich(channel, [
        `【DSH】没找到会话「${argument}」，可用的：`,
        '',
        ...(await sessionLines()),
      ].join('\n'))
      return
    }
    if (matchesCommand(compact(head), ['ws', 'w', 'workspace', '工作区'])) {
      const registry = ctx.get('workspaceRegistry')
      if (argument === '') {
        await replyRich(channel, [
        '【工作区】',
        ...(await workspaceLines()),
        '',
        `发 ${prefix}ws <序号|名字|路径> 选定；${prefix}ws new <name|path> 新建。`,
      ].join('\n'))
        return
      }
      // `#ws fix`: re-attach sessions that sit in 未分组 while their directory is
      // already a project. Membership is an explicit account in the workspace
      // record, so a session created the wrong way stays ungrouped until someone
      // attaches it — this is that someone.
      if (matchesCommand(compact(argument), ['fix', 'repair', '修复', '整理', 'rejoin'])) {
        if (registry === undefined) {
          await replyTo(channel, '【DSH】工作区服务不可用。')
          return
        }
        const homeless = await ungroupedButKnown()
        if (homeless.length === 0) {
          await replyTo(channel, '【DSH】没有需要整理的会话 —— 目录属于某个工作区的会话都已经在组里了。')
          return
        }
        const projects = registry.list()
        const moved = []
        const failed = []
        for (const entry of homeless) {
          const project = projects.find((workspace) => samePath(workspace.path, entry.cwd))
          if (project === undefined || typeof project.attachSession !== 'function') continue
          try {
            await project.attachSession(entry.sessionId)
            moved.push(`· ${sessionLabel({ cwd: entry.cwd, title: null })} → ${project.title}`)
          } catch (error) {
            failed.push(`· ${basename(entry.cwd) ?? entry.cwd}：${describeError(error)}`)
          }
        }
        debug('workspace-fix', { moved: moved.length, failed: failed.length })
        await replyRich(channel, [
          '【工作区整理】',
          moved.length > 0 ? `已挂回 ${moved.length} 个会话：` : '没有需要挂回的会话。',
          ...moved,
          ...(failed.length > 0 ? ['', `失败 ${failed.length} 个：`, ...failed] : []),
          '',
          '侧边栏会立刻跟着变（工作区列表走的是同一个投影）。',
        ].join('\n'))
        return
      }
      // `#ws new <名字|路径>`: create a workspace and pin it in one step. A bare
      // name becomes a sibling of the current workspace, because "start a new
      // project next to this one" is the only thing a phone can sensibly mean.
      const newMatch = /^(?:new|新建|创建)\s+(.+)$/i.exec(argument.trim())
      // A bare `#ws new` must not be mistaken for a *path* called "new" and
      // silently create a directory next to the current workspace.
      if (newMatch === null && /^(?:new|新建|创建)$/i.test(argument.trim())) {
        await replyTo(channel, [
          `【DSH】用法：${prefix}ws new <名字|路径>`,
          `· 名字 → 建在当前工作区旁边，例如 ${prefix}ws new 测试项目`,
          `· 路径 → 建在那里，例如 ${prefix}ws new D:\\work\\new-thing`,
        ].join('\n'))
        return
      }
      if (newMatch !== null) {
        if (registry === undefined) {
          await replyTo(channel, '【DSH】工作区服务不可用。')
          return
        }
        const wanted = newMatch[1].trim()
        const currentCwd = targetWorkspacePath()
        const target = /^[a-z]:[\\/]/i.test(wanted) || wanted.startsWith('\\\\')
          ? wanted
          : join(currentCwd === null ? process.cwd() : dirname(currentCwd), safeFileName(wanted, 'new-workspace'))
        try {
          const made = ensureDirectory(target)
          const created = await registry.create(target)
          state.pinnedWorkspace = created.path
          rememberTarget()
          debug('workspace-created', { path: created.path, made })
          await replyTo(channel, [
            `【DSH】已${made ? '新建' : '选定已存在的'}工作区：${created.title}`,
            `    ${created.path}`,
            '',
            `现在 ${prefix}new 会在这里开新会话；要立刻开一个就发 ${prefix}new。`,
          ].join('\n'))
        } catch (error) {
          await replyTo(channel, `【DSH】新建工作区失败：${describeError(error)}\n目标：${target}`)
        }
        return
      }
      let workspaces = []
      try {
        workspaces = registry?.list() ?? []
      } catch {
        workspaces = []
      }
      const picked = pickByIndexOrPrefix(workspaces, argument, (workspace) => workspace.path,
        (workspace) => workspace.title ?? '')
      if (picked !== undefined) {
        state.pinnedWorkspace = picked.path
        rememberTarget()
        await replyTo(channel, `【DSH】已选定工作区：${picked.title}\n    ${picked.path}\n下次 ${prefix}new 会用这里。`)
        return
      }
      // A name that fits several workspaces must list them rather than guess.
      const ambiguous = ambiguousNames(workspaces, argument, (workspace) => workspace.title ?? '')
      if (ambiguous.length > 1) {
        await replyTo(channel, [
          `【DSH】有 ${ambiguous.length} 个工作区都叫这个名字，换一个更准的写法：`,
          ...ambiguous.map((name) => `· ${name}`),
          `（也可以发 ${prefix}ws 看序号）`,
        ].join('\n'))
        return
      }
      // Not a known name and not shaped like a path: refuse instead of creating a
      // directory called `orders` (or `order`!) next to whatever the server runs in.
      const looksLikePath = /^[a-z]:[\\/]/i.test(argument) || argument.startsWith('\\\\') || /[\\/]/.test(argument)
      if (!looksLikePath) {
        await replyTo(channel, [
          `【DSH】没有找到工作区「${argument}」。`,
          `${prefix}ws 看全部（也可以直接发路径）`,
          `要新建就用 ${prefix}ws new ${argument}`,
        ].join('\n'))
        return
      }
      // Treat it as a path: register (or reuse) the workspace so it also shows
      // up in the web sidebar.
      if (registry === undefined) {
        await replyTo(channel, '【DSH】工作区服务不可用。')
        return
      }
      try {
        // A workspace is a directory: `#ws D:\new\project` is how you *create*
        // one from the phone, so make the directory before registering it.
        const made = ensureDirectory(argument)
        const created = await registry.create(argument)
        state.pinnedWorkspace = created.path
        rememberTarget()
        await replyTo(channel, [
          `【DSH】已选定工作区：${created.title}`,
          `    ${created.path}`,
          made ? '（目录不存在，已新建）' : '',
          `下次 ${prefix}new 会用这里。`,
        ].filter(Boolean).join('\n'))
      } catch (error) {
        await replyTo(channel, `【DSH】无效的工作区路径：${argument}\n${describeError(error)}`)
      }
      return
    }
    if (matchesCommand(compact(head), ['new', 'n', '新建'])) {
      const controller = sessionControllerService()
      if (controller === undefined) {
        await replyTo(channel, '【DSH】会话服务不可用。')
        return
      }
      const requested = argument !== '' ? argument : (state.pinnedWorkspace ?? targetWorkspacePath() ?? null)
      let cwd = requested
      let workspaceId
      let workspaceTitle = null
      if (requested !== null) {
        // `create({ cwd })` records a directory but does NOT make the session a
        // member of that project — the Host attaches membership only on the
        // `workspaceId` path (`workspace.attachSession`). That is the difference
        // between a session appearing under its workspace and appearing in
        // 未分组, so resolve the project first and pass its id.
        try {
          // Same as `#ws`: naming a directory that does not exist yet is a
          // request to create it, not a mistake to bounce back.
          ensureDirectory(requested)
          const registry = ctx.get('workspaceRegistry')
          if (registry !== undefined) {
            const projects = registry.list()
            const found = projects.find((workspace) => samePath(workspace.path, requested))
            const project = found ?? await registry.create(requested)
            if (project !== undefined && project !== null) {
              workspaceId = typeof project.id === 'string' && project.id !== '' ? project.id : undefined
              workspaceTitle = typeof project.title === 'string' ? project.title : null
              if (typeof project.path === 'string' && project.path !== '') cwd = project.path
            }
          }
        } catch (error) {
          // A project that cannot be created must not cost the session: fall back
          // to the plain `cwd` create and say so in the reply.
          debug('new:workspace-failed', { message: describeError(error) })
        }
      }
      try {
        debug('new:create:start', { hasCwd: cwd !== null, workspaceId: workspaceId ?? null })
        const created = workspaceId === undefined
          ? await controller.create(cwd === null ? {} : { cwd })
          : await controller.create({ workspaceId })
        debug('new:create:done', { sessionId: created?.sessionId ?? null })
        if (typeof created?.sessionId !== 'string' || created.sessionId === '') {
          throw new Error(`会话服务没有返回 sessionId：${JSON.stringify(created)?.slice(0, 200)}`)
        }
        state.pinnedSessionId = created.sessionId
        state.lastActiveSessionId = created.sessionId
        state.lastTargetSessionId = created.sessionId
        rememberTarget()
        const fresh = await describeSession(created.sessionId)
        await replyTo(channel, [
          `【DSH】已新建会话《${sessionLabel(fresh)}》`,
          workspaceTitle === null ? `工作区：${cwd ?? '（默认）'}` : `工作区：${workspaceTitle}（${cwd}）`,
          workspaceTitle === null && cwd !== null
            ? '（没有对应的项目，所以它会出现在「未分组」里）'
            : '',
          '',
          '直接发消息就能派活。',
        ].filter(Boolean).join('\n'))
      } catch (error) {
        await replyTo(channel, `【DSH】新建会话失败：${describeError(error)}`)
      }
      return
    }
    if (matchesCommand(compact(head), ['shot', 'sh', 'screenshot', '截图', '截屏'])) {
      const wanted = argument.trim()
      const compactWanted = compact(wanted)
      const monitorWords = {
        all: 'all', 全部: 'all', 所有: 'all', 全屏: 'all', 全部屏幕: 'all',
        main: 'primary', primary: 'primary', 主屏: 'primary', 主屏幕: 'primary',
      }
      // `#shot screen …` changes WHICH display the default uses; a bare value is a
      // one-off override, so a single glance at the other monitor does not need a
      // setting change and a second command to undo it. The separator is optional
      // because a phone keyboard drops spaces, but `#shot screenshot` must still
      // read as a window title rather than as "the screen called shot".
      const settingMatch = /^(screen|monitor|屏|显示器)\s*(.*)$/i.exec(wanted)
      const settingValue = settingMatch !== null
        && (settingMatch[2].trim() === '' || resolveShotTarget(compact(settingMatch[2]), monitorWords) !== null)
        ? compact(settingMatch[2])
        : null
      const asSetting = settingValue !== null
      if (asSetting) {
        const current = describeShotTarget(state.shotMonitor)
        if (settingValue === '') {
          const monitors = await availableMonitors()
          const lines = [
            '【DSH 截图屏幕】',
            `当前默认：${current}`,
            '',
            '可用：',
            '· 主屏（默认，文字最清楚）',
            '· 全部 → 所有显示器拼成一张',
            ...monitors.map((m) => `· ${m.index} → ${m.device.replace(/^\\\\\.\\/, '')} ${m.width}×${m.height}${m.primary ? '（主屏）' : ''}`),
            '',
            `切换：${prefix}shot screen 2  /  ${prefix}shot screen 全部  /  ${prefix}shot screen 主屏`,
            `只看一次：${prefix}shot 2（不改默认）`,
          ]
          await replyRich(channel, lines.join('\n'))
          return
        }
        const resolved = resolveShotTarget(settingValue, monitorWords)
        if (resolved === null) {
          await replyTo(channel, `【DSH】不认识这个屏幕：${settingValue}\n可用：主屏 / 全部 / 1、2…（发 ${prefix}shot screen 看列表）`)
          return
        }
        if (/^[1-9]\d?$/.test(resolved)) {
          const monitors = await availableMonitors()
          if (monitors.length > 0 && !monitors.some((m) => m.index === Number(resolved))) {
            await replyTo(channel, `【DSH】这台机器没有第 ${resolved} 个显示器。\n现有：${monitorSummary(monitors)}`)
            return
          }
        }
        state.shotMonitor = resolved
        rememberTarget()
        debug('shot-monitor', { monitor: resolved })
        await replyTo(channel, `【DSH】截图默认改为：${describeShotTarget(resolved)}。下一条 ${prefix}shot 就按这个来。`)
        return
      }
      const oneOff = resolveShotTarget(compactWanted, monitorWords)
      if (oneOff !== null && /^[1-9]\d?$/.test(oneOff)) {
        const monitors = await availableMonitors()
        if (monitors.length > 0 && !monitors.some((m) => m.index === Number(oneOff))) {
          await replyTo(channel, `【DSH】这台机器没有第 ${oneOff} 个显示器。\n现有：${monitorSummary(monitors)}`)
          return
        }
      }
      // Anything that is not a screen selector is a window title, exactly as before.
      const windowTitle = oneOff === null && wanted !== '' ? wanted : null
      const shot = await takeScreenshot({
        maxWidth: config.screenshotMaxWidth,
        windowTitle,
        monitor: oneOff ?? state.shotMonitor,
      })
      if (shot === null) {
        await replyTo(channel, '【DSH】没有可用的截图通道。')
        return
      }
      const label = windowTitle !== null ? `窗口「${windowTitle}」` : describeShotTarget(oneOff ?? state.shotMonitor)
      const caption = `【DSH 截图】${label} ${shot.width}×${shot.height}（手机上点「查看原图」才是全清晰度）`
      const ok = await broadcastImage(shot.png, { caption, only: channel })
      if (!ok) await replyTo(channel, '【DSH】截图发送失败。')
      return
    }
    if (matchesCommand(compact(head), ['clear', 'cl', '自动', 'unpin'])) {
      const hadPin = state.pinnedSessionId !== undefined || state.pinnedWorkspace !== null
      state.pinnedSessionId = undefined
      state.pinnedWorkspace = null
      // The browser tree shows the pin, so clearing it has to travel too.
      mirrorFieldToSettings('pinSessionId', '')
      mirrorFieldToSettings('pinLabel', '')
      rememberTarget()
      await replyTo(channel, hadPin
        ? '【DSH】已取消锁定，目标会话恢复为「跟随最近活跃会话」。'
        : '【DSH】当前没有锁定任何会话或工作区。')
      return
    }
    if (matchesCommand(compact(head), ['stop', 'k', '停止', 'cancel', '取消'])) {
      const sessionId = resolveTargetSession()
      const agent = sessionId === undefined ? undefined : agentsService()?.get(sessionId)
      if (agent === undefined) {
        await replyTo(channel, '【DSH】没有正在运行的会话可以停止。')
        return
      }
      try {
        agent.cancel({ kind: 'user' })
        await replyTo(channel, `【DSH】已请求停止会话《${liveSessionTitle(agent) ?? basename(agent?.session?.header?.cwd) ?? '未命名'}》。`)
      } catch (error) {
        await replyTo(channel, `【DSH】停止失败：${describeError(error)}`)
      }
      return
    }

    // A question left over from the check above is impossible (it returns when it
    // consumes the message), so the dispatch continues from here.

    if (config.remoteControl !== true) return
    const sessionController = ctx.get('sessionController')
    if (sessionController === undefined) {
      await replyTo(channel, '【DSH】远程控制不可用：sessionController 服务未挂载。')
      return
    }
    const sessionId = resolveTargetSession()
    if (sessionId === undefined) {
      await replyTo(channel, '【DSH】没有可用的活动会话，请先在网页端打开一个会话。')
      return
    }
    await deliverToSession(sessionId, body, channel, { asTarget: true })
  }

  /**
   * Put one message into one session.
   *
   * Shared by the plain "派活" path — which also remembers the session as the
   * remote target — and by `#reply <话>`, which must **not** move the target: the
   * whole point of answering the session that just spoke is that it does not
   * change where the next command goes.
   * @param sessionId - destination session.
   * @param body - the text to deliver.
   * @param channel - the transport the command arrived on.
   * @param options.asTarget - remember this session as the remote target.
   * @returns true when the prompt was accepted.
   */
  async function deliverToSession(sessionId, body, channel, { asTarget = true } = {}) {
    const sessionController = ctx.get('sessionController')
    if (sessionController === undefined) {
      await replyTo(channel, '【DSH】远程控制不可用：sessionController 服务未挂载。')
      return false
    }
    try {
      // Remember this as the remote target before the turn starts: if the
      // process restarts mid-turn, the next command still lands here.
      if (asTarget) {
        state.lastTargetSessionId = sessionId
        rememberTarget()
      }
      const pending = state.pendingRemoteTurns.get(sessionId) ?? 0
      state.pendingRemoteTurns.set(sessionId, pending + 1)
      // A collected attachment batch rides along with the next instruction that
      // actually reaches the session: one prompt, message first then the files.
      const attached = capture !== null && capture.files.length > 0 ? capture.files : []
      if (attached.length > 0) capture = null
      const forwardBody = attached.length === 0 ? body : [
        body,
        '',
        `（附带 ${attached.length} 个附件，已保存到本机，请用文件工具读取：）`,
        ...attached.map((file, index) => `${index + 1}. ${file.path}${file.size ? `（${humanSize(file.size)}）` : ''}`),
      ].join('\n')
      const prompt = {
        requestId: `wechat-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        sessionId,
        mode: deliveryMode(),
        content: [{ type: 'text', text: forwardBody }],
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }
      let delivered = deliveryMode()
      try {
        await sessionController.prompt(prompt, AbortSignal.timeout(45000))
      } catch (error) {
        // `steer` needs a turn that is actually running; when there is none the
        // Host refuses it, and waiting is exactly what the operator meant anyway.
        if (deliveryMode() !== 'steer') throw error
        debug('steer-fallback', { sessionId, message: describeError(error) })
        prompt.mode = 'queue'
        delivered = 'queue'
        await sessionController.prompt(prompt, AbortSignal.timeout(45000))
      }
      state.forwardedCount += 1
      if (config.replyAcks) {
        // Name the destination: a bare `session-1610f112` reads as noise, and
        // when it is the wrong session the operator has no way to tell.
        const destination = await describeSession(sessionId)
        const how = delivered === 'steer' ? '插入' : '排队'
        await replyTo(channel, [
          `【DSH】已${how}投递给《${sessionLabel(destination)}》`,
          `工作区：${destination?.cwd ?? '（未知）'}`,
          `内容：${clamp(body, 120)}`,
          asTarget ? '' : `（目标没变，还是原来那个；要切过去发 ${config.commandPrefix}reply）`,
        ].filter((line) => line !== '').join('\n'))
      }
      return true
    } catch (error) {
      const pending = state.pendingRemoteTurns.get(sessionId) ?? 0
      if (pending > 0) {
        if (pending === 1) state.pendingRemoteTurns.delete(sessionId)
        else state.pendingRemoteTurns.set(sessionId, pending - 1)
      }
      await replyTo(channel, `【DSH】转发失败：${describeError(error)}`)
      return false
    }
  }

  // ------------------------------------------------------------- channel run
  ctx.effect(() => {
    const disposers = []
    const readySeen = new Set()
    for (const channel of channels) {
      disposers.push(channel.onMessage((message) => {
        // A stopped transport should not be delivering anything, but a poll in
        // flight can still land here — never let it count or act.
        if (!channelOn(channel)) return
        state.receivedCount += 1
        state.lastError = null
        debug('inbound', { transport: channel.id, text: redactSecrets(message.text).slice(0, 160) })
        ctx.emit('remote/message', message)
        void handleCommand(message, channel).catch((error) => {
          logger.warn(`handling inbound message failed: ${describeError(error)}`)
          debug('error', { where: 'handleCommand', message: describeError(error) })
        })
      }))
      if (typeof channel.onStatus === 'function') {
        disposers.push(channel.onStatus((snapshot) => {
          ctx.emit('remote/status', { transport: snapshot.id, ...snapshot })
          // Announce only the false -> true edge, so the periodic re-checks do
          // not turn into a stream of "connected" messages.
          if (snapshot.ready && !readySeen.has(snapshot.id)) {
            readySeen.add(snapshot.id)
            logger.info(`${snapshot.label} ready — remote channel armed`)
            if (config.announceOnReady) {
              notify('已连接', [
                `${snapshot.label} 已就绪，远程通道可用。`,
                config.commandPrefix.length > 0
                  ? `直接发送任务；管理命令以 ${config.commandPrefix} 开头，例如 ${config.commandPrefix}status。`
                  : '直接发送任务或命令。',
              ].join('\n'))
            }
          } else if (!snapshot.ready && readySeen.has(snapshot.id)) {
            readySeen.delete(snapshot.id)
            logger.warn(`${snapshot.label} became unavailable`)
            // Remind, never repair: the plugin deliberately does not launch or
            // raise WeChat (a process it started would die with DSH, and raising
            // the window steals the keyboard). The operator starts it.
            notify('通道掉线', [
              `${snapshot.label} 现在不可用。`,
              snapshot.id === 'wechat-local'
                ? '请自己打开微信并登录（插件不会替你启动它），需要的话把「文件传输助手」窗口留在屏幕上。'
                : '检查 NapCat / OneBot WebSocket 是否还在跑。',
              '另一个通道如果还连着，指令照常可用。',
            ].join('\n'))
          }
        }))
      }
      if (!channelOn(channel)) {
        logger.info(`${channel.id} stays stopped — switched off by an earlier command`)
        continue
      }
      void channel.start().catch((error) => {
        logger.warn(`starting ${channel.id} failed: ${describeError(error)}`)
      })
    }
    return () => {
      for (const dispose of disposers) dispose()
      for (const channel of channels) void channel.stop()
    }
  })

  // ------------------------------------------------------- forkable turn marks
  /**
   * Number every finished turn so a phone can point at one.
   *
   * The operator only ever sees the reports this plugin pushed; numbering them
   * (`回合 #12`) turns that chat history into the addressing scheme, which is why
   * `#fork 12` needs no transcript scrolling and no long screenshot.
   */
  ctx.effect(() => ctx.on('agent/turn-stopping', ({ agent }) => {
    const agents = agentsService()
    if (agents === undefined || !agents.roots().includes(agent)) return
    let atSeq = null
    try {
      const events = agent.session?.snapshotEvents?.()
      const last = Array.isArray(events) && events.length > 0 ? events[events.length - 1] : null
      atSeq = typeof last?.seq === 'number' ? last.seq : null
    } catch {
      atSeq = null
    }
    if (atSeq === null) return
    const previous = state.turnMarks.length > 0 ? state.turnMarks[state.turnMarks.length - 1].n : 0
    const text = lastAssistantText(agent.session) ?? ''
    state.turnMarks.push({
      n: previous + 1,
      sessionId: agent.id,
      atSeq,
      at: new Date().toISOString(),
      label: text.replace(/\s+/g, ' ').slice(0, 60),
    })
    if (state.turnMarks.length > FORK_MARK_LIMIT) {
      state.turnMarks = state.turnMarks.slice(-FORK_MARK_LIMIT)
    }
    rememberTarget()
    debug('turn-mark', { n: previous + 1, sessionId: agent.id, atSeq })
  }))

  // ------------------------------------------------------- attachment capture
  /**
   * Files the operator sends during a `#file start … #file end` window.
   *
   * They are saved to disk and then *named in the prompt*: the agent already has
   * file tools, so handing it absolute paths is both simpler and more capable
   * than trying to push bytes through an attachment RPC. Only the QQ transport
   * can do this — WeChat's reader sees pixels, not file bytes.
   */
  let capture = null

  /** Where downloaded attachments live: `$DSH_HOME/downloads` by default. */
  function downloadsRoot() {
    if (typeof config.downloadsDir === 'string' && config.downloadsDir.trim() !== '') return config.downloadsDir.trim()
    const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
      ? process.env.DSH_HOME.trim()
      : join(process.env.USERPROFILE ?? '.', '.dsh')
    return join(home, 'downloads')
  }

  /** Strip anything a Windows path cannot carry. */
  function safeFileName(name, fallback) {
    const cleaned = String(name ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim()
    return cleaned === '' ? fallback : cleaned.slice(0, 120)
  }

  /**
   * Drop day folders past the retention window, then trim the oldest files until
   * the whole tree fits the size cap. Never deletes anything from today.
   */
  function pruneDownloads() {
    const root = downloadsRoot()
    if (!existsSync(root)) return { removed: 0 }
    const days = Math.max(1, Math.floor(config.attachmentRetentionDays))
    const capBytes = Math.max(10, Math.floor(config.attachmentMaxTotalMB)) * 1024 * 1024
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
    const today = new Date().toISOString().slice(0, 10)
    let removed = 0
    const entries = []
    try {
      for (const day of readdirSync(root)) {
        const dir = join(root, day)
        let info
        try {
          info = statSync(dir)
        } catch {
          continue
        }
        if (!info.isDirectory()) continue
        if (day < today && info.mtimeMs < cutoff) {
          try {
            rmSync(dir, { recursive: true, force: true })
            removed += 1
          } catch { /* best effort */ }
          continue
        }
        let files = []
        try {
          files = readdirSync(dir).map((name) => {
            const path = join(dir, name)
            try {
              const file = statSync(path)
              return { path, size: file.size, at: file.mtimeMs }
            } catch {
              return null
            }
          }).filter(Boolean)
        } catch {
          files = []
        }
        entries.push({ day, files })
      }
    } catch {
      return { removed }
    }
    let total = entries.reduce((sum, entry) => sum + entry.files.reduce((inner, file) => inner + file.size, 0), 0)
    if (total <= capBytes) return { removed }
    const oldest = entries
      .filter((entry) => entry.day !== today)
      .flatMap((entry) => entry.files)
      .sort((a, b) => a.at - b.at)
    for (const file of oldest) {
      if (total <= capBytes) break
      try {
        rmSync(file.path, { force: true })
        total -= file.size
        removed += 1
      } catch { /* best effort */ }
    }
    return { removed }
  }

  /** `1.2 MB` / `340 KB`, for acknowledgements. */
  function humanSize(bytes) {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return ''
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
    return `${bytes} B`
  }

  /**
   * Save every attachment on one inbound message into today's download folder.
   * @param message - the inbound message (may carry `attachments`).
   * @param channel - the transport it came from.
   * @returns the saved files, in message order.
   */
  async function collectAttachments(message, channel) {
    const saved = []
    if (typeof channel.downloadAttachment !== 'function') {
      throw new Error(`这个通道（${channel.id}）收不到文件内容；请改用 QQ 通道发文件`)
    }
    const day = new Date().toISOString().slice(0, 10)
    const dir = join(downloadsRoot(), day)
    mkdirSync(dir, { recursive: true })
    for (const attachment of message.attachments) {
      const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '')
      const fallback = attachment.kind === 'image' ? 'image.png' : 'file.bin'
      let name = safeFileName(attachment.name, fallback)
      if (!/\.[a-z0-9]{1,8}$/i.test(name)) {
        const guessed = attachment.kind === 'image' ? '.png' : ''
        name = `${name}${guessed}`
      }
      let path = join(dir, `${stamp}-${name}`)
      // Never overwrite: a second file with the same name in the same second wins
      // a suffix instead of clobbering the first.
      for (let index = 2; existsSync(path) && index < 100; index += 1) {
        path = join(dir, `${stamp}-${index}-${name}`)
      }
      const bytes = await channel.downloadAttachment(attachment, path)
      const size = typeof bytes === 'number' ? bytes : (existsSync(path) ? statSync(path).size : 0)
      saved.push({ path, name, size, kind: attachment.kind })
      debug('attachment-saved', { path, size, kind: attachment.kind })
    }
    return saved
  }

  // ------------------------------------------------------- agent awareness
  /**
   * Tell the model that a person may be following this session from a chat app.
   *
   * Without this the agent has no reason to use `remote_notify`, and a long job
   * would stay silent until its turn ended — the opposite of "report promptly".
   * The text is recomputed per assembly so it disappears while no transport is
   * connected, and mentions the real command prefix.
   */
  function awarenessText() {
    if (!state.enabled || !config.agentAwareness) return ''
    if (!anyReady()) return ''
    const prefix = config.commandPrefix
    const example = prefix.length > 0 ? `${prefix}status` : 'status'
    return [
      '## Remote operator',
      '',
      'The person you are working for may be following this session from a chat app',
      "(WeChat's 文件传输助手 or QQ) rather than from this machine. They send instructions as",
      `messages and can only see what you explicitly send back.`,
      '',
      `- Use the \`remote_notify\` tool to report when you finish a meaningful chunk of work,`,
      `  hit a blocker, or need a decision. A few short plain-text lines; no markdown tables.`,
      `- Use the \`remote_screenshot\` tool when the state that matters is visual — a rendered`,
      `  page, a document layout, a GUI dialog.`,
      `- Keep such messages free of secrets, tokens, and long raw logs.`,
      `- They can also run \`${example}\` style commands; you never need to poll for them.`,
    ].join('\n')
  }

  ctx.inject(['systemPrompt'], (promptCtx) => {
    try {
      promptCtx.systemPrompt.section({
        name: 'remote-channel:audience',
        // Sits with the other policy sections, right after plan mode.
        order: 550,
        text: () => awarenessText(),
      })
      // The working mode's own text (a persona, house rules…). Its own section so
      // it can be long without dragging the audience note around with it.
      promptCtx.systemPrompt.section({
        name: 'remote-channel:mode',
        order: 551,
        text: () => modePromptText(),
      })
    } catch (error) {
      logger.warn(`could not register the system-prompt section: ${describeError(error)}`)
    }
  })

  // ------------------------------------------------------------------ tools
  ctx.inject(['tools'], (toolCtx) => {
    try {
      toolCtx.tools.register(defineTool({
        name: 'remote_notify',
        description:
          'Send a message to the user through the configured remote chat channel ' +
          '(WeChat 文件传输助手 and/or QQ). Use it to report a problem, a blocked state, or a ' +
          'finished long-running job when the user is away from the computer. Plain text only.',
        parameters: {
          text: { type: 'string', required: true, description: 'Message body to send.' },
          headline: { type: 'string', description: 'Short prefix shown as 【DSH·<headline>】.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              sent: { type: 'boolean', required: true },
              reason: { type: 'string' },
            },
          },
          render: (_args, value) => [{
            type: 'text',
            text: value.sent ? 'Remote message sent.' : `Remote message not sent: ${value.reason ?? 'unknown'}`,
          }],
        },
        async execute(args, exec) {
          if (!state.enabled) return { sent: false, reason: 'remote-channel plugin is disabled' }
          if (!anyReady()) {
            for (const channel of channels) await channel.refreshStatus?.()
          }
          if (!anyReady()) return { sent: false, reason: 'no remote transport is ready' }
          const headline = typeof args.headline === 'string' && args.headline.trim() !== ''
            ? args.headline.trim()
            : '通知'
          // Same renderer as every other push, so a report from an agent obeys
          // `#img` instead of being the one message that is always plain text.
          // The calling agent names itself, so the operator can tell which
          // workspace and session is talking without asking.
          const source = sourceLabelFor(exec?.agent) ?? sourceLabelForSession(resolveTargetSession())
          const body = source === null
            ? `【DSH·${headline}】\n${args.text}`
            : `【DSH·${headline}】${source}\n${args.text}`
          const sent = await broadcastRich(body, { force: true })
          return sent ? { sent: true } : { sent: false, reason: state.lastError ?? 'every transport rejected the send' }
        },
      }))

      toolCtx.tools.register(defineTool({
        name: 'remote_screenshot',
        description:
          'Capture the desktop (or one window) and send it as an image to the remote chat channel. ' +
          'Use it when a visual state matters — a rendered page, a PDF layout, a GUI dialog — ' +
          'so the user can see it while away from the computer. Captures the main display by ' +
          'default; pass `monitor` to grab another display, or `all` for every screen side by side.',
        parameters: {
          caption: { type: 'string', description: 'Short text sent above the image.' },
          windowTitle: { type: 'string', description: 'Only capture a window whose title contains this text.' },
          monitor: {
            type: 'string',
            description: "Which display: 'primary' (default), 'all', or a 1-based display number such as '2'.",
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              sent: { type: 'boolean', required: true },
              width: { type: 'integer' },
              height: { type: 'integer' },
              reason: { type: 'string' },
            },
          },
          render: (_args, value) => [{
            type: 'text',
            text: value.sent
              ? `Screenshot sent (${value.width}×${value.height}).`
              : `Screenshot not sent: ${value.reason ?? 'unknown'}`,
          }],
        },
        async execute(args) {
          if (!state.enabled) return { sent: false, reason: 'remote plugin is disabled' }
          const shot = await takeScreenshot({
            maxWidth: config.screenshotMaxWidth,
            windowTitle: typeof args.windowTitle === 'string' && args.windowTitle.trim() !== ''
              ? args.windowTitle.trim()
              : null,
            monitor: typeof args.monitor === 'string' && args.monitor.trim() !== ''
              ? args.monitor.trim()
              : state.shotMonitor,
          })
          if (shot === null) return { sent: false, reason: 'no transport can capture or deliver images' }
          const caption = typeof args.caption === 'string' && args.caption.trim() !== '' ? args.caption.trim() : null
          const sent = await broadcastImage(shot.png, { caption })
          return sent
            ? { sent: true, width: shot.width, height: shot.height }
            : { sent: false, width: shot.width, height: shot.height, reason: 'every transport rejected the image' }
        },
      }))

      toolCtx.tools.register(defineTool({
        name: 'remote_status',
        description:
          'Report the remote-channel plugin state: each transport\'s connection/login detection, ' +
          'and the current remote-control target session (its name and workspace, not just an id).',
        parameters: {},
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              anyReady: { type: 'boolean', required: true },
              settingsRegistered: { type: 'boolean', required: true },
              settingsValues: { type: 'string' },
              targetSessionId: { type: 'string' },
              targetSessionName: { type: 'string' },
              targetWorkspace: { type: 'string' },
              targetRunning: { type: 'boolean' },
              otherLiveSessions: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string', required: true },
                    name: { type: 'string', required: true },
                    workspace: { type: 'string' },
                  },
                },
              },
              sentCount: { type: 'integer', required: true },
              receivedCount: { type: 'integer', required: true },
              forwardedCount: { type: 'integer', required: true },
              transports: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string', required: true },
                    label: { type: 'string', required: true },
                    state: { type: 'string', required: true },
                    ready: { type: 'boolean', required: true },
                    lastError: { type: 'string' },
                  },
                },
              },
            },
          },
          render: (_args, value) => [{
            type: 'text',
            text: [
              `anyReady=${String(value.anyReady)}`,
              `settingsNamespace=${value.settingsRegistered ? 'registered' : 'NOT registered'}${value.settingsValues ? ` ${value.settingsValues}` : ''}`,
              `target=${value.targetSessionName ?? '(none)'}${value.targetWorkspace ? ` — ${value.targetWorkspace}` : ''}`,
              `targetId=${value.targetSessionId ?? '(none)'}${value.targetRunning === undefined ? '' : ` running=${String(value.targetRunning)}`}`,
              ...(value.otherLiveSessions ?? []).map((s) =>
                `otherLive=${s.name}${s.workspace ? ` — ${s.workspace}` : ''} (${s.id})`),
              `sent=${value.sentCount} received=${value.receivedCount} forwarded=${value.forwardedCount}`,
              ...value.transports.map((t) =>
                `- ${t.id} (${t.label}): ${t.ready ? 'ready' : `${t.state} · NOT ready`}${t.lastError ? ` — ${t.lastError}` : ''}`),
            ].join('\n'),
          }],
        },
        async execute() {
          for (const channel of channels) await channel.refreshStatus?.()
          const target = resolveTargetSession()
          const described = await describeSession(target)
          const others = liveSessions()
            .filter((agent) => agent.id !== target)
            .map((agent) => ({
              id: agent.id,
              name: liveSessionTitle(agent) ?? basename(agent.session?.header?.cwd) ?? '未命名会话',
              ...(agent.session?.header?.cwd ? { workspace: String(agent.session.header.cwd) } : {}),
            }))
          return {
            anyReady: anyReady(),
            settingsRegistered: settingsScope !== null,
            ...(settingsScope !== null
              ? { settingsValues: JSON.stringify(settingsScope.get() ?? null) }
              : {}),
            ...(target !== undefined ? { targetSessionId: String(target) } : {}),
            ...(described !== null ? { targetSessionName: sessionLabel(described) } : {}),
            ...(described?.cwd ? { targetWorkspace: String(described.cwd) } : {}),
            ...(described?.live === true ? { targetRunning: described.status === 'running' } : {}),
            ...(others.length > 0 ? { otherLiveSessions: others } : {}),
            sentCount: state.sentCount,
            receivedCount: state.receivedCount,
            forwardedCount: state.forwardedCount,
            transports: channels.map((channel) => {
              const snapshot = channel.statusSync()
              const on = channelOn(channel)
              return {
                id: snapshot.id,
                label: snapshot.label,
                state: on ? snapshot.state : 'disabled',
                ready: on && snapshot.ready,
                ...(snapshot.detail?.lastError ? { lastError: String(snapshot.detail.lastError) } : {}),
              }
            }),
          }
        },
      }))
    } catch (error) {
      logger.warn(`failed to register remote tools: ${describeError(error)}`)
    }
  })

  logger.info(
    `remote-channel loaded (build=${BUILD_ID}, enabled=${String(state.enabled)}, transports=${channels.map((c) => c.id).join(',') || 'none'}, prefix=${JSON.stringify(config.commandPrefix)})`,
  )
}
