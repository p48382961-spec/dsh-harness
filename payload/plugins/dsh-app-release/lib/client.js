/**
 * dsh-app-release 的浏览器端：侧栏底部一行「外壳 vX.Y.Z」，点开是一个极简面板 ——
 * 当前版本、检查更新、有新版本时给一个「下载并安装」。
 *
 * 形态跟 dsh-maintenance 的客户端一致（手写 bundle，不用 JSX / 构建工具）：
 *   window.__ModuleLoader__.load({ id, factory }) → factory(require) 返回 module.exports
 *
 * 下载走的是普通 <a> 点击：Android WebView 对 APK 的导航会触发 App 侧的
 * DownloadListener，App 下载完会自动拉起安装器（见 MainActivity.installApk）。
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
				".dshar-mask{position:fixed;inset:0;z-index:1200;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5)}",
				".dshar-card{width:min(92vw,420px);max-height:84vh;overflow:auto;border-radius:14px;padding:16px;",
				"background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111);",
				"border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.25))}",
				".dshar-title{font-size:15px;font-weight:600;margin-bottom:8px}",
				".dshar-row{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#555);margin:3px 0}",
				".dshar-note{font-size:12px;line-height:18px;margin-top:8px;color:var(--dsw-alias-label-tertiary,#888);white-space:pre-wrap}",
				".dshar-actions{display:flex;gap:8px;margin-top:14px;flex-wrap:wrap}",
				".dshar-primary,.dshar-ghost{border-radius:9px;padding:8px 14px;font-size:13px;cursor:pointer;border:1px solid transparent}",
				".dshar-primary{background:var(--dsw-alias-bg-accent,#2f6feb);color:#fff;text-decoration:none;display:inline-block}",
				".dshar-ghost{background:transparent;color:inherit;border-color:var(--dsw-alias-border-l2,rgba(127,127,127,.35))}",
				".dshar-primary[disabled]{opacity:.5;pointer-events:none}"
			].join("");
			document.head.appendChild(el);
		}

		function currentVersionLabel(info) {
			if (!info || !info.current) return "外壳 --";
			return "外壳 " + info.current;
		}

		function Panel(props) {
			var state = props.state;
			var close = props.onClose;
			var recheck = props.onRecheck;
			var rows = [];
			if (state.info) {
				rows.push(h("div", { className: "dshar-row", key: "cur" }, currentVersionLabel(state.info) + (state.info.payload ? " · 载荷 " + state.info.payload : "")));
			}
			if (state.info && state.info.checked && !state.info.error) {
				rows.push(h("div", { className: "dshar-row", key: "latest" },
					state.info.updateAvailable
						? "远端最新 v" + state.info.latest + (state.info.prerelease ? "（预发布）" : "")
						: "已是最新（远端 v" + state.info.latest + "）"));
			}
			if (state.info && state.info.error) {
				rows.push(h("div", { className: "dshar-row", key: "err" }, "检查失败：" + state.info.error));
			}
			var sizeMb = state.info && state.info.apkSize ? (state.info.apkSize / 1048576).toFixed(1) + " MB" : null;
			var primary = null;
			if (state.info && state.info.updateAvailable && state.info.apkUrl) {
				primary = h("a", {
					className: "dshar-primary",
					href: state.info.apkUrl,
					onClick: () => { close(); }
				}, "下载并安装" + (sizeMb ? "（" + sizeMb + "）" : ""));
			}
			return h("div", { className: "dshar-mask", onClick: close },
				h("div", { className: "dshar-card", onClick: (e) => e.stopPropagation() },
					h("div", { className: "dshar-title" }, "DeepSeek Harness 更新"),
					rows,
					h("div", { className: "dshar-actions" },
						h("button", { className: "dshar-ghost", onClick: recheck, disabled: state.loading }, state.loading ? "检查中…" : "检查更新"),
						primary,
						h("button", { className: "dshar-ghost", onClick: close }, "关闭"))));
		}

		function Entry() {
			var pair = React.useState({ info: null, loading: false });
			var state = pair[0];
			var setState = pair[1];
			var openPair = React.useState(false);
			var open = openPair[0];
			var setOpen = openPair[1];

			var load = React.useCallback(function (network) {
				setState(function (prev) { return { info: prev.info, loading: true }; });
				fetch(API + "?action=" + (network ? "check" : "status"), { credentials: "same-origin" })
					.then(function (r) { return r.json(); })
					.then(function (info) { setState({ info: info, loading: false }); })
					.catch(function (err) { setState({ info: { error: String(err && err.message || err) }, loading: false }); });
			}, []);

			React.useEffect(function () { load(false); }, []);

			return h(React.Fragment, null,
				h("button", {
					className: "dshar-btn",
					title: "查看 App 版本、检查更新",
					onClick: function () { setOpen(true); load(true); }
				}, currentVersionLabel(state.info)),
				open ? h(Panel, {
					state: state,
					onClose: function () { setOpen(false); },
					onRecheck: function () { load(true); }
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
