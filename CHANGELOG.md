# 变更记录

倒序（最新在最上），每条发布一节。格式与版本号判定规则见 [docs/RELEASING.md](docs/RELEASING.md)。

## [0.1.0] - 2026-10-11

### Added
- 首版。会话行「…」菜单里新增一行 **删除**，一键**彻底删除**会话（不可恢复，不进回收站）。
- host 半：3 条 loopback 路由 —— `GET /api/dsh-hard-delete/config`、`POST /inspect`、`POST /delete`（必须带 `confirm: true`）。
- 删除范围（四处一起清，避免悬空元数据）：会话目录本体；
  `storages/session_projcache/sessions/<id>.json`；`storages/session_projcache.json` 的 `tables.sessions[<id>]`；
  `storages/workspace.json` 的 `global.archivedSessionIds` / `global.pinnedSessionIds` / `tables.workspaces[*].sessionIds`。
- 删完发宿主事件 `api-session/removed`（经 `@deepseek-ai/dsh-api-remotes` 转发），侧边栏那一行**立即消失**。
- 确认框：固定三条风险提示（不可恢复 / 这正是当前会话 / 会话可能还在写盘）；
  HTTP 层强制 `confirm: true`；默认焦点落在「取消」；Esc 可退；点击遮罩可退。
- 配置：`<DSH_HOME>/hard-delete.config.json`（`apiPrefix` / `cleanMetadata` / `emitRemovedEvent` /
  `maxFiles` / `headerFrames` / `headerScanBytes` / `text`），env `HARD_DELETE_CONFIG` / `HARD_DELETE_API_PREFIX` 覆盖。
- 元数据兜底：projcache 缺条目时解会话日志**头部若干帧**（多帧 zstd 按 magic 切帧）取标题 / 工作目录 / 创建时间。
- 界面为**自绘**（官方 UI 组件库在浏览器端 `require` 不到，见 README 第五节第 7 条），
  外观与 DOM 严格照官方 `Menu.module.css` 的规格与 `--dsw-*` 主题变量实现。

### Notes
- 与 `dsh-session-recycle`（设置页：软删 → 回收站 → 恢复/回滚）是两套语义，**可以并存**；本插件不碰 `_recycle-bin/`。
- 支持删除「空壳」会话目录（只有目录、没有日志文件）——实测真实 `~/.dsh` 里存在这类残留。
