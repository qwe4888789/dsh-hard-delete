/**
 * dsh-hard-delete — host half（原生 ESM，零第三方运行时依赖）
 *
 * 给 DSH 补一件事：**在侧边栏会话「…」菜单里一键彻底删除会话**（不可恢复）。
 *
 * 与同机另一个插件 dsh-session-recycle 的分工：
 *   - dsh-session-recycle：设置页里的「软删 → 回收站 → 恢复 / 回滚」，保守、可救回；
 *   - 本插件：菜单里的一键**硬删**，直接抹掉，不进回收站，不设活动守卫。
 *   两者互不干扰：本插件只删自己的东西，不碰 `_recycle-bin/`。
 *
 * ── 从宿主实测得到的契约（不是抄来的，是读宿主运行时行为得到的事实） ──
 *
 * 1) 会话目录：`<home>/sessions/<projectKey>/<sessionId>/`，
 *    日志文件形如 `session[.v<N>].jsonl[.zstd]`（多帧 zstd；同目录可能并存多个版本）。
 *    要删干净，光删目录不够 —— 还有两处元数据指向它：
 *
 * 2) projcache：
 *    - 新版：`<home>/storages/session_projcache/sessions/<sessionId>.json`（每会话一个文件）
 *    - 旧版：`<home>/storages/session_projcache.json` 的 `tables.sessions[<sessionId>]`
 *
 * 3) 工作区注册表：`<home>/storages/workspace.json`
 *    - `global.archivedSessionIds` / `global.pinnedSessionIds`
 *    - `tables.workspaces[*].sessionIds`
 *
 * 4) **侧边栏那一行怎么立刻消失**（本插件最关键的一处发现）：
 *    客户端 `ctx.sessions`（@deepseek-ai/dsh-api-session-controller 的 client 半）
 *    通过 `ctx.remote.$on('api-session/added' | 'api-session/removed', ...)` 维护会话列表。
 *    宿主侧 `@deepseek-ai/dsh-api-remotes` 把这个 allowlist 里的宿主 Cordis 事件原样转发给所有客户端。
 *    所以**任何一个 host 插件 `ctx.emit('api-session/removed', sessionId)` 都能让那一行立刻消失**，
 *    不必等下一次 list 刷新。删完文件就 emit，界面才跟得上。
 *
 * 路由（全部 loopback-only；前缀可配置，默认 /api/dsh-hard-delete）：
 *   GET  {p}/config    — 公开配置（前缀 / 文案覆盖 / 开关 / 计数），不含绝对路径
 *   POST {p}/inspect   — 查一个会话的概况（标题 / 工作目录 / 大小 / 文件数 / 是否还在跑）
 *   POST {p}/delete    — **彻底删除**（必须 confirm:true）
 *
 * 刻意不做的事：
 *   - 不做回收站、不做回滚：本插件就是「删掉」这一个动作，误删不可救（那是另一个插件的活）。
 *   - 不返回绝对路径给前端：界面只显示标题 / 工作目录 / 大小 / 文件数。
 *   - 不 import 宿主服务：只 `inject: ['webServer']`，其余靠文件系统 + 一个 Cordis 事件。
 */
import {
  existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

export const name = 'dsh-hard-delete'
/** 只依赖 webServer（注册 HTTP 路由）。 */
export const inject = ['webServer']

const LOOPBACK_ADDRESSES = ['127.0.0.1', '::1', '::ffff:127.0.0.1']
const CONFIG_FILE_NAME = 'hard-delete.config.json'

/** 会话日志文件名：`session[.v<N>].jsonl[.zstd]`（版本号可缺省）。 */
const SESSION_LOG_RE = /^session(?:\.v(\d+))?\.jsonl(?:\.zstd)?$/
const ZSTD_MAGIC = 0xfd2fb528

// ── 配置 ────────────────────────────────────────────────────────────────────
// 载入一次常驻内存；改配置文件后重启 DSH 生效。env 优先于配置文件。

const DEFAULTS = {
  apiPrefix: '/api/dsh-hard-delete',
  /** 连 projcache / workspace.json 里的引用一起清掉（关掉就只删会话目录）。 */
  cleanMetadata: true,
  /** 删完给浏览器发 `api-session/removed`，让侧边栏那一行立刻消失。 */
  emitRemovedEvent: true,
  /** 单次删除最多清点多少文件（防御性上限，防手滑指向巨大目录）。 */
  maxFiles: 20000,
  /** 缺 projcache 元数据时解日志头部：帧数硬上限 + 解压字节预算（两个都设，取先到的）。 */
  headerFrames: 32,
  headerScanBytes: 262144,
  server: {
    allowedHosts: ['127.0.0.1', 'localhost', '[::1]'],
    rejectCrossSite: true,
    sameOriginOnly: true,
    maxJsonBodyBytes: 65536,
  },
}

function homeDir() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return resolve(fromEnv.trim())
  return join(homedir(), '.dsh')
}

function readConfigFile() {
  const explicit = process.env.HARD_DELETE_CONFIG
  const candidates = []
  if (typeof explicit === 'string' && explicit.trim().length > 0) candidates.push(resolve(explicit.trim()))
  candidates.push(join(homeDir(), CONFIG_FILE_NAME))

  for (const file of candidates) {
    if (!existsSync(file)) continue
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { file, value: parsed, error: null }
      }
      return { file, value: {}, error: `${file}: 顶层必须是 JSON 对象` }
    } catch (err) {
      return { file, value: {}, error: `${file}: ${errText(err)}` }
    }
  }
  return { file: candidates[candidates.length - 1], value: {}, error: null }
}

function mergeConfig(base, patch) {
  const out = { ...base }
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value) &&
        base[key] !== null && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = mergeConfig(base[key], value)
    } else if (value !== undefined) {
      out[key] = value
    }
  }
  return out
}

let configSnapshot = null
const configErrors = []

function loadConfig() {
  const { value, error } = readConfigFile()
  if (error) configErrors.push(error)
  const merged = mergeConfig(DEFAULTS, value)
  if (process.env.HARD_DELETE_API_PREFIX) merged.apiPrefix = String(process.env.HARD_DELETE_API_PREFIX)
  configSnapshot = merged
  return merged
}

/** 重新载入配置（测试用）。 */
export function reloadConfig() {
  configErrors.length = 0
  return loadConfig()
}

function cfg() {
  return configSnapshot ?? loadConfig()
}

function sessionsRoot() { return join(homeDir(), 'sessions') }
function storagesDir() { return join(homeDir(), 'storages') }
function projcacheFile() { return join(storagesDir(), 'session_projcache.json') }
function projcacheDir() { return join(storagesDir(), 'session_projcache') }
function projcacheEntryFile(sessionId) { return join(projcacheDir(), 'sessions', `${sessionId}.json`) }
function workspaceFile() { return join(storagesDir(), 'workspace.json') }

// ── 通用小工具 ──────────────────────────────────────────────────────────────

/** 带 code 的 HTTP 错误（路由层统一翻译成 JSON）。 */
class HttpError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

function errText(err) {
  if (err === null || err === undefined) return 'unknown error'
  return err instanceof Error ? (err.message || String(err)) : String(err)
}

function isDir(p) {
  try { return statSync(p).isDirectory() } catch { return false }
}

function readJsonSafe(file) {
  if (!existsSync(file)) return undefined
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return undefined }
}

/** 原子写 JSON（先写临时文件再改名）；失败不留半个文件。 */
function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  renameSync(tmp, file)
}

/** 目录段合法性：只允许单层文件名，挡掉穿越与绝对路径。 */
function assertSafeSegment(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new HttpError(400, `${label}-required`, `${label} is required`)
  }
  if (value === '.' || value === '..') {
    throw new HttpError(400, `invalid-${label}`, `${label} is not a valid name`)
  }
  if (value.includes('/') || value.includes('\\') || value.includes('\0')) {
    throw new HttpError(400, `invalid-${label}`, `${label} must be a single path segment`)
  }
  return value
}

/** 纵深防御：确认最终路径确实落在 root 之下。 */
function assertInside(root, target, label) {
  const rel = relative(resolve(root), resolve(target))
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new HttpError(400, 'path-escape', `${label} escapes its root`)
  }
  return target
}

function safeReaddir(dir) {
  try { return readdirSync(dir) } catch { return [] }
}

/** 递归清点目录内的文件（返回相对路径 + 字节数），带 maxFiles 上限。 */
function collectFiles(dir, maxFiles) {
  const out = []
  const stack = [dir]
  let truncated = false
  while (stack.length > 0) {
    const current = stack.pop()
    for (const name of safeReaddir(current)) {
      const full = join(current, name)
      let st
      try { st = statSync(full) } catch { continue }
      if (st.isDirectory()) {
        stack.push(full)
      } else if (st.isFile()) {
        if (out.length >= maxFiles) { truncated = true; continue }
        out.push({ relative: relative(dir, full) || name, bytes: st.size })
      }
    }
  }
  return { files: out, truncated }
}

// ── 会话定位 ────────────────────────────────────────────────────────────────

/**
 * 在 `sessions/<projectKey>/<sessionId>` 里定位会话目录。
 *
 * 刻意不猜 projectKey：直接扫一层子目录找同名目录，
 * 既不用复刻宿主的目录名编码规则，也不怕它以后改规则。
 *
 * 也刻意**不要求目录里一定有日志文件**：实测真实 ~/.dsh 里存在「空壳」会话目录
 * （宿主建了目录但没写成日志）。要求有日志会让这类目录永远删不掉，
 * 而路径本身（sessions/<project>/<精确的 sessionId>）已经足够确定删除目标。
 */
function findSessionDir(sessionId) {
  const root = sessionsRoot()
  if (!existsSync(root)) return null
  for (const project of safeReaddir(root)) {
    const projectDir = join(root, project)
    if (!isDir(projectDir)) continue
    const dir = join(projectDir, sessionId)
    if (isDir(dir)) return { project, dir, hasLog: sessionLogFiles(dir).length > 0 }
  }
  return null
}

/** 目录里所有会话日志文件，按「版本号高 → 低，zstd 优先」排序。 */
function sessionLogFiles(dir) {
  const found = []
  for (const name of safeReaddir(dir)) {
    const m = SESSION_LOG_RE.exec(name)
    if (!m) continue
    const full = join(dir, name)
    try { if (!statSync(full).isFile()) continue } catch { continue }
    found.push({
      name,
      full,
      version: m[1] === undefined ? 0 : Number(m[1]),
      zstd: name.endsWith('.zstd'),
    })
  }
  found.sort((a, b) => (b.version - a.version) || (a.zstd === b.zstd ? 0 : (b.zstd ? 1 : -1)))
  return found
}

function dirSizeSafe(dir) {
  try {
    const { files } = collectFiles(dir, cfg().maxFiles ?? DEFAULTS.maxFiles)
    let bytes = 0
    for (const f of files) bytes += f.bytes
    return { files: files.length, bytes }
  } catch { return { files: 0, bytes: 0 } }
}

// ── 元数据：projcache + 日志头部兜底 ────────────────────────────────────────

/**
 * 多帧 zstd 拼接解码（只解头部若干帧）。
 *
 * 为什么不能直接 `zstdDecompressSync(整个文件)`：DSH 的会话日志是**多帧拼接**的，
 * Node 的 zstd 流/同步接口只吐第一帧 —— 实测 107 KB 的文件只解出 187 字节。
 * 所以按 magic 切帧、逐帧解。
 *
 * 为什么**帧数与字节双限**：帧大小不固定（实测 1.5 KB ~ 35 KB 都有）。
 * 只限帧数会漏后文，只限字节会解太多帧，两个都设、取先到的那个。
 * 另外 magic 也可能出现在压缩数据内部，解不开就跳过，靠 JSON 解析兜住误判。
 */
function decodeHeadFrames(file, maxFrames, maxBytes) {
  let buf
  try { buf = readFileSync(file) } catch { return '' }
  const offsets = []
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf.readUInt32LE(i) === ZSTD_MAGIC) offsets.push(i)
  }
  if (offsets.length === 0) return ''
  const frameLimit = Math.min(Math.max(1, maxFrames), offsets.length)
  const byteLimit = Math.max(1024, maxBytes)
  let out = ''
  for (let k = 0; k < frameLimit; k++) {
    const start = offsets[k]
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length
    try { out += zstdDecompressSync(buf.subarray(start, end)).toString('utf8') } catch { /* 见上 */ }
    if (out.length >= byteLimit) break
  }
  return out
}

function readHeadText(dir, maxFrames, maxBytes) {
  const file = sessionLogFiles(dir)[0]?.full ?? null
  if (!file) return ''
  if (file.endsWith('.zstd')) return decodeHeadFrames(file, maxFrames, maxBytes)
  try { return readFileSync(file, 'utf8').slice(0, maxBytes) } catch { return '' }
}

/** 机器注入的样板消息：也是 user/message，但拿来做标题没有信息量。 */
const NOISE_TITLE_RE = /^(the approval policy|approval policy|you are (a|an|the)\b|current runtime context|# (instructions|task|context)\b|<)/i

function cleanUserText(text) {
  if (typeof text !== 'string') return ''
  let s = text
  const a = s.indexOf('<system-reminder>')
  if (a !== -1) s = s.slice(0, a)
  const b = s.indexOf('Current runtime context.')
  if (b !== -1) s = s.slice(0, b)
  return s.trim()
}

/** 头部元数据缓存：key = 文件路径 + mtime + size。 */
const diskMetaCache = new Map()

function diskMeta(dir) {
  const file = sessionLogFiles(dir)[0]?.full ?? null
  if (!file) return {}
  let key = file
  try {
    const st = statSync(file)
    key = `${file}|${st.mtimeMs}|${st.size}`
  } catch { return {} }
  const cached = diskMetaCache.get(key)
  if (cached) return cached

  const text = readHeadText(
    dir,
    Number(cfg().headerFrames ?? DEFAULTS.headerFrames),
    Number(cfg().headerScanBytes ?? DEFAULTS.headerScanBytes),
  )
  const result = { title: null, cwd: null, createdAt: null }
  for (const line of text.split('\n')) {
    if (!line) continue
    let ev
    try { ev = JSON.parse(line) } catch { continue }
    if (ev?.type === 'session') {
      if (typeof ev.cwd === 'string' && ev.cwd.length > 0) result.cwd = ev.cwd
      if (ev.createdAt !== undefined && ev.createdAt !== null) result.createdAt = ev.createdAt
    } else if (ev?.type === 'session/title' && typeof ev.data?.title === 'string') {
      const title = ev.data.title.trim()
      if (title.length > 0 && !NOISE_TITLE_RE.test(title)) result.title = title.slice(0, 80)
    } else if (ev?.type === 'user/message' && result.title === null) {
      for (const item of (Array.isArray(ev.data?.content) ? ev.data.content : [])) {
        if (item?.type === 'text' && typeof item.text === 'string') {
          const clean = cleanUserText(item.text)
          if (clean && !NOISE_TITLE_RE.test(clean)) { result.title = clean.slice(0, 80); break }
        }
      }
    }
    if (result.title !== null && result.cwd !== null && result.createdAt !== null) break
  }

  if (diskMetaCache.size > 500) diskMetaCache.clear()
  diskMetaCache.set(key, result)
  return result
}

function projcacheTable() {
  return readJsonSafe(projcacheFile())?.tables?.sessions ?? {}
}

function projcacheRecord(sessionId) {
  const legacy = projcacheTable()[sessionId]
  if (legacy) return { record: legacy, source: 'session_projcache.json' }
  const perSession = readJsonSafe(projcacheEntryFile(sessionId))
  if (perSession) return { record: perSession?.record ?? perSession, source: 'session_projcache/sessions' }
  return { record: undefined, source: null }
}

/** 一条会话的概况：projcache 优先，缺的字段解日志头部兜底。 */
function sessionMeta(sessionId, dir) {
  const { record, source } = projcacheRecord(sessionId)
  const meta = {
    title: record?.rows?.title?.val ?? null,
    cwd: record?.identity?.cwd ?? null,
    createdAt: record?.identity?.createdAt ?? null,
    turns: record?.rows?.sessionStats?.val?.turns ?? 0,
    metaSource: source,
  }
  if ((meta.title === null || meta.cwd === null || meta.createdAt === null) && dir) {
    const fromDisk = diskMeta(dir)
    if (meta.title === null && fromDisk.title) { meta.title = fromDisk.title; meta.metaSource = 'disk-head' }
    if (meta.cwd === null && fromDisk.cwd) meta.cwd = fromDisk.cwd
    if (meta.createdAt === null && fromDisk.createdAt) meta.createdAt = fromDisk.createdAt
  }
  return meta
}

/** GET/POST /inspect 的响应体（不含任何绝对路径）。 */
export function inspectSession(sessionId) {
  assertSafeSegment(sessionId, 'sessionId')
  const found = findSessionDir(sessionId)
  if (!found) throw new HttpError(404, 'session-not-found', `session not found: ${sessionId}`)
  const meta = sessionMeta(sessionId, found.dir)
  const size = dirSizeSafe(found.dir)
  let mtimeMs = null
  try { mtimeMs = statSync(found.dir).mtimeMs } catch { /* ignore */ }
  return {
    sessionId,
    title: meta.title,
    cwd: meta.cwd,
    createdAt: meta.createdAt,
    turns: meta.turns,
    metaSource: meta.metaSource,
    files: size.files,
    bytes: size.bytes,
    hasLog: found.hasLog,
    logFiles: sessionLogFiles(found.dir).map((f) => f.name),
    mtimeMs,
  }
}

// ── 删除 ────────────────────────────────────────────────────────────────────

/**
 * 彻底删除一个会话。
 *
 * @param sessionId - 会话 id（单层路径段）。
 * @param options.cleanMetadata - 是否顺带清 projcache / workspace.json 里的引用。
 * @param options.dryRun - 只清点不落刀（测试与预演用）。
 * @returns 删除报告（含 warnings：哪些清理步骤失败了，便于界面如实告知）。
 */
export function deleteSession(sessionId, options = {}) {
  assertSafeSegment(sessionId, 'sessionId')
  const cleanMetadata = options.cleanMetadata !== false
  const maxFiles = Number(cfg().maxFiles ?? DEFAULTS.maxFiles)

  const found = findSessionDir(sessionId)
  if (!found) throw new HttpError(404, 'session-not-found', `session not found: ${sessionId}`)
  assertInside(sessionsRoot(), found.dir, 'session directory')

  const { files, truncated } = collectFiles(found.dir, maxFiles)
  let bytes = 0
  for (const f of files) bytes += f.bytes

  const report = {
    sessionId,
    project: found.project,
    files: files.length,
    bytes,
    truncated,
    dryRun: options.dryRun === true,
    removed: { sessionDir: false, projcacheEntry: false, projcacheTable: false, workspaceRefs: 0 },
    warnings: [],
  }
  if (options.dryRun === true) return report

  // ① 会话目录本体。force + maxRetries：Windows 上刚写过的文件偶发瞬时占用。
  rmSync(found.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 })
  if (existsSync(found.dir)) {
    throw new HttpError(500, 'delete-failed', `could not remove session directory (still present): ${sessionId}`)
  }
  report.removed.sessionDir = true

  // 项目层目录空了就顺手收掉，不留空壳（失败不算错）。
  try {
    const projectDir = join(sessionsRoot(), found.project)
    if (isDir(projectDir) && safeReaddir(projectDir).length === 0) rmSync(projectDir, { recursive: true, force: true })
  } catch (err) {
    report.warnings.push(`project-dir: ${errText(err)}`)
  }

  // ② projcache / workspace.json 里的引用。
  if (cleanMetadata) {
    const meta = cleanMetadataRefs(sessionId)
    report.removed.projcacheEntry = meta.projcacheEntry
    report.removed.projcacheTable = meta.projcacheTable
    report.removed.workspaceRefs = meta.workspaceRefs
    for (const w of meta.warnings) report.warnings.push(w)
  }

  return report
}

/**
 * 清掉 projcache 与 workspace.json 里对某个会话的引用。
 *
 * 注意：workspace.json 由宿主的 workspace registry 持有，它内存里也有份缓存；
 * 我们改了盘上的文件后，宿主下一次写盘可能把条目又带回来。这**不影响删除本身**
 * （会话目录已经没了，列表也就不会再出现它），只是可能留一条无害的悬空引用。
 * 失败一律降级成 warning，不让「清理元数据失败」把「删除成功」判成失败。
 */
export function cleanMetadataRefs(sessionId) {
  assertSafeSegment(sessionId, 'sessionId')
  const out = { projcacheEntry: false, projcacheTable: false, workspaceRefs: 0, warnings: [] }

  // projcache 每会话文件
  const entryFile = projcacheEntryFile(sessionId)
  try {
    if (existsSync(entryFile)) {
      rmSync(entryFile, { force: true })
      out.projcacheEntry = !existsSync(entryFile)
    }
  } catch (err) {
    out.warnings.push(`projcache-entry: ${errText(err)}`)
  }

  // projcache 聚合文件（旧版布局）
  try {
    const file = projcacheFile()
    const data = readJsonSafe(file)
    const table = data?.tables?.sessions
    if (table && Object.prototype.hasOwnProperty.call(table, sessionId)) {
      delete table[sessionId]
      // 重新走一遍原子写，避免半截文件
      writeJsonAtomic(file, data)
      out.projcacheTable = true
    }
  } catch (err) {
    out.warnings.push(`projcache-table: ${errText(err)}`)
  }

  // workspace.json
  try {
    const file = workspaceFile()
    const data = readJsonSafe(file)
    if (data) {
      let changed = 0
      const dropFrom = (arr) => {
        if (!Array.isArray(arr)) return arr
        const next = arr.filter((id) => id !== sessionId)
        changed += arr.length - next.length
        return next
      }
      if (data.global) {
        data.global.archivedSessionIds = dropFrom(data.global.archivedSessionIds)
        data.global.pinnedSessionIds = dropFrom(data.global.pinnedSessionIds)
      }
      const workspaces = data.tables?.workspaces
      if (workspaces && typeof workspaces === 'object') {
        for (const ws of Object.values(workspaces)) {
          if (ws && typeof ws === 'object') ws.sessionIds = dropFrom(ws.sessionIds)
        }
      }
      if (changed > 0) {
        writeJsonAtomic(file, data)
        out.workspaceRefs = changed
      }
    }
  } catch (err) {
    out.warnings.push(`workspace-refs: ${errText(err)}`)
  }

  return out
}

// ── reveal（打开文件位置）────────────────────────────────────────────────────
// 刻意不提供：本插件是「删掉」，不需要定位；定位在 dsh-session-recycle 里已有。

// ── HTTP 层（loopback-only + same-origin 防护） ────────────────────────────

function isLoopbackRequest(request) {
  const address = request.socket?.remoteAddress
  if (!LOOPBACK_ADDRESSES.includes(address)) return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try { hostUrl = new URL('http://' + host) } catch { return false }
  const allowed = cfg().server?.allowedHosts ?? DEFAULTS.server.allowedHosts
  if (!allowed.includes(hostUrl.hostname) && !allowed.includes('[' + hostUrl.hostname + ']')) return false
  if (cfg().server?.rejectCrossSite !== false && request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  if (cfg().server?.sameOriginOnly === false) return true
  try { return new URL(origin).host === hostUrl.host } catch { return false }
}

function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  })
  res.end(payload)
}

async function readJsonBody(req) {
  const limit = cfg().server?.maxJsonBodyBytes ?? DEFAULTS.server.maxJsonBodyBytes
  const chunks = []
  let size = 0
  try {
    for await (const chunk of req) {
      size += chunk.length
      if (size > limit) return { error: { status: 413, code: 'body-too-large', message: 'request body too large' } }
      chunks.push(chunk)
    }
  } catch {
    return { error: { status: 400, code: 'body-read-failed', message: 'could not read request body' } }
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim().length === 0) return { body: {} }
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { error: { status: 400, code: 'invalid-body', message: 'request body must be a JSON object' } }
    }
    return { body: parsed }
  } catch {
    return { error: { status: 400, code: 'invalid-json', message: 'request body is not valid JSON' } }
  }
}

function boolOf(value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const t = value.trim().toLowerCase()
    if (t === 'true' || t === '1') return true
    if (t === 'false' || t === '0') return false
  }
  return undefined
}

/** 注册一条路由：优先 ctx.webServer.register，退回 ctx.server.register（版本差异探测）。 */
function registerRoute(ctx, route) {
  const server = ctx.webServer ?? ctx.server
  if (!server || typeof server.register !== 'function') {
    throw new Error('dsh-hard-delete: no web server service found (expected ctx.webServer.register or ctx.server.register)')
  }
  return server.register(route)
}

/**
 * 让侧边栏那一行立刻消失：把宿主 allowlist 里的 `api-session/removed` 事件广播出去。
 *
 * 这条事件由 `@deepseek-ai/dsh-api-remotes` 转发给所有客户端，客户端
 * `ctx.sessions` 收到后把该行从会话列表里摘掉。失败只记 warning ——
 * 文件已经删了，界面下一次 list 刷新同样会对齐。
 */
function emitRemoved(ctx, sessionId) {
  if (cfg().emitRemovedEvent === false) return { emitted: false, reason: 'disabled' }
  try {
    if (typeof ctx.emit !== 'function') return { emitted: false, reason: 'no-emit' }
    ctx.emit('api-session/removed', sessionId)
    return { emitted: true, reason: null }
  } catch (err) {
    return { emitted: false, reason: errText(err) }
  }
}

export function apply(ctx) {
  const config = loadConfig()
  if (configErrors.length > 0) ctx.logger?.warn?.('[dsh-hard-delete] config issues: ' + configErrors.join('; '))
  ctx.logger?.info?.(`[dsh-hard-delete] home=${homeDir()} (hard delete; no recycle bin)`)

  const guard = (handler) => async (req, res) => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { error: 'forbidden', code: 'loopback-only', message: 'this endpoint only accepts loopback requests' })
      return
    }
    try {
      await handler(req, res)
    } catch (err) {
      if (err instanceof HttpError) writeJson(res, err.status, { error: err.message, code: err.code })
      else writeJson(res, 500, { error: errText(err), code: 'internal' })
    }
  }

  const prefix = () => String(cfg().apiPrefix ?? DEFAULTS.apiPrefix).replace(/\/+$/, '')

  const routes = [
    {
      kind: 'exact',
      path: '/config',
      handler: guard(async (req, res) => {
        if (req.method !== 'GET') return writeJson(res, 405, { error: 'method not allowed' })
        writeJson(res, 200, {
          apiPrefix: prefix(),
          // 默认下发空文案表：前端用自己的内置 zh 字典；用户可在配置文件的 text 段逐条覆盖。
          text: cfg().text ?? {},
          limits: {
            cleanMetadata: cfg().cleanMetadata !== false,
            emitRemovedEvent: cfg().emitRemovedEvent !== false,
          },
          home: { recycleBinUsed: false },
          configErrors,
        })
      }),
    },
    {
      kind: 'exact',
      path: '/inspect',
      handler: guard(async (req, res) => {
        if (req.method !== 'POST') return writeJson(res, 405, { error: 'method not allowed' })
        const { body, error } = await readJsonBody(req)
        if (error) return writeJson(res, error.status, { error: error.message, code: error.code })
        writeJson(res, 200, inspectSession(body.sessionId))
      }),
    },
    {
      kind: 'exact',
      path: '/delete',
      handler: guard(async (req, res) => {
        if (req.method !== 'POST') return writeJson(res, 405, { error: 'method not allowed' })
        const { body, error } = await readJsonBody(req)
        if (error) return writeJson(res, error.status, { error: error.message, code: error.code })
        assertSafeSegment(body.sessionId, 'sessionId')
        // 不可恢复的动作必须显式确认，避免误点/误发。
        if (boolOf(body.confirm) !== true) {
          throw new HttpError(400, 'confirm-required', 'deleting a session is irreversible; pass confirm: true')
        }
        const report = deleteSession(body.sessionId, { cleanMetadata: cfg().cleanMetadata !== false })
        const emitted = emitRemoved(ctx, body.sessionId)
        report.emitted = emitted.emitted
        if (!emitted.emitted && emitted.reason !== 'disabled') {
          report.warnings.push(`api-session/removed: ${emitted.reason}`)
        }
        ctx.logger?.warn?.(
          `[dsh-hard-delete] hard-deleted ${report.sessionId} ` +
          `(${report.files} files, ${report.bytes} bytes) — irreversible; row-event=${emitted.emitted}`,
        )
        writeJson(res, 200, report)
      }),
    },
  ].map((route) => ({ ...route, path: prefix() + route.path }))

  const disposers = routes.map((route) => registerRoute(ctx, route))
  ctx.logger?.info?.(`[dsh-hard-delete] ${routes.length} routes registered under ${prefix()}`)

  return () => {
    for (const dispose of disposers) {
      try { dispose() } catch { /* ignore */ }
    }
  }
}

/** 供离线单测复用的纯函数 / 数据。 */
export const __testing = {
  HttpError, homeDir, sessionsRoot, storagesDir, projcacheFile, projcacheDir,
  projcacheEntryFile, workspaceFile, cfg, loadConfig, reloadConfig,
  assertSafeSegment, assertInside, collectFiles, safeReaddir, isDir,
  sessionLogFiles, findSessionDir, sessionMeta, diskMeta, decodeHeadFrames,
  inspectSession, deleteSession, cleanMetadataRefs, writeJsonAtomic, boolOf,
  isLoopbackRequest,
}
