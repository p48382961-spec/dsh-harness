/**
 * dsh-app-release 的浏览器端 —— 复刻桌面端那条「应用」栏。
 *
 * 桌面端（Electron）把菜单条画在 OS 标题栏上：应用 ▾ → 关于 DeepSeek Harness / 检查更新…
 * 我们没有标题栏，于是：
 *   ① 宽侧栏时，在顶部品牌名旁边挂一个「应用 ▾」按钮（slot `sidebar.brand.name`）
 *   ② 侧栏收起成 56px 窄轨时 brand.name 不渲染 —— 退到侧栏底部的小药丸（`sidebar.footer.action`）
 *   ③ 菜单与对话框都画在 `shell.overlay`（框架级浮层，`position:absolute; inset:0`，子元素 pointer-events:auto），
 *      这样不会被侧栏的 overflow 裁掉
 *   ④ 对话框照官方 apps/desktop/renderer/update-dialog.css 的规格：380 宽 / 24 圆角 / 竖排 44px 按钮 / 28px 圆形关闭
 *
 * 手写 bundle（不用 JSX / 构建工具），与 dsh-maintenance 的客户端同形态：
 *   window.__ModuleLoader__.load({ id, factory }) → factory(require) 返回 module.exports
 */
window.__ModuleLoader__.load({
	id: "dsh-app-release",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var API = "/api/dsh-app-release";
		var STYLE_ID = "dsh-app-release-style-v2";
		var SLOT_BRAND = "sidebar.brand.name";
		var SLOT_FOOT = "sidebar.footer.action";
		var SLOT_OVERLAY = "shell.overlay";

		var reactNamespace = require("react");
		var React = (reactNamespace && reactNamespace.default) || reactNamespace;
		var h = React.createElement;

		/* ------------------------------------------------------------------ *
		 * 文案：照桌面端 apps/desktop/src/locale.ts 的中文条目
		 * ------------------------------------------------------------------ */
		var T = {
			app: "应用",
			aboutMenu: "关于 DeepSeek Harness",
			checkUpdatesMenu: "检查更新…",
			updateCheckTitle: "检查更新",
			updateCurrent: "已是最新版本",
			updateCurrentDetail: "当前版本：{version}",
			updateAvailable: "发现新版本 {version}",
			updateDetail: "下载完成后，可安装并重启应用。",
			updateDownload: "下载更新",
			later: "稍后",
			confirm: "确定",
			close: "关闭",
			updateDownloading: "正在下载…",
			updateVerifying: "正在校验更新文件…",
			updateInstalling: "正在准备重启…",
			updateDownloadedTitle: "新版本已准备就绪",
			updateDownloadedDetail: "更新期间应用将暂时关闭，完成后会自动打开。",
			updateRetry: "重试更新",
			updateTechnicalDetails: "查看技术详情",
			updateCheckFailed: "检查更新失败，请稍后重试。",
			aboutTitle: "关于 DeepSeek Harness",
			shellTitle: "外壳（这个 App）",
			shellAvailable: "外壳有新版本 v{version}",
			shellWaiting: "下载完成后会自动弹出系统安装界面。",
			engineTitle: "引擎（DSH 本体）",
			engineAvailable: "引擎有新版本 {version}",
			engineDetail: "安装完成后引擎会自动重启，页面自动刷新。",
			engineUpdating: "正在安装新引擎，完成后自动重启…",
			engineReady: "引擎已更新到 {version}",
			checking: "正在检查更新…",
			badgeUpdate: "有更新"
		};

		function fill(text, vars) {
			return String(text).replace(/\{(\w+)\}/g, function (_, key) {
				return vars && vars[key] != null ? String(vars[key]) : "";
			});
		}

		function mb(bytes) {
			return bytes ? (bytes / 1048576).toFixed(1) + " MB" : "";
		}

		/* ------------------------------------------------------------------ *
		 * 模块级轻状态：顶部按钮 / 底部药丸 / 浮层共用
		 * ------------------------------------------------------------------ */
		var state = {
			info: null,
			loading: false,
			view: null, // null | "update" | "about"
			phase: "idle", // idle | checking | latest | available | downloading | installing | ready | error
			note: null,
			detail: null,
			menu: null // 菜单锚点 rect
		};

		var listeners = [];

		function setState(patch) {
			var next = typeof patch === "function" ? patch(state) : patch;
			state = Object.assign({}, state, next);
			listeners.slice().forEach(function (fn) {
				try {
					fn(state);
				} catch (err) {
					/* 单个订阅者抛错不影响其它订阅者 */
				}
			});
		}

		function useStore() {
			var pair = React.useState(state);
			React.useEffect(function () {
				listeners.push(pair[1]);
				return function () {
					listeners = listeners.filter(function (item) {
						return item !== pair[1];
					});
				};
			}, []);
			return pair[0];
		}

		/* ------------------------------------------------------------------ *
		 * 网络
		 * ------------------------------------------------------------------ */
		function call(action) {
			return fetch(API + "?action=" + action, { credentials: "same-origin" }).then(function (response) {
				return response.json();
			});
		}

		function anyUpdate(info) {
			if (!info) return false;
			var app = info.app || {};
			var engine = info.engine || {};
			return Boolean(app.updateAvailable || engine.updateAvailable || engine.updating);
		}

		function phaseFrom(info) {
			var app = (info && info.app) || {};
			var engine = (info && info.engine) || {};
			if (engine.updating) return "installing";
			if (app.updateAvailable || engine.updateAvailable) return "available";
			if (app.error || engine.error) return "error";
			if (app.checked || engine.checked) return "latest";
			return "idle";
		}

		function load(network) {
			setState({ loading: true, note: null });
			if (network) setState({ phase: "checking" });
			return call(network ? "check" : "status")
				.then(function (info) {
					setState({ info: info, loading: false, phase: phaseFrom(info), note: null });
				})
				.catch(function (err) {
					setState({
						loading: false,
						phase: "error",
						note: T.updateCheckFailed + "\n" + String((err && err.message) || err)
					});
				});
		}

		function openView(kind) {
			setState({ view: kind, menu: null, note: null, detail: null });
			if (kind === "update") {
				setState({ phase: "checking" });
				load(true);
			} else {
				load(false);
			}
		}

		function closeView() {
			setState({ view: null, note: null, detail: null });
		}

		function startAppDownload() {
			var app = (state.info && state.info.app) || {};
			if (!app.apkUrl) {
				setState({ note: "这个 release 里没有 APK 资产。" });
				return;
			}
			setState({ phase: "downloading", detail: T.shellWaiting });
			// 交给 WebView 的下载监听：Java 侧落盘 + 拉起系统安装器
			window.location.href = app.apkUrl;
		}

		function startEngineUpdate() {
			var engine = (state.info && state.info.engine) || {};
			var target = engine.latest;
			if (!target) return;
			setState({ phase: "installing", detail: T.engineUpdating });
			fetch(API + "?action=update-engine&version=" + encodeURIComponent(target), {
				method: "POST",
				credentials: "same-origin"
			})
				.then(function (response) {
					return response.json();
				})
				.then(function (result) {
					if (!result || !result.ok) {
						setState({
							phase: "error",
							note: "启动引擎更新失败：" + ((result && result.error) || "未知错误")
						});
						return;
					}
					var ticks = 0;
					var timer = setInterval(function () {
						ticks += 1;
						call("status")
							.then(function (next) {
								var engineState = (next && next.engine) || {};
								setState({ info: next });
								if (!engineState.updating) {
									clearInterval(timer);
									setState({
										phase: "ready",
										detail: fill(T.engineReady, { version: engineState.current || target })
									});
								}
							})
							.catch(function () {
								clearInterval(timer);
							});
						if (ticks > 200) clearInterval(timer);
					}, 3000);
				})
				.catch(function (err) {
					setState({
						phase: "error",
						note: "启动引擎更新失败：" + String((err && err.message) || err)
					});
				});
		}

		/* ------------------------------------------------------------------ *
		 * 样式
		 * ------------------------------------------------------------------ */
		function ensureStyles() {
			if (document.getElementById(STYLE_ID)) return;
			var el = document.createElement("style");
			el.id = STYLE_ID;
			el.textContent = [
				/* 顶部「应用」按钮 */
				".dsar-app{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 8px;border:0;border-radius:6px;",
				"background:transparent;color:var(--dsw-alias-label-secondary,#5b6068);font-size:14px;line-height:1;cursor:pointer;",
				"transition:background 120ms ease,color 120ms ease}",
				".dsar-app:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,#111)}",
				".dsar-app[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-active,rgba(127,127,127,.2));color:var(--dsw-alias-label-primary,#111)}",
				".dsar-caret{width:0;height:0;border-left:3.5px solid transparent;border-right:3.5px solid transparent;border-top:4.5px solid currentColor;opacity:.65}",
				/* 底部药丸（窄轨兜底） */
				".dsar-pill{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));",
				"background:transparent;color:var(--dsw-alias-label-secondary,#666);border-radius:999px;padding:3px 10px;font-size:11px;",
				"line-height:18px;cursor:pointer;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
				".dsar-pill:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}",
				".dsar-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-brand-primary,#2f6feb)}",
				/* 下拉菜单 */
				".dsar-menu{position:fixed;z-index:1300;min-width:212px;padding:6px;border-radius:10px;",
				"background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111);",
				"border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));",
				"box-shadow:0 12px 32px rgba(0,0,0,.18);animation:dsar-in 120ms ease}",
				".dsar-menu-item{display:block;width:100%;text-align:left;border:0;background:transparent;color:inherit;",
				"font-size:14px;line-height:20px;padding:7px 10px;border-radius:6px;cursor:pointer;font-family:inherit}",
				".dsar-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}",
				".dsar-menu-sep{height:1px;margin:5px 6px;background:var(--dsw-alias-border-l2,rgba(127,127,127,.2))}",
				/* 对话框（官方 update-dialog.css 规格） */
				".dsar-mask{position:fixed;inset:0;z-index:1400;display:flex;align-items:center;justify-content:center;",
				"background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.32));animation:dsar-in 150ms ease}",
				".dsar-card{position:relative;width:min(380px,calc(100vw - 32px));max-height:calc(100vh - 48px);overflow:auto;",
				"box-sizing:border-box;padding:22px 24px 24px;border-radius:24px;background:var(--dsw-alias-bg-layer-1,#fff);",
				"color:var(--dsw-alias-label-primary,#0f1115);box-shadow:0 24px 64px rgba(0,0,0,.24);",
				"border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}",
				".dsar-title{font-size:16px;line-height:24px;font-weight:500;padding-right:36px;margin:0}",
				".dsar-msg{font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary,#0f1115);margin:8px 0 0;white-space:pre-wrap}",
				".dsar-dim{color:var(--dsw-alias-label-secondary,#5b6068)}",
				".dsar-row{display:flex;align-items:baseline;flex-wrap:wrap;gap:6px;font-size:13px;line-height:20px;margin:6px 0 0;",
				"color:var(--dsw-alias-label-secondary,#5b6068)}",
				".dsar-row b{font-weight:500;color:var(--dsw-alias-label-primary,#0f1115)}",
				".dsar-arrow{opacity:.5}",
				".dsar-block{margin-top:14px;padding:12px 14px;border-radius:14px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08))}",
				".dsar-block-title{font-size:13px;line-height:18px;font-weight:500;margin:0 0 2px}",
				".dsar-block-note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a8f98);margin:6px 0 0}",
				".dsar-actions{display:flex;flex-direction:column;gap:8px;margin-top:20px}",
				".dsar-btn{min-height:44px;padding:9px 16px;border-radius:12px;border:1px solid transparent;font-size:14px;",
				"line-height:22px;cursor:pointer;font-family:inherit}",
				".dsar-btn[disabled]{opacity:.55;cursor:default}",
				".dsar-btn-primary{background:var(--dsw-alias-button-primary-fill,#0f1115);color:#fff}",
				".dsar-btn-primary:hover:not([disabled]){opacity:.9}",
				".dsar-btn-dim{background:var(--dsw-alias-button-primary-dimmed,#ebeef2);color:var(--dsw-alias-label-primary,#0f1115)}",
				".dsar-close{position:absolute;top:14px;right:14px;width:28px;height:28px;border-radius:50%;border:0;",
				"background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-secondary,#5b6068);",
				"font-size:16px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;font-family:inherit}",
				".dsar-close:hover{background:var(--dsw-alias-interactive-bg-active,rgba(127,127,127,.24))}",
				".dsar-details{margin-top:16px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#5b6068)}",
				".dsar-details summary{cursor:pointer;color:var(--dsw-alias-link,#2f6feb);outline:none}",
				".dsar-pre{margin:8px 0 0;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));",
				"font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-all}",
				"@keyframes dsar-in{from{opacity:0}to{opacity:1}}"
			].join("");
			document.head.appendChild(el);
		}

		/* ------------------------------------------------------------------ *
		 * 顶部「应用 ▾」按钮
		 * ------------------------------------------------------------------ */
		function BrandEntry() {
			var store = useStore();
			var open = Boolean(store.menu);

			React.useEffect(function () {
				if (!open) return undefined;
				function onKey(event) {
					if (event.key === "Escape") setState({ menu: null });
				}
				function onDown(event) {
					var node = event.target;
					while (node) {
						if (node.classList && (node.classList.contains("dsar-menu") || node.classList.contains("dsar-app"))) return;
						node = node.parentNode;
					}
					setState({ menu: null });
				}
				function onMove() {
					setState({ menu: null });
				}
				document.addEventListener("keydown", onKey);
				document.addEventListener("mousedown", onDown, true);
				window.addEventListener("resize", onMove);
				window.addEventListener("scroll", onMove, true);
				return function () {
					document.removeEventListener("keydown", onKey);
					document.removeEventListener("mousedown", onDown, true);
					window.removeEventListener("resize", onMove);
					window.removeEventListener("scroll", onMove, true);
				};
			}, [open]);

			return h(
				"button",
				{
					className: "dsar-app",
					type: "button",
					"aria-haspopup": "menu",
					"aria-expanded": open ? "true" : "false",
					title: T.app,
					onClick: function (event) {
						if (open) {
							setState({ menu: null });
							return;
						}
						var box = event.currentTarget.getBoundingClientRect();
						setState({ menu: { left: box.left, top: box.top, bottom: box.bottom } });
					}
				},
				T.app,
				h("span", { className: "dsar-caret", "aria-hidden": "true" })
			);
		}

		/* ------------------------------------------------------------------ *
		 * 底部药丸（窄轨兜底）
		 * ------------------------------------------------------------------ */
		function FootEntry() {
			var store = useStore();
			var app = (store.info && store.info.app) || {};
			var label = app.current ? "外壳 " + app.current : "外壳 --";
			return h(
				"button",
				{
					className: "dsar-pill",
					type: "button",
					title: "版本与更新（外壳 + 引擎）",
					onClick: function () {
						openView("update");
					}
				},
				label,
				anyUpdate(store.info) ? h("span", { className: "dsar-dot" }) : null
			);
		}

		/* ------------------------------------------------------------------ *
		 * 浮层：菜单 + 对话框
		 * ------------------------------------------------------------------ */
		function MenuLayer(props) {
			var rect = props.rect;
			var top = rect.bottom + 6;
			var maxTop = window.innerHeight - 140;
			if (top > maxTop) top = Math.max(8, rect.top - 118);
			var left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - 232));
			return h(
				"div",
				{ className: "dsar-menu", role: "menu", style: { top: top + "px", left: left + "px" } },
				h(
					"button",
					{
						className: "dsar-menu-item",
						type: "button",
						role: "menuitem",
						onClick: function () {
							openView("about");
						}
					},
					T.aboutMenu
				),
				h("div", { className: "dsar-menu-sep" }),
				h(
					"button",
					{
						className: "dsar-menu-item",
						type: "button",
						role: "menuitem",
						onClick: function () {
							openView("update");
						}
					},
					T.checkUpdatesMenu
				)
			);
		}

		function CloseButton() {
			return h(
				"button",
				{ className: "dsar-close", type: "button", "aria-label": T.close, onClick: closeView },
				"\u00d7"
			);
		}

		function VersionRow(props) {
			return h(
				"div",
				{ className: "dsar-row" },
				h("span", null, props.label),
				h("b", null, props.from || "未知"),
				props.to ? h("span", { className: "dsar-arrow" }, "\u2192") : null,
				props.to ? h("b", null, props.to) : null,
				props.extra ? h("span", { className: "dsar-dim" }, props.extra) : null
			);
		}

		function AboutCard() {
			var store = useStore();
			var app = (store.info && store.info.app) || {};
			var engine = (store.info && store.info.engine) || {};
			return h(
				"div",
				{ className: "dsar-mask", onClick: closeView },
				h(
					"div",
					{ className: "dsar-card", role: "dialog", "aria-modal": "true", onClick: function (e) { e.stopPropagation(); } },
					h(CloseButton),
					h("h2", { className: "dsar-title" }, T.aboutTitle),
					h(VersionRow, { label: "外壳", from: app.current || "未知", extra: app.payload ? " · 载荷 " + app.payload : "" }),
					h(VersionRow, { label: "引擎", from: engine.current || "未知" }),
					h(
						"div",
						{ className: "dsar-actions" },
						h("button", { className: "dsar-btn dsar-btn-primary", type: "button", onClick: closeView }, T.confirm)
					)
				)
			);
		}

		function UpdateCard() {
			var store = useStore();
			var info = store.info || {};
			var app = info.app || {};
			var engine = info.engine || {};
			var phase = store.phase;

			var title = T.updateCheckTitle;
			var message = null;
			var blocks = [];
			var actions = [];

			if (phase === "checking") {
				message = T.checking;
			} else if (phase === "latest") {
				title = T.updateCurrent;
				message = fill(T.updateCurrentDetail, { version: app.current || "未知" });
				var latestBits = [];
				if (app.checked && app.latest) latestBits.push("外壳 v" + app.latest);
				if (engine.checked && engine.latest) latestBits.push("引擎 " + engine.latest);
				if (latestBits.length) message += "\n" + latestBits.join(" · ");
			} else if (phase === "error") {
				message = store.note || T.updateCheckFailed;
			} else if (phase === "available") {
				var heads = [];
				if (app.updateAvailable && app.latest) heads.push(fill(T.shellAvailable, { version: app.latest }));
				if (engine.updateAvailable && engine.latest) heads.push(fill(T.engineAvailable, { version: engine.latest }));
				if (heads.length) title = heads[0];
				if (heads.length > 1) message = heads.slice(1).join("\n");
			} else if (phase === "downloading") {
				title = T.updateDownloading;
				message = store.detail || T.shellWaiting;
			} else if (phase === "installing") {
				title = T.engineUpdating;
			} else if (phase === "ready") {
				title = store.detail || T.updateDownloadedTitle;
				message = T.updateDownloadedDetail;
			} else {
				title = T.updateCheckTitle;
				message = "检查一下有没有新版本。";
			}

			if (phase === "available" || phase === "checking") {
				if (app.updateAvailable) {
					blocks.push(
						h(
							"div",
							{ className: "dsar-block", key: "shell" },
							h("p", { className: "dsar-block-title" }, T.shellTitle),
							h(VersionRow, { label: "当前", from: app.current, to: "v" + app.latest }),
							h("p", { className: "dsar-block-note" }, T.updateDetail)
						)
					);
				}
				if (engine.updateAvailable) {
					blocks.push(
						h(
							"div",
							{ className: "dsar-block", key: "engine" },
							h("p", { className: "dsar-block-title" }, T.engineTitle),
							h(VersionRow, { label: "当前", from: engine.current, to: engine.latest }),
							h("p", { className: "dsar-block-note" }, T.engineDetail)
						)
					);
				}
			}

			if (phase === "available") {
				if (app.updateAvailable) {
					actions.push(
						h(
							"button",
							{ key: "app", className: "dsar-btn dsar-btn-primary", type: "button", onClick: startAppDownload },
							T.updateDownload + (app.apkSize ? "（" + mb(app.apkSize) + "）" : "")
						)
					);
				}
				if (engine.updateAvailable) {
					actions.push(
						h(
							"button",
							{
								key: "engine",
								className: app.updateAvailable ? "dsar-btn dsar-btn-dim" : "dsar-btn dsar-btn-primary",
								type: "button",
								disabled: engine.updating,
								onClick: startEngineUpdate
							},
							"更新引擎并重启"
						)
					);
				}
				actions.push(
					h("button", { key: "later", className: "dsar-btn dsar-btn-dim", type: "button", onClick: closeView }, T.later)
				);
			} else if (phase === "error") {
				actions.push(
					h(
						"button",
						{
							key: "retry",
							className: "dsar-btn dsar-btn-primary",
							type: "button",
							onClick: function () {
								setState({ phase: "checking", note: null });
								load(true);
							}
						},
						T.updateRetry
					),
					h("button", { key: "later", className: "dsar-btn dsar-btn-dim", type: "button", onClick: closeView }, T.later)
				);
			} else if (phase === "downloading" || phase === "installing") {
				actions.push(
					h("button", { key: "later", className: "dsar-btn dsar-btn-dim", type: "button", onClick: closeView }, "后台继续")
				);
			} else if (phase === "ready") {
				actions.push(
					h("button", { key: "ok", className: "dsar-btn dsar-btn-primary", type: "button", onClick: closeView }, T.confirm)
				);
			} else if (phase === "checking") {
				actions.push(
					h("button", { key: "later", className: "dsar-btn dsar-btn-dim", type: "button", onClick: closeView }, T.later)
				);
			} else {
				actions.push(
					h(
						"button",
						{
							key: "check",
							className: "dsar-btn dsar-btn-primary",
							type: "button",
							onClick: function () {
								setState({ phase: "checking" });
								load(true);
							}
						},
						T.checkUpdatesMenu
					),
					h("button", { key: "later", className: "dsar-btn dsar-btn-dim", type: "button", onClick: closeView }, T.later)
				);
			}

			var techLines = [];
			if (app.current || app.latest) {
				techLines.push("外壳 " + (app.current || "?") + (app.latest ? " → v" + app.latest : "") + (app.pageUrl ? "\n" + app.pageUrl : ""));
			}
			if (engine.current || engine.latest) {
				techLines.push("引擎 " + (engine.current || "?") + (engine.latest ? " / npm " + engine.latest : ""));
			}
			if (app.payload) techLines.push("载荷标记 " + app.payload);
			if (app.error) techLines.push("外壳检查错误 " + app.error);
			if (engine.error) techLines.push("引擎检查错误 " + engine.error);
			var details = techLines.length
				? h(
						"details",
						{ className: "dsar-details" },
						h("summary", null, T.updateTechnicalDetails),
						h("pre", { className: "dsar-pre" }, techLines.join("\n\n"))
				  )
				: null;

			return h(
				"div",
				{ className: "dsar-mask", onClick: closeView },
				h(
					"div",
					{ className: "dsar-card", role: "dialog", "aria-modal": "true", onClick: function (e) { e.stopPropagation(); } },
					h(CloseButton),
					h("h2", { className: "dsar-title" }, title),
					message ? h("p", { className: "dsar-msg" }, message) : null,
					blocks,
					details,
					h("div", { className: "dsar-actions" }, actions)
				)
			);
		}

		function OverlayEntry() {
			var store = useStore();
			var layers = [];
			if (store.menu) layers.push(h(MenuLayer, { key: "menu", rect: store.menu }));
			if (store.view === "about") layers.push(h(AboutCard, { key: "about" }));
			else if (store.view === "update") layers.push(h(UpdateCard, { key: "update" }));
			if (!layers.length) return null;
			return h(React.Fragment, null, layers);
		}

		/* ------------------------------------------------------------------ *
		 * 注册
		 * ------------------------------------------------------------------ */
		function apply(ctx) {
			ensureStyles();
			if (!state.info && !state.loading) load(false);
			ctx.slots.inject(SLOT_BRAND, function () {
				return ctx.slots.register({ name: SLOT_BRAND, id: "app-release-menu", order: 40 }, BrandEntry);
			});
			ctx.slots.inject(SLOT_FOOT, function () {
				return ctx.slots.register({ name: SLOT_FOOT, id: "app-release", order: 102 }, FootEntry);
			});
			ctx.slots.inject(SLOT_OVERLAY, function () {
				return ctx.slots.register({ name: SLOT_OVERLAY, id: "app-release-dialog" }, OverlayEntry);
			});
		}

		var inject = ["slots"];
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
