/**
 * dsh-hard-delete — 真数据副本上的端到端验证（**不碰真实 ~/.dsh**）。
 *
 *   node _test/verify-e2e-copy.mjs
 *
 * 做法：把真实 `<home>/sessions` 与 `<home>/storages` **整份复制**到临时目录，
 * 把 DSH_HOME 指向副本，然后走**完整 HTTP 栈**（loopback 守卫 → 读 body →
 * confirm 校验 → 删除 → 发 `api-session/removed`）删掉其中一个真实会话，最后
 * 逐项核对磁盘结果。
 *
 * 为什么值得单独跑：夹具里的会话是我们自己造的；真实会话目录里有宿主写的
 * 多版本日志文件、真实 projcache 两种布局、真实 workspace.json 结构。
 * 只有拿真数据的副本走一遍完整链路，才敢让别人拿真库开刀。
 */
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REAL_HOME = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
const COPY = mkdtempSync(join(tmpdir(), 'dhd-e2e-'))

for (const part of ['sessions', 'storages']) {
  const from = join(REAL_HOME, part)
  if (!existsSync(from)) {
    console.log(`真实 home 里没有 ${part}/，跳过端到端验证。`)
    process.exit(0)
  }
  cpSync(from, join(COPY, part), { recursive: true })
}

process.env.DSH_HOME = COPY

const mod = await import('../lib/index.js')
const T = mod.__testing
T.reloadConfig()

console.log(`真实 home = ${REAL_HOME}`)
console.log(`副本 home = ${COPY}\n`)

function listSessionDirs() {
  const out = []
  const root = T.sessionsRoot()
  if (!existsSync(root)) return out
  for (const project of readdirSync(root)) {
    const projectDir = join(root, project)
    try { if (!statSync(projectDir).isDirectory()) continue } catch { continue }
    for (const id of readdirSync(projectDir)) {
      const dir = join(projectDir, id)
      try { if (!statSync(dir).isDirectory()) continue } catch { continue }
      out.push({ project, id, dir })
    }
  }
  return out
}

const before = listSessionDirs()
assert.ok(before.length > 0, '副本里应当有会话')

// 挑一个有日志、且顺带覆盖「同目录多版本日志」的会话；没有就退而取第一个。
const target = before.find((s) => T.sessionLogFiles(s.dir).length > 1) ?? before[0]
const victimDir = target.dir
const victimId = target.id
const projectDir = join(T.sessionsRoot(), target.project)

const victimLogs = T.sessionLogFiles(victimDir).map((f) => f.name)
console.log(`目标会话：${target.project}/${victimId}`)
console.log(`  日志文件：${victimLogs.join(', ') || '（无）'}`)
console.log(`  概况：${JSON.stringify(T.inspectSession(victimId))}\n`)

// ── 走完整 HTTP 栈删掉它 ────────────────────────────────────────────────────

const routes = new Map()
const emitted = []
const ctx = {
  webServer: { register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path) } },
  emit: (event, arg) => emitted.push([event, arg]),
  logger: { info: () => {}, warn: (...a) => console.log('  [host warn]', a.join(' ')) },
}
mod.apply(ctx)
T.reloadConfig()

const PREFIX = '/api/dsh-hard-delete'

function makeReq(body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  return {
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:19387', 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() { yield payload },
  }
}

const captured = {}
const res = {
  writeHead(status, headers) { captured.status = status; captured.headers = headers },
  end(body) { captured.body = body },
}

await routes.get(PREFIX + '/delete').handler(makeReq({ sessionId: victimId, confirm: true }), res)
const report = JSON.parse(captured.body)

console.log(`HTTP ${captured.status}`)
console.log(JSON.stringify(report, null, 2))

// ── 逐项核对 ────────────────────────────────────────────────────────────────

const checks = []
function check(name, condition, detail = '') {
  checks.push({ name, ok: condition === true, detail })
}

check('HTTP 200', captured.status === 200, String(captured.status))
check('会话目录已删除', !existsSync(victimDir))
check('每会话 projcache 文件已删除', !existsSync(T.projcacheEntryFile(victimId)))
check('发出了 api-session/removed', emitted.some(([e, a]) => e === 'api-session/removed' && a === victimId))

const after = listSessionDirs()
check('只少了这一个会话', after.length === before.length - 1, `${before.length} → ${after.length}`)
check('其它会话都还在', after.every((s) => before.some((b) => b.project === s.project && b.id === s.id)))

check('聚合 projcache 仍是合法 JSON', (() => {
  try { JSON.parse(readFileSync(T.projcacheFile(), 'utf8')); return true } catch { return false }
})())
check('workspace.json 仍是合法 JSON', (() => {
  try { JSON.parse(readFileSync(T.workspaceFile(), 'utf8')); return true } catch { return false }
})())

const ws = JSON.parse(readFileSync(T.workspaceFile(), 'utf8'))
const refsLeft = [
  ...(ws.global?.archivedSessionIds ?? []),
  ...(ws.global?.pinnedSessionIds ?? []),
  ...Object.values(ws.tables?.workspaces ?? {}).flatMap((w) => w.sessionIds ?? []),
].filter((id) => id === victimId)
check('workspace.json 里没有残留引用', refsLeft.length === 0, refsLeft.join(','))

// 项目目录：这个项目下如果还有别的会话就不能被收掉
const othersInProject = after.filter((s) => s.project === target.project).length
if (othersInProject === 0) check('项目目录空了也被收掉', !existsSync(projectDir))
else check('项目目录下还有别的会话，不能收掉', existsSync(projectDir))

// 真实日志里的元数据仍然读得出来（没被误伤）
const survivor = after.find((s) => s.project === target.project) ?? after[0]
const survivorInfo = T.inspectSession(survivor.id)
check('幸存会话仍然可读', typeof survivorInfo.sessionId === 'string', JSON.stringify(survivorInfo).slice(0, 120))

console.log()
for (const c of checks) console.log(`${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? '  (' + c.detail + ')' : ''}`)

try { rmSync(COPY, { recursive: true, force: true }) } catch { /* ignore */ }

const failed = checks.filter((c) => !c.ok)
if (failed.length > 0) {
  console.error(`\n${failed.length} 项未通过。`)
  process.exit(1)
}
console.log(`\n✓ 端到端验证通过（${checks.length} 项）——真实 ~/.dsh 全程未被修改`)
