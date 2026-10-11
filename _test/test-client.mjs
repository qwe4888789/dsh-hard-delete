/**
 * dsh-hard-delete — client 半离线单测。
 *
 *   node _test/test-client.mjs
 *
 * 浏览器半没法在 Node 里真跑 React，所以这里用**最小 hooks 运行时 + 元素树断言**
 * 把一个渲染 pass 走一遍，够抓出这些最容易翻车的错误：
 *   - factory / apply 的形态不对（注册不上槽位）
 *   - 文案 key 拼错（tt("warnRuning") 之类静默回退成 key 本身）
 *   - 组件里 require 了浏览器模块表里没有的包（本机 primitives 就不是客户端模块）
 *   - 菜单项没有把请求写进浮层读的那个 store（点了没反应）
 *   - 缺 slots API 时静默不生效
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT_SRC = join(HERE, '..', 'lib', 'client.js')

let passed = 0
const failures = []

/**
 * 永不解析的 fetch：组件挂载时会去读 /config 与 /inspect，这里让它们停在
 * 「取数中」的初态 —— 单测不模拟网络，但要保证不产生 unhandled rejection。
 */
globalThis.fetch = () => new Promise(() => {})

function ok(name, fn) {
  try { fn(); passed++ } catch (err) { failures.push(`${name}: ${err && err.message ? err.message : String(err)}`) }
}

// ── 最小 React（够渲染一个 pass + 手动触发状态变更） ─────────────────────────

function makeHooks() {
  const slots = []
  let cursor = 0
  return {
    /** 复位成「全新一次挂载」：游标归零 + 状态清空。 */
    reset() { cursor = 0; slots.length = 0 },
    /** 只把游标拉回起点（保留状态），用于模拟一次 re-render。 */
    rewind() { cursor = 0 },
    useState(init) {
      const i = cursor++
      if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init
      const set = (value) => { slots[i] = typeof value === 'function' ? value(slots[i]) : value }
      return [slots[i], set]
    },
    useRef(init) {
      const i = cursor++
      if (!(i in slots)) slots[i] = { current: init }
      return slots[i]
    },
    useCallback(fn) { cursor++; return fn },
    /**
     * 副作用在「挂载后」立即跑一次（React 的真实顺序），返回的清理函数不调用。
     * 组件里那些只读探测/取数都写在 effect 里，不跑就等于没测。
     */
    useEffect(fn) {
      cursor++
      try { fn() } catch { /* effect 抛错在真实 React 里也只是被捕获上报 */ }
    },
  }
}

function makeReact(hooks) {
  const Fragment = Symbol('Fragment')
  const createElement = (type, props, ...children) => ({
    type,
    props: Object.assign({}, props || {}, {
      children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children,
    }),
  })
  return Object.assign({ Fragment, createElement }, hooks)
}

/** 加载一次 client.js，拿到它注册进 __ModuleLoader__ 的 factory。 */
async function loadFactory(hooks, onRequire) {
  const captured = []
  globalThis.window = { __ModuleLoader__: { load(spec) { captured.push(spec) } } }
  globalThis.document = {
    head: { appendChild() {} },
    getElementById() { return null },
    createElement() { return { id: '', textContent: '', dataset: {} } },
    addEventListener() {},
    removeEventListener() {},
  }

  const url = `file:///${CLIENT_SRC.replace(/\\/g, '/')}?t=${Date.now()}-${Math.random()}`
  await import(url)
  assert.equal(captured.length, 1, 'client.js 必须调用一次 window.__ModuleLoader__.load')
  assert.equal(captured[0].id, 'dsh-hard-delete')

  const react = makeReact(hooks)
  const requireStub = (spec) => {
    if (onRequire) onRequire(spec)
    if (spec === 'react') return react
    // 浏览器模块表里只有平台种子词与声明了 dsh.client 的 Loader 条目：
    // 本插件刻意只依赖 react，其它一概不许 require。
    throw new Error(`client-modules: require("${spec}") missed the module table`)
  }

  return { factory: captured[0].factory, requireStub }
}

/**
 * 渲染一个函数组件。passes > 1 时模拟「effect 里 setState → 再渲染一次」，
 * 这次不清理状态槽（否则第二次渲染会把刚设的状态又初始化掉）。
 */
function render(hooks, component, props, passes = 1) {
  hooks.reset()
  let element = component(props)
  for (let i = 1; i < passes; i++) {
    hooks.rewind()
    element = component(props)
  }
  return element
}

/** 若元素类型是自定义函数组件，就把它求值一层；宿主标签/字符串原样返回。 */
function unwrap(element) {
  if (element && typeof element.type === 'function') return element.type(element.props)
  return element
}

// ── 静态检查 ────────────────────────────────────────────────────────────────

const source = readFileSync(CLIENT_SRC, 'utf8')

function fallbackKeys() {
  const block = source.match(/const FALLBACK_TEXT = \{([\s\S]*?)\n\t\t\};/)
  assert.ok(block, '应能定位 FALLBACK_TEXT')
  return [...block[1].matchAll(/^\t\t\t(\w+):/gm)].map((m) => m[1])
}

ok('DICT 的 zh / en 键集一致', () => {
  const zh = source.match(/zh:\s*\{([\s\S]*?)\},\s*en:/)
  const en = source.match(/en:\s*\{([\s\S]*?)\},\s*\};/)
  assert.ok(zh && en, '应能定位 DICT 的 zh / en 两段')
  const keys = (block) => [...block.matchAll(/"([^"]+)":/g)].map((m) => m[1]).sort()
  assert.deepEqual(keys(zh[1]), keys(en[1]))
})

ok('FALLBACK_TEXT 没有重复 key', () => {
  const keys = fallbackKeys()
  assert.ok(keys.length > 0)
  assert.equal(new Set(keys).size, keys.length)
})

ok('源码里每一处 tt("…") / t("…") 的 key 都有兜底文案', () => {
  const known = new Set([...fallbackKeys(), 'menu.delete'])
  const used = [...source.matchAll(/\bt{1,2}\("([a-zA-Z][\w.]*)"\)/g)].map((m) => m[1])
  assert.ok(used.length > 10, `应能抓到足够多的文案调用，实际 ${used.length}`)
  const missing = [...new Set(used)].filter((key) => !known.has(key))
  assert.deepEqual(missing, [], `这些文案 key 没有兜底：${missing.join(', ')}`)
})

ok('只 require("react")：不依赖任何浏览器模块表里没有的包', () => {
  const specs = [...source.matchAll(/require\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1])
  assert.deepEqual([...new Set(specs)], ['react'])
})

// ── 主场景 ──────────────────────────────────────────────────────────────────

const hooks = makeHooks()
const required = []
const scenario = await loadFactory(hooks, (spec) => required.push(spec))

ok('factory 返回 name / inject / apply，且只 require react', () => {
  const exports = scenario.factory(scenario.requireStub)
  assert.deepEqual([...new Set(required)], ['react'])
  assert.equal(exports.name, 'dsh-hard-delete/client')
  assert.deepEqual(exports.inject, ['slots', 'locale'])
  assert.equal(typeof exports.apply, 'function')
})

{
  const exports = scenario.factory(scenario.requireStub)
  const registrations = []
  const dictionaries = []
  const ctx = {
    effect: (fn) => { fn(); return () => {} },
    locale: {
      register: (ns, dict) => { dictionaries.push([ns, dict]); return () => {} },
      bind: () => (key) => key,
    },
    // 假装 session-x 就是当前打开的会话（retainedBy.mainView > 0）——
    // 用来验证「当前会话」那条额外警告会出现。
    get: (name) => (name === 'sessions'
      ? { list: { getSnapshot: () => ({ byId: { 'session-x': { retainedBy: { mainView: 1 } } } }) } }
      : null),
    slots: {
      inject: (key, callback) => { callback(); return () => {} },
      register: (options, component) => { registrations.push({ options, component }); return () => {} },
    },
  }

  ok('apply 注册了菜单项与浮层两个槽位', () => {
    exports.apply(ctx)
    assert.equal(registrations.length, 2)

    const menu = registrations.find((r) => r.options.name === 'sidebar.workspaces.session.menu.item')
    assert.ok(menu, '应注册会话「…」菜单项')
    assert.equal(menu.options.id, 'hard-delete')
    assert.equal(menu.options.order, 500, '应排在 archive(400) 之后')
    assert.equal(menu.options.locale, 'hard-delete')

    const overlay = registrations.find((r) => r.options.name === 'shell.overlay')
    assert.ok(overlay, '确认框必须挂在常驻浮层上（菜单项会随菜单卸载）')
    assert.equal(overlay.options.id, 'hard-delete-confirm')

    assert.equal(dictionaries.length, 1)
    assert.equal(dictionaries[0][0], 'hard-delete')
    assert.equal(dictionaries[0][1].zh['menu.delete'], '删除')
  })

  ok('缺 slots API 时 apply 明确报错（而不是静默不生效）', () => {
    assert.throws(
      () => exports.apply({ effect: () => {}, locale: { register: () => {}, bind: () => () => '' } }),
      /no usable slots API/,
    )
  })

  const menuEntry = registrations.find((r) => r.options.name === 'sidebar.workspaces.session.menu.item')
  const overlayEntry = registrations.find((r) => r.options.name === 'shell.overlay')
  const t = (key) => ({ 'menu.delete': '删除' }[key] ?? key)

  ok('浮层：没有待确认请求时什么都不渲染', () => {
    assert.equal(render(hooks, overlayEntry.component, { t }), null)
  })

  ok('菜单项：与官方行同构（separator + role=menuitem 的危险按钮），点了关菜单并写入请求', () => {
    let closed = null
    const element = render(hooks, menuEntry.component, {
      sessionId: 'session-x',
      displayTitle: '某会话',
      useMenuOpenState: () => [true, (v) => { closed = v }],
      t,
    })
    assert.ok(element, '菜单项必须渲染出东西')
    assert.equal(element.type, 'div')

    const [separator, button] = element.props.children
    assert.equal(separator.type, 'div')
    assert.equal(separator.props.role, 'separator')
    assert.equal(separator.props.className, 'dhd-separator')

    assert.equal(button.type, 'button')
    assert.equal(button.props.role, 'menuitem', '菜单的键盘遍历读的是 role=menuitem')
    assert.ok(String(button.props.className).includes('dhd-danger'), '删除行必须是危险色')
    const [icon, label] = button.props.children
    assert.equal(icon.props.className, 'dhd-icon')
    assert.equal(icon.props.children.type.name, 'TrashIcon', '图标应是自绘的 14px 垃圾桶')
    assert.equal(label.props.children, '删除')

    button.props.onClick()
    assert.equal(closed, false, '点了菜单必须自己关掉菜单')
  })

  ok('浮层：有请求时渲染确认框（三条警告齐全，默认焦点在取消）', () => {
    // 两遍：第一遍跑 effect（其中一步探测「是不是当前会话」并 setState），
    // 第二遍才是界面最终的样子。
    const element = render(hooks, overlayEntry.component, { t }, 2)
    assert.ok(element, '有待确认请求时必须渲染确认框')

    const backdrop = element.props.children[0]
    assert.equal(backdrop.props.className, 'dhd-backdrop')

    const modal = backdrop.props.children
    assert.equal(modal.props.role, 'dialog')
    assert.equal(modal.props['aria-modal'], 'true')

    const [title, desc, rows, ...rest] = modal.props.children
    assert.equal(title.props.children, '彻底删除这个会话？')
    assert.equal(desc.props.children, '会话「某会话」')
    assert.ok(rows, '应渲染概况区（取数中也要有形）')

    const warns = rest.filter((node) => node && String(node.props.className).includes('dhd-warn'))
    assert.equal(warns.length, 3, `应有 3 条警告（不可恢复 / 当前会话 / 可能仍在写盘），实际 ${warns.length}`)
    for (const warn of warns) assert.equal(typeof warn.props.children, 'string')

    const foot = rest.find((node) => node && node.props.className === 'dhd-foot')
    assert.ok(foot, '应有按钮行')
    const [cancel, confirm] = foot.props.children
    assert.equal(cancel.props.children, '取消')
    assert.equal(confirm.props.children, '彻底删除')
    assert.ok(String(confirm.props.className).includes('dhd-danger'))
    assert.equal(typeof cancel.props.ref, 'object', '默认焦点应落在取消按钮上')
  })
}

// ── 降级场景：sessions 服务取不到 ───────────────────────────────────────────

{
  const hooksB = makeHooks()
  const scenarioB = await loadFactory(hooksB)
  const exportsB = scenarioB.factory(scenarioB.requireStub)
  const registrations = []
  const ctx = {
    effect: (fn) => { fn(); return () => {} },
    locale: { register: () => () => {}, bind: () => (key) => key },
    get: () => { throw new Error('sessions service unavailable') },
    slots: {
      inject: (key, callback) => { callback(); return () => {} },
      register: (options, component) => { registrations.push({ options, component }); return () => {} },
    },
  }

  ok('sessions 服务取不到时 apply 与渲染都不炸', () => {
    exportsB.apply(ctx)
    assert.equal(registrations.length, 2)
    const overlay = registrations.find((r) => r.options.name === 'shell.overlay')
    const menu = registrations.find((r) => r.options.name === 'sidebar.workspaces.session.menu.item')

    const element = render(hooksB, menu.component, { sessionId: 'session-y', displayTitle: '另一个会话', t: (k) => k })
    element.props.children[1].props.onClick()

    const rendered = render(hooksB, overlay.component, { t: (k) => k }, 2)
    assert.ok(rendered, '应当照样渲染出确认框')
    const modal = rendered.props.children[0].props.children
    assert.equal(modal.props.role, 'dialog')
    // 探测失败 => 不该出现「当前会话」那条警告
    const warns = modal.props.children.filter((n) => n && String(n.props.className).includes('dhd-warn'))
    assert.equal(warns.length, 2, `探测不到当前会话时只应有 2 条警告，实际 ${warns.length}`)
  })
}

// ── 汇总 ────────────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error(`\n${failures.length} 项失败：`)
  for (const f of failures) console.error('  ✗ ' + f)
  console.error(`\n通过 ${passed} 项。`)
  process.exit(1)
}
console.log(`✓ dsh-hard-delete client 离线单测：${passed} 项全部通过`)
