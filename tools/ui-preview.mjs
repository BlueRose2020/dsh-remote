/**
 * Render this plugin's real UI to a PNG, with no DSH, no React and no network.
 *
 * The browser half is a hand-written bundle that only needs `react.createElement`
 * and three hooks, so a ~80-line renderer can turn its *actual* components into
 * HTML: the markup is whatever the shipped code produces, and the CSS is the very
 * stylesheet `ensureStyles()` injects (captured through a fake `document`). Add a
 * browser that ships with Windows and `--headless --screenshot`, and the surfaces
 * can be looked at — and shown to the operator — *before* spending a restart on
 * them.
 *
 *     node tools/ui-preview.mjs [--out <dir>]
 *
 * Writes `ui-preview-light.png` and `ui-preview-dark.png` into the temp dir
 * (or `--out`), each containing the chip + panel, the three configuration tabs
 * and the avatar crop dialog.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const outIndex = process.argv.indexOf('--out')
const OUT_DIR = outIndex >= 0 ? process.argv[outIndex + 1] : tmpdir()

const failures = []
function check(label, condition, detail = '') {
  const mark = condition ? 'PASS' : 'FAIL'
  if (!condition) failures.push(label)
  process.stderr.write(`${mark}  ${label}${detail ? ` — ${detail}` : ''}\n`)
}

// --------------------------------------------------------------- a tiny React
/** Void elements, which must not get a closing tag. */
const VOID = new Set(['input', 'img', 'br', 'hr', 'meta', 'link', 'source'])
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
const escapeHtml = (text) => String(text).replace(/[&<>"]/g, (character) => ESCAPES[character])

/** `{fontSize: '12px'}` -> `font-size:12px`. */
function styleOf(style) {
  if (style === undefined || style === null) return ''
  return Object.entries(style)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}:${value}`)
    .join(';')
}

/**
 * Per-component hook cells, exactly like React (and like the unit harness): state
 * has to survive the re-render that a click triggers, or none of the surfaces can
 * be driven open.
 */
const cellsByComponent = new Map()
let rendering = null
let hookIndex = 0
function currentCells() {
  let cells = cellsByComponent.get(rendering)
  if (cells === undefined) {
    cells = []
    cellsByComponent.set(rendering, cells)
  }
  return cells
}

const react = {
  /**
   * React puts the children on `props.children`, and this must too: a component
   * that reads `props.children` (the shared `Field` wrapper does) renders nothing
   * otherwise — and that failure would only show up in the preview, not in the app.
   */
  createElement: (type, props, ...children) => {
    const kids = children.length <= 1 ? children[0] : children
    return { type, props: { ...(props ?? {}), children: kids }, children: kids }
  },
  useState: (initial) => {
    const cells = currentCells()
    const index = hookIndex
    hookIndex += 1
    if (cells[index] === undefined) cells[index] = typeof initial === 'function' ? initial() : initial
    return [cells[index], (next) => {
      cells[index] = typeof next === 'function' ? next(cells[index]) : next
    }]
  },
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}

/** Render one element tree the way React would for a single pass. */
function treeOf(component, props) {
  rendering = component
  hookIndex = 0
  const tree = component(props)
  rendering = null
  hookIndex = 0
  return tree
}

/** Walk a tree, rendering function components, and collect what matches. */
function findAll(node, predicate, found = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return found
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, found)
    return found
  }
  if (typeof node !== 'object') return found
  if (predicate(node)) found.push(node)
  if (typeof node.type === 'function') {
    const previous = rendering
    rendering = node.type
    hookIndex = 0
    findAll(node.type(node.props ?? {}), predicate, found)
    rendering = previous
    hookIndex = 0
    // Children reach a component as `props.children` and are rendered by it, so a
    // function component's own `node.children` must not be walked as well.
    return found
  }
  findAll(node.children, predicate, found)
  return found
}

/** Element tree -> HTML. Event handlers and `key` are dropped, as they should be. */
function html(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (Array.isArray(node)) return node.map(html).join('')
  if (typeof node === 'string' || typeof node === 'number') return escapeHtml(node)
  if (typeof node.type === 'function') {
    const previous = rendering
    rendering = node.type
    hookIndex = 0
    const out = html(node.type(node.props ?? {}))
    rendering = previous
    hookIndex = 0
    return out
  }
  const attributes = []
  for (const [key, value] of Object.entries(node.props ?? {})) {
    if (value === undefined || value === null) continue
    if (key === 'children' || key === 'key' || key === 'dangerouslySetInnerHTML') continue
    if (typeof value === 'function') continue
    if (key === 'className') {
      attributes.push(`class="${escapeHtml(value)}"`)
      continue
    }
    if (key === 'style') {
      attributes.push(`style="${escapeHtml(styleOf(value))}"`)
      continue
    }
    if (typeof value === 'object') continue
    if (value === true) {
      attributes.push(key)
      continue
    }
    if (value === false) continue
    attributes.push(`${key}="${escapeHtml(value)}"`)
  }
  const head = `<${node.type}${attributes.length > 0 ? ` ${attributes.join(' ')}` : ''}>`
  if (VOID.has(node.type)) return head
  return `${head}${html(node.children)}</${node.type}>`
}

// --------------------------------------------------------- load the client half
const css = []
const styleElement = { id: 'dsh-plugin-remote-style', textContent: '' }
globalThis.window = {
  __ModuleLoader__: {
    load: (entry) => {
      globalThis.__entry = entry
    },
  },
}
globalThis.document = {
  head: { appendChild: (element) => css.push(element.textContent) },
  getElementById: () => null,
  createElement: () => styleElement,
}

await import('../lib/client.js')
const entry = globalThis.__entry
check('the client bundle registers itself', entry !== undefined && typeof entry.factory === 'function')

const module_ = entry.factory((id) => {
  if (id !== 'react') throw new Error(`unexpected require(${JSON.stringify(id)})`)
  return react
})
check('it exports the plugin face', typeof module_.apply === 'function')
check('it exports the components the preview needs',
  module_.__ui !== undefined && typeof module_.__ui.CropDialog === 'function',
  Object.keys(module_.__ui ?? {}).join(','))

// Mount it once so `ensureStyles()` runs and the CSS is captured.
let registered = []
module_.apply({
  settingsScope: { bind: () => ({}) },
  slots: {
    inject: (_name, factory) => {
      const produced = factory()
      if (produced !== null && typeof produced === 'object' && typeof produced.next === 'function') {
        let step = produced.next()
        while (step.done !== true) step = produced.next()
      }
    },
    register: (options, component) => {
      registered.push({ options, component })
      return () => {}
    },
  },
})
check('the stylesheet was injected', css.length === 1 && css[0].includes('.rc-chip'), `${css.length} style block(s)`)

const chipSlot = registered.find((item) => item.options.name === 'conversation.session.header.utilities')
check('the chip registered in the session header', chipSlot !== undefined)

// ------------------------------------------------------------------- fixtures
const now = Date.now()
const avatarFile = join(PLUGIN_ROOT, 'assets', 'avatars', 'me.png')
const avatarDataUrl = `data:image/png;base64,${readFileSync(avatarFile).toString('base64')}`

const MODE_SCHEMA = [
  { name: 'default', label: '工作', description: '全部命令（默认）', fields: [], hasPrompt: false, pins: {} },
  {
    name: 'persona',
    label: '人格',
    description: '换一种说话方式：人设和语气都在这里写',
    fields: [
      { key: 'persona', label: '人设', type: 'text', rows: 6, placeholder: '例：你是一只猫娘，说话带「喵」', help: '会注入系统提示词', options: [], default: '' },
      { key: 'tone', label: '语气', type: 'select', options: ['冷静', '热情', '毒舌'], placeholder: '', help: '', rows: 4, default: '冷静' },
      { key: 'emoji', label: '允许用 emoji', type: 'bool', placeholder: '', help: '', options: [], rows: 4, default: true },
    ],
    hasPrompt: true,
    pins: { imageReplies: null, richAcks: null, messageMode: 'queue' },
  },
]

const settingsValue = {
  enabled: true,
  wechat: false,
  qq: true,
  nickname: '小D',
  signature: '在的，随时喊我',
  mode: 'persona',
  modes: 'default,persona',
  modeSchema: JSON.stringify(MODE_SCHEMA),
  modeData: JSON.stringify({ persona: { persona: '你是一只蓝发猫娘，说话带「喵」。', tone: '热情', emoji: true } }),
  pinSessionId: 's2',
  pinLabel: '秋招助手（秋招）',
  speakerLabel: '简历筛子（秋招）',
  deliverMode: 'queue',
  imageReplies: true,
  avatarData: avatarDataUrl,
  fullAccessPassword: '',
  pinSessionId: 's2',
}

const writes = []
const scope = {
  getSnapshot: () => ({ status: 'ready', value: settingsValue, writable: true, revision: 1 }),
  subscribe: () => () => {},
  set: (field, value) => {
    writes.push([field, value])
    return Promise.resolve()
  },
}
const sessions = {
  ids: ['s1', 's2', 's3', 's4'],
  byId: {
    s1: { id: 's1', displayTitle: '秋招助手', updatedAt: now - 60_000, running: true },
    s2: { id: 's2', displayTitle: '简历筛子', updatedAt: now - 4 * 60_000, running: false },
    s3: { id: 's3', displayTitle: '抓岗位的 explore', parentId: 's1', origin: 'subagent', updatedAt: now - 20_000, running: false },
    s4: { id: 's4', displayTitle: '分叉：换个说法', parentId: 's2', updatedAt: now - 2 * 60 * 60_000, running: false },
  },
  current: 's1',
}
const workspaces = {
  items: [{ id: 'w1', title: '秋招', path: 'D:\\tool\\programming\\DSH\\秋招', sessionIds: ['s1'] }],
  archivedSessionIds: [],
}
const props = {
  scope,
  useSessions: (selector) => selector(sessions),
  useWorkspaces: (selector) => selector(workspaces),
}

/** Re-render the chip until a click has opened what we want to photograph. */
function surface(steps) {
  // Each surface is a fresh mount: the chip remembers `open`/`page`/`tab` in hook
  // cells, and a leftover `open: true` would make the first click *close* the
  // panel this surface is trying to photograph.
  cellsByComponent.clear()
  let tree = treeOf(chipSlot.component, props)
  for (const step of steps) {
    const target = findAll(tree, step.match)[step.index ?? 0]
    if (target === undefined) throw new Error(`preview step not found: ${step.label}`)
    // Handlers that stop propagation need an event; a click on a fold caret does.
    target.props[step.event ?? 'onClick'](...(step.args ?? []))
    tree = treeOf(chipSlot.component, props)
  }
  // Snapshot the markup *now*: rendering it later would re-read hook cells that a
  // following surface has already overwritten (every tab would photograph as the
  // last one clicked).
  return html(tree)
}
const byText = (text) => (node) => {
  const kids = Array.isArray(node.children) ? node.children : [node.children]
  return kids.includes(text)
}
const byTitle = (title) => (node) => node.props?.title === title

const surfaces = {
  'chip + panel': surface([
    { label: 'open the panel', match: (node) => node.type === 'button' && node.props?.className?.includes('rc-chip') },
  ]),
  'page: 通用': surface([
    { label: 'open the panel', match: (node) => node.type === 'button' && node.props?.className?.includes('rc-chip') },
    { label: 'open the page', match: (node) => typeof node.children === 'string' && node.children.includes('打开配置页') },
  ]),
  'page: 会话树': surface([
    { label: 'open the panel', match: (node) => node.type === 'button' && node.props?.className?.includes('rc-chip') },
    { label: 'open the page', match: (node) => typeof node.children === 'string' && node.children.includes('打开配置页') },
    { label: 'tree tab', match: byText('会话树') },
  ]),
  'page: 会话树（折叠）': surface([
    { label: 'open the panel', match: (node) => node.type === 'button' && node.props?.className?.includes('rc-chip') },
    { label: 'open the page', match: (node) => typeof node.children === 'string' && node.children.includes('打开配置页') },
    { label: 'tree tab', match: byText('会话树') },
    { label: 'fold the grouped parent', match: (node) => node.props?.['data-row'] === 'g-s1', args: [{ stopPropagation: () => {} }] },
    { label: 'fold the lineage parent', match: (node) => node.props?.['data-row'] === 'l-s1', args: [{ stopPropagation: () => {} }] },
  ]),
  'page: 模式（人格）': surface([
    { label: 'open the panel', match: (node) => node.type === 'button' && node.props?.className?.includes('rc-chip') },
    { label: 'open the page', match: (node) => typeof node.children === 'string' && node.children.includes('打开配置页') },
    { label: 'mode tab', match: byText('人格') },
  ]),
}

// The crop dialog never mounts without a FileReader, so it is rendered directly
// (through the testing seam) with a fixed picture size — which is all the maths
// and the layout need.
const CROP_VIEW = { width: 1024, height: 768 }
const cropMarkup = html(treeOf(module_.__ui.CropDialog, {
  image: { width: CROP_VIEW.width, height: CROP_VIEW.height },
  src: avatarDataUrl,
  width: CROP_VIEW.width,
  height: CROP_VIEW.height,
  disabled: false,
  onCancel: () => {},
  onDone: () => {},
}))
surfaces['avatar crop'] = cropMarkup

for (const [label, markup] of Object.entries(surfaces)) {
  check(`renders ${label}`, markup.length > 200 && markup.includes('rc-'), `${markup.length} chars`)
}
const tabBodies = [
  surfaces['page: 通用'].includes('rc-swatch'),
  surfaces['page: 会话树'].includes('rc-tree-row'),
  surfaces['page: 模式（人格）'].includes('rc-textarea'),
]
check('each configuration tab rendered its own body', tabBodies.every(Boolean), JSON.stringify(tabBodies))

// The tree's shape must not depend on the stylesheet arriving. DSH hot-reloads a
// client bundle into the live document, so a tag from an earlier revision can be
// the only CSS in the page — and when that happened, the fold caret fell back to
// the browser's default button (a small bordered box) and the tree stopped reading
// as a tree. Geometry is inline now; these two checks keep it that way.
const treeMarkup = surfaces['page: 会话树（折叠）']
const caretAt = treeMarkup.indexOf('rc-tree-caret')
check('the fold caret carries its own geometry (a stale or foreign stylesheet cannot box it)',
  caretAt >= 0 && treeMarkup.slice(caretAt, caretAt + 400).includes('border:none;background:transparent'),
  treeMarkup.slice(Math.max(0, caretAt), caretAt + 180))
check('the chevron shape and the indent guides are inline as well',
  treeMarkup.includes('border-right:1.6px solid currentColor')
    && treeMarkup.includes('width:18px;box-sizing:border-box'),
  'inline chevron/guide geometry')

// --------------------------------------------------------------------- page
const TOKENS_LIGHT = `
--dsw-alias-bg-base:#ffffff;--dsw-alias-label-primary:#1f2328;--dsw-alias-label-secondary:#6b7280;
--dsw-alias-label-dimmed:#b9bec6;--dsw-alias-border-l2:#d7dbe0;--dsw-alias-border-l3:#e3e6ea;
--dsw-alias-border-l4:#eef1f4;--dsw-alias-brand-primary:#2f6fed;
--dsw-alias-interactive-bg-hover:rgba(17,24,39,.06);--dsw-alias-state-success-primary:#22c55e;`
const TOKENS_DARK = `
--dsw-alias-bg-base:#191b20;--dsw-alias-label-primary:#e9ebef;--dsw-alias-label-secondary:#98a0aa;
--dsw-alias-label-dimmed:#596069;--dsw-alias-border-l2:#34383f;--dsw-alias-border-l3:#2b2f35;
--dsw-alias-border-l4:#23262b;--dsw-alias-brand-primary:#5b9bff;
--dsw-alias-interactive-bg-hover:rgba(255,255,255,.07);--dsw-alias-state-success-primary:#34d399;`

const wrapper = (label, markup, extraClass = '') =>
  `<section class="cell"><h3>${escapeHtml(label)}</h3><div class="stage ${extraClass}">${markup}</div></section>`

const page = (theme, tokens) => `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>remote-channel UI · ${theme}</title>
<style>
:root{${tokens}}
*{box-sizing:border-box}
body{margin:0;padding:26px 30px 40px;background:${theme === 'dark' ? '#0f1114' : '#f2f3f5'};
  color:var(--dsw-alias-label-primary);font-family:"Microsoft YaHei UI","Segoe UI",system-ui,sans-serif}
h1{font-size:18px;margin:0 0 4px}
.lead{font-size:12.5px;color:${theme === 'dark' ? '#9aa1ab' : '#5c636e'};margin:0 0 20px}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:22px}
.cell{margin:0}
.cell h3{font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;
  color:${theme === 'dark' ? '#9aa1ab' : '#5c636e'};margin:0 0 8px}
.stage{position:relative;border:1px dashed ${theme === 'dark' ? '#33373d' : '#d7dbe0'};border-radius:14px;
  padding:14px;background:${theme === 'dark' ? '#15171b' : '#fbfbfc'};min-height:110px;overflow:hidden}
/* The real plugin stylesheet goes here, verbatim. */
${css[0] ?? ''}
/* Preview-only unfixing: each surface lays out inside its own frame instead of
   covering the viewport, so several can be photographed at once. */
.stage .rc-overlay{position:static;inset:auto;background:none;backdrop-filter:none;padding:0}
.stage .rc-overlay>.rc-sheet{width:100%;max-height:none}
.stage .rc-sheet{width:100%;max-height:none;box-shadow:0 10px 30px rgba(0,0,0,.14)}
.stage .rc-pop{position:static;width:100%;top:auto;right:auto}
/* The crop mask dims the whole overlay in the app; inside one preview cell that
   would paint the cell black, so it keeps only its ring here. */
.stage .rc-crop-stage{box-shadow:inset 0 0 0 2px rgba(255,255,255,.9)}
</style></head>
<body>
<h1>远程通道 · 界面预览（${theme === 'dark' ? '深色' : '浅色'}主题）</h1>
<p class="lead">这些是这个插件真实的组件和样式表渲染出来的：右上角头像面板、配置页三个标签、头像裁剪。</p>
<div class="grid">
${wrapper('标题栏头像 + 面板', surfaces['chip + panel'])}
${wrapper('配置页 · 通用', surfaces['page: 通用'])}
${wrapper('配置页 · 会话树', surfaces['page: 会话树'])}
${wrapper('配置页 · 会话树（折叠）', surfaces['page: 会话树（折叠）'])}
${wrapper('配置页 · 模式（人格）', surfaces['page: 模式（人格）'])}
${wrapper('头像裁剪', surfaces['avatar crop'])}
</div>
</body></html>`

const browser = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((path) => existsSync(path))
check('a headless browser is available for the screenshot', browser !== undefined, browser ?? 'none')

mkdirSync(OUT_DIR, { recursive: true })
const shots = []
for (const theme of ['light', 'dark']) {
  const htmlPath = join(OUT_DIR, `ui-preview-${theme}.html`)
  const pngPath = join(OUT_DIR, `ui-preview-${theme}.png`)
  writeFileSync(htmlPath, page(theme, theme === 'dark' ? TOKENS_DARK : TOKENS_LIGHT), 'utf8')
  if (browser !== undefined) {
    execFileSync(browser, [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=2',
      '--window-size=1320,2600',
      `--screenshot=${pngPath}`,
      `file:///${htmlPath.replace(/\\/g, '/')}`,
    ], { stdio: 'ignore', timeout: 90_000 })
  }
  const exists = existsSync(pngPath)
  check(`${theme} screenshot written`, exists, pngPath)
  if (exists) shots.push(pngPath)
}

process.stderr.write(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED: ${failures.join(', ')}`}\n`)
for (const shot of shots) process.stderr.write(`  ${shot}\n`)
process.exit(failures.length === 0 ? 0 : 1)

