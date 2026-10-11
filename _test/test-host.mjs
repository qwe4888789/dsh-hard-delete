/**
 * dsh-hard-delete — host 半夹具单测。
 *
 * 全部在临时目录里跑，**不碰真实 ~/.dsh**：
 *   node _test/test-host.mjs
 *
 * 覆盖：会话定位（多项目 / 版本号文件名）、多帧 zstd 头部解码、概况、
 * 彻底删除（目录 + projcache 两种布局 + workspace.json 引用）、
 * 路径穿越防护、路由守卫（loopback / 同源 / 方法 / 体积 / confirm）、
 * 以及 `api-session/removed` 事件的发出。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

const HOME = mkdtempSync(join(tmpdir(), 'dhd-test-'))
process.env.DSH_HOME = HOME

const mod = await import('../lib/index.js')
const T = mod.__testing

let passed = 0
const failures = []

function ok(name, fn) {
  try {
    fn()
    passed++
  } catch (err) {
    failures.push(`${name}: ${err && err.message ? err.message : String(err)}`)
  }
}

function writeJson(file, data) {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
}

// ── 夹具 ────────────────────────────────────────────────────────────────────

const sessions = join(HOME, 'sessions')
const storages = join(HOME, 'storages')
const projDir = join(storages, 'session_projcache', 'sessions')

/** 两个真实 zstd 帧拼在一起 —— 复刻 DSH 会话日志的「多帧拼接」写法。 */
function multiFrameZstd(lines) {
  return Buffer.concat(lines.map((line) => zstdCompressSync(Buffer.from(line + '\n', 'utf8'))))
}

function makeSession(project, id, body, fileName = 'session.v4.jsonl.zstd') {
  const dir = join(sessions, project, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, fileName), body)
  return dir
}

// 会话 aaa：projcache 里没有条目，只能靠解日志头部拿元数据（多帧 zstd）
const AAA_DIR = makeSession('--E-fixture--', 'session-aaa', multiFrameZstd([
  JSON.stringify({ type: 'session', version: 4, id: 'session-aaa', createdAt: 1791000000000, cwd: 'E:\\fixture' }),
  JSON.stringify({ type: 'model/selection', data: {} }),
  JSON.stringify({ type: 'session/title', data: { title: '多帧标题' } }),
]))

// 会话 bbb：明文日志 + 旧版聚合 projcache 条目
const BBB_DIR = makeSession('--E-fixture--', 'session-bbb',
  JSON.stringify({ type: 'session', version: 0, id: 'session-bbb', createdAt: 1791000001000, cwd: 'E:\\fixture2' }) + '\n',
  'session.jsonl')

// 会话 ccc：同目录并存 v3 / v4，应取 v4
const CCC_DIR = makeSession('--E-other--', 'session-ccc',
  JSON.stringify({ type: 'session', version: 4, id: 'session-ccc', createdAt: 1791000002000, cwd: 'E:\\other' }) + '\n',
  'session.v4.jsonl.zstd')
writeFileSync(join(CCC_DIR, 'session.v3.jsonl.zstd'), Buffer.from('not-a-real-frame'))

// 会话 ddd：只有噪音首条消息，标题应回退为空（不拿样板消息当标题）
makeSession('--E-fixture--', 'session-ddd', multiFrameZstd([
  JSON.stringify({ type: 'session', version: 4, id: 'session-ddd', createdAt: 1791000003000, cwd: 'E:\\fixture' }),
  JSON.stringify({
    type: 'user/message',
    data: { content: [{ type: 'text', text: 'The approval policy changed from "ask" to "never" (changed by the user).' }] },
  }),
]))

// 会话 eee：空壳目录（宿主建了目录但没写着日志）—— 实测真实 ~/.dsh 里就有这种
mkdirSync(join(sessions, '--E-fixture--', 'session-empty'), { recursive: true })

// projcache：新版每会话文件（bbb 的） + 旧版聚合（aaa 的）
writeJson(join(projDir, 'session-bbb.json'), {
  version: 7,
  record: {
    identity: { formatVersion: 4, createdAt: 1791000001000, cwd: 'E:\\fixture2' },
    rows: { title: { val: 'bbb 标题' }, sessionStats: { val: { turns: 3 } } },
  },
})
writeJson(join(storages, 'session_projcache.json'), {
  unit: { name: 'session_projcache', version: 3 },
  global: null,
  tables: {
    sessions: {
      'session-aaa': {
        identity: { createdAt: 1791000000000, cwd: 'E:\\fixture' },
        rows: { title: { val: 'aaa 标题' }, sessionStats: { val: { turns: 7 } } },
      },
      'session-keep': { identity: { createdAt: 1, cwd: 'X' }, rows: { title: { val: '别动我' } } },
    },
  },
})

writeJson(join(storages, 'workspace.json'), {
  unit: { name: 'workspace', version: 2 },
  global: {
    initialized: true,
    workspaceIds: ['ws-1'],
    archivedSessionIds: ['session-bbb', 'session-keep'],
    pinnedSessionIds: ['session-bbb'],
  },
  tables: {
    workspaces: {
      'ws-1': { path: 'E:\\fixture', title: 'fixture', sessionIds: ['session-bbb', 'session-keep'] },
    },
  },
})

T.reloadConfig()

// ── 会话定位与元数据 ────────────────────────────────────────────────────────

ok('findSessionDir 跨项目定位', () => {
  const found = T.findSessionDir('session-aaa')
  assert.equal(found.project, '--E-fixture--')
  assert.equal(found.dir, AAA_DIR)
})

ok('findSessionDir 认带版本号的日志文件名', () => {
  const found = T.findSessionDir('session-ccc')
  assert.equal(found.project, '--E-other--')
})

ok('findSessionDir 找不到就是 null', () => {
  assert.equal(T.findSessionDir('session-nope'), null)
})

ok('空壳会话目录（没有日志文件）也算会话，不能永远删不掉', () => {
  const found = T.findSessionDir('session-empty')
  assert.ok(found, '目录名就是会话 id，应当认得出来')
  assert.equal(found.hasLog, false)
  const info = T.inspectSession('session-empty')
  assert.equal(info.hasLog, false)
  assert.equal(info.files, 0)
  assert.deepEqual(info.logFiles, [])
})

ok('sessionLogFiles 版本号高者优先，zstd 优先', () => {
  const files = T.sessionLogFiles(CCC_DIR)
  assert.equal(files.length, 2)
  assert.equal(files[0].name, 'session.v4.jsonl.zstd')
})

ok('多帧 zstd：两帧都要解出来（同步接口只解第一帧的坑）', () => {
  const text = T.decodeHeadFrames(join(AAA_DIR, 'session.v4.jsonl.zstd'), 64, 262144)
  assert.ok(text.includes('"session"'), '第一帧应解出 session 头')
  assert.ok(text.includes('多帧标题'), '第二帧的标题也要解出来')
})

ok('projcache 优先：aaa 走旧版聚合条目', () => {
  const meta = T.sessionMeta('session-aaa', AAA_DIR)
  assert.equal(meta.title, 'aaa 标题')
  assert.equal(meta.turns, 7)
  assert.equal(meta.metaSource, 'session_projcache.json')
})

ok('projcache 优先：bbb 走新版每会话文件', () => {
  const meta = T.sessionMeta('session-bbb', BBB_DIR)
  assert.equal(meta.title, 'bbb 标题')
  assert.equal(meta.metaSource, 'session_projcache/sessions')
})

ok('缺元数据时解日志头部兜底（标题来自 session/title 事件）', () => {
  const meta = T.sessionMeta('session-ddd', join(sessions, '--E-fixture--', 'session-ddd'))
  assert.equal(meta.title, null, '样板消息不能当标题')
  assert.equal(meta.cwd, 'E:\\fixture')
  assert.equal(meta.createdAt, 1791000003000)
})

ok('inspectSession 返回概况且不含绝对路径', () => {
  const info = T.inspectSession('session-aaa')
  assert.equal(info.sessionId, 'session-aaa')
  assert.equal(info.title, 'aaa 标题')
  assert.equal(info.cwd, 'E:\\fixture')
  assert.ok(info.files >= 1)
  assert.ok(info.bytes > 0)
  assert.deepEqual(info.logFiles, ['session.v4.jsonl.zstd'])
  const raw = JSON.stringify(info)
  assert.ok(!raw.includes(HOME), '响应里不能出现 home 绝对路径')
})

ok('inspectSession 对不存在的会话抛 404', () => {
  assert.throws(() => T.inspectSession('session-nope'), (err) => err.status === 404 && err.code === 'session-not-found')
})

// ── 路径穿越防护 ────────────────────────────────────────────────────────────

ok('assertSafeSegment 挡掉穿越与分隔符', () => {
  for (const bad of ['..', '.', 'a/b', 'a\\b', 'a\0b', '', null, 42]) {
    assert.throws(() => T.assertSafeSegment(bad, 'sessionId'), /sessionId/)
  }
  assert.equal(T.assertSafeSegment('session-ok', 'sessionId'), 'session-ok')
})

ok('deleteSession 对穿越 id 抛 400', () => {
  assert.throws(() => T.deleteSession('../etc'), (err) => err.status === 400 && err.code === 'invalid-sessionId')
})

// ── 删除 ────────────────────────────────────────────────────────────────────

ok('dryRun 只清点不落刀', () => {
  const report = T.deleteSession('session-bbb', { dryRun: true })
  assert.equal(report.dryRun, true)
  assert.equal(report.removed.sessionDir, false)
  assert.ok(existsSync(BBB_DIR), 'dryRun 后目录必须还在')
  assert.ok(report.bytes > 0)
})

  ok('deleteSession 删目录 + 两种 projcache 布局 + workspace.json 引用', () => {
  const report = T.deleteSession('session-bbb')

  assert.equal(report.removed.sessionDir, true)
  assert.equal(report.removed.projcacheEntry, true)
  assert.equal(report.removed.workspaceRefs, 3, 'workspace.json 里应有 3 处引用被清掉')
  assert.deepEqual(report.warnings, [])
  assert.ok(!existsSync(BBB_DIR), '会话目录必须没了')
  assert.ok(!existsSync(join(projDir, 'session-bbb.json')), '每会话 projcache 文件必须没了')

  const ws = JSON.parse(readFileSync(join(storages, 'workspace.json'), 'utf8'))
  assert.deepEqual(ws.global.archivedSessionIds, ['session-keep'])
  assert.deepEqual(ws.global.pinnedSessionIds, [])
  assert.deepEqual(ws.tables.workspaces['ws-1'].sessionIds, ['session-keep'])

  const proj = JSON.parse(readFileSync(join(storages, 'session_projcache.json'), 'utf8'))
  assert.ok(Object.prototype.hasOwnProperty.call(proj.tables.sessions, 'session-keep'), '别动别的会话')
})

ok('deleteSession 清掉空的项目目录', () => {
  // --E-fixture-- 下还有 aaa/ddd，不能删；先只断言它还在
  assert.ok(existsSync(join(sessions, '--E-fixture--')))
})

ok('deleteSession 删掉旧版聚合 projcache 条目', () => {
  const report = T.deleteSession('session-aaa')
  assert.equal(report.removed.projcacheTable, true)
  const proj = JSON.parse(readFileSync(join(storages, 'session_projcache.json'), 'utf8'))
  assert.ok(!Object.prototype.hasOwnProperty.call(proj.tables.sessions, 'session-aaa'))
  assert.ok(!existsSync(AAA_DIR))
})

ok('deleteSession 对已删除的会话抛 404', () => {
  assert.throws(() => T.deleteSession('session-bbb'), (err) => err.status === 404)
})

ok('cleanMetadataRefs 对没有引用的会话是空操作', () => {
  const out = T.cleanMetadataRefs('session-nobody')
  assert.equal(out.projcacheEntry, false)
  assert.equal(out.projcacheTable, false)
  assert.equal(out.workspaceRefs, 0)
  assert.deepEqual(out.warnings, [])
})

// ── HTTP 层 ─────────────────────────────────────────────────────────────────

const routes = new Map()
const emitted = []
const warnings = []

const ctx = {
  webServer: { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path) } },
  emit: (event, arg) => { emitted.push([event, arg]) },
  logger: { info: () => {}, warn: (...args) => warnings.push(args.join(' ')) },
}

mod.apply(ctx)
T.reloadConfig()

const PREFIX = '/api/dsh-hard-delete'

function makeReq({ method = 'POST', body, remoteAddress = '127.0.0.1', headers = {} } = {}) {
  const payload = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')
  return {
    method,
    socket: { remoteAddress },
    headers: Object.assign({ host: '127.0.0.1:19387', 'content-type': 'application/json' }, headers),
    async *[Symbol.asyncIterator]() {
      if (payload) yield payload
    },
  }
}

function makeRes() {
  const captured = {}
  return {
    captured,
    writeHead(status, headers) { captured.status = status; captured.headers = headers },
    end(body) { captured.body = body },
  }
}

async function call(path, reqOptions) {
  const route = routes.get(path)
  if (!route) throw new Error(`route not registered: ${path}`)
  const res = makeRes()
  await route.handler(makeReq(reqOptions), res)
  let json = null
  try { json = JSON.parse(res.captured.body) } catch { /* 可能不是 JSON */ }
  return { status: res.captured.status, json, raw: res.captured.body, headers: res.captured.headers }
}

await (async () => {
  ok('三条路由都注册了', () => {
    assert.ok(routes.has(PREFIX + '/config'))
    assert.ok(routes.has(PREFIX + '/inspect'))
    assert.ok(routes.has(PREFIX + '/delete'))
  })

  {
    const r = await call(PREFIX + '/config', { method: 'GET' })
    ok('GET /config 200 且带 apiPrefix', () => {
      assert.equal(r.status, 200)
      assert.equal(r.json.apiPrefix, PREFIX)
      assert.equal(r.json.limits.cleanMetadata, true)
      assert.ok(Array.isArray(r.json.configErrors))
    })
  }

  {
    const r = await call(PREFIX + '/config', { method: 'POST' })
    ok('非 GET 的 /config → 405', () => assert.equal(r.status, 405))
  }

  {
    const r = await call(PREFIX + '/config', { method: 'GET', remoteAddress: '10.0.0.5' })
    ok('非 loopback → 403 loopback-only', () => {
      assert.equal(r.status, 403)
      assert.equal(r.json.code, 'loopback-only')
    })
  }

  {
    const r = await call(PREFIX + '/config', { method: 'GET', headers: { host: 'evil.example.com' } })
    ok('非白名单 Host → 403', () => assert.equal(r.status, 403))
  }

  {
    const r = await call(PREFIX + '/config', { method: 'GET', headers: { 'sec-fetch-site': 'cross-site' } })
    ok('跨站 sec-fetch-site → 403', () => assert.equal(r.status, 403))
  }

  {
    const r = await call(PREFIX + '/config', { method: 'GET', headers: { origin: 'http://evil.example.com' } })
    ok('跨源 Origin → 403', () => assert.equal(r.status, 403))
  }

  {
    const r = await call(PREFIX + '/config', { method: 'GET', headers: { origin: 'http://127.0.0.1:19387' } })
    ok('同源 Origin → 200', () => assert.equal(r.status, 200))
  }

  {
    const r = await call(PREFIX + '/delete', { method: 'GET', body: { sessionId: 'session-ccc' } })
    ok('非 POST 的 /delete → 405', () => assert.equal(r.status, 405))
  }

  {
    const r = await call(PREFIX + '/delete', { body: '{ not json' })
    ok('非法 JSON → 400 invalid-json', () => {
      assert.equal(r.status, 400)
      assert.equal(r.json.code, 'invalid-json')
    })
  }

  {
    const r = await call(PREFIX + '/delete', { body: { sessionId: 'session-ccc' } })
    ok('缺 confirm → 400 confirm-required', () => {
      assert.equal(r.status, 400)
      assert.equal(r.json.code, 'confirm-required')
    })
  }

  {
    const r = await call(PREFIX + '/inspect', { body: { sessionId: 'session-ccc' } })
    ok('/inspect 认得会话', () => {
      assert.equal(r.status, 200)
      assert.equal(r.json.sessionId, 'session-ccc')
    })
  }

  {
    const r = await call(PREFIX + '/inspect', { body: { sessionId: 'session-nope' } })
    ok('/inspect 不存在 → 404', () => assert.equal(r.status, 404))
  }

  {
    const r = await call(PREFIX + '/delete', { body: { sessionId: 'session-ccc', confirm: true } })
    ok('/delete 200 且发出 api-session/removed', () => {
      assert.equal(r.status, 200)
      assert.equal(r.json.sessionId, 'session-ccc')
      assert.equal(r.json.emitted, true)
      assert.deepEqual(emitted[emitted.length - 1], ['api-session/removed', 'session-ccc'])
    })
    ok('/delete 真的删掉了目录', () => assert.ok(!existsSync(CCC_DIR)))
    ok('/delete 顺手收掉了空的项目目录', () => assert.ok(!existsSync(join(sessions, '--E-other--'))))
  }

  {
    const r = await call(PREFIX + '/delete', { body: { sessionId: 'session-ddd', confirm: 'true' } })
    ok('confirm 接受字符串 "true"', () => assert.equal(r.status, 200))
  }

  {
    const r = await call(PREFIX + '/delete', { body: { sessionId: 'session-nope', confirm: true } })
    ok('/delete 不存在 → 404', () => assert.equal(r.status, 404))
  }

  {
    const big = 'x'.repeat(70000)
    const r = await call(PREFIX + '/delete', { body: JSON.stringify({ sessionId: big }) })
    ok('超大 body → 413', () => assert.equal(r.status, 413))
  }
})()

// ── 关闭事件发射 ────────────────────────────────────────────────────────────

{
  process.env.HARD_DELETE_CONFIG = join(HOME, 'no-emit.config.json')
  writeJson(process.env.HARD_DELETE_CONFIG, { emitRemovedEvent: false })
  T.reloadConfig()

  const routes2 = new Map()
  const emitted2 = []
  const ctx2 = {
    webServer: { register: (route) => { routes2.set(route.path, route); return () => {} } },
    emit: (event, arg) => emitted2.push([event, arg]),
    logger: { info: () => {}, warn: () => {} },
  }
  mod.apply(ctx2)
  T.reloadConfig()

  makeSession('--E-fixture--', 'session-eee',
    JSON.stringify({ type: 'session', version: 4, id: 'session-eee', createdAt: 1, cwd: 'E:\\fixture' }) + '\n',
    'session.jsonl')

  const res = makeRes()
  await routes2.get(PREFIX + '/delete').handler(
    makeReq({ body: { sessionId: 'session-eee', confirm: true } }),
    res,
  )
  const parsed = JSON.parse(res.captured.body)

  ok('emitRemovedEvent:false 时不发事件、不算 warning', () => {
    assert.equal(res.captured.status, 200)
    assert.equal(parsed.emitted, false)
    assert.equal(emitted2.length, 0)
    assert.deepEqual(parsed.warnings, [])
  })

  delete process.env.HARD_DELETE_CONFIG
  T.reloadConfig()
}

// ── 汇总 ────────────────────────────────────────────────────────────────────

try { rmSync(HOME, { recursive: true, force: true }) } catch { /* ignore */ }

if (failures.length > 0) {
  console.error(`\n${failures.length} 项失败：`)
  for (const f of failures) console.error('  ✗ ' + f)
  console.error(`\n通过 ${passed} 项。`)
  process.exit(1)
}
console.log(`✓ dsh-hard-delete host 夹具单测：${passed} 项全部通过`)
