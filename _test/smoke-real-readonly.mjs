/**
 * dsh-hard-delete — 对真实 DSH_HOME 的**只读**冒烟。
 *
 *   node _test/smoke-real-readonly.mjs
 *
 * 只调 inspectSession / sessionMeta 这类读路径，**不删任何东西、不写任何文件**。
 * 价值：夹具里的 zstd 是我们自己压的；真实日志是宿主写的多帧拼接，
 * 真实 projcache 是宿主写的两种布局 —— 只有拿真数据跑一遍才知道解析对不对。
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const mod = await import('../lib/index.js')
const T = mod.__testing

T.reloadConfig()

const home = T.homeDir()
const root = T.sessionsRoot()
console.log(`home      = ${home}`)
console.log(`sessions  = ${root}`)

if (!existsSync(root)) {
  console.log('没有 sessions 目录，跳过。')
  process.exit(0)
}

/** 收集 sessions/<project>/<sessionId> —— 只看目录，不下任何删除命令。 */
function listSessions() {
  const out = []
  for (const project of readdirSync(root)) {
    const projectDir = join(root, project)
    let isDir = false
    try { isDir = statSync(projectDir).isDirectory() } catch { continue }
    if (!isDir) continue
    for (const id of readdirSync(projectDir)) {
      const dir = join(projectDir, id)
      try { if (!statSync(dir).isDirectory()) continue } catch { continue }
      out.push({ project, id })
    }
  }
  return out
}

const sessions = listSessions()
console.log(`发现 ${sessions.length} 个会话目录\n`)

let withTitle = 0
let withCwd = 0
let withCreatedAt = 0
let emptyShells = 0
let failures = 0

for (const { project, id } of sessions) {
  let info
  try {
    info = T.inspectSession(id)
  } catch (err) {
    failures++
    console.log(`✗ ${project}/${id}  →  ${err.message}`)
    continue
  }
  if (info.title) withTitle++
  if (info.cwd) withCwd++
  if (info.createdAt) withCreatedAt++
  if (info.hasLog === false) emptyShells++
  // 响应里绝不能出现 home 绝对路径（前端只显示标题 / 工作目录 / 大小）
  if (JSON.stringify(info).includes(home)) {
    failures++
    console.log(`✗ ${project}/${id}  →  响应泄漏了绝对路径`)
    continue
  }
  const title = info.title ? `「${info.title}」` : '（无标题）'
  const shell = info.hasLog === false ? '  [空壳：没有日志文件]' : ''
  console.log(
    `✓ ${project}/${id}${shell}\n` +
    `    ${title}  cwd=${info.cwd ?? '?'}  files=${info.files}  logs=${info.logFiles.join(',') || '—'}`,
  )
}

console.log(
  `\n有标题 ${withTitle}/${sessions.length} · 有 cwd ${withCwd}/${sessions.length} · ` +
  `有创建时间 ${withCreatedAt}/${sessions.length} · 空壳 ${emptyShells}`,
)

if (failures > 0) {
  console.error(`\n${failures} 个会话读取失败。`)
  process.exit(1)
}
console.log('\n✓ 只读冒烟通过（未做任何写操作）')
