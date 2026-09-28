/**
 * Render the README's `#help` screenshot from the real command table.
 *
 * The image in `docs/help-card.png` is not hand-drawn: this tool boots the plugin
 * against a mock OneBot server, sends `#help`, and keeps the PNG the plugin itself
 * rendered and sent. So the picture cannot drift from `helpText()` the way a
 * hand-maintained command list in prose does — regenerate it and the README is
 * current again.
 *
 * Usage: node tools/make-help-card.mjs [--port 30098]
 */
import { WebSocketServer } from 'ws'
import { apply, Config } from '../lib/index.js'
import { createFakeContext, sleep } from './fake-ctx.mjs'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(PLUGIN_ROOT, 'docs', 'help-card.png')
/** The avatar shipped by the repository and used by a fresh installation. */
const AVATAR = join(PLUGIN_ROOT, 'assets', 'avatars', 'default.png')

const portArg = process.argv.indexOf('--port')
const PORT = portArg >= 0 ? Number(process.argv[portArg + 1]) : 30098
const SELF_ID = 10001
const FRIEND_ID = 20002

/** Minimal OneBot 11 server: answers the handshake, records what was sent. */
function startMockServer() {
  const sockets = new Set()
  const sent = []
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
      const reply = (data) => socket.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: frame.echo }))
      switch (frame.action) {
        case 'get_login_info':
          reply({ user_id: SELF_ID, nickname: 'renderer' })
          break
        case 'get_friend_list':
          reply([{ user_id: FRIEND_ID, nickname: 'me', remark: '' }])
          break
        case 'send_private_msg':
          sent.push(frame.params)
          reply({ message_id: sent.length })
          break
        default:
          reply({})
      }
    })
  })
  return {
    sent,
    connections: () => sockets.size,
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

/** Pull the first `base64://` image out of a OneBot send. */
function imageOf(params) {
  const segments = Array.isArray(params?.message) ? params.message : []
  for (const segment of segments) {
    if (segment?.type === 'image' && typeof segment.data?.file === 'string'
      && segment.data.file.startsWith('base64://')) {
      return Buffer.from(segment.data.file.slice('base64://'.length), 'base64')
    }
  }
  return null
}

async function main() {
  const server = startMockServer()
  await sleep(200)
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-help-card-'))
  await mkdir(join(stateDir, 'downloads'), { recursive: true })

  const settingsValues = {}
  const settingsScope = {
    get: () => ({ ...settingsValues }),
    update: async (patch) => {
      Object.assign(settingsValues, patch)
      return { ...settingsValues }
    },
    watch: () => () => {},
  }

  const config = Config({
    transports: ['onebot'],
    onebot: { url: `ws://127.0.0.1:${PORT}`, ownerId: '', acceptSelfMessages: true },
    // The card is the point: let the plugin render and send it.
    imageReplies: true,
    // Pass it explicitly so this generated documentation always shows the
    // repository's current default avatar.
    avatar: AVATAR,
    announceOnReady: false,
    maxCommandsPerMinute: 0,
    stateFile: join(stateDir, 'state.json'),
    debugLog: join(stateDir, 'debug.jsonl'),
    accessGate: false,
  })

  const fake = createFakeContext({
    services: {
      settings: { register: () => settingsScope },
      systemPrompt: { section: () => () => {}, getSectionOrder: () => 550 },
    },
  })

  apply(fake.ctx, config)
  await sleep(1200)
  if (server.connections() !== 1) {
    throw new Error(`the mock server never got a connection (${server.connections()})`)
  }

  server.inject(privateMessage('#help'))
  await sleep(2500)

  const png = server.sent.map(imageOf).find((bytes) => bytes !== null)
  await server.close()
  await fake.disposeAll()

  if (png === undefined || png === null) {
    const shapes = server.sent.map((params) => JSON.stringify(params?.message).slice(0, 80))
    throw new Error(`no image reply captured; got ${JSON.stringify(shapes)}`)
  }

  // The header is a 4-byte PNG length plus `PNG`; refusing anything else keeps this
  // tool from quietly publishing a placeholder if a future change breaks the path.
  if (png.subarray(0, 4).toString('binary') !== '\x89PNG') {
    throw new Error('the captured payload is not a PNG')
  }

  await mkdir(dirname(OUT), { recursive: true })
  await writeFile(OUT, png)
  const width = png.readUInt32BE(16)
  const height = png.readUInt32BE(20)
  process.stdout.write(`wrote ${OUT} (${png.length} bytes, ${width}x${height})\n`)
}

await main()
