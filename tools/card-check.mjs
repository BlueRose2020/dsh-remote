/**
 * Checks for the text → PNG card renderer (`bridge/text_image.py`).
 *
 * The card is what a phone actually sees, so the things worth asserting are the
 * ones a reader would notice: the avatar header is drawn from the bundled asset,
 * Markdown shapes change the picture, an unrenderable card falls back instead of
 * throwing, and an image-setting-aware answer keeps the transport working when
 * Pillow is missing.
 *
 * Usage: node tools/card-check.mjs
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderTextImage, DEFAULT_TEXT_IMAGE_SCRIPT } from '../lib/text-image.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, '..')
const AVATAR = join(PLUGIN, 'assets', 'avatars', 'me.png')
const PYTHON = process.env.DSH_TEST_PYTHON ?? 'python'

const failures = []
function check(label, condition, detail = '') {
  if (!condition) failures.push(label)
  process.stderr.write(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}\n`)
}

/** True when the PNG's IHDR says this exact size. */
function pngSize(buffer) {
  if (buffer.length < 24 || buffer.toString('latin1', 1, 4) !== 'PNG') return null
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

function run(args, env = null) {
  return new Promise((resolve) => {
    execFile(PYTHON, args, {
      timeout: 30000,
      windowsHide: true,
      env: env === null ? process.env : { ...process.env, ...env },
    }, (error, stdout, stderr) => {
      resolve({ code: error ? 1 : 0, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

const SAMPLE = [
  '# 标题一',
  '',
  '## 标题二',
  '- 项目 **加粗** 与 `代码`',
  '- 第二项，尾部带 *斜体*',
  '1. 第一',
  '2. 第二',
  '',
  '> 引用一行，注意前面有灰条',
  '',
  '```bash',
  'dsh web --port 3080',
  '```',
  '',
  '标签：值在这里',
  '',
  '---',
  '',
  '收尾一行很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长',
].join('\n')

const workspace = await mkdtemp(join(tmpdir(), 'dsh-card-check-'))

try {
  // --- the bundled avatar is part of the deliverable, not an afterthought
  check('bundled avatar exists', existsSync(AVATAR), AVATAR)
  if (existsSync(AVATAR)) {
    const bytes = await readFile(AVATAR)
    const size = pngSize(bytes)
    check('bundled avatar is a PNG', size !== null, `${bytes.length} bytes`)
    check('bundled avatar is square', size !== null && size.width === size.height,
      size === null ? 'n/a' : `${size.width}x${size.height}`)
  }

  // --- plain text still renders (backwards compatibility)
  const plain = await renderTextImage({
    text: '【DSH】状态\n会话：beta\n工作区：D:\\proj\\beta',
    avatar: null,
    pythonPath: PYTHON,
  })
  const plainSize = pngSize(Buffer.from(plain.png, 'base64'))
  check('plain card renders', plainSize !== null && plainSize.width === 900,
    JSON.stringify(plainSize))
  check('plain card has a plausible height', plain.height > 100 && plain.height < 500,
    String(plain.height))

  // --- Markdown subset: one card, richer, and taller than the plain one
  const markdown = await renderTextImage({ text: `【DSH 汇报】测试\n${SAMPLE}`, avatar: null, pythonPath: PYTHON })
  const markdownSize = pngSize(Buffer.from(markdown.png, 'base64'))
  check('markdown card renders', markdownSize !== null, JSON.stringify(markdownSize))
  check('markdown blocks make the card taller than a few plain lines',
    markdown.height > plain.height, `${markdown.height} vs ${plain.height}`)
  // A fenced block draws a padded panel, so it must be measurably taller than the
  // same words as a paragraph — that is how we know the fence was understood.
  const fenced = await renderTextImage({ text: '【DSH】代码\n```\ndsh web --port 3080\n```', avatar: null, pythonPath: PYTHON })
  const unfenced = await renderTextImage({ text: '【DSH】代码\ndsh web --port 3080', avatar: null, pythonPath: PYTHON })
  check('a fenced block is drawn as a panel, not as literal backticks',
    fenced.height > unfenced.height, `${fenced.height} vs ${unfenced.height}`)
  // Headings are bigger type than body text.
  const heading = await renderTextImage({ text: '【DSH】标题\n# 甲\n\n乙', avatar: null, pythonPath: PYTHON })
  const bodyOnly = await renderTextImage({ text: '【DSH】标题\n甲\n\n乙', avatar: null, pythonPath: PYTHON })
  check('a heading renders larger than the same words as body text',
    heading.height > bodyOnly.height, `${heading.height} vs ${bodyOnly.height}`)

  // --- long single line wraps instead of widening the card
  const wrapping = await renderTextImage({ text: `【DSH】换行\n${'很长的一段话'.repeat(60)}`, avatar: null, pythonPath: PYTHON })
  check('long text wraps instead of widening the card',
    wrapping.width === 900 && wrapping.height > 200, `${wrapping.width}x${wrapping.height}`)

  // --- avatar header changes the geometry but never breaks the render
  const avatarText = '【DSH】头像卡片\n会话：beta\n工作区：D:\\proj\\beta'
  const withAvatar = await renderTextImage({ text: avatarText, avatar: AVATAR, pythonPath: PYTHON })
  const withoutAvatar = await renderTextImage({ text: avatarText, avatar: null, pythonPath: PYTHON })
  const avatarSize = pngSize(Buffer.from(withAvatar.png, 'base64'))
  check('card with the bundled avatar renders', avatarSize !== null, JSON.stringify(avatarSize))
  check('the avatar header is taller than a bare title header',
    withAvatar.height > withoutAvatar.height, `${withAvatar.height} vs ${withoutAvatar.height}`)
  check('the avatar does not stretch the card wider', withAvatar.width === withoutAvatar.width,
    `${withAvatar.width} vs ${withoutAvatar.width}`)

  // --- tab-separated rows are one aligned table: command | shorthand | 说明.
  //     Nothing here asserts pixels, but the shape matters: a table must not blow
  //     up the card, must accept rows with missing cells, and must not need colour.
  const table = await renderTextImage({
    text: [
      '【DSH 远程指令】',
      '## 会话',
      '#status\t#s\t会话名 / 工作区 / 状态',
      '#sessions\t#ls\t列出活动会话（含已关闭的）',
      '#use\t#u\t切换目标会话：<n|name>',
      '#ws new\t\t新建一个工作区并选定：<name|path>',
      '## 控制',
      '#on / #off\t#o / #x\t总开关（关=不转发不汇报，但仍接指令）',
      '',
      '选 #1 · 自定义 #<text>',
    ].join('\n'),
    avatar: AVATAR,
    pythonPath: PYTHON,
  })
  check('a tab-separated table renders', table.height > 0 && table.width === 900,
    `${table.width}x${table.height}`)
  const tableNoAvatar = await renderTextImage({
    text: '#status\t#s\t会话名 / 工作区 / 状态',
    avatar: null,
    pythonPath: PYTHON,
  })
  check('a one-row table renders on its own',
    tableNoAvatar.height > 0 && tableNoAvatar.width === 900, `${tableNoAvatar.height}`)
  const piped = await renderTextImage({
    text: '#status │ #s │ 用竖线分隔的表格行也行',
    avatar: null,
    pythonPath: PYTHON,
  })
  check('the │ separator is accepted too (it survives a plain-text chat)',
    piped.height > 0 && piped.width === 900, `${piped.height}`)
  const mixed = await renderTextImage({
    text: '【DSH】混排\n#status\t#s\t表格行\n普通一段话\n单格行\t就两列',
    avatar: null,
    pythonPath: PYTHON,
  })
  check('a table can sit between ordinary paragraphs, and 2-cell rows are safe',
    mixed.height > 0 && mixed.width === 900, `${mixed.height}`)

  // --- a missing avatar degrades to a plain header; it must not throw
  const missingAvatar = await renderTextImage({
    text: '【DSH】没有头像\n也行',
    avatar: join(workspace, 'does-not-exist.png'),
    pythonPath: PYTHON,
  })
  check('a missing avatar is ignored rather than fatal',
    missingAvatar.height > 0 && missingAvatar.width === 900,
    `${missingAvatar.width}x${missingAvatar.height}`)

  // --- empty input is refused explicitly, so callers can fall back to text
  let refused = false
  try {
    await renderTextImage({ text: '   ', pythonPath: PYTHON })
  } catch {
    refused = true
  }
  check('empty text is refused', refused)

  // --- the CLI contract the Node side parses stays `WxH` on the last line
  const cliInput = join(workspace, 'in.txt')
  const cliOutput = join(workspace, 'out.png')
  await writeFile(cliInput, '【DSH】命令行\n会话：beta\n', 'utf8')
  const cli = await run([DEFAULT_TEXT_IMAGE_SCRIPT, cliInput, cliOutput, '700'])
  check('cli renders and prints WxH', /^\d+x\d+$/.test(cli.stdout.trim().split(/\r?\n/).pop() ?? ''),
    JSON.stringify(cli.stdout.trim().slice(0, 60)))
  check('cli output width follows the argument',
    cli.stdout.includes('700x'), cli.stdout.trim())

  // --- the avatar reaches the renderer through DSH_IMAGE_AVATAR, which is
  //     exactly the path `renderTextImage({avatar})` uses
  const cliPlain = await run([DEFAULT_TEXT_IMAGE_SCRIPT, cliInput, cliOutput, '700'], { DSH_IMAGE_AVATAR: '' })
  const cliAvatar = await run([DEFAULT_TEXT_IMAGE_SCRIPT, cliInput, cliOutput, '700'], { DSH_IMAGE_AVATAR: AVATAR })
  const heightOf = (text) => Number((text.trim().split('x')[1] ?? '0'))
  check('DSH_IMAGE_AVATAR makes the header taller (avatar actually drawn)',
    heightOf(cliAvatar.stdout) > heightOf(cliPlain.stdout),
    `${cliAvatar.stdout.trim()} vs ${cliPlain.stdout.trim()}`)
} finally {
  await rm(workspace, { recursive: true, force: true }).catch(() => undefined)
}

if (failures.length > 0) {
  process.stderr.write(`\n${failures.length} CHECK(S) FAILED:\n${failures.map((f) => ` - ${f}`).join('\n')}\n`)
  process.exit(1)
}
process.stderr.write('\nALL CHECKS PASSED\n')
