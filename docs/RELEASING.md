# 发布流程（RELEASING）

本文件说明本仓库的**版本号策略**、**变更记录规范**、**发布前检查单**与**双端发布（GitHub 主 + Gitee 镜像）**的具体步骤。
通用方法论（为什么这么定版本、怎么写变更记录）与本仓同源，本文只写本仓可执行的步骤。

---

## 1. 版本号策略（SemVer）

`MAJOR.MINOR.PATCH`，按**用户可见面**判定，不按内部重构：

| 变更 | 版本位 | 例子 |
|---|---|---|
| 破坏性：配置键改名/删除、HTTP 路由或响应字段破坏性变更、主包支持区间收窄、删除语义变化 | **MAJOR** | 改 `/delete` 的响应结构、去掉 `cleanMetadata` |
| 新增：新配置键、新路由、新 UI 动作、扩大主包支持区间 | **MINOR** | 加 `hard-delete.maxFiles` 可配置 |
| 修复：bug 修复、文案修正、性能优化、内部重构（行为不变） | **PATCH** | 修多帧 zstd 只解第一帧的兜底 |

补充规则：

- 版本号只增不减；发错了就发下一个补丁版本回退，**不重打已发布的 tag**。
- **插件市场靠 `package.json` 的 `version` 判断「有没有新版」**——只改代码不 bump 版本，用户那边永远不会出现「更新」按钮。
- `0.x` 期间允许 MINOR 位承载破坏性变更，但必须在 CHANGELOG 里显式标注 **BREAKING**。

## 2. 变更记录规范

`CHANGELOG.md`，倒序（最新在最上），每条发布一节：

```markdown
## [0.2.0] - 2026-10-11

### Added
- 新增了什么（面向使用者：他能观察到什么）。
### Changed
- 行为/文案/默认值的变化。
### Fixed
- 修了什么 bug，影响面是什么。
### Breaking
- （若有）改了什么、怎么迁移。
```

## 3. 发布前检查单

按顺序跑，任一项不过就不发：

- [ ] `node _test/test-host.mjs` → 39 项全过（夹具在临时目录，不碰真实 `~/.dsh`）
- [ ] `node _test/test-client.mjs` → 11 项全过（客户端离线渲染断言）
- [ ] `node _test/smoke-real-readonly.mjs` → 只读冒烟通过（**不写任何东西**）
- [ ] `node _test/verify-e2e-copy.mjs` → 端到端通过（真实 home 的**副本**上走完整 HTTP 链路删一个真会话）
- [ ] 在**真实 DSH 实例**上装一次并真删一个会话（菜单出现、确认框、删完那一行消失）
- [ ] **隐私扫描**：仓库里没有本机路径、机器名、用户名、会话内容、凭据
      （`git grep -nE "[A-H]:[\\\\/]"` 只应命中文档里的通用示例；`_test` 里的路径都是 `os.tmpdir()`）
- [ ] `package.json` 的 `version` 已递增；`repository` / `homepage` / `bugs` 指向本仓
- [ ] `disclosure` 字段与实现一致（本插件：不发数据、不联网、无凭据）
- [ ] 打包内容正确：`npm pack --dry-run` 只应包含 `lib/` `cordis.patch.yml` `README.md` `LICENSE`

## 4. 发布步骤

```bash
# 1) 版本与记录：改 package.json 的 version、写 CHANGELOG.md
# 2) 全套验证
node _test/test-host.mjs && node _test/test-client.mjs
node _test/smoke-real-readonly.mjs
node _test/verify-e2e-copy.mjs
# 3) 提交与标签
git add -A
git commit -m "release: v0.1.0"
git tag -a v0.1.0 -m "v0.1.0"
# 4) 推送（token 只从环境变量读，不落盘、不进 git 配置）
$env:OSS_PUSH_TOKEN='<你的 GitHub PAT>'
node scripts/push-publish.mjs --platform github --owner qwe4888789 --repo dsh-hard-delete `
     --topics dsh-plugin,dsh,deepseek-harness,cordis-plugin
```

`push-publish.mjs` 做五件事：前置自检（干净工作区 / 分支 / 关键文件在位）→ 远端仓不存在则用 API 建
→ 用**临时带 token 的 URL** push（**不执行 `git remote add`**，token 不进 `.git/config`）
→ 用不带 token 的 URL 回读 refs 验证 → GitHub 打 topic（插件市场收录入口）。所有输出都过一遍脱敏。

> **本仓只推 GitHub**（见第 5 节：市场按 GitHub 索引，Gitee 镜像没有收益）。
> 脚本保留了 `--platform gitee` 分支（同一作者其它仓库在用），将来要加镜像可直接复用，
> 四个 Gitee 专属的坑见文末附录。

## 5. 插件市场收录（本仓的目标之一）

[dshbase](https://dshbase.com/) 与 [DSH 插件市场](https://github.com/bradeGithub/DSH-Plugins-Marketplace)
**按 GitHub 仓库的 topic **`dsh-plugin`** 自动索引**（CI 每 2 小时扫一次，无需申请或提 issue）：

- **必须**在 GitHub 仓库页 → Settings → Topics 打上 `dsh-plugin`；建议再加 `dsh`、`deepseek-harness`、`cordis-plugin`。
  `push-publish.mjs --platform github` 带 `--topics` 时会顺带调 API 打好。
- 市场按 `package.json` 的 `name` 做**同名互斥**：**同名 npm 包已被别人占用时，只显示 star 高的那个**。
  本仓取名 `dsh-hard-delete` 就是为了避开三个同功能的 `dsh-session-delete` 仓库（hualiong / xrn1997 / vtxf）。
- 市场判定类型时**先看根目录特征文件**：本仓根 `package.json` 声明了 `dsh` 对象 ⇒ `cordis-plugin`。
  **不要在仓库根放 `install.ps1` / `install.sh`**（会被误当脚本型，且脚本型没有版本检测与自动卸载）。
- README 里的 `dsh plugin add <target>` 会被市场当「代执行通道」优先采用，target 请指向本仓地址或本包的 npm 名。
- 市场按 `version` 做更新检测 ⇒ 每次发版必须 bump（见第 1 节）。

## 6. 附录：将来若要加 Gitee 镜像（四个实测坑）

> 本仓目前**只推 GitHub**（见第 5 节：市场按 GitHub 索引，镜像没有收益）。
> 以下四个坑是同一作者在其它仓库上实测出来的 Gitee 专属行为，将来加镜像时直接照用。

1. **Gitee 建仓后默认是私有**——即便建仓请求里写了 `private: false`，实测建出来的仍是私有仓
   （症状：匿名 API 一律 `404 Not Found Project`，而带 token 的 API 正常）。建仓后必须再显式 PATCH 一次：
   `PATCH /api/v5/repos/{owner}/{repo}`，**且必须带 `name` 字段**（否则报 `{"messages":["name is missing"]}`），
   body 用 form 编码：`access_token=…&name=<repo>&private=false`。`push-publish.mjs` 已内置这一步。
2. **post-publish 复核要看「匿名视角」**：带 token 读得到 ≠ 公开。权威判据 = 匿名
   `GET /api/v5/repos/{owner}/{repo}` 返回 `private: false`，且匿名能取到文件内容。
3. **重打过的 tag 推送会被拒**（提示像认证失败，其实是 non-fast-forward）→ **只对 tag 用 `--force`**，
   分支仍走非快进保护。
4. **Gitee 不因 push 自动建仓**：目标仓不存在时 push 直接 `404 not found`，建仓只能走 API 或网页；
   而且它用的是**账号级令牌**（与 GitHub PAT 不是一回事），要另外准备。

## 7. 兼容性回归（每次动到会话格式相关代码时）

改到 `lib/index.js` 里解码 / 元数据 / 删除相关的函数时，除了跑第 3 节那四条脚本，
还要在真实 DSH 上复核：菜单出现、概况能出数（标题 / 工作目录 / 大小）、真删一个会话后那一行消失。
原因：这些函数的输入是**主包私有格式**（多帧 zstd 日志、projcache 两种布局、workspace.json 结构），
主包升级（尤其 `0.1.x → 0.2.x`）可能改事件族与日志封装。
