// dsh-hard-delete / lib/client.js（浏览器端）
//
// 给侧边栏的会话「…」菜单补一行【删除】，点了就把这个会话**彻底删掉**（不可恢复）。
//
// ── 打包形态 ──
// window.__ModuleLoader__.load({ id, factory })，factory 内 require("react")，
// 末尾 return module.exports。与宿主其它客户端插件同款形态：无构建步骤、无 JSX。
//
// 为什么只 require("react")：浏览器端的模块表里只有平台种子词（react 一族）与
// **声明了 dsh.client 的 Loader 条目**。实测本机的
// `@deepseek-ai/dsh-client-ui-primitives` 并不是 Loader 条目（它是被官方客户端
// 插件在构建期内联的库），所以第三方插件 require 不到它。
// 界面因此自己写：用宿主主题变量（--dsw-*）把菜单行做成和官方行同款外观。
//
// ── 两个槽位 ──
// ① `sidebar.workspaces.session.menu.item` —— 会话行「…」菜单里的**菜单项**。
//    宿主（@deepseek-ai/dsh-client-ui-workspace）声明该槽位时给每个占用者注入
//    `useMenuOpenState` 钩子和 owner props `{ sessionId, displayTitle }`；
//    菜单项自己负责在动作后把菜单关掉。
//
// ② `shell.overlay` —— 框架级浮层。
//    为什么确认框不放在菜单项里：菜单项随菜单关闭而卸载，**它自己挂的弹窗活不过这一下**。
//    所以菜单项只把「待确认请求」写进模块级小 store，由常驻浮层里的对话框去读。
//
// ── 数据流 ──
// 全部经 host 半的 loopback 路由（前缀由 GET {p}/config 下发）：
//   GET  {p}/config    POST {p}/inspect    POST {p}/delete
// 绝对路径一律不显示：host 刻意不返回，界面只显示标题 / 工作目录 / 大小 / 文件数。
//
// ── 为什么删完界面会立刻少一行 ──
// host 半删完文件后会 emit 宿主的 `api-session/removed` 事件；
// @deepseek-ai/dsh-api-remotes 把它转发给浏览器，客户端的 ctx.sessions 收到后
// 把该行从会话列表里摘掉。本插件这边不需要自己维护列表状态。
window.__ModuleLoader__.load({
	id: "dsh-hard-delete",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const h = react.createElement;
		const { useState, useEffect, useCallback, useRef } = react;

		const NS = "hard-delete";
		const DEFAULT_PREFIX = "/api/dsh-hard-delete";
		const CSS_ID = "dsh-hard-delete-css";
		const ATTR = "data-dsh-hard-delete";

		/** 侧栏标签等随 DSH 语言切换。 */
		const DICT = {
			zh: {
				"menu.delete": "删除",
			},
			en: {
				"menu.delete": "Delete",
			},
		};

		/** 界面文案的内置兜底（host 的 /config.text 可按 key 逐条覆盖）。 */
		const FALLBACK_TEXT = {
			menuDelete: "删除",
			title: "彻底删除这个会话？",
			desc: "会话「{title}」",
			labelCwd: "工作目录",
			labelSize: "占用",
			labelFiles: "文件数",
			labelCreated: "创建时间",
			unknownCwd: "未知工作目录",
			unknownTime: "时间未知",
			sizeFmt: "{size} · {n} 个文件",
			warnHard: "这会物理删除会话目录、日志文件与相关元数据引用。不进回收站，删完无法恢复。",
			warnCurrent: "这正是你当前打开的会话；删除后请手动切换会话或刷新页面。",
			warnRunning: "会话可能还在写入；若它正在运行，宿主可能仍在后台写盘，建议删完重启一次 DSH。",
			cancel: "取消",
			confirmAction: "彻底删除",
			working: "正在删除…",
			loading: "正在读取…",
			done: "已彻底删除「{title}」",
			doneCurrent: "已彻底删除「{title}」。它正是当前会话 —— 请切换会话或刷新页面。",
			doneWarn: "已彻底删除「{title}」（有 {n} 项清理未完成，详见插件日志）",
			failed: "删除失败：{error}",
			close: "关闭",
		};

		function humanSize(bytes) {
			const n = Number(bytes);
			if (!Number.isFinite(n) || n < 0) return "—";
			if (n < 1024) return n + " B";
			const units = ["KB", "MB", "GB", "TB"];
			let v = n / 1024;
			let i = 0;
			while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
			return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + " " + units[i];
		}

		function humanTime(ms) {
			const n = Number(ms);
			if (!Number.isFinite(n) || n <= 0) return null;
			try {
				const d = new Date(n);
				const pad = (x) => String(x).padStart(2, "0");
				return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
					" " + pad(d.getHours()) + ":" + pad(d.getMinutes());
			} catch { return null; }
		}

		function shortId(id) {
			return typeof id === "string" && id.length > 8 ? id.slice(0, 8) : String(id ?? "");
		}

		/** 一次性注入样式表。用宿主主题变量，深色/浅色自动跟随；每个 var() 都带兜底。 */
		function ensureCss() {
			if (typeof document === "undefined") return;
			if (document.getElementById(CSS_ID)) return;
			const style = document.createElement("style");
			style.id = CSS_ID;
			// 变量名对齐 @deepseek-ai/dsh-client-ui-primitives 的 Menu.module.css，
			// 让这一行看起来就是官方那一行（尺寸 / 圆角 / hover 填充 / 危险色）。
			style.textContent = `
[${ATTR}] { position: relative; }
[${ATTR}] .dhd-separator { height: 1px; margin: 2px 4px; background: var(--dsw-alias-border-l1, rgba(127,127,127,.28)); }
[${ATTR}] .dhd-item {
	display: flex; align-items: center; gap: 6px; width: 100%; box-sizing: border-box;
	min-height: 34px; padding: 6px 8px; border: none; border-radius: var(--dsw-radius-md, 8px);
	background: transparent; cursor: pointer; font: inherit; font-size: 13px; line-height: 20px;
	color: var(--dsw-alias-label-primary, inherit); text-align: left;
}
[${ATTR}] .dhd-item:hover:not(:disabled),
[${ATTR}] .dhd-item:focus-visible:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.16)); outline: none; }
[${ATTR}] .dhd-item:disabled { opacity: .4; cursor: not-allowed; }
[${ATTR}] .dhd-item.dhd-danger { color: var(--dsw-alias-state-error-primary, #e0574f); }
[${ATTR}] .dhd-item.dhd-danger:hover:not(:disabled),
[${ATTR}] .dhd-item.dhd-danger:focus-visible:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger, rgba(224,87,79,.14)); }
[${ATTR}] .dhd-icon { display: inline-flex; flex: none; width: 14px; height: 14px; align-items: center; justify-content: center; color: var(--dsw-alias-menu-icon, currentColor); }
[${ATTR}] .dhd-danger .dhd-icon { color: currentColor; }
[${ATTR}] .dhd-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.dhd-backdrop { position: fixed; inset: 0; z-index: 12000; display: flex; align-items: center; justify-content: center;
	background: color-mix(in srgb, CanvasText 32%, transparent); }
.dhd-modal { box-sizing: border-box; width: min(480px, calc(100vw - 48px)); padding: 18px 20px;
	border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.4)); border-radius: var(--dsw-radius-lg, 12px);
	background: var(--dsw-alias-bg-base, Canvas); color: var(--dsw-alias-label-primary, CanvasText);
	box-shadow: var(--dsw-elevation-prominent, 0 12px 40px rgba(0,0,0,.3)); font-size: 13px; line-height: 1.55; }
.dhd-modal-title { font-size: 15px; font-weight: 600; margin-bottom: 4px; }
.dhd-modal-desc { opacity: .78; margin-bottom: 10px; }
.dhd-rows { margin: 0 0 10px; font-size: 12px; opacity: .82; display: flex; flex-direction: column; gap: 2px; }
.dhd-warn { font-size: 12px; color: var(--dsw-alias-state-error-primary, #e0574f); margin-top: 4px; }
.dhd-err { font-size: 12px; color: var(--dsw-alias-state-error-primary, #e0574f); margin-top: 8px; }
.dhd-foot { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
.dhd-btn { font: inherit; font-size: 13px; padding: 5px 14px; border-radius: var(--dsw-radius-md, 8px);
	border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.5)); background: transparent;
	color: inherit; cursor: pointer; }
.dhd-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.16)); }
.dhd-btn:disabled { opacity: .45; cursor: not-allowed; }
.dhd-btn.dhd-danger { border-color: var(--dsw-alias-state-error-primary, #e0574f); color: var(--dsw-alias-state-error-primary, #e0574f); }
.dhd-btn.dhd-danger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger, rgba(224,87,79,.14)); }
.dhd-toast { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); z-index: 12001;
	max-width: 70vw; padding: 8px 14px; border-radius: var(--dsw-radius-md, 8px); font-size: 13px;
	border: 1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.5));
	background: var(--dsw-alias-bg-base, Canvas); color: var(--dsw-alias-label-primary, CanvasText);
	box-shadow: var(--dsw-elevation-prominent, 0 8px 24px rgba(0,0,0,.28)); }
`;
			document.head.appendChild(style);
		}

		/** 垃圾桶图标（14px，stroke 跟 currentColor，与官方图标同尺寸盒子）。 */
		function TrashIcon() {
			return h("svg", {
				viewBox: "0 0 16 16", width: 14, height: 14, fill: "none",
				stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round",
				"aria-hidden": "true", focusable: "false",
			},
				h("path", { d: "M3 4.6h10" }),
				h("path", { d: "M6.4 4.6V3.3c0-.4.3-.7.7-.7h1.8c.4 0 .7.3.7.7v1.3" }),
				h("path", { d: "M4.5 4.6l.6 8.2c0 .4.4.7.8.7h4.2c.4 0 .8-.3.8-.7l.6-8.2" }),
				h("path", { d: "M6.8 7.1v3.6" }),
				h("path", { d: "M9.2 7.1v3.6" })
			);
		}

		// ── 待确认请求的小 store（跨菜单项与浮层共享） ────────────────────────
		//
		// 只放一个请求：同一时刻只可能有一个确认框。模块级 + 订阅者集合，
		// 用 useState/useEffect 消费（不依赖 React 版本里的 useSyncExternalStore）。

		let pendingRequest = null;
		const pendingListeners = new Set();

		function setPendingRequest(next) {
			pendingRequest = next;
			for (const listener of [...pendingListeners]) {
				try { listener(); } catch { /* 单个订阅者出错不影响其它 */ }
			}
		}

		function usePendingRequest() {
			const [value, setValue] = useState(pendingRequest);
			useEffect(() => {
				const listener = () => setValue(pendingRequest);
				pendingListeners.add(listener);
				listener();
				return () => { pendingListeners.delete(listener); };
			}, []);
			return value;
		}

		/** 插件 ctx：仅用于只读探测「这个会话是不是当前打开的」（拿不到就退化为不判断）。 */
		let pluginCtx = null;

		function isCurrentSession(sessionId) {
			try {
				const sessions = pluginCtx && typeof pluginCtx.get === "function" ? pluginCtx.get("sessions") : null;
				const list = sessions && sessions.list;
				const snapshot = list && typeof list.getSnapshot === "function" ? list.getSnapshot() : null;
				const row = snapshot && snapshot.byId ? snapshot.byId[sessionId] : null;
				const retained = row && row.retainedBy ? row.retainedBy.mainView : 0;
				return Number(retained) > 0;
			} catch { return false; }
		}

		// ── ① 会话「…」菜单里的那一行 ─────────────────────────────────────────

		/**
		 * @param props - owner props `{ sessionId, displayTitle }`、槽位注入的
		 *   `useMenuOpenState`、以及 `locale: NS` 带来的 `t`。
		 */
		function SessionDeleteMenuItem(props) {
			const sessionId = props.sessionId;
			const displayTitle = typeof props.displayTitle === "string" && props.displayTitle.length > 0
				? props.displayTitle
				: "";

			const menuState = typeof props.useMenuOpenState === "function" ? props.useMenuOpenState() : null;
			const setMenuOpen = Array.isArray(menuState) ? menuState[1] : null;

			const onSelect = useCallback(() => {
				if (typeof setMenuOpen === "function") setMenuOpen(false);
				setPendingRequest({ sessionId, displayTitle });
			}, [sessionId, displayTitle, setMenuOpen]);

			const label = props.t ? props.t("menu.delete") : FALLBACK_TEXT.menuDelete;

			// DOM 与官方的 MenuItemButton 一致：itemWrap > [separator] + button[role=menuitem]，
			// 菜单的键盘遍历与焦点回收都是读 DOM 的，所以自绘的按钮同样能参与。
			return h("div", { [ATTR]: "" },
				h("div", { className: "dhd-separator", role: "separator" }),
				h("button", {
					type: "button",
					role: "menuitem",
					className: "dhd-item dhd-danger",
					onClick: onSelect,
				},
					h("span", { className: "dhd-icon" }, h(TrashIcon, null)),
					h("span", { className: "dhd-label" }, label)
				)
			);
		}

		// ── ② 常驻浮层里的确认框 ──────────────────────────────────────────────

		function DeleteConfirmOverlay(props) {
			const request = usePendingRequest();
			const t = props.t;

			const [apiPrefix, setApiPrefix] = useState(DEFAULT_PREFIX);
			const [text, setText] = useState(null);
			const [info, setInfo] = useState(null);
			const [busy, setBusy] = useState(false);
			const [error, setError] = useState(null);
			const [toast, setToast] = useState(null);
			const [current, setCurrent] = useState(false);
			const toastTimer = useRef(null);
			const cancelRef = useRef(null);

			const tt = useCallback((key, vars) => {
				const dict = text || {};
				let s = dict[key];
				if (typeof s !== "string" || s.length === 0) s = FALLBACK_TEXT[key];
				if (typeof s !== "string") s = key;
				if (vars) for (const k of Object.keys(vars)) s = s.split("{" + k + "}").join(String(vars[k]));
				return s;
			}, [text]);

			const call = useCallback(async (path, options) => {
				const res = await fetch(apiPrefix + path, Object.assign({
					credentials: "same-origin",
					headers: { "content-type": "application/json" },
				}, options || {}));
				let body = null;
				try { body = await res.json(); } catch { body = null; }
				if (!res.ok) {
					const err = new Error((body && body.error) || ("HTTP " + res.status));
					err.code = body && body.code;
					err.status = res.status;
					throw err;
				}
				return body || {};
			}, [apiPrefix]);

			const flash = useCallback((msg) => {
				setToast({ text: msg });
				if (toastTimer.current) { try { clearTimeout(toastTimer.current); } catch { /* ignore */ } }
				toastTimer.current = setTimeout(() => setToast(null), 8000);
			}, []);

			useEffect(() => () => {
				if (toastTimer.current) { try { clearTimeout(toastTimer.current); } catch { /* ignore */ } }
			}, []);

			// 一次性读配置（前缀 + 文案覆盖）。
			useEffect(() => {
				let alive = true;
				(async () => {
					try {
						const config = await call("/config");
						if (!alive) return;
						if (typeof config.apiPrefix === "string" && config.apiPrefix.length > 0) setApiPrefix(config.apiPrefix);
						if (config.text && typeof config.text === "object") setText(config.text);
					} catch { /* /config 失败不致命，用默认前缀继续 */ }
				})();
				return () => { alive = false; };
			}, [call]);

			// 每次有新请求：探一次「是不是当前会话」并查一次概况。
			useEffect(() => {
				if (!request) { setInfo(null); setError(null); return; }
				let alive = true;
				setError(null);
				setInfo(null);
				setCurrent(isCurrentSession(request.sessionId));
				(async () => {
					try {
						const detail = await call("/inspect", {
							method: "POST",
							body: JSON.stringify({ sessionId: request.sessionId }),
						});
						if (alive) setInfo(detail);
					} catch (err) {
						// 概况拿不到不拦路：标题用菜单带来的 displayTitle 兜底。
						if (alive) setError(err && err.message ? err.message : String(err));
					}
				})();
				return () => { alive = false; };
			}, [request, call]);

			const cancel = useCallback(() => {
				if (busy) return;
				setPendingRequest(null);
			}, [busy]);

			// Esc = 取消；焦点默认落在「取消」上 —— 破坏性操作的默认键不能是「确认」。
			useEffect(() => {
				if (!request) return undefined;
				const onKey = (event) => { if (event.key === "Escape") { event.preventDefault(); cancel(); } };
				document.addEventListener("keydown", onKey);
				try { cancelRef.current?.focus?.(); } catch { /* ignore */ }
				return () => document.removeEventListener("keydown", onKey);
			}, [request, cancel]);

			const confirm = useCallback(async () => {
				if (!request) return;
				setBusy(true);
				setError(null);
				try {
					const report = await call("/delete", {
						method: "POST",
						body: JSON.stringify({ sessionId: request.sessionId, confirm: true }),
					});
					const title = request.displayTitle || (info && info.title) || shortId(request.sessionId);
					const warnings = Array.isArray(report && report.warnings) ? report.warnings.length : 0;
					const wasCurrent = current;
					setPendingRequest(null);
					if (warnings > 0) flash(tt("doneWarn", { title, n: warnings }));
					else flash(tt(wasCurrent ? "doneCurrent" : "done", { title }));
				} catch (err) {
					setError(tt("failed", { error: err && err.message ? err.message : String(err) }));
				} finally {
					setBusy(false);
				}
			}, [request, info, current, call, flash, tt]);

			const toastNode = toast
				? h("div", { className: "dhd-toast", role: "status" }, toast.text)
				: null;

			if (!request) return toastNode;

			const title = request.displayTitle || (info && info.title) || shortId(request.sessionId);
			const rows = [];
			if (info) {
				rows.push(h("div", { key: "cwd" }, tt("labelCwd") + "：" + (info.cwd || tt("unknownCwd"))));
				rows.push(h("div", { key: "size" }, tt("labelSize") + "：" + tt("sizeFmt", {
					size: humanSize(info.bytes),
					n: Number(info.files) || 0,
				})));
				const created = humanTime(info.createdAt);
				if (created) rows.push(h("div", { key: "created" }, tt("labelCreated") + "：" + created));
			} else if (!error) {
				rows.push(h("div", { key: "loading" }, tt("loading")));
			}

			return h(react.Fragment, null,
				h("div", {
					className: "dhd-backdrop",
					onClick: (event) => { if (event.target === event.currentTarget) cancel(); },
				},
					h("div", {
						className: "dhd-modal",
						role: "dialog",
						"aria-modal": "true",
						"aria-label": tt("title"),
					},
						h("div", { className: "dhd-modal-title" }, tt("title")),
						h("div", { className: "dhd-modal-desc" }, tt("desc", { title })),
						rows.length > 0 ? h("div", { className: "dhd-rows" }, rows) : null,
						h("div", { className: "dhd-warn" }, tt("warnHard")),
						current ? h("div", { className: "dhd-warn" }, tt("warnCurrent")) : null,
						h("div", { className: "dhd-warn" }, tt("warnRunning")),
						error ? h("div", { className: "dhd-err" }, error) : null,
						h("div", { className: "dhd-foot" },
							h("button", {
								type: "button",
								className: "dhd-btn",
								disabled: busy,
								ref: cancelRef,
								onClick: cancel,
							}, tt("cancel")),
							h("button", {
								type: "button",
								className: "dhd-btn dhd-danger",
								disabled: busy,
								onClick: confirm,
							}, busy ? tt("working") : tt("confirmAction"))
						)
					)
				),
				toastNode
			);
		}

		//#region plugin
		const name = "dsh-hard-delete/client";
		const inject = ["slots", "locale"];

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, DICT), "dsh-hard-delete: dictionaries");

			if (!ctx.slots || typeof ctx.slots.inject !== "function" || typeof ctx.slots.register !== "function") {
				throw new Error(
					"dsh-hard-delete: no usable slots API found (ctx.slots.inject / ctx.slots.register missing)"
				);
			}

			// 校验通过后再认这个 ctx：apply 中途抛错时不留一个半残的引用。
			pluginCtx = ctx;
			ensureCss();

			// ① 会话「…」菜单里的一行（排在 archive 的 400 之后，成为最后一行）。
			ctx.slots.inject("sidebar.workspaces.session.menu.item", () => ctx.slots.register({
				name: "sidebar.workspaces.session.menu.item",
				id: "hard-delete",
				order: 500,
				locale: NS,
			}, SessionDeleteMenuItem));

			// ② 常驻浮层里的确认框（菜单项卸载后它还在）。
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "hard-delete-confirm",
				order: 9000,
				locale: NS,
			}, DeleteConfirmOverlay));
		}
		//#endregion

		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		exports.__internal = {
			SessionDeleteMenuItem, DeleteConfirmOverlay, setPendingRequest,
			usePendingRequest, FALLBACK_TEXT, DICT, DEFAULT_PREFIX, NS,
		};
		return module.exports;
	}
});
