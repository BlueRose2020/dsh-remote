/**
 * Flood-guard check for the remote-channel plugin.
 *
 * A sender that runs away must not be able to queue unbounded work, so the
 * plugin refuses commands past `maxCommandsPerMinute` and says so once.
 *
 * Kept as its own script because the limit is plugin-wide config and would
 * otherwise interfere with the longer end-to-end suite.
 *
 * Usage: node tools/ratelimit-check.mjs [--port 30098]
 */
import { WebSocketServer } from 'ws'
import { apply, Config } from '../lib/index.js'
import { createFakeContext, sleep } from './fake-ctx.mjs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const portArg = process.argv.indexOf('--port')
const PORT = portArg >= 0 ? Number(process.argv[portArg + 1]) : 30098
const LIMIT = 3

const failures = []
function check(label, condition, detail = '') {
  if (!condition) failures.push(label)
  process.stderr.write(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}\n`)
}

const sent = []
const prompts = []

const server = new WebSocketServer({ port: PORT })
const sockets = new Set()
server.on('connection', (socket) => {
  sockets.add(socket)
  socket.on('message', (raw) => {
    const frame = JSON.parse(String(raw))
    const reply = (data) => socket.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: frame.echo }))
    if (frame.action === 'get_login_info') reply({ user_id: 10001, nickname: 't' })
    else if (frame.action === 'get_friend_list') reply([{ user_id: 20002, nickname: 'me' }])
    else if (frame.action === 'send_private_msg') { sent.push(frame.params); reply({ message_id: sent.length }) }
    else reply({})
  })
})

function text(params) {
  const message = params?.message
  if (typeof message === 'string') return message
  return Array.isArray(message) ? message.map((s) => (s.type === 'text' ? s.data.text : '')).join('') : ''
}

async function main() {
  await sleep(200)
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-ratelimit-'))
  const config = Config({
    transports: ['onebot'],
    onebot: { url: `ws://127.0.0.1:${PORT}`, ownerId: '' },
    announceOnReady: false,
    replyAcks: true,
    maxCommandsPerMinute: LIMIT,
    stateFile: join(stateDir, 'state.json'),
  })

  const fake = createFakeContext({
    services: {
      agents: {
        roots: () => [{ id: 'session-ratelimit-0001', session: { header: { cwd: process.cwd() } } }],
        get: (id) => ({ id, session: { header: { cwd: process.cwd() }, snapshotEvents: () => [] }, cancel: () => {} }),
      },
      sessionController: {
        prompt: async (request) => { prompts.push(request.content.map((p) => p.text).join('')); return { accepted: true } },
        list: async () => ({ items: [] }),
      },
      workspaceRegistry: { list: () => [], create: async (p) => ({ id: 'w', path: p, title: p }) },
    },
  })

  apply(fake.ctx, config)
  await sleep(1200)

  // `#ping` is not a built-in, so each one would normally be forwarded.
  for (let i = 0; i < LIMIT + 3; i += 1) {
    for (const socket of sockets) {
      socket.send(JSON.stringify({
        post_type: 'message',
        self_id: 10001,
        time: Math.floor(Date.now() / 1000),
        message_id: i,
        message_type: 'private',
        sub_type: 'friend',
        user_id: 20002,
        sender: { user_id: 20002, nickname: 'me' },
        message: [{ type: 'text', data: { text: `#ping ${i}` } }],
        raw_message: `#ping ${i}`,
      }))
    }
    await sleep(250)
  }
  await sleep(900)

  check('forwarded exactly the allowed number of commands',
    prompts.length === LIMIT, `prompts=${prompts.length} ${JSON.stringify(prompts)}`)
  check('dropped the overflow without forwarding',
    !prompts.some((p) => p.includes('ping 4')), JSON.stringify(prompts))
  check('told the user it was rate limiting',
    sent.some((s) => text(s).includes('过于频繁')), JSON.stringify(sent.map(text).slice(-2)))

  await fake.disposeAll()
  for (const socket of sockets) socket.terminate()
  await new Promise((resolve) => server.close(resolve))
  await rm(stateDir, { recursive: true, force: true }).catch(() => undefined)

  process.stderr.write(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED: ${failures.join(', ')}`}\n`)
  process.exit(failures.length === 0 ? 0 : 1)
}

void main()
