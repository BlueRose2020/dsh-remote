/**
 * End-to-end test of the `onebot` transport against a mock OneBot 11 server.
 *
 * Covers the whole remote-control surface without needing NapCatQQ:
 *   - connect, action echo, `get_login_info`, single-friend auto-targeting
 *   - built-ins: #status #help #stop #sessions #ws #new #use #shot
 *   - plain text forwarded to the session as a prompt
 *   - the turn-end report pushed back to the chat
 *   - prefix filtering and group-allowlist filtering
 *
 * Usage: node tools/onebot-e2e.mjs [--port 30099]
 */
import { WebSocketServer } from 'ws'
import { apply, Config, COMMAND_WORDS } from '../lib/index.js'
import { listMonitors } from '../lib/desktop.js'
import { createFakeContext, sleep } from './fake-ctx.mjs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repository root, for the static drift check on the command table. */
const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const portArg = process.argv.indexOf('--port')
const PORT = portArg >= 0 ? Number(process.argv[portArg + 1]) : 30099
const SELF_ID = 10001
const FRIEND_ID = 20002
const SESSION_A = 'session-aaaaaaaa-1111'
const SESSION_B = 'session-bbbbbbbb-2222'
const SESSION_CLOSED = 'session-dddddddd-4444'
/** A closed branch: forked from A, so it must nest under it in `#tree`. */
const SESSION_FORK = 'session-ffffffff-6666'
/** Only reachable through an explicit `#use`; its cwd is a temp directory. */
const SESSION_TMP = 'session-eeeeeeee-5555'
/** Sessions attached to a project at runtime by `#new` / `#ws fix`. */
const ATTACHED = []
const WORKSPACES = [
  {
    id: 'ws-1',
    path: 'D:\\proj\\alpha',
    title: 'alpha',
    sessionIds: [],
    /** The real records validate the session header's cwd before attaching. */
    async attachSession(sessionId) {
      if (this.sessionIds.includes(sessionId)) return
      this.sessionIds.push(sessionId)
      ATTACHED.push({ workspaceId: this.id, sessionId })
    },
  },
  {
    id: 'ws-2',
    path: 'D:\\proj\\beta',
    title: 'beta',
    sessionIds: [],
    async attachSession(sessionId) {
      if (this.sessionIds.includes(sessionId)) return
      this.sessionIds.push(sessionId)
      ATTACHED.push({ workspaceId: this.id, sessionId })
    },
  },
]

const failures = []
function check(label, condition, detail = '') {
  const mark = condition ? 'PASS' : 'FAIL'
  if (!condition) failures.push(label)
  process.stderr.write(`${mark}  ${label}${detail ? ` — ${detail}` : ''}\n`)
}

/** Minimal OneBot 11 server: echoes actions, records sends, injects events. */
function startMockServer() {
  const sockets = new Set()
  const sent = []
  const actions = []
  const fileActions = []
  /** Path the mock answers `get_file` with; set by the attachment test. */
  let sourceFile = null
  const wss = new WebSocketServer({ port: PORT })

  wss.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('message', (raw) => {
      let frame
      try {
        frame = JSON.parse(String(raw))
      } catch {
        return
      }
      actions.push(frame.action)
      const reply = (data) => socket.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: frame.echo }))
      switch (frame.action) {
        case 'get_login_info':
          reply({ user_id: SELF_ID, nickname: 'tester' })
          break
        case 'get_friend_list':
          // Exactly one friend: the plugin must adopt it without configuration.
          reply([{ user_id: FRIEND_ID, nickname: 'me', remark: '' }])
          break
        case 'send_private_msg':
          sent.push(frame.params)
          reply({ message_id: sent.length })
          break
        case 'send_group_msg':
          reply({ message_id: sent.length })
          break
        case 'get_file':
        case 'get_image':
          // NapCat hands back a local path for files; the plugin must copy it.
          fileActions.push(frame.action)
          reply({ file: sourceFile ?? '' })
          break
        default:
          reply({})
      }
    })
  })

  return {
    sent,
    actions,
    fileActions,
    get sourceFile() { return sourceFile },
    set sourceFile(value) { sourceFile = value },
    inject(event) {
      const frame = JSON.stringify({
        post_type: 'message',
        self_id: SELF_ID,
        time: Math.floor(Date.now() / 1000),
        message_id: Math.floor(Math.random() * 1e6),
        ...event,
      })
      for (const socket of sockets) socket.send(frame)
    },
    async close() {
      for (const socket of sockets) socket.terminate()
      await new Promise((resolve) => wss.close(resolve))
    },
    get connections() {
      return sockets.size
    },
  }
}

function privateMessage(text) {
  return {
    message_type: 'private',
    sub_type: 'friend',
    user_id: FRIEND_ID,
    sender: { user_id: FRIEND_ID, nickname: 'me' },
    message: [{ type: 'text', data: { text } }],
    raw_message: text,
  }
}

/** Flatten whatever the plugin sent into comparable text. */
function sentText(params) {
  const segments = Array.isArray(params?.message) ? params.message : []
  if (typeof params?.message === 'string') return params.message
  return segments.map((s) => (s.type === 'text' ? s.data.text : `[${s.type}]`)).join('')
}

function lastSent(server) {
  return server.sent.at(-1)
}

async function main() {
  const server = startMockServer()
  await sleep(200)
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-wechat-state-'))
  const stateFile = join(stateDir, 'state.json')
  const debugFile = join(stateDir, 'debug.jsonl')
  const prompts = []
  const promptModes = []
  /** Which session each forwarded prompt went to (the `#reply` assertions). */
  const promptTargets = []
  const renames = []
  const permissionSets = []
  const workspaceRenames = []
  const created = []
  /** Workspaces the plugin registered at runtime (through `#ws`/`#ws new`). */
  const createdWorkspaces = []
  /** Which workspace each created session was attached to. */
  const attached = ATTACHED
  const sections = []
  /** Settings namespaces the plugin registered (the page's source of truth). */
  const settingsRegistered = []
  /** The live settings document, as the Host would hold it. */
  const settingsValues = {}
  const settingsWatchers = []
  const settingsWrites = []
  const settingsScope = {
    get: () => ({ ...settingsValues }),
    update: async (patch) => {
      settingsWrites.push(patch)
      Object.assign(settingsValues, patch)
      for (const watcher of settingsWatchers) await watcher({ ...settingsValues })
      return { ...settingsValues }
    },
    watch: (watcher) => {
      settingsWatchers.push(watcher)
      return () => {}
    },
  }
  let cancelCalled = false
  let rejectSteer = false

  const config = Config({
    transports: ['onebot'],
    onebot: {
      url: `ws://127.0.0.1:${PORT}`,
      ownerId: '',            // empty on purpose: single-friend discovery must fill it
      acceptSelfMessages: true,
      groupAllowFrom: ['999999'],
    },
    replyAcks: true,
    reportOnTurnEnd: true,
    announceOnReady: false,
    progressEveryToolCalls: 2,
    // Informational replies default to a rendered PNG card; this suite asserts on
    // text, so it starts in text mode and exercises the card path explicitly.
    imageReplies: false,
    // Stands in for the settings secret. The settings *provider* below is a real
    // (if tiny) one, so this is the fallback rather than the only source.
    fullAccessPassword: 'hunter2',
    // Keep downloaded attachments inside the test's own temp tree.
    downloadsDir: join(stateDir, 'downloads'),
    // This suite fires a few dozen commands back to back; the flood guard has
    // its own suite (tools/ratelimit-check.mjs) and must not throttle it here.
    maxCommandsPerMinute: 0,
    stateFile,
    debugLog: debugFile,
    // YAML parses a bare `off` as boolean false, so the fixture uses that exact
    // shape: `false` must mean "password only for permissions", not a failure.
    accessGate: false,
    // One extra working mode, so `#mode` has something real to switch to. Its
    // command list is short on purpose: a restricted mode is the whole point.
    // It also carries a form and a prompt template, which is what the config page
    // and the system-prompt injection are built on.
    modes: [
      {
        name: 'focus',
        label: '专注',
        description: '只看状态和会话，别的命令都关掉',
        commands: ['status', 'sessions', 'help', 'mode'],
        fields: [
          { key: 'persona', label: '人设', type: 'text', default: '默认人设' },
          { key: 'tone', label: '语气', type: 'select', options: ['冷静', '热情'], default: '冷静' },
        ],
        prompt: '人格设定：{{persona}}（语气：{{tone}}）',
      },
    ],
  })
  check('nested onebot defaults resolve', config.onebot.reconnectMs === 5000)
  check('report defaults on', config.reportOnTurnEnd === true)
  check('reportOnlyRemoteTurns defaults on', config.reportOnlyRemoteTurns === true)
  check('a configured working mode parses with its optional fields left out',
    config.modes.length === 1 && config.modes[0].imageReplies === undefined,
    JSON.stringify(config.modes))

  const agentA = {
    id: SESSION_A,
    // Real SessionEvent shape: the payload lives under `data`, with seq/time on
    // the envelope. Encoding this correctly is what keeps a report regression
    // from hiding behind a passing test.
    session: {
      header: { cwd: 'D:\\proj\\alpha' },
      snapshotEvents: () => [
        { type: 'user/message', seq: 0, time: 1, data: { message: { role: 'user', content: [] } } },
        {
          type: 'assistant/message',
          seq: 1,
          time: 2,
          data: {
            turn: 2,
            step: 0,
            message: { role: 'assistant', content: [{ type: 'text', text: '第一步做完了，等你确认。' }] },
          },
        },
      ],
    },
    cancel: () => { cancelCalled = true },
  }
  const agentB = {
    id: SESSION_B,
    session: { header: { cwd: 'D:\\proj\\beta' }, snapshotEvents: () => [] },
    cancel: () => {},
  }
  // A session whose workspace lives INSIDE the test's temp directory, so
  // `#ws new <名字>` (which creates a sibling of the current workspace) can be
  // exercised for real without writing anywhere near the operator's disk.
  // Deliberately absent from `roots()`: it must not change what "auto" targets.
  const TMP_CWD = join(stateDir, 'proj-tmp')
  mkdirSync(TMP_CWD, { recursive: true })
  const agentTmp = {
    id: SESSION_TMP,
    session: { header: { cwd: TMP_CWD }, snapshotEvents: () => [] },
    cancel: () => {},
  }

  const fake = createFakeContext({
    services: {
      /**
       * A real (if tiny) settings provider.
       *
       * The plugin registers a namespace, reads it back, watches it and writes
       * mirrors into it — and so does the browser half. Faking it here is what
       * lets the suite prove the two directions of that channel: `#use` reaching
       * the page, and the page's `pinSessionId` / `modeData` reaching the host.
       */
      settings: {
        register: (namespace) => {
          settingsRegistered.push(namespace)
          return settingsScope
        },
      },
      agents: {
        roots: () => [agentA, agentB],
        get: (id) => [agentA, agentB, agentTmp].find((a) => a.id === id),
      },
      sessionController: {
        prompt: async (request) => {
          // `steer` needs a live turn; the Host refuses it when there is none,
          // which this flag reproduces so the queue fallback is covered too.
          if (rejectSteer && request.mode === 'steer') {
            throw new Error('steer unavailable: no running turn')
          }
          prompts.push(request.content.map((p) => p.text).join(''))
          promptModes.push(request.mode)
          promptTargets.push(request.sessionId)
          return { accepted: true }
        },
        rename: async (request) => {
          renames.push(request)
          return { title: request.title, seq: 1 }
        },
        /**
         * The real controller resolves `workspaceId` to its path and then calls
         * `workspace.attachSession(sessionId)` — membership is ONLY granted on
         * this path. Mirroring that is what lets a test catch "the session was
         * created in the right directory but landed in 未分组".
         */
        create: async (request) => {
          created.push(request)
          const workspace = request.workspaceId === undefined
            ? undefined
            : [...WORKSPACES, ...createdWorkspaces].find((w) => w.id === request.workspaceId)
          if (request.workspaceId !== undefined && workspace === undefined) {
            throw new Error(`workspace "${request.workspaceId}" not found`)
          }
          if (workspace !== undefined) attached.push({ workspaceId: workspace.id, path: workspace.path })
          return { sessionId: 'session-cccccccc-3333' }
        },
        // Real `SessionSummary` shape, including one session that is persisted
        // but has no live agent — the post-restart case. `updatedAt` is epoch ms
        // (as the Host sends it) so the recency column has something real to say.
        list: async () => ({
          items: [
            { sessionId: SESSION_A, updatedAt: Date.now() - 60_000, running: true, blank: false, cwd: 'D:\\proj\\alpha' },
            { sessionId: SESSION_B, updatedAt: Date.now() - 4 * 60_000, running: true, blank: false, cwd: 'D:\\proj\\beta' },
            { sessionId: SESSION_CLOSED, updatedAt: Date.now() - 5 * 60_000, running: false, blank: false, cwd: 'D:\\proj\\gamma' },
            { sessionId: SESSION_TMP, updatedAt: Date.now() - 30 * 60_000, running: true, blank: false, cwd: join(stateDir, 'proj-tmp') },
            {
              sessionId: SESSION_FORK,
              updatedAt: Date.now() - 2 * 60 * 60_000,
              running: false,
              blank: false,
              parentSessionId: SESSION_A,
              cwd: 'D:\\proj\\alpha',
              projections: { values: { title: '分叉实验' } },
            },
          ],
        }),
      },
      workspaceRegistry: {
        list: () => [...WORKSPACES, ...createdWorkspaces],
        create: async (path) => {
          const made = { id: `ws-new-${createdWorkspaces.length + 1}`, path, title: path.split('\\').pop() }
          createdWorkspaces.push(made)
          return made
        },
      },
      permissionPresets: {
        names: ['read-only', 'workspace-write', 'danger-full-access'],
        current: () => 'read-only',
        resolve: (name) => ({
          sandbox: name,
          approval: name === 'danger-full-access' ? 'never' : 'always',
          name,
          description: name === 'danger-full-access'
            ? 'Full file access without approval prompts.'
            : name === 'workspace-write' ? 'Write inside the workspace.' : 'Read only.',
        }),
        optionOf: (name) => ({
          value: name,
          label: name === 'read-only' ? '只读' : name === 'workspace-write' ? '标准' : '完全权限',
        }),
        set: (session, name) => { permissionSets.push({ sessionId: session?.id, name }) },
      },
      workspaceController: {
        rename: async (request) => {
          workspaceRenames.push(request)
          return { workspace: { id: request.workspaceId, path: 'D:\\proj\\beta', title: request.title } }
        },
      },
      systemPrompt: {
        section: (section) => {
          sections.push(section)
          return () => {}
        },
        getSectionOrder: () => 550,
      },
    },
  })

  apply(fake.ctx, config)
  await sleep(1200)
  check('mock server has a connection', server.connections === 1, `connections=${server.connections}`)
  check('login info queried', server.actions.includes('get_login_info'), server.actions.join(','))
  check('friend list queried', server.actions.includes('get_friend_list'))

  // --- `#again` with an empty history must answer, not go quiet. It runs before
  //     any other reply, because every answer becomes the `#again` target.
  server.inject(privateMessage('#again'))
  await sleep(900)
  check('#again with nothing to resend still answers',
    sentText(lastSent(server)).includes('还没有可重发的内容'),
    sentText(lastSent(server)).slice(0, 120))

  // --- the administrator password is asked for **only where permission is at
  //     stake**: switching to the danger preset. Ordinary commands are not gated,
  //     because the operator's own chat is not a hostile channel.
  server.inject(privateMessage('#status'))
  await sleep(1200)
  check('an ordinary command needs no password (the gate is off by default)',
    sentText(lastSent(server)).includes('DSH 状态'), sentText(lastSent(server)).slice(0, 120))
  check('#status says the password is only for full access',
    sentText(lastSent(server)).includes('只有完全权限要密码'), sentText(lastSent(server)).slice(-200))
  check('a YAML-style boolean off for accessGate is honoured, not rejected',
    config.accessGate === false, JSON.stringify(config.accessGate))

  // --- auto target from the single friend, with no ownerId configured
  server.inject(privateMessage('#status'))
  await sleep(900)
  check('single friend auto-targeted for the reply',
    lastSent(server)?.user_id === FRIEND_ID,
    JSON.stringify(lastSent(server)?.user_id))
  const statusReply = sentText(lastSent(server))
  process.stderr.write(`---- #status reply ----\n${statusReply}\n-----------------------\n`)
  // Replies name sessions by workspace, never by raw id — a bare
  // `session-4cd98f30` tells a phone reader nothing.
  check('#status names the target session instead of its id',
    statusReply.includes('beta') && !statusReply.includes(SESSION_B.slice(0, 12)),
    statusReply.slice(0, 200))
  check('#status names the session and its workspace',
    statusReply.includes('D:\\proj\\beta') && statusReply.includes('beta'),
    statusReply.slice(0, 200))
  check('#status reports who may send commands',
    sentText(lastSent(server)).includes(`可发指令者`) && sentText(lastSent(server)).includes(String(FRIEND_ID)),
    sentText(lastSent(server)).slice(0, 240))

  // --- #again hands the previous answer back, in one message, with a tag that
  //     says it is a resend (text mode) so it cannot read as a duplicate
  server.inject(privateMessage('#again'))
  await sleep(800)
  const againReply = sentText(lastSent(server))
  check('#again re-sends the previous answer',
    againReply.includes('D:\\proj\\beta') && againReply.includes('beta'),
    againReply.slice(0, 200))
  check('#again marks the resend so it cannot look like a duplicate',
    againReply.includes('重发'),
    againReply.slice(-80))
  check('#again does not address the operator by raw session id',
    !againReply.includes(SESSION_B.slice(0, 12)),
    againReply.slice(0, 200))
  // The tag must not accumulate: the resend itself becomes the new history entry
  // only in its original form.
  server.inject(privateMessage('#again'))
  await sleep(800)
  check('#again stays stable when repeated',
    sentText(lastSent(server)).includes('D:\\proj\\beta')
      && sentText(lastSent(server)).split('（重发 ·').length === 2,
    sentText(lastSent(server)).slice(-120))

  // --- a stranger must not be able to drive the machine: the single friend
  //     becomes the effective allowlist even though privateAllowFrom is empty
  const beforeStranger = prompts.length
  const beforeStrangerSent = server.sent.length
  server.inject({
    message_type: 'private',
    sub_type: 'friend',
    user_id: 30003,
    sender: { user_id: 30003, nickname: 'stranger' },
    message: [{ type: 'text', data: { text: '#status' } }],
    raw_message: '#status',
  })
  await sleep(800)
  check('command from a non-allowlisted sender ignored',
    prompts.length === beforeStranger && server.sent.length === beforeStrangerSent,
    `prompts=${prompts.length} sent=${server.sent.length}`)

  // --- #sessions
  server.inject(privateMessage('#sessions'))
  await sleep(800)
  let text = sentText(lastSent(server))
  check('#sessions lists both sessions by name',
    text.includes('alpha') && text.includes('beta') && !text.includes(SESSION_A.slice(0, 12)),
    text.slice(0, 200))

  // --- #use switches the target
  server.inject(privateMessage('#use 1'))
  await sleep(800)
  check('#use acknowledged', sentText(lastSent(server)).includes('已切换到'))
  check('#use changed the target', sentText(lastSent(server)).includes('alpha'), sentText(lastSent(server)).slice(0, 160))

  // --- by name, which is what a phone can actually type
  server.inject(privateMessage('#use beta'))
  await sleep(800)
  check('#use <名字> switches by session name',
    sentText(lastSent(server)).includes('已切换到') && sentText(lastSent(server)).includes('beta'),
    sentText(lastSent(server)).slice(0, 160))
  server.inject(privateMessage('#use 1'))
  await sleep(700)

  // --- #ws lists workspaces
  server.inject(privateMessage('#ws'))
  await sleep(800)
  text = sentText(lastSent(server))
  check('#ws lists workspaces', text.includes('alpha') && text.includes('beta'), text.slice(0, 140))

  // --- #ws <n> pins a workspace
  server.inject(privateMessage('#ws 2'))
  await sleep(700)
  check('#ws <n> pins a workspace', sentText(lastSent(server)).includes('beta'))

  // --- #ws <名字>: nobody types a full path on a phone
  server.inject(privateMessage('#ws alpha'))
  await sleep(700)
  check('#ws <名字> pins a workspace by its title',
    sentText(lastSent(server)).includes('alpha') && sentText(lastSent(server)).includes('D:\\proj\\alpha'),
    sentText(lastSent(server)).slice(0, 160))
  server.inject(privateMessage('#ws bet'))
  await sleep(700)
  check('#ws <名字片段> matches a unique partial name',
    sentText(lastSent(server)).includes('beta'), sentText(lastSent(server)).slice(0, 140))
  // A name that matches nothing must NOT be turned into a directory: that is how
  // a typo becomes a stray folder next to the server's working directory.
  const strayName = 'zzz-no-such-workspace'
  server.inject(privateMessage(`#ws ${strayName}`))
  await sleep(700)
  check('#ws <不像路径的名字> is refused instead of created',
    !existsSync(join(process.cwd(), strayName)) && sentText(lastSent(server)).includes('没有找到工作区'),
    sentText(lastSent(server)).slice(0, 160))
  // A real path still creates the directory (`#ws` doubles as "make me one").
  const freshPath = join(stateDir, 'by-path-ws')
  server.inject(privateMessage(`#ws ${freshPath}`))
  await sleep(800)
  check('#ws <路径> still creates a missing directory', existsSync(freshPath), freshPath)
  server.inject(privateMessage('#ws 2'))
  await sleep(700)

  // --- #new creates a session in the pinned workspace, and — the part that used
  //     to be wrong — creates it *through* the workspace so the Host attaches it
  //     to that group instead of leaving it in 未分组.
  server.inject(privateMessage('#new'))
  await sleep(900)
  check('#new creates the session through the pinned workspace',
    created.length === 1 && created[0].workspaceId === 'ws-2',
    JSON.stringify(created))
  check('#new does not settle for a bare cwd (that is the 未分组 bug)',
    created[0].cwd === undefined, JSON.stringify(created[0]))
  check('#new reports the workspace it landed in',
    sentText(lastSent(server)).includes('工作区：beta'),
    sentText(lastSent(server)).slice(0, 200))
  check('#new switched the target', sentText(lastSent(server)).includes('已新建会话'), sentText(lastSent(server)).slice(0, 160))

  // --- #ws fix: a session whose directory is already a project but which was
  //     never attached shows up as 未分组; the repair path attaches it. (The
  //     fixture lists SESSION_A as living in alpha without being a member.)
  server.inject(privateMessage('#ws'))
  await sleep(1500)
  check('#ws notices sessions that belong in a workspace but are ungrouped',
    sentText(lastSent(server)).includes('未分组') && sentText(lastSent(server)).includes('#ws fix'),
    sentText(lastSent(server)).slice(-220))
  server.inject(privateMessage('#ws fix'))
  await sleep(1800)
  const fixed = sentText(lastSent(server))
  check('#ws fix attaches them',
    fixed.includes('已挂回') && attached.some((entry) => entry.workspaceId === 'ws-1'),
    `${fixed.slice(0, 160)} | ${JSON.stringify(attached.slice(-2))}`)
  server.inject(privateMessage('#ws fix'))
  await sleep(1500)
  check('#ws fix is idempotent (nothing left to do the second time)',
    sentText(lastSent(server)).includes('没有需要整理'), sentText(lastSent(server)).slice(0, 160))

  // --- forwarding to the (now pinned) session
  const before = prompts.length
  server.inject(privateMessage('继续把剩下的投完'))
  await sleep(900)
  check('plain text without a prefix is forwarded as a prompt', prompts.slice(before).includes('继续把剩下的投完'), JSON.stringify(prompts))
  check('acknowledgement sent',
    /已(排队|插入)投递给/.test(sentText(lastSent(server))),
    sentText(lastSent(server)).slice(0, 160))

  // --- #shot delivers an image
  server.inject(privateMessage('#shot'))
  await sleep(9000)
  const shot = lastSent(server)
  const hasImage = Array.isArray(shot?.message) && shot.message.some((s) => s.type === 'image')
  check('#shot sent an image segment', hasImage, JSON.stringify(shot?.message?.[0]?.type))
  check('#shot defaults to the main screen',
    sentText(shot).includes('主屏'), sentText(shot).slice(0, 120))

  // --- screen selection: a persistent default plus one-off overrides. The
  //     machine's real monitor list decides which numbers exist, so every
  //     number-dependent check is guarded by what `listMonitors()` reports.
  const monitors = await listMonitors({ pythonPath: process.env.DSH_TEST_PYTHON ?? 'python' })
  check('the monitor probe finds this machine\'s displays', monitors.length >= 1,
    JSON.stringify(monitors))

  server.inject(privateMessage('#shot screen'))
  await sleep(1200)
  const screenList = sentText(lastSent(server))
  check('#shot screen shows the current default', screenList.includes('当前默认：主屏'), screenList.slice(0, 160))
  check('#shot screen lists the displays', screenList.includes('可用'), screenList.slice(0, 200))

  server.inject(privateMessage('#shot screen 全部'))
  await sleep(1000)
  check('#shot screen 全部 switches the default', sentText(lastSent(server)).includes('全部屏幕'),
    sentText(lastSent(server)).slice(0, 120))
  const persistedAfterScreen = JSON.parse(await readFile(stateFile, 'utf8'))
  check('the chosen screen survives a restart', persistedAfterScreen.shotMonitor === 'all',
    JSON.stringify(persistedAfterScreen.shotMonitor))

  server.inject(privateMessage('#shot'))
  await sleep(9000)
  check('a bare #shot uses the switched default', sentText(lastSent(server)).includes('全部屏幕'),
    sentText(lastSent(server)).slice(0, 120))

  server.inject(privateMessage('#shot 主屏'))
  await sleep(9000)
  check('#shot 主屏 is a one-off override', sentText(lastSent(server)).includes('主屏'),
    sentText(lastSent(server)).slice(0, 120))
  server.inject(privateMessage('#shot screen'))
  await sleep(1200)
  check('a one-off override does not change the default',
    sentText(lastSent(server)).includes('当前默认：全部屏幕'),
    sentText(lastSent(server)).slice(0, 160))

  if (monitors.length >= 2) {
    const second = monitors.find((m) => m.index === 2)
    server.inject(privateMessage('#shot screen 2'))
    await sleep(1000)
    check('#shot screen <序号> switches to that display',
      sentText(lastSent(server)).includes('第 2 个显示器'), sentText(lastSent(server)).slice(0, 120))
    server.inject(privateMessage('#shot'))
    await sleep(9000)
    const secondShot = sentText(lastSent(server))
    check('the numbered screen is really captured',
      secondShot.includes('第 2 个显示器') && secondShot.includes(`${second.width}×${second.height}`),
      secondShot.slice(0, 140))
  } else {
    process.stderr.write('SKIP  numbered-screen checks (this machine reports one display)\n')
  }

  server.inject(privateMessage('#shot screen 9'))
  await sleep(9000)
  check('#shot screen <不存在的序号> explains instead of failing silently',
    sentText(lastSent(server)).includes('没有第 9 个显示器'),
    sentText(lastSent(server)).slice(0, 160))

  server.inject(privateMessage('#shot screen 主屏'))
  await sleep(1000)
  check('#shot screen 主屏 goes back to the main screen',
    sentText(lastSent(server)).includes('主屏'), sentText(lastSent(server)).slice(0, 120))

  // --- aim back at a live session: reports and #stop only apply to the target
  server.inject(privateMessage('#use 1'))
  await sleep(800)
  check('state persisted after #use', JSON.parse(await readFile(stateFile, 'utf8')).pinnedSessionId === SESSION_A)

  // This forward is what makes the next turn a *remote* turn, which is the only
  // kind that reports.
  server.inject(privateMessage('给这个会话派个活'))
  await sleep(900)
  check('second forward landed on the pinned session', prompts.at(-1) === '给这个会话派个活', JSON.stringify(prompts.at(-1)))

  // --- the agent is told it has a remote audience
  check('system-prompt sections registered (audience + working mode)',
    sections.length === 2
      && sections[0].name === 'remote-channel:audience'
      && sections[1].name === 'remote-channel:mode',
    JSON.stringify(sections.map((s) => s.name)))
  if (sections.length > 0) {
    const text = sections[0].text()
    check('awareness text mentions the reporting tools',
      text.includes('remote_notify') && text.includes('remote_screenshot'),
      text.slice(0, 100))
    check('awareness text mentions the command prefix', text.includes('#status'))
  }

  // --- mechanical progress ping while a remote turn is in flight
  const beforeProgress = server.sent.length
  await fake.fire('tools/result', { agent: agentA, name: 'pwsh' })
  await sleep(200)
  check('no progress ping before the threshold', server.sent.length === beforeProgress)
  await fake.fire('tools/result', { agent: agentA, name: 'read' })
  await sleep(900)
  check('progress ping at the threshold',
    sentText(lastSent(server)).includes('已执行 2 个工具调用'),
    sentText(lastSent(server)).slice(0, 120))

  // --- turn-end report: only turns this plugin started are reported
  const beforeReport = server.sent.length
  await fake.fire('agent/turn-stopping', { agent: agentA, turn: 2 })
  await sleep(1200)
  const report = server.sent.slice(beforeReport).map(sentText).join('\n')
  check('turn report pushed back for a remote turn', report.includes('第一步做完了'), report.slice(0, 160))

  // A second turn with no remote command behind it must stay silent.
  const beforeLocal = server.sent.length
  await fake.fire('agent/turn-stopping', { agent: agentA, turn: 3 })
  await sleep(900)
  check('local-only turn not reported', server.sent.length === beforeLocal,
    JSON.stringify(server.sent.slice(beforeLocal).map(sentText)))

  // --- ...unless the operator asked for every turn of the target session. This
  //     is the switch that makes a browser-started turn reach the phone too,
  //     instead of depending on the agent remembering `remote_notify`.
  config.reportOnlyRemoteTurns = false
  const beforeEveryTurn = server.sent.length
  await fake.fire('agent/turn-stopping', { agent: agentA, turn: 4 })
  await sleep(3000)
  const everyTurn = server.sent.slice(beforeEveryTurn).map(sentText).join('\n')
  check('with reportOnlyRemoteTurns off, a browser-started turn is reported too',
    everyTurn.includes('第一步做完了'), everyTurn.slice(0, 160))
  check('the report names the workspace and the session',
    everyTurn.includes('alpha'), everyTurn.slice(0, 160))
  config.reportOnlyRemoteTurns = true
  await sleep(300)

  // --- a non-target session must not be reported
  const beforeOther = server.sent.length
  await fake.fire('agent/turn-stopping', { agent: agentB, turn: 1 })
  await sleep(900)
  check('non-target session not reported', server.sent.length === beforeOther)

  // --- prefixes distinguish built-in controls from ordinary conversation
  const beforePrefix = server.sent.length
  const beforePrompts = prompts.length
  server.inject(privateMessage('status'))
  await sleep(700)
  check('bare text is forwarded even when it resembles a built-in command',
    prompts.length === beforePrompts + 1 && prompts.at(-1) === 'status', JSON.stringify(prompts.slice(beforePrompts)))
  check('bare text receives the normal delivery acknowledgement, not command output',
    server.sent.length === beforePrefix + 1 && /已(排队|插入)投递给/.test(sentText(lastSent(server))),
    JSON.stringify(server.sent.slice(beforePrefix).map(sentText)))

  // --- group allowlist
  const beforeGroupPrompts = prompts.length
  server.inject({
    message_type: 'group',
    sub_type: 'normal',
    group_id: 123456,
    user_id: FRIEND_ID,
    sender: { user_id: FRIEND_ID, nickname: 'me' },
    message: [{ type: 'text', data: { text: '#status' } }],
    raw_message: '#status',
  })
  await sleep(700)
  check('non-allowlisted group ignored', prompts.length === beforeGroupPrompts)

  // --- #stop
  server.inject(privateMessage('#stop'))
  await sleep(800)
  check('#stop cancels the agent', cancelCalled)

  // --- prefix that should never have been run: plain ping
  server.inject(privateMessage('#help'))
  await sleep(800)
  check('#help mentions the workspace commands', sentText(lastSent(server)).includes('工作区'))
  check('#help mentions #clear', sentText(lastSent(server)).includes('clear'))
  // Every row carries its own shorthand, so the card can render command | 短写 |
  // 说明 without a separate lookup line.
  check('#help pairs each command with its shorthand',
    sentText(lastSent(server)).includes('#status') && sentText(lastSent(server)).includes('#s')
      && sentText(lastSent(server)).includes('#sessions') && sentText(lastSent(server)).includes('#ls'),
    sentText(lastSent(server)).slice(0, 200))
  check('#help keeps Chinese out of the command tokens (ASCII placeholders only)',
    !/#[^\s#]*[\u4e00-\u9fff]/.test(sentText(lastSent(server))),
    (sentText(lastSent(server)).match(/#[^\s#]*[\u4e00-\u9fff]/g) ?? []).slice(0, 3).join(','))

  // --- a persisted-but-closed session can still be re-attached and prompted
  server.inject(privateMessage('#sessions'))
  await sleep(900)
  text = sentText(lastSent(server))
  check('#sessions lists the closed session and marks it',
    text.includes('gamma') && text.includes('已关闭') && !text.includes(SESSION_CLOSED.slice(0, 12)),
    text.slice(0, 300))

  server.inject(privateMessage('#use 3'))
  await sleep(800)
  check('#use can pin a closed session',
    sentText(lastSent(server)).includes('gamma'),
    sentText(lastSent(server)).slice(0, 160))

  server.inject(privateMessage('#status'))
  await sleep(900)
  check('#status says the session will be resumed on demand',
    sentText(lastSent(server)).includes('自动恢复'),
    sentText(lastSent(server)).slice(0, 240))

  const beforeResume = prompts.length
  server.inject(privateMessage('#恢复之后继续干活'))
  await sleep(900)
  check('forwarding to a closed session still prompts it',
    prompts.slice(beforeResume).includes('恢复之后继续干活'),
    JSON.stringify(prompts.slice(beforeResume)))

  // --- on/off switches (this fixture runs a single transport: onebot)
  server.inject(privateMessage('#channels'))
  await sleep(800)
  text = sentText(lastSent(server))
  check('#channels lists the running transport', text.includes('onebot'), text.slice(0, 200))
  check('#channels shows the master switch', text.includes('总开关'), text.slice(0, 120))

  // Turning off the transport the command arrived on must be refused.
  server.inject(privateMessage('#switch qq off'))
  await sleep(800)
  check('refuses to switch off the transport in use',
    sentText(lastSent(server)).includes('联系不上'),
    sentText(lastSent(server)).slice(0, 200))
  check('...and did not actually stop it', server.connections === 1, `connections=${server.connections}`)

  // An unknown transport is answered with usage, not a silent no-op.
  server.inject(privateMessage('#switch wechat off'))
  await sleep(800)
  check('unknown transport falls back to usage',
    sentText(lastSent(server)).includes('用法'),
    sentText(lastSent(server)).slice(0, 160))

  // Master switch: stops forwarding but keeps answering control commands.
  server.inject(privateMessage('#off'))
  await sleep(800)
  check('#off explains that the channel stays reachable',
    sentText(lastSent(server)).includes('#on'),
    sentText(lastSent(server)).slice(0, 240))
  const beforeQuiet = prompts.length
  server.inject(privateMessage('这条不该被转发'))
  await sleep(900)
  check('#off stops forwarding', prompts.length === beforeQuiet, JSON.stringify(prompts.slice(beforeQuiet)))
  server.inject(privateMessage('#status'))
  await sleep(900)
  check('#status still answers while off',
    sentText(lastSent(server)).includes('关闭状态'),
    sentText(lastSent(server)).slice(0, 160))
  server.inject(privateMessage('#on'))
  await sleep(800)
  server.inject(privateMessage('重新打开之后要能派活'))
  await sleep(900)
  check('#on resumes forwarding',
    prompts.slice(beforeQuiet).includes('重新打开之后要能派活'),
    JSON.stringify(prompts.slice(beforeQuiet)))

  // --- reply format (#img) and delivery mode (#deliver)
  server.inject(privateMessage('#img on'))
  await sleep(700)
  check('#img on acknowledges the switch',
    sentText(lastSent(server)).includes('图片卡片'),
    sentText(lastSent(server)).slice(0, 160))

  const beforeCard = server.sent.length
  server.inject(privateMessage('#status'))
  await sleep(2500)
  const card = lastSent(server)
  const hasCardImage = Array.isArray(card?.message) && card.message.some((segment) => segment.type === 'image')
  check('#status answers with a rendered image',
    hasCardImage && server.sent.length > beforeCard,
    JSON.stringify(card?.message?.[0]?.type))

  server.inject(privateMessage('#img off'))
  await sleep(700)
  check('#img off returns to text',
    sentText(lastSent(server)).includes('纯文字'),
    sentText(lastSent(server)).slice(0, 160))

  // --- working modes: a named bundle of behaviour + a command surface
  server.inject(privateMessage('#mode list'))
  await sleep(700)
  check('#mode list names every mode and marks the current one',
    sentText(lastSent(server)).includes('focus') && sentText(lastSent(server)).includes('专注')
      && sentText(lastSent(server)).includes('当前'),
    sentText(lastSent(server)).slice(0, 200))
  server.inject(privateMessage('#mode focus'))
  await sleep(700)
  check('#mode switches to a configured mode',
    sentText(lastSent(server)).includes('专注') && sentText(lastSent(server)).includes('已切到模式'),
    sentText(lastSent(server)).slice(0, 200))
  check('#status reports the mode it is really in',
    sentText(lastSent(server)).includes('专注'),
    sentText(lastSent(server)).slice(0, 200))

  const beforeRefusal = server.sent.length
  server.inject(privateMessage('#shot'))
  await sleep(800)
  check('a restricted mode refuses a command outside its list',
    sentText(lastSent(server)).includes('没有这条命令'), sentText(lastSent(server)).slice(0, 200))
  check('the refusal names what is available instead',
    sentText(lastSent(server)).includes('#status'), sentText(lastSent(server)).slice(0, 200))
  check('the refused command really did not run',
    server.sent.length > beforeRefusal
      && !sentText(lastSent(server)).includes('[image]'),
    sentText(lastSent(server)).slice(0, 120))

  // A restricted mode must not swallow prose: it exists to *narrow commands*,
  // not to stop the operator from talking to the session.
  const beforeProse = prompts.length
  server.inject(privateMessage('专注模式下还能说话吗'))
  await sleep(900)
  check('a restricted mode still forwards prose to the session',
    prompts.slice(beforeProse).includes('专注模式下还能说话吗'),
    JSON.stringify(prompts.slice(beforeProse)))

  server.inject(privateMessage('#mode default'))
  await sleep(700)
  check('#mode default restores every command',
    sentText(lastSent(server)).includes('工作'), sentText(lastSent(server)).slice(0, 160))
  server.inject(privateMessage('#mode nope'))
  await sleep(700)
  check('an unknown mode is refused with the list',
    sentText(lastSent(server)).includes('没有这个模式'), sentText(lastSent(server)).slice(0, 160))

  // --- the config page's two write paths, exercised through the settings service
  check('the plugin registered its settings namespace',
    settingsRegistered.includes('remote-channel'), JSON.stringify(settingsRegistered))
  check('the mode schema reaches the page as JSON, fields and all',
    (() => {
      try {
        const focus = JSON.parse(settingsValues.modeSchema ?? '[]').find((mode) => mode.name === 'focus')
        return focus !== undefined && focus.fields.length === 2 && focus.hasPrompt === true
      } catch {
        return false
      }
    })(), String(settingsValues.modeSchema ?? '').slice(0, 200))
  // Clicking a node in the web tree writes this field; the chat must follow.
  await settingsScope.update({ pinSessionId: SESSION_B })
  await sleep(600)
  server.inject(privateMessage('#status'))
  await sleep(1100)
  check('a pin written by the web page moves the remote target',
    sentText(lastSent(server)).includes('beta'), sentText(lastSent(server)).slice(0, 160))
  // …and a pin made in the chat travels the other way, so the tree can show which
  // session is current without asking the host for anything.
  server.inject(privateMessage('#use 1'))
  await sleep(900)
  check('the chat mirrors its own target back for the page',
    typeof settingsValues.pinLabel === 'string' && settingsValues.pinLabel.includes('alpha'),
    String(settingsValues.pinLabel))
  // …and the mode's own form feeds the system prompt while that mode is active.
  await settingsScope.update({ modeData: JSON.stringify({ focus: { persona: '你是猫娘', tone: '热情' } }) })
  const modeSection = sections.find((section) => section.name === 'remote-channel:mode')
  check('the working mode has its own system-prompt section', modeSection !== undefined)
  check('the mode text is empty while the default mode is active',
    modeSection !== undefined && modeSection.text() === '', String(modeSection?.text()))
  server.inject(privateMessage('#mode focus'))
  await sleep(800)
  check('a mode injects its template with the form values filled in',
    String(modeSection?.text()).includes('你是猫娘') && String(modeSection?.text()).includes('热情'),
    String(modeSection?.text()))
  await settingsScope.update({ modeData: JSON.stringify({ focus: { persona: '换个说法' } }) })
  check('editing the form changes the injected text without a restart',
    String(modeSection?.text()).includes('换个说法') && String(modeSection?.text()).includes('冷静'),
    String(modeSection?.text()))
  server.inject(privateMessage('#mode default'))
  await sleep(700)
  check('switching away empties the mode section again',
    modeSection !== undefined && modeSection.text() === '', String(modeSection?.text()))
  server.inject(privateMessage('#use 1'))
  await sleep(700)

  server.inject(privateMessage('#deliver steer'))
  await sleep(700)
  check('#deliver steer acknowledges', sentText(lastSent(server)).includes('插入'), sentText(lastSent(server)).slice(0, 160))
  const beforeSteer = prompts.length
  server.inject(privateMessage('#用插入方式干活'))
  await sleep(900)
  check('#deliver steer reaches the session controller',
    promptModes.slice(beforeSteer).includes('steer'),
    JSON.stringify(promptModes.slice(beforeSteer)))
  check('#deliver steer is acknowledged as 插入',
    sentText(lastSent(server)).includes('插入投递'),
    sentText(lastSent(server)).slice(0, 160))

  // A refused steer falls back to queueing rather than losing the message.
  rejectSteer = true
  const beforeFallback = prompts.length
  server.inject(privateMessage('#插入失败就排队'))
  await sleep(900)
  rejectSteer = false
  check('a refused steer falls back to queue',
    prompts.slice(beforeFallback).includes('插入失败就排队')
      && promptModes.slice(beforeFallback).includes('queue'),
    JSON.stringify(promptModes.slice(beforeFallback)))
  check('the fallback is reported to the operator',
    sentText(lastSent(server)).includes('排队投递'),
    sentText(lastSent(server)).slice(0, 200))
  server.inject(privateMessage('#deliver queue'))
  await sleep(700)

  // --- #ws creates the workspace directory when it is missing
  const freshWorkspace = join(stateDir, 'fresh-workspace')
  check('the workspace directory does not exist yet', !existsSync(freshWorkspace))
  server.inject(privateMessage(`#ws ${freshWorkspace}`))
  await sleep(900)
  check('#ws creates a missing workspace directory', existsSync(freshWorkspace), freshWorkspace)
  check('#ws reports the creation',
    sentText(lastSent(server)).includes('已新建'),
    sentText(lastSent(server)).slice(0, 200))

  // --- permission presets, with the danger preset gated by a password
  // (needs a LIVE session: the preset service writes through the session object)
  server.inject(privateMessage('#use 2'))
  await sleep(800)
  server.inject(privateMessage('#perm'))
  await sleep(800)
  text = sentText(lastSent(server))
  check('#perm lists the presets', text.includes('只读') && text.includes('完全权限'), text.slice(0, 200))
  check('#perm says the password is configured', text.includes('密码已设置'), text.slice(0, 240))

  server.inject(privateMessage('#perm danger-full-access'))
  await sleep(800)
  check('#perm refuses the danger preset without a password',
    sentText(lastSent(server)).includes('密码不对') && permissionSets.length === 0,
    sentText(lastSent(server)).slice(0, 200))

  server.inject(privateMessage('#perm danger-full-access wrong-one'))
  await sleep(800)
  check('#perm refuses a wrong password', permissionSets.length === 0, JSON.stringify(permissionSets))

  server.inject(privateMessage('#perm danger-full-access hunter2'))
  await sleep(800)
  check('#perm applies the danger preset with the right password',
    permissionSets.length === 1 && permissionSets[0].name === 'danger-full-access',
    JSON.stringify(permissionSets))
  check('#perm names what it switched to',
    sentText(lastSent(server)).includes('完全权限'),
    sentText(lastSent(server)).slice(0, 200))

  server.inject(privateMessage('#perm read-only'))
  await sleep(800)
  check('#perm switches a safe preset without a password',
    permissionSets.length === 2 && permissionSets[1].name === 'read-only',
    JSON.stringify(permissionSets))

  // --- `r` / `w` / `f` shorthands, resolved against the advertised preset names
  server.inject(privateMessage('#perm w'))
  await sleep(800)
  check('#perm w picks the middle (write) preset',
    permissionSets.length === 3 && permissionSets[2].name === 'workspace-write',
    JSON.stringify(permissionSets))
  check('#perm w names the preset it picked',
    sentText(lastSent(server)).includes('标准'),
    sentText(lastSent(server)).slice(0, 160))

  server.inject(privateMessage('#perm r'))
  await sleep(800)
  check('#perm r is the read-only preset',
    permissionSets.length === 4 && permissionSets[3].name === 'read-only',
    JSON.stringify(permissionSets))

  server.inject(privateMessage('#perm f'))
  await sleep(800)
  check('#perm f still demands the password',
    permissionSets.length === 4 && sentText(lastSent(server)).includes('密码不对'),
    sentText(lastSent(server)).slice(0, 160))
  server.inject(privateMessage('#perm f hunter2'))
  await sleep(800)
  check('#perm f <密码> opens the danger preset',
    permissionSets.length === 5 && permissionSets[4].name === 'danger-full-access',
    JSON.stringify(permissionSets))
  server.inject(privateMessage('#perm read-only'))
  await sleep(700)

  // --- renaming a session and its workspace
  server.inject(privateMessage('#rename 投简历-新名字'))
  await sleep(800)
  check('#rename renames the target session',
    renames.length === 1 && renames[0].title === '投简历-新名字' && renames[0].sessionId === SESSION_B,
    JSON.stringify(renames))
  check('#rename confirms by name',
    sentText(lastSent(server)).includes('投简历-新名字'),
    sentText(lastSent(server)).slice(0, 160))

  server.inject(privateMessage('#rename ws 订单服务'))
  await sleep(800)
  check('#rename ws renames the workspace',
    workspaceRenames.length === 1 && workspaceRenames[0].title === '订单服务',
    JSON.stringify(workspaceRenames))

  // --- attachment capture: #file start → a file segment → #file end
  const downloadsDir = join(stateDir, 'downloads')
  const sourceFile = join(stateDir, 'source-简历.pdf')
  await writeFile(sourceFile, 'PDF-ish bytes for the attachment test', 'utf8')
  server.sourceFile = sourceFile
  const fileSegment = {
    message_type: 'private',
    sub_type: 'friend',
    user_id: FRIEND_ID,
    sender: { user_id: FRIEND_ID, nickname: 'me' },
    message: [{ type: 'file', data: { name: '简历.pdf', file: 'file-1', file_id: 'file-1' } }],
    raw_message: '[CQ:file]',
  }

  const beforeUncollected = server.sent.length
  server.inject(fileSegment)
  await sleep(900)
  check('a file outside a capture window is declined politely',
    sentText(lastSent(server)).includes('没在收集'),
    sentText(lastSent(server)).slice(0, 200))
  check('...and nothing was written', !existsSync(join(downloadsDir, new Date().toISOString().slice(0, 10))),
    downloadsDir)

  server.inject(privateMessage('#file start'))
  await sleep(800)
  check('#file start acknowledges', sentText(lastSent(server)).includes('开始收集'), sentText(lastSent(server)).slice(0, 200))

  server.inject(fileSegment)
  await sleep(1200)
  const day = new Date().toISOString().slice(0, 10)
  const savedDir = join(downloadsDir, day)
  const savedFiles = existsSync(savedDir) ? readdirSync(savedDir) : []
  check('the attachment landed on disk', savedFiles.length === 1, JSON.stringify(savedFiles))
  check('it kept a readable, non-colliding name',
    savedFiles[0]?.includes('简历.pdf') ?? false,
    JSON.stringify(savedFiles))
  check('the fetch went through get_file', server.fileActions.includes('get_file'), server.fileActions.join(','))
  check('#file start…file reports the received file',
    sentText(lastSent(server)).includes('简历.pdf'),
    sentText(lastSent(server)).slice(0, 200))

  // No terminator: the next instruction that reaches the session carries the files.
  const beforeFileEnd = prompts.length
  server.inject(privateMessage('把这份简历投了'))
  await sleep(1000)
  const delivered = prompts.slice(beforeFileEnd)
  check('the next instruction carries text and attachments in ONE prompt',
    delivered.length === 1
      && delivered[0].includes('把这份简历投了')
      && delivered[0].includes(savedDir)
      && delivered[0].includes('简历.pdf'),
    JSON.stringify(delivered).slice(0, 300))
  check('the ack names the session',
    /已(排队|插入)投递给/.test(sentText(lastSent(server))),
    sentText(lastSent(server)).slice(0, 200))
  check('the same file is not collected twice after the window closes',
    (() => {
      const count = existsSync(savedDir) ? readdirSync(savedDir).length : 0
      return count === 1
    })(),
    savedFiles.join(','))

  const toolNames = fake.registeredTools.map((t) => t.name)
  check('tools registered',
    toolNames.includes('remote_notify') && toolNames.includes('remote_status') && toolNames.includes('remote_screenshot'),
    toolNames.join(','))

  const notifyTool = fake.registeredTools.find((t) => t.name === 'remote_notify')
  if (notifyTool !== undefined) {
    const value = await notifyTool.execute({ text: '工具自检', headline: '自检' }, {})
    check('remote_notify delivered', value.sent === true, JSON.stringify(value))
  }

  // --- `#ws new`: create a workspace and pin it in one step. The bare-name form
  //     is the phone-friendly one ("start something next to this project"), and
  //     it resolves against the CURRENT workspace, so the target session first
  //     has to be the temp-cwd one (which is only reachable by an explicit #use,
  //     so it never disturbs what "auto" targets).
  server.inject(privateMessage('#use 4'))
  await sleep(800)
  check('#use can pin the temp-cwd session',
    sentText(lastSent(server)).includes('proj-tmp'),
    sentText(lastSent(server)).slice(0, 160))

  const siblingName = '新项目'
  const siblingPath = join(stateDir, siblingName)
  check('the sibling workspace does not exist yet', !existsSync(siblingPath))
  server.inject(privateMessage(`#ws new ${siblingName}`))
  await sleep(1000)
  check('#ws new <名字> creates a sibling of the current workspace',
    existsSync(siblingPath), siblingPath)
  check('#ws new reports the creation',
    sentText(lastSent(server)).includes('已新建工作区') && sentText(lastSent(server)).includes(siblingPath),
    sentText(lastSent(server)).slice(0, 220))

  const beforeNewSession = created.length
  server.inject(privateMessage('#new'))
  await sleep(1000)
  check('#new after #ws new opens the session in the NEW workspace group',
    created.length === beforeNewSession + 1
      && attached[attached.length - 1]?.path === siblingPath,
    JSON.stringify(attached.slice(-1)))

  // An absolute path is taken as a path, not as a name to hang next to the cwd.
  const absoluteNew = join(stateDir, 'abs-new-ws')
  server.inject(privateMessage(`#ws new ${absoluteNew}`))
  await sleep(1000)
  check('#ws new <绝对路径> creates exactly that directory',
    existsSync(absoluteNew), absoluteNew)

  // Running it again on an existing directory must say so instead of pretending.
  // (#new above pinned a session the fixture has no live agent for, so the target
  // goes back to the temp one explicitly first.)
  server.inject(privateMessage('#use 4'))
  await sleep(800)
  server.inject(privateMessage(`#ws new ${siblingName}`))
  await sleep(1000)
  check('#ws new on an existing directory says it already existed',
    sentText(lastSent(server)).includes('选定已存在的'),
    sentText(lastSent(server)).slice(0, 200))

  // A bare `#ws new` must ask for a name rather than creating a folder called
  // "new" next to the current workspace.
  server.inject(privateMessage('#ws new'))
  await sleep(800)
  check('#ws new without a name explains the usage',
    sentText(lastSent(server)).includes('用法'),
    sentText(lastSent(server)).slice(0, 160))
  check('#ws new without a name creates nothing',
    !existsSync(join(stateDir, 'proj-tmp', 'new')),
    join(stateDir, 'proj-tmp', 'new'))

  // --- the SAME report machinery honours `#img`: with cards on, a turn report
  //     arrives as an image, and `#again` can then hand it back as text
  server.inject(privateMessage('#use 1'))
  await sleep(800)
  server.inject(privateMessage('#img on'))
  await sleep(700)
  server.inject(privateMessage('#把这段再跑一遍'))
  await sleep(900)
  const beforeImageReport = server.sent.length
  await fake.fire('agent/turn-stopping', { agent: agentA, turn: 9 })
  await sleep(3500)
  const imageReport = server.sent.slice(beforeImageReport).map(sentText).join('\n')
  check('turn report is delivered as an image when #img is on',
    imageReport.includes('[image]'), imageReport.slice(0, 160))
  check('the image report carries no raw session id',
    !imageReport.includes(SESSION_A.slice(0, 12)), imageReport.slice(0, 160))

  server.inject(privateMessage('#img off'))
  await sleep(700)
  server.inject(privateMessage('#again'))
  await sleep(900)
  const textAgain = sentText(lastSent(server))
  check('#again after #img off re-sends the last report as text',
    textAgain.includes('第一步做完了') && !textAgain.includes('[image]'),
    textAgain.slice(0, 200))

  // --- notifications obey `#img` too: a progress ping / error report is not a
  //     special case that quietly stays text
  server.inject(privateMessage('#img on'))
  await sleep(700)
  const beforeNotify = server.sent.length
  await fake.fire('agent/error', {
    agent: agentA, turn: 1, step: 0, error: new Error('boom for the test'),
  })
  await sleep(3000)
  const notifySent = server.sent.slice(beforeNotify).map(sentText).join('\n')
  check('a notification is delivered as an image when #img is on',
    notifySent.includes('[image]'), notifySent.slice(0, 160))
  check('the notification names the session, never the raw id',
    !notifySent.includes(SESSION_A.slice(0, 12)), notifySent.slice(0, 160))

  // --- and `richAcks` extends that to one-line receipts, which is what makes
  //     *every* reply follow `#img` the way this deployment is configured
  config.richAcks = true
  const beforeAck = server.sent.length
  server.inject(privateMessage('#use 2'))
  await sleep(3500)
  const ackSent = server.sent.slice(beforeAck).map(sentText).join('\n')
  check('richAcks renders a one-line receipt as a card',
    ackSent.includes('[image]'), ackSent.slice(0, 160))
  config.richAcks = false
  await sleep(300)

  server.inject(privateMessage('#img off'))
  await sleep(700)

  // --- answering an `ask_user_question` from the chat. The Web question surface
  //     is modelled by `fake.askUserQuestion`'s `downstream`, so both the
  //     "chat answers" and "desktop answers" paths are exercised for real.
  server.inject(privateMessage('#use 1'))
  await sleep(800)

  const twoQuestions = [
    {
      id: 'cleanup',
      question: '要把这三个临时文件删掉吗？',
      header: '确认',
      options: [
        { label: '删掉（推荐）', description: '释放 12 MB' },
        { label: '先留着' },
      ],
    },
    {
      id: 'name',
      question: '新项目叫什么？',
      options: [{ label: '订单助手' }, { label: '数据看板' }],
    },
  ]

  // (a) a single question, answered by its number
  const askOne = fake.askUserQuestion({
    questions: [{
      id: 'cleanup',
      question: '要把这三个临时文件删掉吗？',
      options: [{ label: '删掉（推荐）' }, { label: '先留着' }],
    }],
    agent: agentA,
  })
  await sleep(1200)
  check('a question is announced in the chat with numbered options',
    sentText(lastSent(server)).includes('需要你回答') && sentText(lastSent(server)).includes('1) 删掉（推荐）'),
    sentText(lastSent(server)).slice(0, 200))
  check('the announcement says how to answer in one line',
    sentText(lastSent(server)).includes('#1'), sentText(lastSent(server)).slice(-120))

  const beforeAnswer = prompts.length
  server.inject(privateMessage('#1'))
  await sleep(1200)
  const firstAnswer = await Promise.race([askOne, sleep(1500).then(() => null)])
  check('answering #1 resolves the pending question with the option label',
    firstAnswer?.answers?.[0]?.id === 'cleanup'
      && firstAnswer.answers[0].selected[0] === '删掉（推荐）'
      && firstAnswer.answers[0].custom === undefined,
    JSON.stringify(firstAnswer))
  check('an answered question is not also forwarded as a prompt',
    prompts.length === beforeAnswer, `${prompts.length} vs ${beforeAnswer}`)
  check('the chat acknowledges what was chosen',
    sentText(lastSent(server)).includes('已交卷') || sentText(lastSent(server)).includes('删掉'),
    sentText(lastSent(server)).slice(0, 200))

  // (b) a number with no matching option is the custom answer, not an error
  const askCustom = fake.askUserQuestion({
    questions: [{
      id: 'size',
      question: '要多少个？',
      options: [{ label: '10' }, { label: '20' }],
    }],
    agent: agentA,
  })
  await sleep(1000)
  server.inject(privateMessage('#7'))
  await sleep(1200)
  const customAnswer = await Promise.race([askCustom, sleep(1500).then(() => null)])
  check('an out-of-range number becomes a custom answer',
    customAnswer?.answers?.[0]?.custom === '7' && customAnswer.answers[0].selected.length === 0,
    JSON.stringify(customAnswer))

  // (c) free text is a custom answer — and the prefix is optional, because the
  //     hint on the phone reads `自定义 <text>`, so people type exactly that
  const askText = fake.askUserQuestion({
    questions: [{ id: 'note', question: '有什么要补充的？' }],
    agent: agentA,
  })
  await sleep(1000)
  server.inject(privateMessage('周三之前投完'))
  await sleep(1200)
  const textAnswer = await Promise.race([askText, sleep(1500).then(() => null)])
  check('free text without the prefix becomes the custom answer',
    textAnswer?.answers?.[0]?.custom === '周三之前投完', JSON.stringify(textAnswer))

  // (c2) …and a bare number is still an option number, not the string "2"
  const askBare = fake.askUserQuestion({
    questions: [{
      id: 'pick',
      question: '先做哪个？',
      options: [{ label: '投简历' }, { label: '写周报' }],
    }],
    agent: agentA,
  })
  await sleep(1000)
  server.inject(privateMessage('2'))
  await sleep(1200)
  const bareAnswer = await Promise.race([askBare, sleep(1500).then(() => null)])
  check('a bare number picks the option, it is not read as text',
    bareAnswer?.answers?.[0]?.selected?.[0] === '写周报' && bareAnswer.answers[0].custom === undefined,
    JSON.stringify(bareAnswer))

  // (d) paging: `#>` / `#<` move the pointer without answering, `#题2` jumps
  const askTwo = fake.askUserQuestion({ questions: twoQuestions, agent: agentA })
  await sleep(1200)
  check('a multi-question request announces the first question',
    sentText(lastSent(server)).includes('题 1/2'), sentText(lastSent(server)).slice(0, 200))
  server.inject(privateMessage('#>'))
  await sleep(900)
  check('#> moves to the next question without answering it',
    sentText(lastSent(server)).includes('题 2/2') && sentText(lastSent(server)).includes('新项目叫什么'),
    sentText(lastSent(server)).slice(0, 200))
  server.inject(privateMessage('#<'))
  await sleep(900)
  check('#< moves back', sentText(lastSent(server)).includes('题 1/2'), sentText(lastSent(server)).slice(0, 160))
  server.inject(privateMessage('#q2'))
  await sleep(900)
  check('#q2 jumps straight to question 2 (the advertised form)',
    sentText(lastSent(server)).includes('题 2/2'), sentText(lastSent(server)).slice(0, 160))

  // answering the second question first, then the first, must submit a complete
  // batch in the ORIGINAL question order
  server.inject(privateMessage('#1'))
  await sleep(1000)
  check('a choice advances to the remaining question',
    sentText(lastSent(server)).includes('题 1/2'), sentText(lastSent(server)).slice(0, 200))
  server.inject(privateMessage('#2'))
  await sleep(1200)
  const batch = await Promise.race([askTwo, sleep(1500).then(() => null)])
  check('both answers are submitted in question order',
    batch?.answers?.length === 2
      && batch.answers[0].id === 'cleanup' && batch.answers[0].selected[0] === '先留着'
      && batch.answers[1].id === 'name' && batch.answers[1].selected[0] === '订单助手',
    JSON.stringify(batch))

  // (e) `#提交` submits whatever is there, skipping the rest
  const askSkip = fake.askUserQuestion({ questions: twoQuestions, agent: agentA })
  await sleep(1000)
  server.inject(privateMessage('#1'))
  await sleep(1000)
  server.inject(privateMessage('#submit'))
  await sleep(1200)
  const skipped = await Promise.race([askSkip, sleep(1500).then(() => null)])
  check('#submit submits early and records the rest as skipped',
    skipped?.answers?.length === 2
      && skipped.answers[0].selected[0] === '删掉（推荐）'
      && skipped.answers[1].selected.length === 0,
    JSON.stringify(skipped))

  // (e2) a *prefixed* `#stop` still escapes the question: a blocked turn is the
  //      one place where the documented way out has to keep working
  const askStop = fake.askUserQuestion({
    questions: [{ id: 'stuck', question: '还继续吗？', options: [{ label: '继续' }, { label: '别做了' }] }],
    agent: agentA,
  })
  await sleep(1000)
  cancelCalled = false
  server.inject(privateMessage('#stop'))
  await sleep(1000)
  check('#stop still stops the run instead of becoming an answer',
    cancelCalled === true, String(cancelCalled))
  server.inject(privateMessage('#submit'))
  await sleep(1200)
  const stopAnswer = await Promise.race([askStop, sleep(1500).then(() => null)])
  check('and the question can then be submitted as usual',
    stopAnswer?.answers?.[0]?.id === 'stuck' && stopAnswer.answers[0].selected.length === 0,
    JSON.stringify(stopAnswer))

  // (f) the desktop surface stays live: if it answers first, its answer is used
  const askGui = fake.askUserQuestion({
    questions: [{ id: 'gui', question: '桌面端回答？', options: [{ label: '桌面选了' }] }],
    agent: agentA,
  }, {
    downstream: async () => ({ answers: [{ id: 'gui', selected: ['桌面选了'] }] }),
  })
  const guiAnswer = await Promise.race([askGui, sleep(2500).then(() => null)])
  check('the Web question surface can still answer while the chat listens',
    guiAnswer?.answers?.[0]?.selected?.[0] === '桌面选了', JSON.stringify(guiAnswer))
  // The announcement is fire-and-forget, so give it a beat before reading it.
  await sleep(1200)
  check('a question answered on the desktop is announced in the chat too',
    sentText(lastSent(server)).includes('需要你回答'), sentText(lastSent(server)).slice(0, 160))

  // (g) cancelling the turn settles the question as aborted, not as an answer
  const controller = new AbortController()
  const askAbort = fake.askUserQuestion({
    questions: [{ id: 'abort', question: '会被取消吗？', options: [{ label: '是' }] }],
    agent: agentA,
    signal: controller.signal,
  })
  await sleep(900)
  controller.abort()
  const aborted = await askAbort.then(() => 'resolved', (error) => `rejected:${error.message}`)
  check('an aborted question is rejected instead of answered',
    typeof aborted === 'string' && aborted.startsWith('rejected:'), String(aborted))
  server.inject(privateMessage('#还是能正常发指令'))
  await sleep(1000)
  check('after the abort the chat forwards prompts normally again',
    prompts.includes('还是能正常发指令'), JSON.stringify(prompts.slice(-2)))

  // --- 多会话手感: `#sessions` 按最近活动排序, `#reply` 回刚刚发言的那个,
  //     and a blocked question no longer locks the whole command surface
  {
    server.inject(privateMessage('#sessions'))
    await sleep(1100)
    const list = sentText(lastSent(server))
    check('#sessions stamps every session with how long ago it was active',
      /分钟前|刚刚|小时前|天前/.test(list), list.slice(0, 240))
    check('#sessions advertises the reply shortcut',
      list.includes('#reply'), list.slice(-200))
    check('#sessions nests the forked branch under its parent session',
      list.includes('分叉实验'), list.slice(0, 300))

    server.inject(privateMessage('#use 1'))
    await sleep(900)
    // B speaks (a question counts as speaking) while the *pin* is still A.
    const askB = fake.askUserQuestion({
      questions: [{
        id: 'from-b',
        question: 'beta 这边要动吗？',
        options: [{ label: '动' }, { label: '不动' }],
      }],
      agent: agentB,
    })
    await sleep(1200)
    check('a question from B is announced as coming from B',
      sentText(lastSent(server)).includes('需要你回答') && sentText(lastSent(server)).includes('beta'),
      sentText(lastSent(server)).slice(0, 160))

    const beforeReply = promptTargets.length
    server.inject(privateMessage('#reply 先别动'))
    await sleep(1100)
    check('#reply delivers to the session that spoke last, not the pinned one',
      promptTargets.slice(beforeReply).includes(SESSION_B)
        && prompts.slice(-1)[0] === '先别动',
      JSON.stringify({ targets: promptTargets.slice(beforeReply), last: prompts.slice(-1)[0] }))
    check('#reply says the target did not move',
      sentText(lastSent(server)).includes('目标没变'), sentText(lastSent(server)).slice(0, 240))
    server.inject(privateMessage('#status'))
    await sleep(1200)
    check('the pin is still on alpha after replying to beta',
      sentText(lastSent(server)).includes('alpha'), sentText(lastSent(server)).slice(0, 160))

    // The command surface stays usable while the turn is blocked on the question
    // — including `#tree`, which has to walk the whole session list.
    server.inject(privateMessage('#tree'))
    await sleep(1600)
    const tree = sentText(lastSent(server))
    check('#tree draws both trees while a question is pending',
      tree.includes('会话分叉') && tree.includes('工作区') && tree.includes('├─'),
      tree.slice(0, 260))
    check('#tree nests the fork under the session it came from',
      tree.includes('分叉实验') && tree.indexOf('分叉实验') > tree.indexOf('alpha'),
      tree.slice(0, 320))
    check('#tree marks the current target and the recency',
      tree.includes('← 当前') && /分钟前|刚刚|小时前/.test(tree), tree.slice(0, 320))
    // Tofu guard: the card draws these rows in Consolas, so a glyph that font does
    // not have renders as an empty box — verified against a real render, not
    // guessed. (Tested live: ├ └ ─ │ ● ○ · ← all draw; the list below do not.)
    const TOFU = ['↳', '⇢', '◐', '◉', '◍', '▸', '▹', '▶', '►', '▷', '★', '☆', '⏳', '⌛', '⏵', '⏴', '➤', '⟶']
    check('#tree avoids glyphs the monospace font lacks (they render as boxes)',
      !TOFU.some((glyph) => tree.includes(glyph)),
      TOFU.filter((glyph) => tree.includes(glyph)).join(' '))

    server.inject(privateMessage('#reply'))
    await sleep(1000)
    check('a bare #reply switches the target to whoever spoke last',
      sentText(lastSent(server)).includes('目标已切到') && sentText(lastSent(server)).includes('beta'),
      sentText(lastSent(server)).slice(0, 200))

    server.inject(privateMessage('#2'))
    await sleep(1300)
    const answeredLate = await Promise.race([askB, sleep(1500).then(() => null)])
    check('the question survives all of that and still answers normally',
      answeredLate?.answers?.[0]?.id === 'from-b' && answeredLate.answers[0].selected[0] === '不动',
      JSON.stringify(answeredLate))
  }

  // --- the optional指令门: `accessGate: all` makes the SAME administrator password
  //     stand in front of every command. Off by default, because "the password is
  //     for permissions" is what the operator asked for; on, the chat is safe even
  //     if the phone is not.
  const SECRET = 'x7-kaimen'
  config.accessPassword = SECRET
  config.accessGate = 'all'
  const beforeGate = prompts.length
  server.inject(privateMessage('#status'))
  await sleep(900)
  check('with accessGate all, an unauthorized command is refused with an explanation',
    sentText(lastSent(server)).includes('需要先授权'), sentText(lastSent(server)).slice(0, 160))
  check('the refused command ran nothing', prompts.length === beforeGate,
    `${prompts.length} vs ${beforeGate}`)

  server.inject(privateMessage('#nope'))
  await sleep(900)
  check('a wrong password is rejected', sentText(lastSent(server)).includes('密码不对'),
    sentText(lastSent(server)).slice(0, 140))

  server.inject(privateMessage(`#${SECRET}`))
  await sleep(900)
  check('the password authorizes the conversation',
    sentText(lastSent(server)).includes('已授权'), sentText(lastSent(server)).slice(0, 140))
  server.inject(privateMessage('#status'))
  await sleep(1200)
  check('after authorizing, commands work again',
    sentText(lastSent(server)).includes('目标') || sentText(lastSent(server)).includes('DSH'),
    sentText(lastSent(server)).slice(0, 160))
  check('#status reports the open gate',
    sentText(lastSent(server)).includes('授权：已开启'), sentText(lastSent(server)).slice(-160))

  server.inject(privateMessage('#lock'))
  await sleep(900)
  check('#lock drops the grant', sentText(lastSent(server)).includes('已锁回'),
    sentText(lastSent(server)).slice(0, 140))
  server.inject(privateMessage('#status'))
  await sleep(900)
  check('after #lock a command needs the password again',
    sentText(lastSent(server)).includes('需要先授权'), sentText(lastSent(server)).slice(0, 140))

  // The password itself must never reach the trace file or the chat.
  const trace = await readFile(debugFile, 'utf8').catch(() => '')
  check('the password never appears in the debug trace', !trace.includes(SECRET),
    trace.split('\n').filter((line) => line.includes('access-')).slice(-2).join(' | ').slice(0, 160))

  // Turning the gate back off restores password-free commands — and the danger
  // preset still asks for the password, which is the whole point of the split.
  config.accessGate = 'off'
  config.accessPassword = ''
  server.inject(privateMessage('#status'))
  await sleep(1200)
  check('with the gate off, commands need no password again',
    sentText(lastSent(server)).includes('DSH 状态') && !sentText(lastSent(server)).includes('需要先授权'),
    sentText(lastSent(server)).slice(0, 140))
  // (#hunter2 is this fixture's `fullAccessPassword`, i.e. the same secret.)
  server.inject(privateMessage('#perm f'))
  await sleep(900)
  check('the danger preset still demands the administrator password',
    sentText(lastSent(server)).includes('密码不对'), sentText(lastSent(server)).slice(0, 160))
  server.inject(privateMessage('#perm r'))
  await sleep(800)
  check('a safe preset still needs no password',
    sentText(lastSent(server)).includes('权限已切换'), sentText(lastSent(server)).slice(0, 140))

  // --- the command-word set the gate consults cannot drift from the dispatcher
  {
    const source = await readFile(join(PLUGIN_ROOT, 'lib', 'index.js'), 'utf8')
    const missing = new Set()
    for (const [, body] of source.matchAll(/matchesCommand\([^,]+,\s*\[([^\]]*)\]/g)) {
      for (const word of [...body.matchAll(/'([^']+)'/g)].map((m) => m[1])) {
        if (!COMMAND_WORDS.has(word)) missing.add(word)
      }
    }
    check('every dispatcher alias is in COMMAND_WORDS (the gate cannot drift)',
      missing.size === 0, [...missing].join(', '))
  }

  // --- last: force-off the only transport, and confirm it really disconnects
  server.inject(privateMessage('#switch qq off force'))
  await sleep(1200)
  check('force-off stops the transport',
    sentText(lastSent(server)).includes('已停用'),
    sentText(lastSent(server)).slice(0, 200))
  check('force-off closed the socket', server.connections === 0, `connections=${server.connections}`)
  const statusTool = fake.registeredTools.find((t) => t.name === 'remote_status')
  if (statusTool !== undefined) {
    const value = await statusTool.execute({}, {})
    check('remote_status reports the transport as disabled',
      value.anyReady === false && value.transports[0]?.state === 'disabled',
      JSON.stringify(value.transports))
  }
  const persistedState = JSON.parse(await readFile(stateFile, 'utf8'))
  check('the switch survives a restart',
    Array.isArray(persistedState.disabledChannels) && persistedState.disabledChannels.includes('onebot'),
    JSON.stringify(persistedState.disabledChannels))
  check('the master switch is persisted too',
    persistedState.enabled === true,
    String(persistedState.enabled))

  await fake.disposeAll()
  await server.close()
  await rm(stateDir, { recursive: true, force: true }).catch(() => undefined)

  process.stderr.write(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED: ${failures.join(', ')}`}\n`)
  process.exit(failures.length === 0 ? 0 : 1)
}

void main()
