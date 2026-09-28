/**
 * Live inbound check for the `wechat-local` transport.
 *
 * Runs the real plugin against the real WeChat bridge in its own process, then
 * waits for an inbound message to appear in 文件传输助手 and reports what the
 * plugin did with it. Use it to tell "the transport is broken" apart from
 * "the running DSH instance is stale".
 *
 * Usage:
 *   node tools/inbound-check.mjs [--seconds 90]
 *
 * While it runs, send a `#`-prefixed message to 文件传输助手 from your phone
 * (or from another bridge process via tools/drive.py).
 */
import { apply, Config } from '../lib/index.js'
import { createFakeContext, sleep } from './fake-ctx.mjs'

const secondsArg = process.argv.indexOf('--seconds')
const seconds = secondsArg >= 0 ? Number(process.argv[secondsArg + 1]) : 90

const prompts = []
const fake = createFakeContext({
  services: {
    agents: {
      roots: () => [{ id: 'session-inbound-check-0001', session: { header: { cwd: process.cwd() } } }],
      get: (id) => (id === 'session-inbound-check-0001' ? { id, cancel: () => {} } : undefined),
    },
    sessionController: {
      prompt: async (request) => {
        const text = request.content.map((part) => part.text).join('')
        prompts.push(text)
        process.stderr.write(`\n>>> FORWARDED TO SESSION: ${JSON.stringify(text)}\n\n`)
        return { accepted: true }
      },
      list: async () => ({ items: [] }),
    },
    workspaceRegistry: { list: () => [], create: async (p) => ({ id: 'w', path: p, title: p }) },
  },
})

const config = Config({ transports: ['wechat-local'], reportOnTurnEnd: false, commandPrefix: '#', replyAcks: true, announceOnReady: false })
apply(fake.ctx, config)
process.stderr.write(`inbound check running for ${seconds}s — send a # message to 文件传输助手 now\n`)

async function main() {
  const deadline = Date.now() + seconds * 1000
  let reported = 0
  while (Date.now() < deadline) {
    await sleep(2000)
    if (prompts.length !== reported) {
      reported = prompts.length
      process.stderr.write(`prompt count = ${prompts.length}\n`)
    }
  }
  const statusTool = fake.registeredTools.find((t) => t.name === 'remote_status')
  if (statusTool !== undefined) {
    process.stderr.write(`final status: ${JSON.stringify(await statusTool.execute({}, {}))}\n`)
  }
  await fake.disposeAll()
  process.stderr.write(prompts.length > 0
    ? `\nINBOUND OK — ${prompts.length} message(s) reached the session\n`
    : '\nINBOUND FAILED — nothing reached the session\n')
  process.exit(prompts.length > 0 ? 0 : 1)
}

void main()
