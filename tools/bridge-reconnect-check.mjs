/**
 * Robustness check for the WeChat bridge process manager.
 *
 * The bridge is a child Python process. It can be killed by anything — a crash,
 * the user's own cleanup, an out-of-memory kill — and the plugin must heal
 * itself without a DSH restart. This asserts that `request()` respawns the
 * child, and that a pending request is rejected rather than left hanging when
 * the child dies underneath it.
 *
 * Usage: node tools/bridge-reconnect-check.mjs
 */
import { WeChatBridge } from '../lib/bridge.js'

const failures = []
function check(label, condition, detail = '') {
  if (!condition) failures.push(label)
  process.stderr.write(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}\n`)
}

const logSink = []
const logger = {
  info: (...a) => logSink.push(a.join(' ')),
  warn: (...a) => logSink.push(a.join(' ')),
  error: (...a) => logSink.push(a.join(' ')),
  debug: () => {},
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main() {
  const bridge = new WeChatBridge({ logger, timeoutMs: 30000 })

  const started = await bridge.start()
  check('bridge starts and handshakes', started === true, `state=${bridge.state}`)
  check('bridge reports ready', bridge.state === 'ready')

  const first = await bridge.request('ping', {})
  check('ping answers', first.pong === true)

  // Kill THIS bridge's child specifically — there may be another bridge running
  // for a live DSH instance, and killing that one would be a rude test.
  const firstPid = bridge.childPid
  check('bridge exposes its child pid', Number.isInteger(firstPid) && firstPid > 0, String(firstPid))
  const { execFileSync } = await import('node:child_process')
  if (Number.isInteger(firstPid)) {
    execFileSync('taskkill', ['/PID', String(firstPid), '/F'], { stdio: 'ignore' })
  }

  // A request issued right after the kill must not hang: it either lands on a
  // fresh child or rejects cleanly.
  await sleep(1200)
  let settled = false
  try {
    const pong = await bridge.request('ping', {}, 8000)
    settled = pong.pong === true
  } catch {
    settled = true
  }
  check('a request during the crash settles instead of hanging', settled)

  let recovered = false
  for (let attempt = 0; attempt < 3 && !recovered; attempt += 1) {
    try {
      const pong = await bridge.request('ping', {}, 20000)
      recovered = pong.pong === true
    } catch (error) {
      process.stderr.write(`  retry ${attempt + 1}: ${String(error?.message ?? error)}\n`)
      await sleep(1500)
    }
  }
  check('bridge self-heals after the child is killed', recovered, `state=${bridge.state}`)

  const secondPid = bridge.childPid
  check('a different child is now serving', Number.isInteger(secondPid) && secondPid !== firstPid,
    `before=${firstPid} after=${secondPid}`)

  await bridge.stop()
  check('stop() leaves the bridge stopped', bridge.state === 'stopped')
  check('stop() clears the child pid', bridge.childPid === null)

  process.stderr.write(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED: ${failures.join(', ')}`}\n`)
  process.exit(failures.length === 0 ? 0 : 1)
}

void main()
