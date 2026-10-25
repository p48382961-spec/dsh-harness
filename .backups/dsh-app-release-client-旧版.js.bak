/**
 * dsh-app-release 的浏览器端：侧栏底部一行「外壳 vX.Y.Z」，点开是一个极简面板 ——
 * 两个版本各一块：
 *   ① 外壳（这个 APK）：有新版本时给「下载并安装」（普通 <a>，走下载监听 + 系统安装器）
 *   ② 引擎（DSH 本体）：有新版本时给「更新并重启」（POST 到插件 API，脚本 npm 装完自己重启）
 *
 * 形态跟 dsh-maintenance 的客户端一致（手写 bundle，不用 JSX / 构建工具）：
 *   window.__ModuleLoader__.load({ id, factory }) → factory(require) 返回 module.exports
 */
window.__ModuleLoader__.load({
	id: "dsh-app-release",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var SLOT = "sidebar.footer.action";
		var API = "/api/dsh-app-release";
		var STYLE_ID = "dsh-app-release-style";

		var reactNamespace = require("react");
		var React = (reactNamespace && reactNamespace.default) || reactNamespace;
		var h = React.createElement;

		function ensureStyles() {
			if (document.getElementById(STYLE_ID)) return;
			var el = document.createElement("style");
			el.id = STYLE_ID;
			el.textContent = [
				".dshar-btn{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));",
				"background:transparent;color:var(--dsw-alias-label-secondary,#666);border-radius:999px;padding:3px 10px;",
				"font-size:11px;line-height:18px;cursor:pointer;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
				".dshar-btn:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12))}",
				".dshar-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-fg-accent,#2f6feb)}",
				".dshar-mask{position:fixed;inset:0;z-index:1200;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5)}",
				".dshar-card{width:min(92vw,440px);max-height:84vh;overflow:auto;border-radius:14px;padding:16px;",
				"background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111);",
				"border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25))}",
				".dshar-title{font-size:15px;font-weight:600;margin-bottom:10px}",
				".dshar-section{border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.18));padding-top:10px;margin-top:10px}",
				".dshar-sect-title{font-size:13px;font-weight:600;margin-bottom:4px}",
				".dshar-row{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#555);margin:3px 0;word-break:break-all}",
				".dshar-note{font-size:12px;line-height:18px;margin-top:8px;color:var(--dsw-alias-label-tertiary,#888);white-space:pre-wrap}",
				".dshar-actions{display:flex;gap:8px;margin-top:14px;flex-wrap:wrap}",
				".dshar-primary,.dshar-ghost{border-radius:9px;padding:8px 14px;font-size:13px;cursor:pointer;border:1px solid transparent}",
				".dshar-primary{background:var(--dsw-alias-bg-accent,#2f6feb);color:#fff;text-decoration:none;display:inline-block}",
				".dshar-ghost{background:transparent;color:inherit;border-color:var(--dsw-alias-border-l2,rgba(127,127,127,.35))}",
				".dshar-primary[disabled],.dshar-ghost[disabled]{opacity:.5;pointer-events:none}"
			].join("");
			document.head.appendChild(el);
		}

		function hasUpdate(info) {
			if (!info) return false;
			return Boolean(
				(info.app && info.app.updateAvailable) ||
				(info.engine && info.engine.updateAvailable) ||
				(info.engine && info.engine.updating)
			);
		}

		function shellLabel(info) {
			var app = info && info.app;
			if (!app || !app.current) return "外壳 --";
			return "外壳 " + app.current;
		}

		function Section(props) {
			return h("div", { className: "dshar-section" },
				h("div", { className: "dshar-sect-title" }, props.title),
				props.children);
		}

		function Panel(props) {
			var state = props.state;
			var close = props.onClose;
			var recheck = props.onRecheck;
			var updateEngine = props.onUpdateEngine;
			var info = state.info || {};
			var app = info.app || {};
			var engine = info.engine || {};

			var appRows = [];
			appRows.push(h("div", { className: "dshar-row", key: "a" },
				"当前 " + (app.current || "未知") + (app.payload ? " · 载荷 " + app.payload : "")));
			if (app.error) appRows.push(h("div", { className: "dshar-row", key: "ae" }, "检查失败：" + app.error));
			else if (app.checked) {
				appRows.push(h("div", { className: "dshar-row", key: "al" },
					app.updateAvailable
						? "远端最新 v" + app.latest + (app.prerelease ? "（预发布）" : "")
						: "已是最新（远端 v" + app.latest + "）"));
			}

			var engineRows = [];
			engineRows.push(h("div", { className: "dshar-row", key: "e" }, "当前 " + (engine.current || "未知")));
			if (engine.error) engineRows.push(h("div", { className: "dshar-row", key: "ee" }, "检查失败：" + engine.error));
			else if (engine.updating) engineRows.push(h("div", { className: "dshar-row", key: "eu" }, "正在更新，完成后引擎会自动重启…"));
			else if (engine.checked) {
				engineRows.push(h("div", { className: "dshar-row", key: "el" },
					engine.updateAvailable
						? "npm 上已有 " + engine.latest
						: "已是最新（npm latest " + engine.latest + "）"));
			}

			var sizeMb = app.apkSize ? (app.apkSize / 1048576).toFixed(1) + " MB" : null;
			var actions = [];
			actions.push(h("button", { className: "dshar-ghost", key: "c", onClick: recheck, disabled: state.loading },
				state.loading ? "检查中…" : "检查更新"));
			if (app.updateAvailable && app.apkUrl) {
				actions.push(h("a", { className: "dshar-primary", key: "d", href: app.apkUrl, onClick: function () { close(); } },
					"下载并安装" + (sizeMb ? "（" + sizeMb + "）" : "")));
			}
			if (engine.updateAvailable && engine.latest) {
				actions.push(h("button", {
					className: "dshar-primary",
					key: "e",
					disabled: state.updatingEngine || engine.updating,
					onClick: function () { updateEngine(engine.latest); }
				}, state.updatingEngine ? "正在更新…" : "更新引擎并重启"));
			}
			actions.push(h("button", { className: "dshar-ghost", key: "f", onClick: close }, "关闭"));

			return h("div", { className: "dshar-mask", onClick: close },
				h("div", { className: "dshar-card", onClick: function (e) { e.stopPropagation(); } },
					h("div", { className: "dshar-title" }, "DeepSeek Harness 更新"),
					h(Section, { title: "外壳（这个 App）" }, appRows),
					h(Section, { title: "引擎（DSH 本体）" }, engineRows),
					state.note ? h("div", { className: "dshar-note" }, state.note) : null,
					h("div", { className: "dshar-actions" }, actions)));
		}

		function Entry() {
			var pair = React.useState({ info: null, loading: false, updatingEngine: false, note: null });
			var state = pair[0];
			var setState = pair[1];
			var openPair = React.useState(false);
			var open = openPair[0];
			var setOpen = openPair[1];

			var load = React.useCallback(function (network) {
				setState(function (prev) { return Object.assign({}, prev, { loading: true }); });
				fetch(API + "?action=" + (network ? "check" : "status"), { credentials: "same-origin" })
					.then(function (r) { return r.json(); })
					.then(function (info) { setState(function (prev) { return Object.assign({}, prev, { info: info, loading: false }); }); })
					.catch(function (err) {
						setState(function (prev) {
							return Object.assign({}, prev, { loading: false, note: "检查失败：" + String((err && err.message) || err) });
						});
					});
			}, []);

			var updateEngine = React.useCallback(function (version) {
				setState(function (prev) { return Object.assign({}, prev, { updatingEngine: true, note: "已开始更新引擎到 " + version + "，安装约 1–3 分钟，完成后页面会自动刷新" }); });
				fetch(API + "?action=update-engine&version=" + encodeURIComponent(version), { method: "POST", credentials: "same-origin" })
					.then(function (r) { return r.json(); })
					.then(function (res) {
						if (!res || !res.ok) {
							setState(function (prev) { return Object.assign({}, prev, { updatingEngine: false, note: "启动更新失败：" + ((res && res.error) || "未知错误") }); });
							return;
						}
						var ticks = 0;
						var timer = setInterval(function () {
							ticks += 1;
							fetch(API + "?action=status", { credentials: "same-origin" })
								.then(function (r) { return r.json(); })
								.then(function (info) {
									setState(function (prev) { return Object.assign({}, prev, { info: info }); });
									if (info && info.engine && !info.engine.updating) {
										clearInterval(timer);
										setState(function (prev) { return Object.assign({}, prev, { updatingEngine: false, note: "引擎已更新到 " + (info.engine.current || "新版本") }); });
									}
								})
								.catch(function () { clearInterval(timer); });
							if (ticks > 120) clearInterval(timer);
						}, 3000);
					})
					.catch(function (err) {
						setState(function (prev) { return Object.assign({}, prev, { updatingEngine: false, note: "启动更新失败：" + String((err && err.message) || err) }); });
					});
			}, []);

			React.useEffect(function () { load(false); }, []);

			return h(React.Fragment, null,
				h("button", {
					className: "dshar-btn",
					title: "版本与更新（外壳 + 引擎）",
					onClick: function () {
						setOpen(true);
						setState(function (prev) { return Object.assign({}, prev, { note: null }); });
						load(true);
					}
				}, shellLabel(state.info), hasUpdate(state.info) ? h("span", { className: "dshar-dot" }) : null),
				open ? h(Panel, {
					state: state,
					onClose: function () { setOpen(false); },
					onRecheck: function () { load(true); },
					onUpdateEngine: updateEngine
				}) : null);
		}

		function apply(ctx) {
			ensureStyles();
			ctx.slots.inject(SLOT, function () {
				return ctx.slots.register({ name: SLOT, id: "app-release", order: 102 }, Entry);
			});
		}

		var inject = ["slots"];
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
