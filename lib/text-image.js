/**
 * Text → PNG rendering for chat replies.
 *
 * A phone chat renders `#status` badly: proportional fonts, awkward wrapping,
 * and no alignment. The same text drawn as a small card is readable at a
 * glance, and both transports already know how to deliver an image.
 *
 * The drawing itself is a Python helper (`bridge/text_image.py`, Pillow) for the
 * same reason the screenshot helper is: a CJK font with real text measurement is
 * a Pillow one-liner and a Node problem without a canvas dependency. Pillow is
 * already required by the WeChat transport, so this adds no new dependency.
 *
 * @module dsh-remote/text-image
 */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
export const DEFAULT_TEXT_IMAGE_SCRIPT = join(HERE, '..', 'bridge', 'text_image.py')

/**
 * Draw one text block as a PNG.
 * @param options - the text, the widest edge in px, a footer stamp, an optional
 *   avatar image path drawn in the card header, and
 *   `pythonPath`/`scriptPath`/`timeoutMs` overrides.
 * @returns `{ png, width, height }` with `png` base64-encoded.
 */
export async function renderTextImage({
  text,
  maxWidth = 900,
  footer = null,
  avatar = null,
  pythonPath = 'python',
  scriptPath = DEFAULT_TEXT_IMAGE_SCRIPT,
  timeoutMs = 20000,
} = {}) {
  const body = String(text ?? '')
  if (body.trim() === '') throw new Error('nothing to render')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-card-'))
  const input = join(dir, 'card.txt')
  const output = join(dir, 'card.png')
  try {
    await writeFile(input, body, 'utf8')
    const args = [scriptPath, input, output, String(Math.max(360, Math.min(1600, Math.floor(maxWidth))))]
    const environment = { ...process.env }
    if (footer !== null) environment.DSH_IMAGE_FOOTER = String(footer)
    // An avatar that does not exist is simply not drawn, so a missing asset can
    // never be the reason an answer fails to render.
    if (typeof avatar === 'string' && avatar !== '') environment.DSH_IMAGE_AVATAR = avatar
    const size = await new Promise((resolve, reject) => {
      execFile(pythonPath, args, { timeout: timeoutMs, windowsHide: true, env: environment, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(`${error.message}${stderr ? ` — ${String(stderr).trim().slice(0, 300)}` : ''}`))
            return
          }
          resolve(String(stdout).trim())
        })
    })
    const match = /^(\d+)x(\d+)$/.exec(size.split(/\r?\n/).pop() ?? '')
    if (match === null) throw new Error(`unexpected render output: ${JSON.stringify(size.slice(0, 160))}`)
    const bytes = await readFile(output)
    return { png: bytes.toString('base64'), width: Number(match[1]), height: Number(match[2]) }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}
