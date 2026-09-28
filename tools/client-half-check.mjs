/**
 * Offline check of the browser half (`lib/client.js`).
 *
 * The client bundle never runs under Node in production — the browser's module
 * loader consumes it. This harness stands in for that loader, so a typo in the
 * card, a wrong slot key, or a missing export fails here instead of silently
 * rendering nothing in Settings.
 *
 * It is deliberately dependency-free: `react` is stubbed down to the two entry
 * points the card uses, and the element tree it builds is walked directly.
 *
 *     node tools/client-half-check.mjs
 */

const failures = []
function check(label, condition, detail = '') {
  const mark = condition ? 'PASS' : 'FAIL'
  if (!condition) failures.push(label)
  process.stderr.write(`${mark}  ${label}${detail ? ` — ${detail}` : ''}\n`)
}

/**
 * Stand-in for React: `createElement`, a real (per-render) hook cell store, and
 * `useSyncExternalStore`. The state modelling matters: a component's closure
 * captures the value it rendered with, so a test that types and commits without
 * a re-render would be testing something React never does.
 */
/** One cell array per component function, the way React keeps state per instance. */
const cellsByComponent = new Map()
/** Which component is rendering right now; `walk` sets it around each call. */
let rendering = null
let hookIndex = 0

/** The cells of the component currently rendering. */
function currentCells() {
  let cells = cellsByComponent.get(rendering)
  if (cells === undefined) {
    cells = []
    cellsByComponent.set(rendering, cells)
  }
  return cells
}

const reactStub = {
  /**
   * React hands the children to the component as `props.children`, and so must
   * this: the shared `Field` wrapper reads them, and a stub that keeps them only
   * on the element would let a component that renders *nothing* pass.
   */
  createElement: (type, props, ...children) => {
    const kids = children.length <= 1 ? children[0] : children
    return { type, props: { ...(props ?? {}), children: kids }, children: kids }
  },
  useState: (initial) => {
    const cells = currentCells()
    const index = hookIndex
    hookIndex += 1
    if (cells[index] === undefined) {
      cells[index] = typeof initial === 'function' ? initial() : initial
    }
    const setter = (next) => {
      cells[index] = typeof next === 'function' ? next(cells[index]) : next
    }
    return [cells[index], setter]
  },
  useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
}

/** Render a component the way React would for one pass (hook order resets). */
function render(component, props) {
  rendering = component
  hookIndex = 0
  const tree = component(props)
  rendering = null
  hookIndex = 0
  return tree
}

/**
 * Forget every hook cell, the way unmounting everything would.
 *
 * Cells are kept per component across renders (that is what makes "type, then
 * commit on the next render" testable) but must not survive a mount/unmount.
 */
function resetHooks() {
  cellsByComponent.clear()
  rendering = null
  hookIndex = 0
}

/** The platform seed table the bundle may require from. */
function makeRequire(log) {
  return (id) => {
    log.push(id)
    if (id === 'react') return reactStub
    throw new Error(`client bundle requested a module outside the platform seed: ${id}`)
  }
}

/** Depth-first walk of the stubbed element tree. */
function walk(node, visit) {
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (typeof node !== 'object') return
  visit(node)
  // Render function components the way React would, so the tree under test is
  // the tree a browser gets (a row's own element carries the props a test wants,
  // its rendered output carries the controls).
  //
  // A component's children are rendered *by that component* (they reach it as
  // `props.children`), so this must not also walk `node.children` — doing both
  // would count every child of a wrapper like `Field` twice.
  if (typeof node.type === 'function') {
    const previous = rendering
    rendering = node.type
    hookIndex = 0
    walk(node.type(node.props ?? {}), visit)
    rendering = previous
    hookIndex = 0
    return
  }
  walk(node.children, visit)
}

const main = async () => {
  // --- the loader facade the bundle registers itself with
  let entry = null
  globalThis.window = {
    __ModuleLoader__: {
      load: (value) => {
        entry = value
      },
    },
  }

  const required = []
  await import('../lib/client.js')

  check('the bundle registers itself with the module loader', entry !== null)
  if (entry === null) {
    process.stderr.write('\n1 CHECK(S) FAILED\n')
    process.exit(1)
  }
  check('its module id is the package name', entry.id === 'dsh-plugin-remote', String(entry.id))
  check('it exposes a factory', typeof entry.factory === 'function')

  const clientModule = entry.factory(makeRequire(required))
  check('the factory exports apply()', typeof clientModule.apply === 'function')
  check('it injects the services it uses',
    Array.isArray(clientModule.inject) && clientModule.inject.includes('slots') && clientModule.inject.includes('settingsScope'),
    JSON.stringify(clientModule.inject))
  check('it requires nothing outside the platform seed',
    required.every((id) => id === 'react'),
    required.join(','))

  // --- mounting into the slot ledger
  let boundSpec = null
  const writes = []
  const scope = {
    getSnapshot: () => ({
      status: 'ready',
      value: { enabled: true, wechat: false, qq: true },
      user: { wechat: false },
      writable: true,
      revision: 3,
      mode: 'host',
    }),
    subscribe: () => () => {},
    set: (field, value) => {
      writes.push([field, value])
      return Promise.resolve()
    },
  }
  let injectedInto = null
  const injections = new Map()
  const ctx = {
    settingsScope: {
      bind: (spec) => {
        boundSpec = spec
        return scope
      },
    },
    slots: {
      inject: (name, factory) => {
        injectedInto = name
        const produced = factory()
        // The registrations are yielded by a generator so they can be replaced
        // without re-injecting; drive it once, exactly like the loader does.
        if (produced !== null && typeof produced === 'object' && typeof produced.next === 'function') {
          let step = produced.next()
          while (step.done !== true) step = produced.next()
        }
      },
      register: (options, component) => {
        injections.set(options.name, { options, component })
        return () => {}
      },
    },
  }

  clientModule.apply(ctx)

  // The plugin mounts two entries against one namespace: the Settings card and
  // the header chip. Both are exercised below, so neither can rot unnoticed.
  const registered = injections.get('settings.plugin.item') ?? null
  const chip = injections.get('conversation.session.header.utilities') ?? null

  check('it binds the Host settings namespace',
    boundSpec !== null && boundSpec.namespace === 'remote-channel',
    JSON.stringify(boundSpec))
  check('it injects into the plugin-card slot', injections.has('settings.plugin.item'), String(injectedInto))
  check('it registers the card under the settings namespace key',
    registered !== null && registered.options?.key === 'remote-channel' && registered.options?.name === 'settings.plugin.item',
    JSON.stringify(registered?.options))
  check('it hands the scope to the component', typeof registered?.options?.inject === 'function')

  // --- rendering and one interaction
  const props = { ...(registered?.options?.inject?.() ?? {}) }
  check('the card receives the scope', props.scope === scope)
  const tree = render(registered.component, props)

  const labels = []
  const texts = []
  const secrets = []
  let toggles = 0
  walk(tree, (node) => {
    if (typeof node.props?.label === 'string') labels.push(node.props.label)
    if (typeof node.props?.onToggle === 'function') toggles += 1
    if (node.props?.type === 'password') secrets.push(node)
    const kids = Array.isArray(node.children) ? node.children : [node.children]
    for (const kid of kids) if (typeof kid === 'string') texts.push(kid)
  })
  check('the card renders every switch', toggles === 3, `toggles=${toggles}`)
  check('the card names the plugin and both transports',
    texts.some((t) => t.includes('远程通道')) && labels.some((l) => l.includes('微信')) && labels.some((l) => l.includes('QQ')),
    `texts=${texts.join(' | ')} labels=${labels.join(' | ')}`)
  check('reply format and delivery mode stay out of the card',
    !labels.some((l) => l.includes('图片卡片')) && !labels.some((l) => l.includes('投递方式')),
    labels.join(' | '))
  check('the card exposes the one administrator-password field',
    labels.some((l) => l.includes('管理员密码')) && secrets.length === 1,
    `labels=${labels.join(' | ')} secrets=${secrets.length}`)

  // `apply()` reports the stylesheet revision it found on the document, so it is
  // the first thing written; the switch assertions below are about the *user's*
  // writes, so they filter the probe out.
  const userWrites = () => writes.filter(([field]) => field !== 'uiProbe')
  check('it reports which stylesheet revision the document carries',
    writes.some(([field, value]) => field === 'uiProbe' && String(value).startsWith('no-document css=')),
    JSON.stringify(writes.filter(([field]) => field === 'uiProbe')))

  let wechatRow = null
  walk(tree, (node) => {
    if (typeof node.props?.label === 'string' && node.props.label.includes('微信')) wechatRow = node
  })
  check('the WeChat switch reflects the stored value', wechatRow?.props?.checked === false,
    String(wechatRow?.props?.checked))
  wechatRow?.props?.onToggle(true)
  check('flipping it writes the settings field',
    userWrites().length === 1 && userWrites()[0][0] === 'wechat' && userWrites()[0][1] === true,
    JSON.stringify(writes))

  // The secret row is write-only: type into the draft, re-render (the Enter
  // handler is a closure that sees the value it rendered with), then commit.
  // One password covers both jobs, so it writes the single `fullAccessPassword`.
  const typeSecret = (index, value) => {
    secrets[index]?.props?.onChange?.({ target: { value } })
    const retyped = []
    walk(render(registered.component, props), (node) => {
      if (node.props?.type === 'password') retyped.push(node)
    })
    retyped[index]?.props?.onKeyDown?.({ key: 'Enter' })
  }
  typeSecret(0, 'hunter2')
  check('the administrator-password row writes its secret once',
    writes.filter(([field, value]) => field === 'fullAccessPassword' && value === 'hunter2').length === 1,
    JSON.stringify(writes))
  check('no stale second password field is written',
    !writes.some(([field]) => field === 'accessPassword'), JSON.stringify(writes))

  // --- the header chip: the front door to the same settings
  check('it registers a chip in the session header utilities',
    chip !== null && chip.options?.name === 'conversation.session.header.utilities',
    JSON.stringify(chip?.options))
  check('the chip sorts last in the header utilities, so it sits far right',
    typeof chip?.options?.id === 'string' && chip.options.id !== '' && chip.options.order >= 100,
    `${chip?.options?.id} @ ${chip?.options?.order}`)

  resetHooks()
  const chipWrites = []
  /** One tab's worth of mode schema, including a text box and a select. */
  const MODE_SCHEMA = [
    {
      name: 'default',
      label: '工作',
      description: '全部命令',
      fields: [],
      hasPrompt: false,
      pins: { imageReplies: null, richAcks: null, messageMode: null },
    },
    {
      name: 'focus',
      label: '专注',
      description: '只看状态',
      fields: [
        { key: 'persona', label: '人设', type: 'text', rows: 6, placeholder: '写点什么', help: '注入系统提示词', options: [], default: '' },
        { key: 'tone', label: '语气', type: 'select', options: ['冷静', '热情'], optionsLabel: '', placeholder: '', help: '', rows: 4, default: '冷静' },
        { key: 'strict', label: '严格', type: 'bool', placeholder: '', help: '', options: [], rows: 4, default: false },
      ],
      hasPrompt: true,
      pins: { imageReplies: false, richAcks: null, messageMode: 'queue' },
    },
  ]
  const chipScope = {
    ...scope,
    getSnapshot: () => ({
      status: 'ready',
      value: {
        enabled: true,
        wechat: false,
        qq: true,
        nickname: '小D',
        signature: '在的',
        mode: 'default',
        modes: 'default,focus',
        modeSchema: JSON.stringify(MODE_SCHEMA),
        modeData: JSON.stringify({ focus: { persona: '你是猫娘' } }),
        pinSessionId: 's2',
        pinLabel: 'beta（beta）',
        speakerLabel: 'alpha（alpha）',
        deliverMode: 'queue',
        imageReplies: true,
      },
      writable: true,
      revision: 4,
    }),
    set: (field, value) => {
      chipWrites.push([field, value])
      return Promise.resolve()
    },
  }
  /** The slot hands the component these two store hooks; the page needs them. */
  const fakeUseSessions = (selector) => selector({
    ids: ['s1', 's2', 's3'],
    byId: {
      s1: { id: 's1', displayTitle: 'alpha', updatedAt: Date.now() - 60_000, running: true },
      s2: { id: 's2', displayTitle: 'beta', updatedAt: Date.now() - 5 * 60_000, running: false },
      s3: { id: 's3', displayTitle: '探索子代理', parentId: 's1', origin: 'subagent', updatedAt: Date.now() - 2_000, running: false },
    },
    current: 's1',
  })
  const fakeUseWorkspaces = (selector) => selector({
    items: [{ id: 'w1', title: '订单服务', path: 'D:\\proj\\alpha', sessionIds: ['s1'] }],
    archivedSessionIds: [],
  })
  const chipProps = {
    ...(chip.options.inject() ?? {}),
    scope: chipScope,
    useSessions: fakeUseSessions,
    useWorkspaces: fakeUseWorkspaces,
  }
  check('the chip receives the scope', chipProps.scope === chipScope)

  /** Render the chip and collect what the tree holds. */
  const renderChip = () => {
    // `nodes` is every element (the tree rows are divs with role=button — a real
    // <button> may not contain the fold caret's <button>), `buttons` is only the
    // real ones.
    const found = { nodes: [], buttons: [], texts: [], files: [], toggles: 0 }
    walk(render(chip.component, chipProps), (node) => {
      if (typeof node.type === 'string') found.nodes.push(node)
      if (node.type === 'button') found.buttons.push(node)
      if (node.props?.type === 'file') found.files.push(node)
      if (typeof node.props?.onToggle === 'function') found.toggles += 1
      const kids = Array.isArray(node.children) ? node.children : [node.children]
      for (const kid of kids) if (typeof kid === 'string') found.texts.push(kid)
    })
    return found
  }
  const buttonWithText = (buttons, text) => buttons.find((button) => {
    const kids = Array.isArray(button.children) ? button.children : [button.children]
    return kids.includes(text)
  })

  const closed = renderChip()
  check('the closed chip is a single button showing the nickname',
    closed.buttons.length === 1 && closed.texts.includes('小D'),
    `${closed.buttons.length} buttons, texts=${closed.texts.join(' | ')}`)
  check('the closed chip does not show the panel',
    !closed.texts.includes('模式'), closed.texts.join(' | '))

  closed.buttons[0]?.props?.onClick?.()
  const opened = renderChip()
  check('clicking the chip opens the panel',
    opened.texts.includes('小D') && opened.texts.includes('在的')
      && opened.texts.some((t) => t.includes('打开配置页'))
      && opened.texts.some((t) => t.includes('模式')),
    opened.texts.join(' | '))
  check('the panel offers the mode buttons, the page button and the chip',
    opened.buttons.length === 4 && opened.buttons.some((b) => b.children === 'focus'),
    `${opened.buttons.length} buttons`)
  check('the panel names the current target and the last speaker',
    opened.texts.some((t) => t.includes('目标') && t.includes('beta') && t.includes('刚发过言')),
    opened.texts.join(' | '))
  buttonWithText(opened.buttons, 'focus')?.props?.onClick?.()
  check('a mode button writes the mode the chat would switch to',
    chipWrites.some(([field, value]) => field === 'mode' && value === 'focus'),
    JSON.stringify(chipWrites))

  // --- the configuration page behind 「打开配置页」
  const pageButton = buttonWithText(renderChip().buttons, (renderChip().texts.find((t) => t.startsWith('打开配置页'))))
  check('the panel has a button that opens the configuration page', pageButton !== undefined)
  pageButton?.props?.onClick?.()
  const page = renderChip()
  check('the page opens as an overlay with a tab per subject',
    page.texts.includes('通用') && page.texts.includes('会话树') && page.texts.includes('专注'),
    page.texts.join(' | '))
  check('the page shows the identity and the avatar picker',
    page.files.length === 1 && page.texts.includes('小D'),
    `files=${page.files.length}`)

  /** Commit one text-ish field the way a browser does: type, re-render, blur. */
  const commitField = (match, value, commitKey) => {
    const find = () => {
      const found = []
      walk(render(chip.component, chipProps), (node) => {
        if (match(node)) found.push(node)
      })
      return found[0]
    }
    find()?.props?.onChange?.({ target: { value } })
    // Enter carries the key; a blur carries only the target. Sending both keeps
    // one helper for either commit path.
    find()?.props?.[commitKey ?? 'onBlur']?.({ key: 'Enter', target: { value } })
  }
  commitField((node) => node.props?.type === 'text' && node.props?.placeholder === '卡片署名', '小D 2')
  check('the page writes the nickname',
    chipWrites.some(([field, value]) => field === 'nickname' && value === '小D 2'),
    JSON.stringify(chipWrites))
  commitField((node) => node.props?.type === 'password', 'hunter2', 'onKeyDown')
  check('the page writes the same single administrator password',
    chipWrites.filter(([field, value]) => field === 'fullAccessPassword' && value === 'hunter2').length === 1,
    JSON.stringify(chipWrites))
  const steerRow = renderChip().buttons
  let steerToggle = null
  walk(render(chip.component, chipProps), (node) => {
    if (node.props?.label === '派活插入正在跑的那一轮') steerToggle = node
  })
  steerToggle?.props?.onToggle(true)
  check('the page can switch the delivery mode too',
    chipWrites.some(([field, value]) => field === 'deliverMode' && value === 'steer'),
    JSON.stringify(chipWrites))

  // The session tree: rows come from the browser's own snapshot, and clicking one
  // pins the remote target through the same settings field `#use` writes.
  buttonWithText(renderChip().buttons, '会话树')?.props?.onClick?.()
  const treeTab = renderChip()
  /** Session rows only: the fold carets are elements too, and must not be counted. */
  const sessionRowsOf = (found) => found.nodes.filter((node) =>
    (node.props?.className ?? '').includes('rc-tree-row'))
  const caretsOf = (found) => found.nodes.filter((node) =>
    (node.props?.className ?? '').includes('rc-tree-caret'))
  const treeRows = sessionRowsOf(treeTab)
  check('the session tree lists every session, in both groupings',
    treeRows.length === 6
      && treeTab.texts.some((t) => t.includes('订单服务'))
      && treeTab.texts.some((t) => t.includes('未分组'))
      && treeTab.texts.some((t) => t.includes('分支')),
    `${treeRows.length} rows, texts=${treeTab.texts.join(' | ')}`)
  /** Depth is drawn as one hairline guide per ancestor, inside the fold gutter. */
  const gutterOf = (found, key) => {
    const row = sessionRowsOf(found).find((entry) => entry.props['data-key'] === key)
    const kids = Array.isArray(row?.children) ? row.children : []
    return kids.find((kid) => (kid?.props?.className ?? '') === 'rc-tree-gutter')
  }
  const guideCount = (found, key) => {
    const gutter = gutterOf(found, key)
    const kids = Array.isArray(gutter?.children) ? gutter.children : [gutter?.children]
    return kids.filter((kid) => (kid?.props?.className ?? '') === 'rc-tree-guide').length
  }
  check('the tree nests the subagent under its parent with one more guide line',
    guideCount(treeTab, 'g-s3') === guideCount(treeTab, 'g-s1') + 1 && guideCount(treeTab, 'l-s1') === 0,
    `s1=${guideCount(treeTab, 'g-s1')} guides, s3=${guideCount(treeTab, 'g-s3')} guides, lineage root=${guideCount(treeTab, 'l-s1')}`)
  check('the web tree draws no bracket art (that belongs on the phone card)',
    !JSON.stringify(treeRows.map((row) => row.children)).includes('└─'),
    JSON.stringify(treeRows.map((row) => row.children)).slice(0, 160))
  check('the tree marks the pinned session',
    treeRows.some((row) => row.props.title === 's2' && JSON.stringify(row.children).includes('当前')),
    JSON.stringify(treeRows.filter((row) => row.props.title === 's2').map((row) => row.children)))

  // --- folding: a caret on every row that has children, nothing on a leaf -----
  const carets = caretsOf(treeTab)
  const caretFor = (key, found = renderChip()) =>
    caretsOf(found).find((caret) => caret.props?.['data-row'] === key)
  const rowWithKey = (found, key) => sessionRowsOf(found).find((row) => row.props['data-key'] === key)
  const groupedRows = (found) => sessionRowsOf(found).filter((row) => (row.props['data-key'] ?? '').startsWith('g-'))
  const lineageRows = (found) => sessionRowsOf(found).filter((row) => (row.props['data-key'] ?? '').startsWith('l-'))
  // 5 grouped rows (2 workspace headers + s1 + s3 + s2) + 3 lineage rows, of which
  // 4 hang over something and so get a working caret.
  check('every tree row gets a caret slot, but only parents get a working one',
    carets.length === 8
      && carets.filter((caret) => caret.props.title === '折叠').length === 4
      && carets.filter((caret) => caret.props.title === '').every((caret) => caret.props.tabIndex === -1),
    `${carets.length} carets: ${carets.map((c) => `${c.props['data-row']}=${c.props.title || 'leaf'}`).join(', ')}`)
  check('a parent caret advertises that it can fold',
    caretFor('g-s1')?.props?.title === '折叠' && caretFor('g-s1')?.props?.['aria-expanded'] === true,
    JSON.stringify(caretFor('g-s1')?.props))

  caretFor('g-s1')?.props?.onClick?.({ stopPropagation: () => {} })
  const folded = renderChip()
  check('folding a node hides its subtree — in that tree only',
    rowWithKey(folded, 'g-s3') === undefined
      && rowWithKey(folded, 'g-s1') !== undefined
      && rowWithKey(folded, 'l-s3') !== undefined,
    `grouped=${groupedRows(folded).map((r) => r.props['data-key']).join(',')} lineage=${lineageRows(folded).map((r) => r.props['data-key']).join(',')}`)
  caretFor('g-s1', folded)?.props?.onClick?.({ stopPropagation: () => {} })
  check('clicking the same arrow again expands it', rowWithKey(renderChip(), 'g-s3') !== undefined,
    `grouped=${groupedRows(renderChip()).map((r) => r.props['data-key']).join(',')}`)

  // The fold target is the whole indent gutter, not just the 18px chevron: aiming
  // at a small box in a 40-row list is how "没法展开" happens.
  const beforeGutter = chipWrites.length
  gutterOf(renderChip(), 'g-s1')?.props?.onClick?.({ stopPropagation: () => {} })
  check('clicking the indent gutter folds, and does not switch the target',
    rowWithKey(renderChip(), 'g-s3') === undefined
      && !chipWrites.slice(beforeGutter).some(([field]) => field === 'pinSessionId'),
    `writes=${JSON.stringify(chipWrites.slice(beforeGutter))}`)
  gutterOf(renderChip(), 'g-s1')?.props?.onClick?.({ stopPropagation: () => {} })
  check('and the gutter expands it again', rowWithKey(renderChip(), 'g-s3') !== undefined)
  check('a workspace row folds wherever it is clicked',
    (() => {
      const group = renderChip().nodes.find((node) => (node.props?.className ?? '') === 'rc-tree-group'
        && node.props['data-key'] === 'g-ws-w1')
      return typeof group?.props?.onClick === 'function'
    })(), 'group rows are clickable as a whole')

  caretFor('g-s1')?.props?.onClick?.({ stopPropagation: () => {} })
  const foldedAgain = renderChip()
  check('a folded row says how many it is hiding and turns its caret round',
    foldedAgain.texts.includes('+1') && caretFor('g-s1', foldedAgain)?.props?.title === '展开',
    `counts=${foldedAgain.texts.filter((t) => t.startsWith('+')).join(',')} caret=${caretFor('g-s1', foldedAgain)?.props?.title}`)
  check('folding does not touch the remote target',
    !chipWrites.some(([field, value]) => field === 'pinSessionId' && value === 's3'),
    JSON.stringify(chipWrites.slice(-3)))

  // A whole workspace folds in one click, which is the point of the grouped tree.
  caretFor('g-ws-w1', folded)?.props?.onClick?.({ stopPropagation: () => {} })
  const workspaceFolded = renderChip()
  check('a workspace group folds all of its sessions away',
    rowWithKey(workspaceFolded, 'g-s1') === undefined
      && rowWithKey(workspaceFolded, 'g-s3') === undefined
      && rowWithKey(workspaceFolded, 'g-s2') !== undefined
      && workspaceFolded.texts.includes('+2'),
    `grouped=${groupedRows(workspaceFolded).map((r) => r.props['data-key']).join(',')} counts=${workspaceFolded.texts.filter((t) => t.startsWith('+')).join(',')}`)

  buttonWithText(renderChip().buttons, '全部折叠')?.props?.onClick?.()
  check('「全部折叠」 leaves only what has nothing above it',
    lineageRows(renderChip()).length === 2 && groupedRows(renderChip()).length === 0,
    `lineage=${lineageRows(renderChip()).map((r) => r.props['data-key']).join(',')} grouped=${groupedRows(renderChip()).length}`)
  check('a fold that swallows the current target says so on the folded row',
    (renderChip().texts.includes('← 当前')
      && groupedRows(renderChip()).every((row) => row.props['data-key'] !== 'g-s2')),
    `texts=${renderChip().texts.filter((t) => t.includes('当前')).join(',')}`)
  buttonWithText(renderChip().buttons, '全部展开')?.props?.onClick?.()
  check('「全部展开」 brings everything back',
    sessionRowsOf(renderChip()).length === 6 && !renderChip().texts.includes('+1'),
    `${sessionRowsOf(renderChip()).length} rows`)

  // Folding must survive looking at another tab: the operator folds a branch, goes
  // to check the switches, comes back — and expects the tree to still be folded.
  caretFor('g-s1')?.props?.onClick?.({ stopPropagation: () => {} })
  buttonWithText(renderChip().buttons, '通用')?.props?.onClick?.()
  buttonWithText(renderChip().buttons, '会话树')?.props?.onClick?.()
  check('a fold survives a trip to another tab',
    rowWithKey(renderChip(), 'g-s3') === undefined,
    `grouped=${groupedRows(renderChip()).map((r) => r.props['data-key']).join(',')}`)
  caretFor('g-s1')?.props?.onClick?.({ stopPropagation: () => {} })
  check('and unfolding still works afterwards', rowWithKey(renderChip(), 'g-s3') !== undefined)

  treeRows.find((row) => row.props.title === 's1')?.props?.onClick?.()
  check('clicking a tree row pins that session',
    chipWrites.some(([field, value]) => field === 'pinSessionId' && value === 's1'),
    JSON.stringify(chipWrites))
  buttonWithText(renderChip().buttons, '取消锁定（跟随最近活跃会话）')?.props?.onClick?.()
  check('and the page can release the pin',
    chipWrites.some(([field, value]) => field === 'pinSessionId' && value === ''),
    JSON.stringify(chipWrites))

  // A mode's own form is rendered from the schema in the profile, and saved into
  // `modeData` — the one blob a mode author can add fields to without code.
  buttonWithText(renderChip().buttons, '专注')?.props?.onClick?.()
  const modeTab = renderChip()
  const textarea = []
  walk(render(chip.component, chipProps), (node) => {
    if (node.type === 'textarea') textarea.push(node)
  })
  check('a mode tab renders the fields the mode declared',
    textarea.length === 1 && textarea[0].props.value === '你是猫娘'
      && modeTab.texts.includes('人设') && modeTab.texts.includes('语气'),
    `textareas=${textarea.length} value=${textarea[0]?.props?.value} texts=${modeTab.texts.join(' | ')}`)
  check('a mode tab says its text reaches the model',
    modeTab.texts.some((t) => t.includes('注入到系统提示词')),
    modeTab.texts.join(' | '))
  commitField((node) => node.type === 'textarea', '你是猫娘，说话带喵')
  const saved = chipWrites.filter(([field]) => field === 'modeData').map(([, value]) => value)
  check('editing a mode field writes the per-mode JSON blob',
    saved.length >= 1 && saved[saved.length - 1].includes('猫娘，说话带喵'),
    JSON.stringify(saved))

  // --- the pure helpers the UI is built on (exported for this file only)
  const ui = clientModule.__ui
  check('it exports its pure UI helpers for the offline check',
    ui !== undefined && typeof ui.cropSourceRect === 'function' && typeof ui.treeRows === 'function',
    typeof ui)

  // `cropSourceRect` is the whole point of the avatar flow: the operator picks a
  // *region*, so the kept square must follow the pan and the zoom exactly.
  const square = ui.cropSourceRect({ width: 400, height: 200 }, 200, 1, 0, 0)
  check('the crop starts on the centre square of the picture',
    square.side === 200 && square.sx === 100 && square.sy === 0, JSON.stringify(square))
  const zoomed = ui.cropSourceRect({ width: 400, height: 200 }, 200, 2, 0, 0)
  check('zooming in keeps a smaller square from the source',
    zoomed.side === 100 && zoomed.sx === 150 && zoomed.sy === 50, JSON.stringify(zoomed))
  const dragged = ui.cropSourceRect({ width: 400, height: 200 }, 200, 1, 80, 0)
  check('dragging the picture right reveals what was on its left',
    dragged.sx === 20, JSON.stringify(dragged))
  const overshoot = ui.cropSourceRect({ width: 400, height: 200 }, 200, 1, 999, 0)
  check('an over-drag is clamped to the picture edge', overshoot.sx === 0, JSON.stringify(overshoot))
  const tall = ui.cropSourceRect({ width: 100, height: 400 }, 200, 1, 0, 0)
  check('a tall picture is cropped from the middle of its height',
    tall.side === 100 && tall.sy === 150, JSON.stringify(tall))
  const clamped = ui.clampPan(square.width, square.height, 200, 999, 999)
  check('the pan is clamped so no corner of the picture is ever exposed',
    clamped.x === 100 && clamped.y === 0, JSON.stringify(clamped))

  check('relativeTime speaks in the units a phone reader wants',
    ui.relativeTime(Date.now() - 5_000) === '刚刚'
      && ui.relativeTime(Date.now() - 90 * 60_000) === '2 小时前'
      && ui.relativeTime(0) === '',
    `${ui.relativeTime(Date.now() - 5_000)} / ${ui.relativeTime(Date.now() - 90 * 60_000)}`)

  // --- the look: a stylesheet with hover/focus states, reached by class names
  buttonWithText(renderChip().buttons, '通用')?.props?.onClick?.()
  const classNames = []
  walk(render(chip.component, chipProps), (node) => {
    if (typeof node.props?.className === 'string') classNames.push(node.props.className)
  })
  const hasClass = (needle) => classNames.some((name) => name.includes(needle))
  check('the page is styled through the injected stylesheet',
    hasClass('rc-sheet') && hasClass('rc-pill') && hasClass('rc-card') && hasClass('rc-note'),
    classNames.join(' | ').slice(0, 200))
  check('the switches render as switch tracks, not bare checkboxes',
    hasClass('rc-switch') && hasClass('rc-row-label'),
    classNames.join(' | ').slice(0, 200))
  check('the avatar control offers a picker and a remove action',
    hasClass('rc-swatch') && hasClass('rc-btn') && hasClass('rc-file') === false,
    classNames.join(' | ').slice(0, 200))

  // --- an unavailable namespace renders nothing rather than a dead card
  const unavailable = {
    ...scope,
    getSnapshot: () => ({ status: 'unavailable', value: undefined, writable: false }),
  }
  resetHooks()
  check('an unavailable namespace renders no card',
    render(registered.component, { scope: unavailable }) === null)
  resetHooks()
  check('an unavailable namespace renders no chip',
    render(chip.component, { scope: unavailable }) === null)

  process.stderr.write(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED: ${failures.join(', ')}`}\n`)
  process.exit(failures.length === 0 ? 0 : 1)
}

void main()
