/**
 * Desktop capture for report images.
 *
 * Deliberately *not* part of any chat transport: a screenshot is an output
 * artifact the agent attaches to a report, so it must work on a QQ-only
 * install with the WeChat transport switched off.
 *
 * The capture itself is a small Python helper (`bridge/screenshot.py`) because
 * Pillow's `ImageGrab` handles multi-monitor, DPI-scaled desktops reliably,
 * while `System.Drawing` via PowerShell is not loadable on every Windows
 * install. The helper is also what the WeChat transport already depends on, so
 * this adds no new dependency.
 *
 * @module dsh-plugin-remote/desktop
 */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
export const DEFAULT_SCREENSHOT_SCRIPT = join(HERE, '..', 'bridge', 'screenshot.py')

function run(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${error.message}${stderr ? ` — ${String(stderr).trim().slice(0, 300)}` : ''}`))
          return
        }
        resolve(String(stdout).trim())
      })
  })
}

/**
 * Capture the desktop and return it as a base64 PNG.
 * @param options - `maxWidth` scales the image down (`<= 0` keeps the native,
 *   pixel-exact capture), `windowTitle` crops to one window, `monitor` selects
 *   what is captured (`primary`, `all`, or a 1-based display number),
 *   `pythonPath`/`scriptPath` override the helper, `timeoutMs` bounds it.
 * @returns `{ png, width, height }`.
 */
export async function captureScreen({
  maxWidth = 0,
  windowTitle = null,
  monitor = 'primary',
  pythonPath = 'python',
  scriptPath = DEFAULT_SCREENSHOT_SCRIPT,
  timeoutMs = 30000,
} = {}) {
  if (process.platform !== 'win32') throw new Error('desktop capture is Windows-only')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-shot-'))
  const file = join(dir, 'screen.png')
  // Never floor a deliberate 0 (native resolution) up to a small width — that
  // bug is invisible in code and very visible on a phone.
  const width = Number.isFinite(maxWidth) ? Math.floor(maxWidth) : 0
  const args = [scriptPath, file, String(width <= 0 ? 0 : Math.max(320, width))]
  args.push(windowTitle ?? '')
  args.push(describeMonitor(monitor))
  try {
    const size = await run(pythonPath, args, timeoutMs)
    const match = /^(\d+)x(\d+)$/.exec(size.split(/\r?\n/).pop() ?? '')
    if (match === null) throw new Error(`unexpected capture output: ${JSON.stringify(size.slice(0, 160))}`)
    const bytes = await readFile(file)
    return { png: bytes.toString('base64'), width: Number(match[1]), height: Number(match[2]) }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Normalise a monitor selector into the helper's own vocabulary. */
function describeMonitor(monitor) {
  if (typeof monitor === 'number' && Number.isFinite(monitor) && monitor >= 1) return String(Math.floor(monitor))
  const token = String(monitor ?? '').trim().toLowerCase()
  if (token === '' || token === 'primary' || token === 'main' || token === '主屏') return 'primary'
  if (token === 'all' || token === '全部' || token === '所有') return 'all'
  if (/^\d+$/.test(token)) return token
  return 'primary'
}

/**
 * List the displays Windows exposes, numbered the way the helper captures them.
 * @param options - `pythonPath`/`scriptPath`/`timeoutMs` overrides.
 * @returns `{ index, device, width, height, primary }[]`; empty when the probe
 *   fails, because a missing monitor list must never break `#shot`.
 */
export async function listMonitors({
  pythonPath = 'python',
  scriptPath = DEFAULT_SCREENSHOT_SCRIPT,
  timeoutMs = 20000,
} = {}) {
  if (process.platform !== 'win32') return []
  try {
    const output = await run(pythonPath, [scriptPath, '--list'], timeoutMs)
    return output.split(/\r?\n/).map((line) => {
      const [index, device, size, role] = line.trim().split('|')
      const match = /^(\d+)x(\d+)$/.exec(size ?? '')
      if (match === null) return null
      return {
        index: Number(index),
        device: device ?? '',
        width: Number(match[1]),
        height: Number(match[2]),
        primary: role === 'primary',
      }
    }).filter((entry) => entry !== null && Number.isSafeInteger(entry.index))
  } catch {
    return []
  }
}
