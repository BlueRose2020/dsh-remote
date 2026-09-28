/**
 * Offline smoke test for the `wechat-local` transport.
 *
 * Boots the real plugin against a minimal fake Cordis context, so imports,
 * config handling, the Python bridge process, the login probe, event wiring and
 * tool registration are all exercised without touching a live DSH profile.
 *
 * Sending is OFF by default: this test used to litter the real 文件传输助手
 * with messages. Pass --send to exercise the outbound path for real.
 *
 * Usage:
 *   node tools/smoke.mjs                 # passive checks only
 *   node tools/smoke.mjs --send          # also send real WeChat messages
 *   node tools/smoke.mjs --seconds 20    # keep the loops running for N seconds
 *   node tools/smoke.mjs --transports wechat-local,onebot
 */
import { apply, Config } from '../lib/index.js'
import { createFakeContext, sleep } from './fake-ctx.mjs'

const argv = process.argv.slice(2)
const noSend = !argv.includes('--send')
const secondsArg = argv.indexOf('--seconds')
const seconds = secondsArg >= 0 ? Number(argv[secondsArg + 1]) : 8
const transportsArg = argv.indexOf('--transports')
const transports = transportsArg >= 0
  ? argv[transportsArg + 1].split(',').map((s) => s.trim()).filter(Boolean)
  : ['wechat-local']

const failures = []
function check(label, condition, detail = '') {
  const mark = condition ? 'PASS' : 'FAIL'
  if (!condition) failures.push(label)
  process.stderr.write(`${mark}  ${label}${detail ? ` — ${detail}` : ''}\n`)
}

const prompts = []
const fake = createFakeContext({
  services: {
    agents: {
      roots: () => [{ id: 'session-smoke-0001' }],
      get: (id) => (id === 'session-smoke-0001' ? { id, cancel: () => prompts.push('CANCEL') } : undefined),
    },
    sessionController: {
      prompt: async (request) => {
        prompts.push(request.content.map((part) => part.text).join(''))
        return { accepted: true }
      },
    },
  },
})

const config = Config({ transports, dedupeMs: 0, announceOnReady: !noSend })
process.stderr.write(`INFO  transports=${JSON.stringify(config.transports)}\n`)

apply(fake.ctx, config)

async function main() {
  await sleep(7000)

  const statusTool = fake.registeredTools.find((t) => t.name === 'remote_status')
  check('remote_status registered', statusTool !== undefined)
  if (statusTool !== undefined) {
    const value = await statusTool.execute({}, {})
    process.stderr.write(`INFO  remote_status -> ${JSON.stringify(value)}\n`)
    check('remote_status reports a transport', value.transports.length === transports.length)
  }

  if (!noSend) {
    await fake.fire('agent/error', {
      agent: { id: 'session-smoke-0001' },
      turn: 3,
      step: 2,
      error: new Error('smoke test: simulated tool failure'),
    })
    await sleep(3500)

    const notifyTool = fake.registeredTools.find((t) => t.name === 'remote_notify')
    check('remote_notify registered', notifyTool !== undefined)
    if (notifyTool !== undefined) {
      const value = await notifyTool.execute({ text: '冒烟测试：插件可以主动发消息。', headline: '自检' }, {})
      process.stderr.write(`INFO  remote_notify -> ${JSON.stringify(value)}\n`)
      check('remote_notify delivered', value.sent === true, JSON.stringify(value))
    }
  }

  process.stderr.write(`INFO  tools: ${fake.registeredTools.map((t) => t.name).join(', ') || '(none)'}\n`)
  process.stderr.write(`INFO  events: ${fake.emitted.map((e) => e.event).join(', ') || '(none)'}\n`)

  await sleep(Math.max(0, seconds * 1000))
  await fake.disposeAll()

  process.stderr.write(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED: ${failures.join(', ')}`}\n`)
  process.exit(failures.length === 0 ? 0 : 1)
}

void main()
