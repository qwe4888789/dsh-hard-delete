# dsh-hard-delete

> **仓库**：<https://github.com/qwe4888789/dsh-hard-delete>
> **许可**：AGPL-3.0-only（+ 商业授权，见第九节） ｜ **版本**：v0.1.0 ｜ **类型**：cordis 插件（host + client 双半，零运行时依赖）

在 DSH 的侧边栏会话「…」菜单里加一行 **删除** —— 点一下就把这个会话**彻底删掉**：

- **不可恢复**：直接物理删除，不进回收站、没有回滚。
- **不设门槛**：不看「疑似还在活动」，不要求二次输入，只弹一次确认框（因为不可逆）。
- **当前会话也能删**：确认框会明确提示「这正是你当前打开的会话，删完请切换或刷新」。
- **删完整**：会话目录之外，还清掉指向它的 projcache 条目与 `workspace.json` 引用，
  避免留下悬空元数据。

> 与同机另一个插件 **`dsh-session-recycle`** 的分工：
> 那个是设置页里的「软删 → 回收站 → 恢复 / 回滚」，保守、可救回；
> 这个是菜单里的一键硬删。两者互不干扰（本插件不碰 `_recycle-bin/`）。

---

## 一、形态与注册

本插件**同时**声明 `dsh.bundle` 与 `dsh.client`，因此走 **bundle 层**注册：

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "inject": [], "platform": "web" }
}
```

> `dsh.client.inject` 刻意留空：本插件浏览器半只 `require("react")`（平台种子词）。
> 为什么不去 require 官方 UI 组件库，见第六节第 7 条。

> ⚠️ 只有 `dsh.client` 而**没有** `dsh.bundle` 的插件不能进 `dsh.profile.bundles` ——
> 宿主会以 `declares no dsh.bundle` 拒绝并**启动即崩**。本插件两个都声明了，所以不受此限。

装到某个 profile：

```bash
# 方式 A（推荐）：让 DSH 自己装 —— 桌面端「插件 → 添加插件」里粘贴本仓地址，
#   或命令行（profile 名按你的实际环境改）：
dsh plugin --profile web add qwe4888789/dsh-hard-delete

# 方式 B：声明式手工安装
#   在 <DSH_HOME>/profiles/<name>/package.json 里
#     dependencies:        { "dsh-hard-delete": "link:<本仓路径>" }
#     dsh.profile.bundles: 追加 "dsh-hard-delete"
cd <DSH_HOME>/profiles/<name> && pnpm install
# 重启 DSH
```

> 桌面版（DeepSeek Harness 桌面端）的 `desktop` profile 由 Electron 应用独占，
> 别用 `dsh plugin --profile desktop …`（CLI 会直接拒绝）；桌面端请走「插件 → 添加插件」。

---

## 二、两个槽位

| 槽位 | 挂什么 | 为什么 |
|---|---|---|
| `sidebar.workspaces.session.menu.item` | 菜单里的「删除」行（id `hard-delete`，order **500**，排在 archive 的 400 之后） | owner 注入 `{ sessionId, displayTitle }` 与 `useMenuOpenState` 钩子 |
| `shell.overlay` | 确认框 + 结果提示 | **必须挂在常驻浮层上**：确认框若挂在菜单项里，菜单一关它就跟着卸载了 |

菜单项只做一件事：把「待确认请求」写进模块级小 store，然后关掉菜单。
浮层里的对话框读同一个 store，所以在菜单卸载后依然活着。

界面**自绘**（官方 `MenuItemButton` / `Modal` / `Button` / `Toast` 拿不到，见第六节第 7 条），
但完全照官方 `Menu.module.css` 的规格来：`min-height:34px` / `padding:6px 8px` /
`gap:6px` / `border-radius: var(--dsw-radius-md)` / hover 用
`--dsw-alias-interactive-bg-hover`，危险行用 `--dsw-alias-state-error-primary` +
`--dsw-alias-interactive-bg-hover-danger`。DOM 也与官方同构：
`div > [role=separator] + button[role=menuitem]` —— 菜单的键盘遍历与焦点回收都是读 DOM 的，
自绘按钮同样能参与。每个 `var()` 都写了兜底值，主题变量缺失时不会变成透明。

---

## 三、host 半的路由

前缀可配（默认 `/api/dsh-hard-delete`），全部 **loopback-only + same-origin 校验**。

| 方法 | 路径 | 请求体 | 说明 |
|---|---|---|---|
| GET | `/config` | — | 公开配置（`apiPrefix` / 文案覆盖 / 开关 / `configErrors`），**不含绝对路径** |
| POST | `/inspect` | `{sessionId}` | 一个会话的概况：标题 / 工作目录 / 大小 / 文件数 / 有无线索日志 |
| POST | `/delete` | `{sessionId, confirm:true}` | **彻底删除**（不可逆） |

错误统一 `{ error, code }`。值得注意的 code：`session-not-found`(404)、
`confirm-required`(400)、`invalid-sessionId`(400)、`path-escape`(400)、
`loopback-only`(403)、`body-too-large`(413)。

返回列表里**不含任何绝对路径**——界面只显示标题 / 工作目录 / 大小 / 文件数。

---

## 四、删一个会话要动几处

```
<DSH_HOME>/
├─ sessions/<projectKey>/<sessionId>/
│  └─ session[.v<N>].jsonl[.zstd]        ← ① 整个目录物理删除（多版本日志一起）
├─ storages/
│  ├─ session_projcache/sessions/<id>.json  ← ② 新版：每会话一个文件
│  ├─ session_projcache.json                ← ③ 旧版：tables.sessions[<id>]
│  └─ workspace.json                        ← ④ archivedSessionIds / pinnedSessionIds
│                                              / tables.workspaces[*].sessionIds
└─ （浏览器那一边）
   └─ ctx.emit('api-session/removed', id)   ← ⑤ 让侧边栏那一行立刻消失
```

安全性质：

- **路径纵深防御**：`sessionId` 必须是单层路径段（挡 `.` / `..` / 分隔符 / NUL），
  定位后再用 `relative()` 确认最终目录没跑出 `sessions/`。
- **只认精确路径**：只在 `sessions/<任意项目目录>/<精确的 sessionId>` 下动手，
  绝不复刻宿主的目录名编码规则（也就不会被规则变化带偏）。
- **不覆盖、不猜**：定位不到就是 404，什么都不做。
- **元数据清理失败不冒充删除失败**：降级成 `warnings` 如实回传，界面照实提示。
- **原子写 JSON**：先写 `.tmp-<pid>-<ts>` 再 rename，网络盘上失败也不留半个文件。
- **只读探测**：`/inspect` 全程不写盘。

---

## 五、七个实测踩出来的坑（本节是这份代码最有价值的部分）

1. **多帧 zstd：Node 的同步接口只解第一帧。** DSH 的会话日志是**多帧拼接**的。
   `zstdDecompressSync(整个文件)` 实测在 107 KB 的文件上只吐 187 字节（就第一帧），
   `zlib.createZstdDecompress()` 流也一样停在第一帧。必须按 magic `28 B5 2F FD`
   切帧、逐帧解。第一版没做这件事，标题/工作目录大面积读不出来。

2. **头部解码要「帧数 + 字节」双限。** 帧大小不固定（实测 1.5 KB ~ 35 KB 都有），
   只限帧数会漏后文，只限字节会白解一堆帧。两个都设，取先到的那个；
   并且 magic 也可能出现在压缩数据内部，解不开就跳过，靠 JSON 解析兜住误判。

3. **projcache 有两种布局，都得清。** 实测 `<home>/storages/session_projcache/sessions/<id>.json`
   与 `<home>/storages/session_projcache.json` 的 `tables.sessions[<id>]` 同时存在。
   只清一种就会留下悬空条目。

4. **存在「空壳」会话目录。** 真实 `~/.dsh` 里有目录建了但没写成日志的会话
   （实测 15 个会话目录里有 1 个）。如果「必须扫到日志才算会话」，
   这类目录就永远删不掉。改成：**目录名精确等于 sessionId 就认**，
   日志有无只作为 `hasLog` 事实回传。

5. **侧边栏那一行不会自己消失 —— 但有一条现成的事件。**
   客户端 `ctx.sessions`（`@deepseek-ai/dsh-api-session-controller` 的 client 半）
   通过 `ctx.remote.$on('api-session/added' | 'api-session/removed', …)` 维护会话列表；
   宿主侧 `@deepseek-ai/dsh-api-remotes` 把这批宿主 Cordis 事件原样转发给浏览器。
   所以删完文件只要 `ctx.emit('api-session/removed', sessionId)`，那一行立刻消失，
   不必等下一次 list 刷新，也不必自己去动客户端的列表状态。

6. **删除当前会话受 Windows 文件语义影响。** 宿主对日志文件是**持有句柄持续追加写**的。
   Node/libuv 打开文件时带 `FILE_SHARE_DELETE`，所以删除通常能成功（名字立刻消失），
   但宿主后台仍可能在写那个已经 unlink 的文件。因此确认框里明确写了
   「若它正在运行，建议删完重启一次 DSH」。

7. **`@deepseek-ai/dsh-client-ui-primitives` 在浏览器里 require 不到。**
   浏览器端模块表里只有两类东西：平台种子词（react 一族）和**声明了 `dsh.client`
   的 Loader 条目**。primitives 两个都不是 —— 它没有 `dsh.client`，在插件树里也没有
   对应条目（实测 201 条 Loader 条目里没有它）；官方客户端插件是在**构建期**把它内联
   进自己 bundle 的。所以第三方插件要么自己上构建，要么自己画。本插件选择自己画，
   但严格照官方 `Menu.module.css` 的规格与主题变量来（见第二节）。
   推论：`dsh.client.inject` 里写一个不存在的包名不会报错（只是解析不到），
   真正会炸的是运行时的 `require` —— 所以本插件只 `require("react")`。

---

## 六、配置

`<DSH_HOME>/hard-delete.config.json`（可选；env 优先）。载入一次常驻，改完**重启 DSH** 生效。

```json
{
  "apiPrefix": "/api/dsh-hard-delete",
  "cleanMetadata": true,
  "emitRemovedEvent": true,
  "maxFiles": 20000,
  "headerFrames": 32,
  "headerScanBytes": 262144,
  "text": {}
}
```

env 覆盖：`DSH_HOME`、`HARD_DELETE_CONFIG`、`HARD_DELETE_API_PREFIX`。

`text` 段可按 key 覆盖界面文案（前端内置 zh 字典兜底；默认下发空表 = 不覆盖）。
`cleanMetadata:false` = 只删会话目录，留元数据；`emitRemovedEvent:false` = 不发那一行消失事件。

---

## 七、测试

```bash
node _test/test-host.mjs           # 39 项夹具断言，全在临时目录里跑，不碰真实会话
node _test/test-client.mjs         # 11 项客户端离线断言（最小 hooks 运行时跑一遍渲染）
node _test/smoke-real-readonly.mjs # 对真实 ~/.dsh 只读冒烟（不做任何写操作）
node _test/verify-e2e-copy.mjs     # 把真实 home 复制一份，走完整 HTTP 栈删一个真会话
```

夹具单测覆盖：多项目定位、版本号文件名、多帧 zstd 头部解码、两种 projcache 布局、
空壳目录、路径穿越、dryRun、workspace.json 引用清理、删除后 404、
loopback / Host / 跨站 / 跨源 / 405 / 非法 JSON / 413 / `confirm` 校验 /
`api-session/removed` 的发出与关闭开关。

客户端离线单测覆盖：factory 形态、**只 require `react`**、两个槽位的 id/order/locale、
文案 key 全部有兜底、菜单项 DOM 与官方同构且点击后关菜单并写入请求、
确认框三条警告齐全且默认焦点在「取消」、缺 slots API 时明确报错、
sessions 服务取不到时降级不炸。

`verify-e2e-copy.mjs` 是最后一道闸：真实会话目录里的多版本日志、真实 projcache
与 workspace.json，走完整链路删掉一个真会话后逐项核对，**真实库全程只读**。

---

## 八、明确不做的事（以及为什么）

- **不做回收站 / 回滚**：本插件就是「删掉」这一个动作。要可恢复请用 `dsh-session-recycle`。
- **不做活动守卫**：用户要的是「自由删除」，加守卫就回到了软删插件的语义。
  取而代之的是确认框里把风险讲清楚（不可恢复 / 当前会话 / 可能仍在写盘）。
- **不改主包的会话列表状态**：只发一个宿主事件，列表由客户端自己维护。
- **不碰宿主服务**：只 `inject: ['webServer']`，不 import 会话/工作区服务。
- **不返回绝对路径**：前端显示不了也不需要。

---

## 九、许可

**AGPL-3.0-only**（GNU Affero General Public License v3.0），全文见 [LICENSE](./LICENSE)。

本项目管理在 **AGPL-3.0** 下开放：个人、学习、开源项目可自由使用与修改。
若需在 **闭源** 或 **商业场景** 中使用（不愿承接 AGPL 的传染条款），请联系获取**商业授权** ——
本仓暂无公开的联系邮箱，**请通过本仓 Issue 联系**。

本仓自 v0.1.0 起即为 AGPL-3.0，尚无许可变更历史。

本仓代码为**独立实现**：实现时观察了宿主公开的运行时约定（HTTP 路由注册方式 `ctx.webServer.register`、
客户端打包形态 `window.__ModuleLoader__.load`、槽位注册 `ctx.slots.inject/register`、
磁盘布局与日志文件名、转发事件 allowlist）与官方 `Menu.module.css` 的公开样式规格；
**未复制任何第三方插件代码**。命名上刻意避开 npm 上已被占用的 `dsh-session-delete` / `dsh-session-recycle`。

---

## 十、发布与收录

- 发布流程、版本号策略与推送步骤见 [docs/RELEASING.md](docs/RELEASING.md)；
  推送脚本 [scripts/push-publish.mjs](scripts/push-publish.mjs)（token 只从环境变量读，不落盘、不进 git 配置）。
- **远端只有 GitHub**：插件市场按 GitHub 仓库索引，Gitee 镜像对本仓没有收益，故不做。
- **插件市场收录**：[dshbase](https://dshbase.com/) 与 [DSH 插件市场](https://github.com/bradeGithub/DSH-Plugins-Marketplace)
  按 GitHub 仓库的 **`dsh-plugin` topic 自动索引**（每 2 小时扫一次）。本仓的 topic：
  `dsh-plugin` · `dsh` · `deepseek-harness` · `cordis-plugin`。
- 市场按 `package.json` 的 `version` 判断更新；**发版必须 bump version**（见 CHANGELOG）。
