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
		var SLOT_HEADER = "conversation.header.leading";
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
			mirrorDetail: "走镜像地址下载（GitHub 直连不通时用）。",
			apiFallback: "GitHub API 限流，已改用订阅源检查版本（不影响更新）。",
			mirrorTitle: "外壳下载镜像",
			mirrorPlaceholder: "http://…/dsh-harness-arm64.apk",
			mirrorSave: "保存",
			mirrorClear: "清除",
			mirrorHint: "GitHub 直连下不动时，把 APK 直链填这里（本机下载服务或自己的服务器都行）。",
			engineTitle: "引擎（DSH 本体）",
			engineAvailable: "引擎有新版本 {version}",
			engineRidesShell: "引擎（官方 DSH 核心）随外壳一起升级：上面的「下载并安装」会把新引擎一并换上。Android 版引擎必须是打过补丁的构建，不能从 npm 单独热更新。",
			engineUpdateAction: "更新引擎（{version}，约 95 MB）",
			engineDetail: "官方 DSH 核心。Android 上它必须是打好补丁的预构建包，所以这里给的是我们自己发布的引擎包（下载 → 校验 sha256 → 冒烟 → 原子换目录，失败可回滚），不跑 npm。",
			engineUpdating: "正在安装新引擎，完成后自动重启…",
			engineProgressStarting: "正在启动升级脚本…",
			engineProgressElapsed: "已用时",
			engineProgressStale: "已经 N 秒没有新进展 —— 下载大包时正常，超过 5 分钟建议看下面的日志。",
			engineProgressLog: "最近日志",
			engineProgressDone: "升级完成，正在重启引擎…",
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
			setState({ view: kind, menu: null, note: null, detail: null, dl: null });
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
			// 优先走壳的 JS 桥（Java 内下载 + 自动拉起系统安装器）；
			// 直接导航会被 shouldOverrideUrlLoading 当成外部链接丢给浏览器，用户看到的是「点了没反应」。
			var bridge = window.DSHBridge;
			if (bridge && typeof bridge.download === "function") {
				try {
					bridge.download(app.apkUrl);
					return;
				} catch (err) {
					/* 桥挂了就退回导航 */
				}
			}
			window.location.href = app.apkUrl;
		}

		function saveMirror(value) {
			setState({ loading: true, note: null });
			fetch(API + "?action=mirror&url=" + encodeURIComponent(String(value || "").trim()), {
				method: "POST",
				credentials: "same-origin"
			})
				.then(function (response) {
					return response.json();
				})
				.then(function (result) {
					if (!result || !result.ok) throw new Error((result && result.error) || "保存失败");
					setState({ loading: false, note: result.note || "已保存。" });
					load(false);
				})
				.catch(function (err) {
					setState({ loading: false, note: "保存镜像失败：" + String((err && err.message) || err) });
				});
		}

		function pollEngineProgress(target) {
			// 每 1.5 秒取一次状态：脚本会一步步写 .dsh-update-state.json，
			// 面板据此刷新进度条、当前步骤、耗时和日志尾巴。
			var ticks = 0;
			var sawUpdating = false;
			var timer = setInterval(function () {
				ticks += 1;
				call("status")
					.then(function (next) {
						var engineState = (next && next.engine) || {};
						var progress = engineState.progress || {};
						setState({ info: next });
						if (engineState.updating) sawUpdating = true;
						if (progress.stage === "error") {
							clearInterval(timer);
							setState({
								phase: "error",
								note: "更新失败：" + (progress.error || progress.label || "见日志")
							});
							return;
						}
						// 脚本还没被拉起的那几秒别急着下结论（0.10.22 就是这里秒判「更新完成」）
						if (engineState.updating || (!sawUpdating && ticks < 5)) return;
						if (engineState.updating) return;
						clearInterval(timer);
						var now = String(engineState.current || "").replace(/\s*\(.*$/, "");
						if (now && target && now !== target) {
							setState({
								phase: "error",
								note: "更新没有生效：引擎仍是 " + now + "（目标 " + target + "）。看下面日志里的失败原因。"
							});
							return;
						}
						setState({
							phase: "ready",
							detail: fill(T.engineReady, { version: engineState.current || target })
						});
					})
					.catch(function () {
						// 引擎重启期间会短暂连不上，继续轮询即可
					});
				if (ticks > 240) clearInterval(timer);
			}, 1500);
		}

		function startEngineUpdate() {
			var engine = (state.info && state.info.engine) || {};
			var target = engine.latest;
			if (!target) return;
			setState({ phase: "installing", detail: T.engineUpdating });
			try {
				if (window.DSHBridge && window.DSHBridge.log) {
					window.DSHBridge.log(
						"引擎更新点击 bridge=" + Boolean(window.DSHBridge.engineUpdate) +
						" tar=" + (engine.tarUrl || "null") + " ver=" + target
					);
				}
			} catch (e) {
				/* 诊断失败不影响更新 */
			}
			// 优先让 App（Java）下载引擎包：设备网络下脚本里的 node fetch 到 GitHub 资产会超时，
			// 而 Java 的下载链路（外层 APK 更新用的同一条）一直是通的。
			if (window.DSHBridge && window.DSHBridge.engineUpdate && engine.tarUrl) {
				try {
					window.DSHBridge.engineUpdate(engine.tarUrl, target);
				} catch (err) {
					setState({ phase: "error", note: "启动引擎更新失败：" + String((err && err.message) || err) });
					return;
				}
				pollEngineProgress(target);
				return;
			}
			// 没有桥（比如在 Termux 里用浏览器打开）就退回服务端 spawn 脚本的老路
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
					pollEngineProgress(target);
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
				/* 版本摘要行 */
				".dsar-verline{display:flex;align-items:center;gap:9px;margin-top:4px;font-size:13px;",
				"color:var(--dsw-alias-label-secondary,#5b6068);font-variant-numeric:tabular-nums}",
				".dsar-sep{width:3px;height:3px;border-radius:50%;background:currentColor;opacity:.35}",
				".dsar-note{margin:8px 0 0;font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#8b929c);",
				"white-space:pre-wrap;word-break:break-word}",
				".dsar-card.is-ok .dsar-title{color:#2f9e5f}",
				".dsar-card.is-err .dsar-title{color:#e0564d}",
				/* 下载进度（面板内） */
				".dsar-dl{margin:14px 0 2px;padding:12px 14px 13px;border-radius:14px;",
				"background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));",
				"border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.14))}",
				".dsar-dl-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px}",
				".dsar-dl-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#111)}",
				".dsar-dl-pct{font:600 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums;",
				"color:var(--dsw-alias-label-secondary,#5b6068)}",
				".dsar-dl-bar{position:relative;margin-top:8px;height:6px;border-radius:999px;overflow:hidden;",
				"background:color-mix(in srgb,var(--dsw-alias-label-primary,#111) 10%,transparent)}",
				".dsar-dl-bar i{display:block;height:100%;width:0;border-radius:999px;",
				"background:linear-gradient(90deg,#5b8cff,#7aa2ff 55%,#9dbbff);transition:width 160ms linear}",
				".dsar-dl:not(.is-done):not(.is-error) .dsar-dl-bar i::after{content:'';position:absolute;inset:0;",
				"background:linear-gradient(90deg,transparent,rgba(255,255,255,.45),transparent);animation:dsar-shimmer 1.4s infinite}",
				"@keyframes dsar-shimmer{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}",
				".dsar-dl.is-done .dsar-dl-bar i{background:linear-gradient(90deg,#37b26b,#5ed08c)}",
				".dsar-dl.is-error .dsar-dl-bar i{background:linear-gradient(90deg,#e5544b,#f08278)}",
				".dsar-dl-sub{margin-top:7px;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8b929c);",
				"word-break:break-all}",
				/* 顶部「应用」按钮 */				/* 顶部「应用」按钮 */
				".dsar-app{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 8px;border:0;border-radius:6px;",
				"background:transparent;color:var(--dsw-alias-label-secondary,#5b6068);font-size:14px;line-height:1;cursor:pointer;",
				"transition:background 120ms ease,color 120ms ease}",
				".dsar-app:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,#111)}",
				".dsar-app[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-active,rgba(127,127,127,.2));color:var(--dsw-alias-label-primary,#111)}",
				".dsar-app-compact{padding:0 6px;font-size:13px;height:26px}",
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
				/* 升级进度 */
				".dsar-progress{margin-top:16px;padding:14px;border-radius:16px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.06))}",
				".dsar-progress-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px}",
				".dsar-progress-label{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,#111)}",
				".dsar-progress-elapsed{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a8f98);font-variant-numeric:tabular-nums}",
				".dsar-bar{position:relative;height:6px;border-radius:99px;background:var(--dsw-alias-border-l2,rgba(127,127,127,.22));overflow:hidden;margin:10px 0 2px}",
				".dsar-bar-fill{position:absolute;left:0;top:0;bottom:0;border-radius:99px;background:var(--dsw-alias-brand-primary,#111);transition:width .4s ease}",
				".dsar-steps{list-style:none;margin:12px 0 0;padding:0;display:grid;gap:6px}",
				".dsar-step{display:flex;align-items:center;gap:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a8f98)}",
				".dsar-step-mark{display:inline-flex;width:14px;justify-content:center;font-size:11px}",
				".dsar-step.is-done{color:var(--dsw-alias-label-secondary,#5b6068)}",
				".dsar-step.is-now{color:var(--dsw-alias-label-primary,#111);font-weight:500}",
				".dsar-step.is-now .dsar-step-mark{animation:dsar-pulse 1.2s ease-in-out infinite}",
				".dsar-step.is-cancel{color:var(--dsw-alias-danger,#d9534f)}",
				"@keyframes dsar-pulse{0%,100%{opacity:1}50%{opacity:.25}}",
				".dsar-note-warn{margin:10px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-danger,#d9534f)}",
				".dsar-logbox{margin-top:12px}",
				".dsar-log{margin:6px 0 0;padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.08));font-family:ui-monospace,Menlo,monospace;font-size:11px;line-height:16px;white-space:pre-wrap;word-break:break-all;max-height:120px;overflow:auto}",
				".dsar-input{display:block;width:100%;box-sizing:border-box;margin-top:8px;padding:9px 12px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));background:var(--dsw-alias-bg-layer-1,transparent);color:inherit;font-size:13px;line-height:18px}",
				".dsar-input:focus{outline:2px solid var(--dsw-alias-link,#4c8dff);outline-offset:1px}",
				".dsar-row{display:flex;gap:8px;margin-top:8px}",
				".dsar-btn-small{padding:6px 12px;font-size:13px;min-height:0}",
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
		 * 「应用 ▾」按钮 —— 三处共用同一个组件：
		 *   · conversation.header.leading（内容区顶栏左侧，手机上唯一像标题栏的位置）
		 *   · sidebar.brand.name（宽侧栏时的品牌名旁，桌面/平板）
		 *   · sidebar.footer.action（窄轨底部兜底，永远在）
		 * ------------------------------------------------------------------ */
		function AppChip(props) {
			var store = useStore();
			var open = Boolean(store.menu);
			var compact = Boolean(props && props.compact);

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
					className: compact ? "dsar-app dsar-app-compact" : "dsar-app",
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
				h("span", { className: "dsar-caret", "aria-hidden": "true" }),
				anyUpdate(store.info) ? h("span", { className: "dsar-dot" }) : null
			);
		}

		function BrandEntry() {
			return h(AppChip);
		}

		/** 内容区顶栏左侧：手机上侧栏永远是 56px 窄轨，brand.name 不渲染，这里是唯一能当标题栏的座位。 */
		function HeaderEntry() {
			return h(AppChip);
		}

		/** 窄轨底部兜底：面板切换（文件/终端/浏览器）时顶栏可能不在，这里永远在。 */
		function FootEntry() {
			return h(AppChip, { compact: true });
		}

		/* ------------------------------------------------------------------ *
		 * 浮层：菜单 + 对话框
		 * ------------------------------------------------------------------ */
		/** 菜单里那条更新项的文案：别在"已经最新"时还写"检查更新" */
		function menuUpdateLabel(info) {
			var app = (info && info.app) || {};
			var engine = (info && info.engine) || {};
			if (engine.updating) return "正在更新引擎…";
			if (app.updateAvailable || engine.updateAvailable) return "有新版本可用";
			if (app.checked || engine.checked) return "已是最新版本";
			return "检查更新…";
		}

		function MenuLayer(props) {
			var store = useStore();
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
					menuUpdateLabel(store)
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

		/* ── 下载进度（画在更新面板里，不浮在屏幕底部）────────────────────
		   Java 侧每 ~120ms 通过 window.__dshDl(name, done, total, phase) 推一次。
		   phase: start / downloading / downloaded / done / error
		   这里只更新 store，面板里的 DownloadBlock 负责画进度条。 */
		window.__dshDl = function (name, done, total, phase) {
			setState({
				dl: {
					name: name || "",
					done: Number(done) || 0,
					total: Number(total) || 0,
					phase: phase || "downloading"
				}
			});
		};

		function humanMB(bytes) {
			var n = Number(bytes) || 0;
			if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB";
			if (n >= 1024) return Math.round(n / 1024) + " KB";
			return n + " B";
		}

		/* 下载进度块：标题 + 百分比 + 细进度条 + 已下载/总量 */
		function DownloadBlock(props) {
			var dl = props.dl || {};
			var pct = dl.total > 0 ? Math.min(100, (dl.done / dl.total) * 100) : 0;
			var done = dl.phase === "done" || dl.phase === "downloaded";
			var failed = dl.phase === "error";
			var title = failed ? "下载失败" : done ? "已下载，正在交给安装器" : "正在下载更新包";
			var sub = dl.total > 0
				? humanMB(dl.done) + " / " + humanMB(dl.total)
				: humanMB(dl.done);
			return h(
				"div",
				{ className: "dsar-dl" + (done ? " is-done" : "") + (failed ? " is-error" : "") },
				h(
					"div",
					{ className: "dsar-dl-head" },
					h("span", { className: "dsar-dl-title" }, title),
					h("span", { className: "dsar-dl-pct" }, Math.round(pct) + "%")
				),
				h("div", { className: "dsar-dl-bar" }, h("i", { style: { width: pct + "%" } })),
				h("div", { className: "dsar-dl-sub" }, sub + (dl.name ? "  ·  " + dl.name : ""))
			);
		}

		/* 下载镜像：折叠在一块里，不占面板主视觉 */
		function MirrorRow(props) {
			var ref = React.useRef(null);
			var busy = React.useState(false);
			return h(
				"details",
				{ className: "dsar-details" },
				h("summary", null, "下载镜像（可选）"),
				h(
					"div",
					{ className: "dsar-row" },
					h("input", {
						ref: ref,
						className: "dsar-input",
						placeholder: "http://…/dsh-harness-arm64.apk",
						defaultValue: props.current || ""
					}),
					h(
						"button",
						{
							className: "dsar-btn dsar-btn-secondary dsar-btn-small",
							type: "button",
							disabled: busy[0],
							onClick: function () {
								busy[1](true);
								saveMirror(ref.current ? ref.current.value : "");
								setTimeout(function () {
									busy[1](false);
								}, 1200);
							}
						},
						T.mirrorSave
					),
					h(
						"button",
						{
							className: "dsar-btn dsar-btn-dim dsar-btn-small",
							type: "button",
							onClick: function () {
								if (ref.current) ref.current.value = "";
								saveMirror("");
							}
						},
						T.mirrorClear
					)
				),
				h("p", { className: "dsar-note" }, props.current ? "当前镜像：" + props.current : "GitHub 直连下不动时，把 APK 直链填这里。")
			);
		}

		/* 升级进度：步骤清单 + 进度条 + 耗时 + 日志尾巴 */
		var STEPS = [
			["prepare", "检查环境"],
			["download", "下载引擎包"],
			["verify", "校验 sha256"],
			["extract", "解包"],
			["smoke", "冒烟测试新引擎"],
			["swap", "切换目录（旧版保留）"],
			["restart", "重启引擎"],
			["done", "完成"]
		];

		function stepIndex(stage) {
			for (var i = 0; i < STEPS.length; i += 1) {
				if (STEPS[i][0] === stage) return i;
			}
			return stage === "error" ? -2 : -1;
		}

		function ProgressBlock(props) {
			var progress = props.progress || {};
			var logTail = props.logTail || [];
			var tick = React.useState(0);
			React.useEffect(function () {
				var timer = setInterval(function () {
					tick[1](function (n) {
						return n + 1;
					});
				}, 1000);
				return function () {
					clearInterval(timer);
				};
			}, []);
			var idx = stepIndex(progress.stage);
			var pct = typeof progress.pct === "number" ? progress.pct : 0;
			var elapsed = progress.elapsedMs ? Math.max(0, Math.round(progress.elapsedMs / 1000) + tick[0]) : null;
			var human = elapsed === null
				? ""
				: Math.floor(elapsed / 60) + ":" + String(elapsed % 60).padStart(2, "0");
			var stale = Boolean(progress.stale) && !progress.done && idx !== -2;
			return h(
				"div",
				{ className: "dsar-progress", key: "progress" },
				h(
					"div",
					{ className: "dsar-progress-head" },
					h("span", { className: "dsar-progress-label" }, progress.label || T.engineProgressStarting),
					human ? h("span", { className: "dsar-progress-elapsed" }, T.engineProgressElapsed + " " + human) : null
				),
				h("div", { className: "dsar-bar" }, h("div", { className: "dsar-bar-fill", style: { width: pct + "%" } })),
				h(
					"ul",
					{ className: "dsar-steps" },
					STEPS.map(function (step, i) {
						var cls = "dsar-step";
						var mark = "○";
						if (idx === -2) {
							cls += i === 0 ? " is-cancel" : "";
						} else if (i < idx || progress.done) {
							cls += " is-done";
							mark = "✓";
						} else if (i === idx) {
							cls += " is-now";
							mark = "●";
						}
						return h(
							"li",
							{ className: cls, key: step[0] },
							h("span", { className: "dsar-step-mark" }, mark),
							h("span", null, step[1])
						);
					})
				),
				stale
					? h(
							"p",
							{ className: "dsar-note-warn" },
							T.engineProgressStale.replace("N", String(progress.idleSec == null ? "?" : progress.idleSec))
					  )
					: null,
				progress.error
					? h("p", { className: "dsar-note-warn" }, "失败：" + progress.error)
					: null,
				logTail.length
					? h(
							"div",
							{ className: "dsar-logbox" },
							h("p", { className: "dsar-block-note" }, T.engineProgressLog),
							h("pre", { className: "dsar-log" }, logTail.join("\n"))
					  )
					: null
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
			var blocks = [];
			var actions = [];

			function btn(label, kind, onClick, key) {
				return h(
					"button",
					{
						key: key || label,
						className: "dsar-btn dsar-btn-" + kind,
						type: "button",
						onClick: onClick
					},
					label
				);
			}

			function recheck() {
				setState({ phase: "checking", note: null, dl: null });
				load(true);
			}

			// 一行版本摘要：外壳 · 引擎（不再单独占两块 + 一堆说明）
			var versions = h(
				"div",
				{ className: "dsar-verline", key: "verline" },
				h("span", null, "外壳 v" + (app.current || "?")),
				h("i", { className: "dsar-sep" }),
				h("span", null, "引擎 " + (engine.current || "?"))
			);

			var title = "版本与更新";
			var tone = "";
			if (phase === "checking") title = "正在检查更新…";
			else if (phase === "latest") { title = "已是最新版本"; tone = "is-ok"; }
			else if (phase === "available") title = app.updateAvailable ? "发现新版本" : "发现引擎更新";
			else if (phase === "downloading") title = "正在下载更新包";
			else if (phase === "installing") title = "正在更新引擎";
			else if (phase === "ready") { title = "更新完成"; tone = "is-ok"; }
			else if (phase === "error") { title = "更新失败"; tone = "is-err"; }

			/* ── 主体：每种状态只放该有的东西 ─────────────────────────── */
			if (phase === "latest") {
				blocks.push(versions);
				var checkedAt = new Date();
				blocks.push(
					h(
						"p",
						{ className: "dsar-note", key: "when" },
						"刚刚检查于 " + String(checkedAt.getHours()).padStart(2, "0") + ":" + String(checkedAt.getMinutes()).padStart(2, "0")
					)
				);
				actions.push(btn("重新检查", "secondary", recheck, "re"));
				actions.push(btn(T.close, "dim", closeView, "close"));
			} else if (phase === "available") {
				if (app.updateAvailable) {
					blocks.push(
						h(
							"div",
							{ className: "dsar-block", key: "shell" },
							h("p", { className: "dsar-block-title" }, "外壳"),
							h(VersionRow, { label: "", from: "v" + (app.current || "?"), to: "v" + app.latest })
						)
					);
					actions.push(
						btn(
							"下载并安装" + (app.apkSize ? "（" + mb(app.apkSize) + "）" : ""),
							"primary",
							startAppDownload,
							"app"
						)
					);
				}
				if (engine.updateAvailable) {
					blocks.push(
						h(
							"div",
							{ className: "dsar-block", key: "engine" },
							h("p", { className: "dsar-block-title" }, "引擎"),
							h(VersionRow, { label: "", from: engine.current || "?", to: engine.latest })
						)
					);
					actions.push(
						btn(
							"更新引擎" + (engine.latest ? "（" + engine.latest + "）" : ""),
							"dim",
							startEngineUpdate,
							"engine"
						)
					);
				}
				actions.push(btn("稍后", "dim", closeView, "later"));
			} else if (phase === "downloading" || (store.dl && store.dl.phase !== "error")) {
				if (store.dl) blocks.push(h(DownloadBlock, { key: "dl", dl: store.dl }));
				blocks.push(h("p", { className: "dsar-note", key: "hint" }, "下载完成后会自动打开系统安装器。"));
				actions.push(btn("后台继续", "dim", closeView, "bg"));
			} else if (phase === "installing") {
				var engineInfo = (store.info && store.info.engine) || {};
				blocks.push(
					h(ProgressBlock, {
						key: "progress",
						progress: engineInfo.progress || null,
						logTail: engineInfo.logTail || []
					})
				);
				actions.push(btn("后台继续", "dim", closeView, "bg"));
			} else if (phase === "checking") {
				blocks.push(
					h(
						"p",
						{ className: "dsar-note", key: "checking" },
						"正在向 GitHub 与 npm 查询最新版本…"
					)
				);
				actions.push(btn("关闭", "dim", closeView, "close"));
			} else if (phase === "ready") {
				blocks.push(versions);
				actions.push(btn(T.confirm, "primary", closeView, "ok"));
			} else if (phase === "error") {
				blocks.push(
					h("p", { className: "dsar-note", key: "err" }, store.note || T.updateCheckFailed)
				);
				actions.push(btn("重试", "primary", recheck, "retry"));
				actions.push(btn(T.close, "dim", closeView, "close"));
			} else {
				blocks.push(versions);
				actions.push(btn("检查更新", "primary", recheck, "check"));
				actions.push(btn(T.close, "dim", closeView, "close"));
			}

			// 技术详情只在出错时给，平时不占地方
			var details = null;
			if (phase === "error") {
				var techLines = [];
				if (app.current || app.latest) techLines.push("外壳 " + (app.current || "?") + (app.latest ? " → v" + app.latest : ""));
				if (engine.current || engine.latest) techLines.push("引擎 " + (engine.current || "?") + (engine.latest ? " → " + engine.latest : ""));
				if (app.payload) techLines.push("载荷 " + app.payload);
				if (app.error) techLines.push("外壳检查错误 " + app.error);
				if (engine.error) techLines.push("引擎检查错误 " + engine.error);
				if (techLines.length) {
					details = h(
						"details",
						{ className: "dsar-details" },
						h("summary", null, T.updateTechnicalDetails),
						h("pre", { className: "dsar-pre" }, techLines.join("\n"))
					);
				}
			}

			var mirror = null;
			if (phase === "available" && app.updateAvailable) {
				mirror = h(MirrorRow, { key: "mirror", current: app.mirror || "" });
			}

			return h(
				"div",
				{ className: "dsar-mask", onClick: closeView },
				h(
					"div",
					{ className: "dsar-card " + tone, role: "dialog", "aria-modal": "true", onClick: function (e) { e.stopPropagation(); } },
					h(CloseButton),
					h("h2", { className: "dsar-title" }, title),
					blocks,
					details,
					mirror,
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
		/** 单个槽注册失败（重复注册、槽不存在）不该把整个页面带崩。 */
		function guard(label, fn) {
			try {
				fn();
			} catch (err) {
				try {
					window.DSHBridge && window.DSHBridge.log("app-release 注册 " + label + " 失败：" + String((err && err.message) || err));
				} catch (ignored) {
					/* 没有桥就只吞掉 */
				}
			}
		}

		function apply(ctx) {
			ensureStyles();
			if (!state.info && !state.loading) load(false);
			// 只在会话顶栏（conversation.header.leading）放一个入口。
			// 侧栏底部那个「应用」是多余的第二份 —— 手机是 56px 窄轨，底部那一栏已经有账号和设置，
			// 再加一个同名按钮，用户看到的就是"重复出现在左下角"；而且两个注册点还会撞
			// single slot 的重复注册检查（brand.name 只能有一个注册者）。
			guard("header", function () {
				ctx.slots.inject(SLOT_HEADER, function () {
					return ctx.slots.register({ name: SLOT_HEADER, id: "app-release-header", order: 10 }, HeaderEntry);
				});
			});
			guard("overlay", function () {
				ctx.slots.inject(SLOT_OVERLAY, function () {
					return ctx.slots.register({ name: SLOT_OVERLAY, id: "app-release-dialog" }, OverlayEntry);
				});
			});
		}

		var inject = ["slots"];
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
