/**
 * dsh-maintenance 的浏览器端。
 *
 * 两个入口：
 *   ① 侧栏底部一行按钮 —— 常驻显示当前版本 + 一个状态点（这就是「查看当前版本」）。
 *   ② 点开一个面板 —— 运行环境、补丁/守护健康、检查更新、**以及查到新版本之后的动作**
 *      （一键升级 → 看进度 → 重启生效），最后加一条「修复插件」的兜底。
 *
 * 这是一个**手写的客户端 bundle**，不是构建产物 —— DSH Web 的客户端插件是浏览器
 * 运行时按需加载的同源经典脚本（`<script src="/plugins/...">`），所以不需要
 * pnpm / vite / tsdown。代价是不能用 JSX，只能用 `React.createElement`。
 *
 * 形态契约（与 dsh-plugin-restart、@michengai/dsh-codex-ui 一致）：
 *   - 入口固定 `window.__ModuleLoader__.load({ id, factory })`，`id` 必须是包名；
 *   - `factory(require)` 返回 `module.exports`；
 *   - 导出具名 `apply` / `inject`，**没有 default**；
 *   - 这里的 `inject` 是 cordis 服务名（`slots`），与 package.json 里
 *     `dsh.client.inject` 的包名数组是两回事。
 *
 * ── 为什么按钮和面板由同一个组件持有 ──────────────────────────────────────
 * 插槽只能挂一个节点。按钮是触发器、面板是内容，二者共享同一份状态机；拆成两个
 * 插槽反而要再造一层全局状态。所以这里返回一个 Fragment。
 *
 * ── 一条刻意的设计 ──────────────────────────────────────────────────────
 * 面板一打开只读**本地**状态（版本、补丁、守护健康），不碰网络；只有点了「检查更新」
 * 才打一次 registry。手机上没有 hover，也没人喜欢界面一打开就转圈等外网。
 *
 * UI 组件尽量用 DSH 自己的 primitives（Modal / Button / Tag / StateDot），
 * 但每一个都带降级：任一组件缺失时退回自绘元素，面板不会整块塌掉。
 */

window.__ModuleLoader__.load({
	id: "dsh-maintenance",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/** 侧栏底部动作区：kind=list / scope=root，只需一个 id。 */
		var SLOT = "sidebar.footer.action";
		/** 服务端插件注册的同一路由；action 由 query 决定。 */
		var API = "/api/dsh-maintenance";
		var CLASS = "dshm-btn";
		var STYLE_ID = "dsh-plugin-maintenance-style";

		/** 升级进行中时的轮询间隔。 */
		var POLL_MS = 2500;

		var reactNamespace = require("react");
		var React = (reactNamespace && reactNamespace.default) || reactNamespace;
		var h = React.createElement;

		var primitives = require("@deepseek-ai/dsh-client-ui-primitives") || {};
		var Button = primitives.Button || "button";
		var Modal = primitives.Modal || null;
		var Tag = primitives.Tag || null;
		var StateDot = primitives.StateDot || null;

		// ─────────────────────────── 小工具 ───────────────────────────

		/** 16×16、1px 描边、颜色继承，和 primitives 的图标同构。 */
		function glyph(children) {
			return h("svg", {
				width: 16, height: 16, viewBox: "0 0 16 16", fill: "none",
				xmlns: "http://www.w3.org/2000/svg", strokeWidth: 1, "aria-hidden": "true"
			}, children);
		}

		/** 环形箭头 —— 检查更新。 */
		function RefreshGlyph() {
			return glyph([
				h("path", { key: "arc", d: "M14.5001 8C14.5 9.28552 14.1188 10.5422 13.4045 11.611C12.6903 12.6799 11.6752 13.5129 10.4875 14.0049C9.29982 14.4968 7.99295 14.6255 6.73212 14.3747C5.4713 14.124 4.31314 13.505 3.4041 12.596C2.49514 11.687 1.87614 10.5288 1.62537 9.26798C1.37459 8.00716 1.50331 6.70028 1.99525 5.51261C2.48719 4.32494 3.32025 3.30981 4.3891 2.59557C5.45795 1.88134 6.71458 1.50008 8.0001 1.5C9.9001 1.5 11.7001 2.3 13.0001 3.6L14.5001 5.1", stroke: "currentColor" }),
				h("path", { key: "head", d: "M14.4999 1.5V5.1H10.8999", stroke: "currentColor" })
			]);
		}

		/** 对勾 —— 已是最新 / 升级完成。 */
		function CheckGlyph() {
			return glyph(h("path", { key: "tick", d: "M13.5 4L6 11.5L2.5 8", stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round" }));
		}

		/** 感叹号 —— 有新版本 / 出错。 */
		function WarningGlyph() {
			return glyph([
				h("path", { key: "ring", d: "M8 14.5C11.5899 14.5 14.5 11.5899 14.5 8C14.5 4.41015 11.5899 1.5 8 1.5C4.41015 1.5 1.5 4.41015 1.5 8C1.5 11.5899 4.41015 14.5 8 14.5Z", stroke: "currentColor" }),
				h("path", { key: "stem", d: "M8 4.29199V9.79199", stroke: "currentColor" }),
				h("path", { key: "dot", d: "M8 12.3V12.2", stroke: "currentColor", strokeLinecap: "round" })
			]);
		}

		/** 向上箭头入托盘 —— 升级。 */
		function UpgradeGlyph() {
			return glyph([
				h("path", { key: "shaft", d: "M8 10.5V1.8", stroke: "currentColor", strokeLinecap: "round" }),
				h("path", { key: "top", d: "M4.6 5.2L8 1.8L11.4 5.2", stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round" }),
				h("path", { key: "tray", d: "M2.2 10.1V12.5C2.2 13.4 2.9 14.1 3.8 14.1H12.2C13.1 14.1 13.8 13.4 13.8 12.5V10.1", stroke: "currentColor", strokeLinecap: "round" })
			]);
		}

		/** 电源 —— 重启。 */
		function PowerGlyph() {
			return glyph([
				h("path", { key: "ring", d: "M8 14.2C11.4243 14.2 14.2 11.4243 14.2 8C14.2 4.57566 11.4243 1.8 8 1.8", stroke: "currentColor", strokeLinecap: "round" }),
				h("path", { key: "stem", d: "M8 1.5V7.5", stroke: "currentColor", strokeLinecap: "round" })
			]);
		}

		/** 扳手 —— 修复插件。 */
		function WrenchGlyph() {
			return glyph([
				h("path", { key: "body", d: "M9.4 5.1L13 1.5M6.9 7.6L2.6 11.9C1.9 12.6 1.9 13.7 2.6 14.4C3.3 15.1 4.4 15.1 5.1 14.4L9.4 10.1M9.4 5.1C10.6 3.9 12.5 3.9 13.7 5.1L11.5 7.3L12.9 8.7L15.1 6.5", stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round" })
			]);
		}

		/** 毫秒 → 粗颗粒中文时长。 */
		function formatDuration(ms) {
			if (!(ms > 0)) return "—";
			var total = Math.floor(ms / 1000);
			var days = Math.floor(total / 86400);
			var hours = Math.floor((total % 86400) / 3600);
			var minutes = Math.floor((total % 3600) / 60);
			var seconds = total % 60;
			if (days > 0) return days + " 天 " + hours + " 小时";
			if (hours > 0) return hours + " 小时 " + minutes + " 分";
			if (minutes > 0) return minutes + " 分 " + seconds + " 秒";
			return seconds + " 秒";
		}

		/** ISO 时间 → 「3 天前」。 */
		function relativeTime(iso) {
			if (!iso) return "";
			var then = Date.parse(iso);
			if (isNaN(then)) return "";
			var diff = Date.now() - then;
			if (diff < 0) diff = 0;
			var minutes = Math.floor(diff / 60000);
			if (minutes < 1) return "刚刚";
			if (minutes < 60) return minutes + " 分钟前";
			var hours = Math.floor(minutes / 60);
			if (hours < 24) return hours + " 小时前";
			var days = Math.floor(hours / 24);
			if (days < 30) return days + " 天前";
			var months = Math.floor(days / 30);
			if (months < 12) return months + " 个月前";
			return Math.floor(months / 12) + " 年前";
		}

		/** 两个 ISO 时间之间相差几天（后者比前者新几天）。 */
		function daysBetween(fromIso, toIso) {
			var a = Date.parse(fromIso);
			var b = Date.parse(toIso);
			if (isNaN(a) || isNaN(b)) return null;
			return Math.round((b - a) / 86400000);
		}

		/** a 的主版本号是否高于 b（只比 x.y.z，预发布标识不参与）。 */
		function isNewerVersion(a, b) {
			var pa = String(a || "").replace(/^v/, "").split("-")[0].split(".").map(Number);
			var pb = String(b || "").replace(/^v/, "").split("-")[0].split(".").map(Number);
			for (var i = 0; i < 3; i += 1) {
				var left = pa[i] || 0;
				var right = pb[i] || 0;
				if (left !== right) return left > right;
			}
			return false;
		}

		/** 本地时间的短格式，用于日志头。 */
		function clock(ts) {
			if (!ts) return "";
			try {
				return new Date(ts).toLocaleString();
			} catch (error) {
				return String(ts);
			}
		}

		/** 新标签页打开外链；被拦截就算了，不抛。 */
		function openExternal(url) {
			try {
				window.open(url, "_blank", "noopener,noreferrer");
			} catch (error) {
				/* 忽略 */
			}
		}

		// ─────────────────────────── 样式 ───────────────────────────

		var STYLE = [
			"button." + CLASS + "{display:inline-flex;align-items:center;justify-content:center;",
			"gap:6px;height:28px;min-width:28px;max-width:100%;flex:none;padding:0 10px;",
			"border-radius:14px;font-family:inherit;font-size:12px;line-height:18px;",
			"white-space:nowrap;color:var(--dsw-alias-label-secondary);}",
			'button.' + CLASS + '[data-compact="true"]{width:28px;padding:0;border-radius:50%;}',

			// 真正的容器是 `dcu-footer-actions`，实测 `display:block`，**不是 flex**
			// （2026-10-14 布局探针实测；先前从别处的 dsh 副本读到的类名与 display:flex 都是错的）。
			// 所以 align-items / gap / flex-wrap 在这里一个都不管用——原先写在这里的
			// `[class*="footerActions"]{align-items:center;gap:6px;}` 是死代码，从未生效过。
			//
			// 容器既然是 block，两颗胶囊就是同一行里的 inline-flex 盒子，按
			// `vertical-align:baseline` 对齐。内联盒子的基线取自它的第一个 flex 项：
			//   本插件原先首个 flex 项是 8px 圆点 → 基线落在按钮顶下 18px
			//   「重启」首个 flex 项是 16px 内联 SVG → 基线落在按钮顶下 22px
			// 差 4px，实测本插件正好低 4px（y=719.2 vs 715.2）。数字对得上。
			//
			// 修法不是去改容器（动 display 会把容器里别的东西一起重排），而是让首个 flex 项
			// 也变成 16px 的内联 SVG（见 StateGlyph）：内联 SVG 是替换元素，基线就是它的
			// 下边缘，两颗胶囊于是对齐到同一条基线。
			//
			// 展开态再给一点左间距，免得两颗胶囊紧贴；折叠态容器居中，不加偏移。
			'button.' + CLASS + '[data-compact="false"]{flex:0 1 auto;margin-left:6px;}',
			"button." + CLASS + ":hover:not(:disabled){color:var(--dsw-alias-label-primary);",
			"background:var(--dsw-alias-interactive-bg-hover);}",
			'button.' + CLASS + '[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary);}',
			'button.' + CLASS + '[data-tone="good"]{color:var(--dsw-alias-state-success-primary);}',
			'button.' + CLASS + '[data-tone="bad"]{color:var(--dsw-alias-state-error-primary);}',
			"." + CLASS + "-glyph{display:inline-flex;align-items:center;justify-content:center;flex:none;}",
			"." + CLASS + "-text{overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums;}",
			'button.' + CLASS + '[data-spin="true"] .' + CLASS + "-glyph{animation:dshm-spin .9s linear infinite;}",

			".dshm-root{display:flex;flex-direction:column;gap:12px;",
			"font-size:12px;line-height:18px;",
			"color:var(--dsw-alias-label-secondary);}",

			// primitives 的 Modal.module.css 里 `.dialog{overflow:hidden}` 且不设
			// 高度上限，其注释明确写着「consumers cap growth with max-height:100%」。
			// 不封顶时内容比屏幕高，弹窗垂直居中后上下两端顶出视口又无法滚动 ——
			// 这就是「看不全」的根因。封顶 + 让内容区自己滚，footer 常驻。
			".dshm-modal{max-height:100%;}",
			".dshm-modal-content{overflow:auto;min-height:0;flex:1 1 auto;}",

			".dshm-hero{display:flex;align-items:center;gap:12px;padding:15px 16px;",
			"border-radius:12px;background:var(--dsw-alias-bg-layer-2);",
			"border:1px solid var(--dsw-alias-border-l2);}",
			".dshm-hero-dot{flex:none;width:8px;height:8px;border-radius:50%;",
			"box-shadow:0 0 0 3px var(--dsw-alias-bg-layer-2);}",
			".dshm-hero-main{display:flex;flex-direction:column;gap:5px;flex:1;min-width:0;}",
			// 版本号用等宽字体：`0.2.1-rc.2` 里那个 `1` 和 `2` 宽度一致，
			// 待重启时 running/onDisk 两串数字才对得齐。
			".dshm-ver{display:flex;align-items:center;gap:8px;flex-wrap:wrap;",
			"font-size:20px;line-height:26px;font-weight:600;letter-spacing:-.01em;",
			"font-variant-numeric:tabular-nums;",
			'font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;',
			"color:var(--dsw-alias-label-primary);}",
			".dshm-ver .dshm-tag{font-family:inherit;letter-spacing:0;}",
			".dshm-sub{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);",
			"word-break:break-all;}",

			".dshm-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:2px 12px;}",
			// 左侧一厘米竖条：给每张卡一个统一的视觉锚点，
			// 免得一页卡片看起来像同一种灰色块。
			".dshm-card-title{display:flex;align-items:center;gap:6px;padding:9px 0 3px;",
			"font-size:11px;font-weight:600;letter-spacing:.04em;",
			"color:var(--dsw-alias-label-tertiary);text-transform:uppercase;}",
			".dshm-card-title::before{content:'';flex:none;width:2px;height:9px;border-radius:1px;",
			"background:var(--dsw-alias-border-l3);}",
			".dshm-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px;",
			"padding:8px 0 2px;}",
			".dshm-card-head .dshm-card-title{padding:0;}",
			".dshm-compat-list{display:flex;flex-direction:column;}",
			".dshm-compat-item{display:flex;align-items:baseline;gap:8px;padding:7px 0;",
			"border-top:1px solid var(--dsw-alias-border-l2);font-size:11px;line-height:16px;}",
			".dshm-compat-item:first-child{border-top:none;}",
			".dshm-compat-name{flex:1;min-width:0;word-break:break-all;",
			'font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;',
			"color:var(--dsw-alias-label-primary);}",
			".dshm-compat-ver{flex:none;color:var(--dsw-alias-label-tertiary);",
			"font-variant-numeric:tabular-nums;}",
			".dshm-bar-meta{display:flex;align-items:center;justify-content:space-between;gap:8px;",
			"margin-top:8px;font-size:11px;color:var(--dsw-alias-label-tertiary);",
			"font-variant-numeric:tabular-nums;}",
			".dshm-bar{position:relative;height:4px;margin:6px 0 2px;border-radius:2px;",
			"overflow:hidden;background:var(--dsw-alias-border-l2);}",
			".dshm-bar-fill{position:absolute;top:0;bottom:0;left:0;border-radius:2px;",
			"background:var(--dsw-alias-state-idle-primary);transition:width .3s ease;}",
			'.dshm-bar-fill[data-tone="good"]{background:var(--dsw-alias-state-success-primary);}',
			'.dshm-bar-fill[data-tone="bad"]{background:var(--dsw-alias-state-error-primary);}',

			// 折叠分区：一行标题，点开才占版面
			".dshm-fold{border-top:1px solid var(--dsw-alias-border-l2);}",
			".dshm-fold-head{display:flex;align-items:center;gap:6px;padding:9px 0;cursor:pointer;",
			"user-select:none;font-size:11px;color:var(--dsw-alias-label-secondary);}",
			".dshm-fold-head:hover .dshm-fold-title{color:var(--dsw-alias-label-primary);}",
			".dshm-fold-head:focus-visible{outline:2px solid var(--dsw-alias-state-idle-primary);",
			"outline-offset:-2px;border-radius:6px;}",
			".dshm-fold-caret{display:inline-block;width:10px;text-align:center;font-size:12px;",
			"line-height:1;color:var(--dsw-alias-label-tertiary);transition:transform .15s ease;}",
			'.dshm-fold-caret[data-open="1"]{transform:rotate(90deg);}',
			".dshm-fold-title{font-weight:600;letter-spacing:.02em;}",
			".dshm-fold-meta{margin-left:auto;color:var(--dsw-alias-label-tertiary);",
			"font-variant-numeric:tabular-nums;}",
			".dshm-fold-body{padding-bottom:6px;}",

			// 「一切正常」的一行式状态：不占卡片，不抢视线
			".dshm-inline-ok{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;",
			"border-radius:999px;border:1px solid var(--dsw-alias-border-l2);",
			"background:var(--dsw-alias-bg-layer-2);",
			"font-size:11px;color:var(--dsw-alias-label-tertiary);}",
			".dshm-inline-ok .dshm-spacer{display:none;}",
			".dshm-inline-row{display:flex;align-items:center;gap:6px;}",
			".dshm-inline-row .dshm-spacer{flex:1;}",
			".dshm-row{display:flex;align-items:center;justify-content:space-between;gap:12px;",
			"padding:9px 0;border-top:1px solid var(--dsw-alias-border-l2);}",
			".dshm-row:first-child{border-top:none;}",
			".dshm-row-k{flex:none;color:var(--dsw-alias-label-tertiary);}",
			".dshm-row-v{display:flex;align-items:center;gap:6px;min-width:0;",
			"justify-content:flex-end;text-align:right;font-variant-numeric:tabular-nums;",
			"color:var(--dsw-alias-label-primary);word-break:break-all;}",

			".dshm-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}",
			".dshm-spacer{flex:1;}",

			".dshm-note{padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);",
			"border-left:3px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);}",
			'.dshm-note[data-tone="warn"]{border-left-color:var(--dsw-alias-state-warn-primary);}',
			'.dshm-note[data-tone="good"]{border-left-color:var(--dsw-alias-state-success-primary);}',
			'.dshm-note[data-tone="bad"]{border-left-color:var(--dsw-alias-state-error-primary);}',
			".dshm-note-title{display:flex;align-items:center;gap:6px;font-weight:600;",
			"color:var(--dsw-alias-label-primary);}",
			".dshm-note-body{margin-top:4px;font-size:11px;line-height:16px;",
			"color:var(--dsw-alias-label-tertiary);}",

			".dshm-log{margin:0;max-height:168px;overflow:auto;padding:8px 10px;border-radius:8px;",
			"background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);",
			'font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;',
			"font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);",
			"white-space:pre-wrap;word-break:break-all;}",

			".dshm-ack{display:flex;align-items:flex-start;gap:8px;cursor:pointer;",
			"color:var(--dsw-alias-label-secondary);}",
			".dshm-ack input{margin:2px 0 0;flex:none;}",

			".dshm-tags{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}",
			".dshm-mono{font-variant-numeric:tabular-nums;}",
			// 一个「值」里要放多行时用它：主行 + 次要行，行距收紧但仍可读
			".dshm-stack{display:flex;flex-direction:column;gap:2px;min-width:0;}",
			".dshm-dim{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;}",
			// 值列里的 mono 路径可能很长，允许换行而不是把行撑破
			".dshm-row-v .dshm-mono,.dshm-row-v .dshm-dim{overflow-wrap:anywhere;}",
			".dshm-card-sub{margin-top:8px;padding-top:4px;border-top:1px solid var(--dsw-alias-border-l2);}",

			"@keyframes dshm-spin{to{transform:rotate(360deg);}}",
			"@media (prefers-reduced-motion:reduce){",
			'button.' + CLASS + '[data-spin="true"] .' + CLASS + "-glyph{animation:none;}}"
		].join("");

		function ensureStyles() {
			if (typeof document === "undefined" || !document.head) return;
			if (document.getElementById(STYLE_ID)) return;
			var el = document.createElement("style");
			el.id = STYLE_ID;
			el.textContent = STYLE;
			document.head.appendChild(el);
		}

		// ─────────────────────────── 网络 ───────────────────────────

		/** 带超时的请求；返回已解析 JSON 或 null。失败不抛。 */
		function requestJson(url, method, timeoutMs) {
			var controller = typeof AbortController === "function" ? new AbortController() : null;
			var guard = setTimeout(function () { if (controller) controller.abort(); }, timeoutMs);
			return fetch(url, { method: method, signal: controller ? controller.signal : undefined })
				.then(function (response) {
					return response.json().catch(function () { return null; }).then(function (body) {
						return { ok: response.ok, status: response.status, body: body };
					});
				})
				.catch(function () { return { ok: false, status: 0, body: null }; })
				.then(function (result) { clearTimeout(guard); return result; });
		}

		// ─────────────────────────── 布局探针 ───────────────────────────

		/**
		 * 量一次侧栏底部那一行的真实几何，回传服务端落盘。
		 *
		 * 存在的理由：这台设备上没有浏览器，改布局的 agent 看不到渲染结果，只能猜——
		 * 而"齐不齐"恰恰是猜不出来的（胶囊在哪、多高、外间距多少，全看真实 CSS 级联）。
		 * 与其反复猜，不如把 getBoundingClientRect 的数字带出来。
		 * 只跑一次，任何异常都吞掉：探针挂掉绝不能拖累界面。
		 */
		var LAYOUT_PROBED = "__dshm_layout_probed__";

		function probeLayout() {
			try {
				if (window[LAYOUT_PROBED]) return;
				window[LAYOUT_PROBED] = true;

				function round(value) { return Math.round(value * 100) / 100; }

				function box(node) {
					if (!node) return null;
					var rect = node.getBoundingClientRect();
					var computed = window.getComputedStyle(node);
					var out = {
						tag: node.tagName.toLowerCase(),
						cls: String(node.className || ""),
						text: String(node.textContent || "").slice(0, 40),
						rect: { x: round(rect.x), y: round(rect.y), w: round(rect.width), h: round(rect.height) }
					};
					[
						"display", "alignItems", "alignSelf", "justifyContent", "flexDirection", "flexWrap",
						"gap", "rowGap", "height", "minHeight", "width", "maxWidth", "minWidth",
						"padding", "margin", "flex", "flexBasis", "borderRadius", "fontSize", "lineHeight",
						"verticalAlign", "boxSizing", "overflow", "position", "whiteSpace"
					].forEach(function (key) { out[key] = computed[key]; });
					return out;
				}

				/** 从节点沿 parentElement 往上走，记录整条祖先链——容器叫什么由宿主决定，不能猜。 */
				function chain(node, limit) {
					var out = [];
					var current = node;
					var index = 0;
					while (current && current !== document.documentElement && index < limit) {
						out.push(box(current));
						current = current.parentElement;
						index += 1;
					}
					return out;
				}

				var mine = document.querySelector("button.dshm-btn");
				var restart = document.querySelector("button.dsh-restart-btn");
				var payload = {
					at: new Date().toISOString(),
					viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
					mine: box(mine),
					restart: box(restart),
					sameParent: Boolean(mine && restart && mine.parentElement === restart.parentElement),
					mineChain: chain(mine, 10),
					restartChain: chain(restart, 10),
					allButtons: Array.prototype.map.call(document.querySelectorAll("button"), function (node) {
						var rect = node.getBoundingClientRect();
						return {
							cls: String(node.className || ""),
							text: String(node.textContent || "").slice(0, 24),
							x: round(rect.x), y: round(rect.y), w: round(rect.width), h: round(rect.height)
						};
					})
				};

				window.fetch(API + "?action=report-layout", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(payload)
				}).catch(function () { /* 探针失败就算了 */ });
			} catch (error) {
				/* 探针绝不影响界面 */
			}
		}

		// ─────────────────────────── 面板 ───────────────────────────

		/**
		 * 面板主体。所有状态都在这里；触发器只是它的一个开关。
		 */
		function MaintenancePanel(props) {
			var wide = !!(props && props.wide);

			// 打开/关闭
			var openState = React.useState(false);
			var open = openState[0];
			var setOpen = openState[1];

			// 本地快照
			var snapState = React.useState(null);
			var snapshot = snapState[0];
			var setSnapshot = snapState[1];

			// 更新检查
			var checkState = React.useState("idle"); // idle | checking | done | error
			var checkPhase = checkState[0];
			var setCheckPhase = checkState[1];
			var updateState = React.useState(null);
			var update = updateState[0];
			var setUpdate = updateState[1];

			// 升级
			var jobState = React.useState(null);
			var job = jobState[0];
			var setJob = jobState[1];
			var logState = React.useState([]);
			var logLines = logState[0];
			var setLogLines = logState[1];

			// 两段式确认
			var confirmState = React.useState(false);
			var confirming = confirmState[0];
			var setConfirming = confirmState[1];
			var ackState = React.useState(false);
			var acknowledged = ackState[0];
			var setAcknowledged = ackState[1];

			// 一对通知
			var noticeState = React.useState(null);
			var notice = noticeState[0];
			var setNotice = noticeState[1];

			// 插件兼容性（决定界面能不能起来）
			var compatState = React.useState(null);
			var compat = compatState[0];
			var setCompat = compatState[1];
			// 手动「重新检测」时要有可见的进行中状态：检测结果通常和上次一模一样，
			// 不给反馈的话点下去跟没点没区别。
			var compatBusyState = React.useState(false);
			var compatBusy = compatBusyState[0];
			var setCompatBusy = compatBusyState[1];
			var compatFlashState = React.useState(false);
			var compatFlash = compatFlashState[0];
			var setCompatFlash = compatFlashState[1];
			var aligningState = React.useState(false);
			var aligning = aligningState[0];
			var setAligning = aligningState[1];

			var running = !!(job && job.running);
			var wasRunning = React.useRef(false);

			/** 读本地状态（不碰网络）。 */
			function loadStatus(withNetwork) {
				var action = withNetwork ? "check-update" : "status";
				return requestJson(API + "?action=" + action, "GET", withNetwork ? 20000 : 6000)
					.then(function (result) {
						if (!result.ok || !result.body || !result.body.ok) return null;
						setSnapshot(result.body);
						if (withNetwork) {
							setUpdate(result.body.update || null);
							setCheckPhase(result.body.update && result.body.update.error ? "error" : "done");
						}
						if (result.body.upgrade) setJob(result.body.upgrade);
						return result.body;
					});
			}

			/** 读升级进度（含日志尾）。 */
			function loadJob() {
				return requestJson(API + "?action=upgrade-status", "GET", 8000).then(function (result) {
					if (!result.ok || !result.body || !result.body.ok) return null;
					setJob(result.body.upgrade);
					setLogLines((result.body.log && result.body.log.lines) || []);
					if (result.body.onDiskVersion !== undefined || result.body.restartRequired !== undefined) {
						setSnapshot(function (previous) {
							if (!previous) return previous;
							return Object.assign({}, previous, {
								onDiskVersion: result.body.onDiskVersion,
								restartRequired: result.body.restartRequired
							});
						});
					}
					return result.body;
				});
			}

			// 挂载即取一次本地状态：侧栏按钮上的版本号靠它。
			React.useEffect(function () {
				var stopped = false;
				loadStatus(false).then(function () { if (stopped) return; });
				return function () { stopped = true; };
			}, []);

			// 布局探针：这台设备上没有浏览器，agent 只能靠数字判断"齐不齐"。
			// 挂载后量一次真实几何回传服务端落盘；只跑一次，任何异常都吞掉，绝不影响 UI。
			React.useEffect(function () {
				var timer = setTimeout(probeLayout, 1500);
				return function () { clearTimeout(timer); };
			}, []);

			// 升级进行中：轮询进度；一旦结束再刷一次完整状态。
			React.useEffect(function () {
				if (!open) return undefined;
				if (!running) return undefined;
				var timer = setInterval(function () { loadJob(); }, POLL_MS);
				return function () { clearInterval(timer); };
			}, [open, running]);

			React.useEffect(function () {
				if (running) {
					wasRunning.current = true;
					return;
				}
				if (wasRunning.current) {
					wasRunning.current = false;
					setNotice(
						job && job.exitCode === 0
							? { tone: "good", title: "升级脚本已执行完成", body: "重启后新版本才会生效。" }
							: { tone: "bad", title: "升级脚本退出异常", body: "退出码 " + (job && job.exitCode) + "，请查看下方日志。" }
					);
					loadStatus(false);
					loadJob();
				}
			}, [running]);

			// 面板打开时把进度与日志补上（可能是打开前就启动的升级），并顺带体检插件。
			React.useEffect(function () {
				if (!open) return;
				loadJob();
				loadCompat();
			}, [open]);

			/** 读插件兼容性：服务端会跑一次 `dsh --dump-config`，比普通接口慢。 */
			function loadCompat() {
				setCompatBusy(true);
				return requestJson(API + "?action=plugin-compat", "GET", 60000).then(function (result) {
					setCompatBusy(false);
					if (!result.ok || !result.body || !result.body.ok) {
						setCompat({ ok: false, error: (result.body && result.body.error) || "无法获取插件兼容性" });
						return null;
					}
					setCompat(result.body);
					// 结果通常和上次一模一样，给一秒半的「已重新检测」闪一下，
					// 否则点下去视觉上毫无变化，等于没有反馈。
					setCompatFlash(true);
					setTimeout(function () { setCompatFlash(false); }, 1600);
					return result.body;
				}, function (error) {
					setCompatBusy(false);
					setCompat({ ok: false, error: String((error && error.message) || error) });
					return null;
				});
			}

			/** 跑一次对齐脚本；restore 为真时改为恢复上次升级前的插件版本。 */
			function doAlign(restore) {
				setAligning(true);
				setNotice(null);
				var action = restore ? "plugin-restore" : "plugin-align";
				return requestJson(API + "?action=" + action, "POST", 180000).then(function (result) {
					setAligning(false);
					var body = (result && result.body) || {};
					if (body.ok === false) {
						setNotice({
							tone: "bad",
							title: restore ? "恢复失败" : "对齐失败",
							body: body.error || "脚本没有正常结束，请看终端输出。"
						});
					} else {
						setNotice({
							tone: "good",
							title: restore ? "已恢复到上次升级前的插件版本" : "插件已对齐到当前 dsh 版本",
							body: "重启 DSH 后生效。"
						});
					}
					return loadCompat();
				}, function (error) {
					setAligning(false);
					setNotice({ tone: "bad", title: restore ? "恢复失败" : "对齐失败", body: String((error && error.message) || error) });
					return null;
				});
			}

			function doCheck() {
				setCheckPhase("checking");
				setNotice(null);
				return loadStatus(true).then(function (body) {
					if (!body) {
						setCheckPhase("error");
						setUpdate(null);
						setNotice({ tone: "bad", title: "检查失败", body: "无法访问 npm registry，或请求超时。" });
					}
				});
			}

			function doUpgrade(version) {
				setNotice(null);
				return requestJson(API + "?action=upgrade&version=" + encodeURIComponent(version), "POST", 20000)
					.then(function (result) {
						if (!result.ok || !result.body || !result.body.ok) {
							setNotice({ tone: "bad", title: "升级未能启动", body: (result.body && result.body.error) || "未知错误" });
							return;
						}
						setConfirming(false);
						setAcknowledged(false);
						setNotice({ tone: "warn", title: "升级已启动", body: "后台执行中，进度会显示在下方。" });
						loadJob();
					});
			}

			function doRestart() {
				return requestJson(API + "?action=restart", "POST", 10000).then(function (result) {
					if (!result.ok || !result.body || !result.body.ok) {
						setNotice({ tone: "bad", title: "重启失败", body: (result.body && result.body.error) || "未知错误" });
						return;
					}
					setNotice({ tone: "good", title: "已发出重启指令", body: "服务重启期间本页面会短暂断开。" });
				});
			}

			function doRepair() {
				return requestJson(API + "?action=repair", "POST", 20000).then(function (result) {
					if (!result.ok || !result.body || !result.body.ok) {
						setNotice({ tone: "bad", title: "修复失败", body: (result.body && result.body.error) || "未知错误" });
						return;
					}
					setNotice({
						tone: result.body.changed ? "warn" : "good",
						title: result.body.changed ? "已修复" : "无需修复",
						body: result.body.changed ? "环境已回到正确状态；如有插件行被禁用，重启后恢复。" : "守护对象与登记都正确。"
					});
					loadStatus(false);
				});
			}

			// ── 派生视图 ──

			var runningVersion = (snapshot && snapshot.runningVersion) || "…";
			var onDiskVersion = (snapshot && snapshot.onDiskVersion) || runningVersion;
			var restartRequired = !!(snapshot && snapshot.restartRequired);
			var health = snapshot && snapshot.health;
			var patch = snapshot && snapshot.patchRecord;

			// 0 是合法值（补丁全部就位时 patched=0），只有 null/undefined 才该显示 "?"
			function showNum(value) {
				return (value === null || value === undefined) ? "?" : String(value);
			}

			var dotState = "idle";
			var tones = "none";
			if (restartRequired) { dotState = "warning"; tones = "warn"; }
			else if (health && !health.healthy) { dotState = "error"; tones = "bad"; }
			else if (health && health.healthy) { dotState = "done"; tones = "good"; }

			var triggerText = restartRequired ? "待重启" : "v" + runningVersion;
			var triggerTitle = restartRequired
				? "磁盘上已是 v" + onDiskVersion + "，重启后生效 —— 点开查看"
				: "当前 DSH v" + runningVersion + " —— 点开查看与检查更新";

			var latestTag = update && update.tags && update.tags.latest;
			var recommended = update && update.recommended;
			var updateAvailable = !!(update && update.updateAvailable);
			var currentPublishedAt = update && update.currentPublishedAt;

			// ── 组装 DOM ──

			var body = [];

			// ① 版本主卡
			body.push(h("div", { key: "hero", className: "dshm-hero" },
				h("span", {
					className: "dshm-hero-dot",
					style: { background: dotColor(health ? (health.healthy ? "done" : "error") : "idle") }
				}),
				h("div", { className: "dshm-hero-main" },
					h("div", { className: "dshm-ver" },
						h("span", null, "v" + runningVersion),
						restartRequired ? tag("warning", "待重启") : null,
						health ? tag(health.healthy ? "success" : "danger", health.healthy ? "健康" : "需修复") : null
					),
					h("div", { className: "dshm-sub" },
						// 首屏只回答「现在是什么状态」；node/pid/路径这些去「技术细节」里看。
						"DSH " + runningVersion +
						(restartRequired ? " · 磁盘已是 " + onDiskVersion + "，等重启" : "") +
						" · 已运行 " + ((snapshot && snapshot.startedAt) ? formatDuration(Date.now() - snapshot.startedAt) : "—") +
						(patch && patch.present && !patch.error
							? " · 补丁 " + showNum(patch.patched) + "/" + showNum(patch.rules)
							: "")
					)
				)
			));

			// ② 环境事实
			var rows = [];
			rows.push(row("运行时长", (snapshot && snapshot.startedAt) ? formatDuration(Date.now() - snapshot.startedAt) : "—"));
			rows.push(row("运行版本", h("span", { className: "dshm-stack" },
				h("span", null, "v" + runningVersion + (restartRequired ? "（运行中）" : " · 已生效")),
				(onDiskVersion !== runningVersion)
					? h("span", { className: "dshm-dim" }, "磁盘已是 v" + onDiskVersion + (restartRequired ? " · 待重启生效" : ""))
					: null
			)));
			rows.push(row("进程", h("span", { className: "dshm-mono" },
				((snapshot && snapshot.node) || "?") + " · pid " + ((snapshot && snapshot.pid) || "?"))));
			rows.push(row("补丁记录", patch
				? (patch.present
					? (patch.error ? "读取失败" : h("span", { className: "dshm-stack" },
						h("span", null,
							"v" + (patch.version || "?") +
							" · " + (patch.mode || "?") +
							" · rules " + showNum(patch.rules) +
							" · patched " + showNum(patch.patched) +
							" · skipped " + showNum(patch.skipped) +
							(patch.failed === null || patch.failed === undefined ? "" : " · failed " + showNum(patch.failed))),
						patch.validatedAt
							? h("span", { className: "dshm-dim" }, "验证于 " + relativeTime(patch.validatedAt) + " · " + patch.validatedAt.replace("T", " ").slice(0, 19) + "Z")
							: null,
						patch.path ? h("span", { className: "dshm-mono dshm-dim" }, patch.path) : null
					))
					: "缺失（VALIDATED.json 不存在）")
				: "—"));
			rows.push(row("守护插件", health
				? h("span", { className: "dshm-stack" },
					h("span", { className: "dshm-actions" },
						stateDot(health.healthy ? "done" : "warning"),
						h("span", null, health.guarded + " · " + (health.loadable ? "可加载" : "不可加载") + " · " + (health.registered ? "已登记" : "未登记"))
					),
					health.ignored ? h("span", { className: "dshm-dim" }, "node_modules/.ignored 里存在同名残骸，修复会清掉") : null
				)
				: "—"));
			rows.push(row("补丁集目录", h("span", { className: "dshm-mono" }, (snapshot && snapshot.patchDir) || "—")));
			rows.push(row("DSH 安装目录", h("span", { className: "dshm-mono" }, (snapshot && snapshot.packageDir) || "—")));
			rows.push(row("升级脚本", h("span", { className: "dshm-stack" },
				h("span", { className: "dshm-mono" }, (snapshot && snapshot.upgrade && snapshot.upgrade.script) || "—"),
				(snapshot && snapshot.upgrade && snapshot.upgrade.allowUpgrade === false)
					? h("span", { className: "dshm-dim" }, "已禁用（配置 allowUpgrade=false）")
					: null
			)));
			rows.push(row("升级日志", h("span", { className: "dshm-mono" }, (snapshot && snapshot.updateLog) || "—")));
			// 技术细节（补丁、路径、进程）默认收起，挪到页面末尾 —— 见「⑤ 通知」之前。

			// ②.5 插件兼容性 —— 界面能不能起来，全看这一步
			var compatRows = [];
			if (!compat) {
				compatRows.push(h("div", { key: "loading", className: "dshm-dim", style: { padding: "8px 0" } }, "检测中…"));
			} else if (compat.ok === false) {
				compatRows.push(h("div", { key: "error", className: "dshm-note", "data-tone": "bad" },
					h("div", { className: "dshm-note-title" }, h(IconDotState, { state: "error" }), "检测失败"),
					h("div", { className: "dshm-note-body" }, compat.error || "无法运行 dsh --dump-config")
				));
			} else if (!compat.count) {
				compatRows.push(h("div", { key: "ok", className: "dshm-note", "data-tone": "good" },
					h("div", { className: "dshm-note-title" }, h(IconDotState, { state: "done" }), "全部插件都能加载"),
					h("div", { className: "dshm-note-body" },
						"当前 dsh v" + (compat.runtime || onDiskVersion) + " 下没有任何 profile bundle 被跳过。")
				));
			} else {
				compatRows.push(h("div", { key: "bad", className: "dshm-note", "data-tone": "warn" },
					h("div", { className: "dshm-note-title" },
						h(IconDotState, { state: "warning" }),
						compat.count + " 个插件会被 dsh 跳过"),
					h("div", { className: "dshm-note-body" },
						"它们的 peerDependencies 都不含 v" + (compat.runtime || onDiskVersion) +
						"，启动时整包不加载；依赖它们的界面会一直 pending —— 表现出来就是「Failed to load plugins」。")
				));
				compatRows.push(h("div", { key: "list", className: "dshm-compat-list" },
					// 只列前 6 条：面板是用来看结论的，完整清单在「对齐」输出里。
					compat.items.slice(0, 6).map(function (item) {
						return h("div", { key: item.bundle, className: "dshm-compat-item" },
							h("span", { className: "dshm-compat-name" }, item.bundle),
							item.version ? h("span", { className: "dshm-compat-ver" }, "v" + item.version) : null
						);
					}),
					compat.items.length > 6
						? h("div", { key: "more", className: "dshm-dim", style: { padding: "6px 0" } },
							"… 另有 " + (compat.items.length - 6) + " 个")
						: null
				));
			}
			compatRows.push(h("div", { key: "actions", className: "dshm-actions", style: { padding: "10px 0 6px" } },
				h(Button, {
					variant: "ghost", size: "sm", icon: h(RefreshGlyph),
					disabled: aligning, onClick: function () { loadCompat(); }
				}, "重新检测"),
				compat && compat.count
					? h(Button, {
						variant: "primary", size: "sm", icon: h(UpgradeGlyph),
						disabled: aligning, onClick: function () { doAlign(false); }
					}, aligning ? "对齐中…" : "一键对齐")
					: null,
				compat && compat.count
					? h(Button, {
						variant: "ghost", size: "sm", disabled: aligning,
						onClick: function () { doAlign(true); }
					}, "恢复上次备份")
					: null
			));
			// 一切正常时只留一行淡字：这是背景信息，不该占一张卡片的位置。
			if (compat && compat.ok && !compat.count) {
				body.push(h("div", { key: "compat-ok", className: "dshm-inline-row" },
					h("span", { className: "dshm-inline-ok" },
						h(IconDotState, { state: compatBusy ? "ongoing" : "done" }),
						h("span", null, compatBusy
							? "正在检测插件兼容性…"
							: compatFlash
								? "已重新检测 · 全部兼容"
								: "插件全部兼容 v" + (compat.runtime || onDiskVersion))
					),
					h("span", { className: "dshm-spacer" }),
					h(Button, {
						variant: "ghost",
						size: "sm",
						disabled: aligning || compatBusy,
						onClick: function () { loadCompat(); }
					}, compatBusy ? "检测中…" : "重新检测")
				));
			} else if (compat) {
				body.push(h("div", { key: "compat", className: "dshm-card" },
					h("div", { className: "dshm-card-head" },
						h("div", { className: "dshm-card-title" }, "插件兼容性"),
						compat.count ? tag("warning", compat.count + " 个待修") : null
					),
					compatRows
				));
			}

			// ③ 更新区块
			var updateRows = [];

			if (checkPhase === "idle") {
				updateRows.push(h("div", { key: "idle", className: "dshm-row" },
					h("span", { className: "dshm-row-k" }, "尚未检查"),
					h(Button, { variant: "outline", size: "sm", icon: h(RefreshGlyph), onClick: doCheck }, "检查更新")
				));
			} else if (checkPhase === "checking") {
				updateRows.push(h("div", { key: "checking", className: "dshm-row" },
					h("span", { className: "dshm-actions" }, stateDot("ongoing"), h("span", null, "正在查询 npm registry…")),
					null
				));
			} else if (checkPhase === "error") {
				updateRows.push(h("div", { key: "error", className: "dshm-note", "data-tone": "bad" },
					h("div", { className: "dshm-note-title" }, h(IconDotState, { state: "error" }), "检查失败"),
					h("div", { className: "dshm-note-body" }, (update && update.error) || "无法访问 npm registry。"),
					h("div", { className: "dshm-actions", style: { marginTop: 8 } },
						h(Button, { variant: "outline", size: "sm", icon: h(RefreshGlyph), onClick: doCheck }, "重试")
					)
				));
			} else if (update && !updateAvailable) {
				var newerTags = Object.keys(update.tags || {}).map(function (key) {
					return update.tags[key] || {};
				}).filter(function (entry) {
					return isNewerVersion(entry.version, update.current || onDiskVersion);
				});
				updateRows.push(h("div", { key: "uptodate", className: "dshm-note", "data-tone": "good" },
					h("div", { className: "dshm-note-title" }, h(IconDotState, { state: "done" }), "已是最新"),
					h("div", { className: "dshm-note-body" },
						"本机 v" + (update.current || onDiskVersion) +
						(currentPublishedAt ? " · 发布于 " + relativeTime(currentPublishedAt) + "（" + String(currentPublishedAt).slice(0, 10) + "）" : "") +
						(latestTag && latestTag.publishedAt ? " · latest 发布于 " + relativeTime(latestTag.publishedAt) : "")
					),
					newerTags.length
						? h("div", { className: "dshm-dim", style: { marginTop: 6 } },
							"存在更新的预发布版本：" + newerTags.map(function (entry) { return "v" + entry.version; }).join(" / ") + "（默认不推荐）")
						: null,
					h("div", { className: "dshm-actions", style: { marginTop: 8 } },
						h(Button, { variant: "ghost", size: "sm", icon: h(RefreshGlyph), onClick: doCheck }, "重新检查")
					)
				));
			} else if (updateAvailable && recommended) {
				var targetPublishedAt = update.tags && update.tags[recommended.tag] && update.tags[recommended.tag].publishedAt;
				var gap = daysBetween(currentPublishedAt, targetPublishedAt);
				updateRows.push(h("div", { key: "available", className: "dshm-note", "data-tone": "warn" },
					h("div", { className: "dshm-note-title" },
						h(IconDotState, { state: "warning" }),
						"发现新版本 v" + recommended.version,
						tag(recommended.isStable ? "success" : "info", recommended.tag)
					),
					h("div", { className: "dshm-note-body" },
						[
							targetPublishedAt ? "发布于 " + relativeTime(targetPublishedAt) : null,
							gap !== null && gap > 0 ? "比当前新 " + gap + " 天" : null,
							"当前 v" + (update.current || onDiskVersion)
						].filter(Boolean).join(" · ")
					),
					// —— 这就是用户要的「后续动作」—— //
					confirming
						? h("div", { key: "confirm", style: { marginTop: 10, display: "flex", flexDirection: "column", gap: 8 } },
							h("div", { className: "dshm-note", "data-tone": "bad", style: { margin: 0 } },
								h("div", { className: "dshm-note-title" }, h(IconDotState, { state: "warning" }), "确认升级到 v" + recommended.version + "？"),
								h("div", { className: "dshm-note-body" },
									"会重装全局 DSH、重新应用 Android 补丁、重编译 landlock，并重装守护插件；" +
									"过程中服务可能短暂中断，升级完成后需要重启。脚本不会自动回滚。"
								)
							),
							h("label", { className: "dshm-ack" },
								h("input", {
									type: "checkbox",
									checked: acknowledged,
									onChange: function (event) { setAcknowledged(!!event.target.checked); }
								}),
								h("span", null, "我已了解，升级会改动本机 DSH 安装")
							),
							h("div", { className: "dshm-actions" },
								h(Button, {
									variant: "primary",
									size: "sm",
									icon: h(UpgradeGlyph),
									disabled: !acknowledged,
									onClick: function () { doUpgrade(recommended.version); }
								}, "确认升级"),
								h(Button, {
									variant: "ghost",
									size: "sm",
									onClick: function () { setConfirming(false); setAcknowledged(false); }
								}, "取消")
							)
						)
						: h("div", { className: "dshm-actions", style: { marginTop: 10 } },
							h(Button, {
								variant: "primary",
								size: "sm",
								icon: h(UpgradeGlyph),
								disabled: running || !(snapshot && snapshot.upgrade && snapshot.upgrade.allowUpgrade),
								onClick: function () { setConfirming(true); setAcknowledged(false); }
							}, "一键升级到 " + recommended.version),
							h(Button, {
								variant: "ghost",
								size: "sm",
								onClick: function () {
									openExternal("https://www.npmjs.com/package/@deepseek-ai/dsh/v/" + recommended.version);
								}
							}, "发布说明"),
							h(Button, { variant: "ghost", size: "sm", icon: h(RefreshGlyph), onClick: doCheck }, "重新检查")
						)
				));

			}

			// 只有真的存在可升级版本时才铺开这张通道表；
			// 「已是最新」的常态下，这一整块属于噪音。
			if (updateAvailable && recommended && update && update.tags && Object.keys(update.tags).length) {
				var currentText = update.current || onDiskVersion;
				updateRows.push(h("div", { key: "tags", className: "dshm-card-sub" },
					h("div", { className: "dshm-card-title" }, "全部发布通道（dist-tags）"),
					Object.keys(update.tags).map(function (key) {
						var entry = update.tags[key] || {};
						var isCurrent = entry.version === currentText;
						var newer = !isCurrent && isNewerVersion(entry.version, currentText);
						return h("div", { key: key, className: "dshm-row" },
							h("span", { className: "dshm-row-k" }, key),
							h("span", { className: "dshm-row-v" },
								h("span", { className: "dshm-mono" }, String(entry.version || "?")),
								isCurrent ? tag("neutral", "本机") : (newer ? tag("info", "更新") : null),
								entry.publishedAt ? h("span", { className: "dshm-sub" }, relativeTime(entry.publishedAt)) : null
							)
						);
					})
				));
			}

			body.push(h("div", { key: "update", className: "dshm-card" },
				h("div", { className: "dshm-card-title" }, "版本更新"),
				updateRows
			));

			// ④ 升级进度
			//
			// 这张卡只在「此刻正在升级」或「本进程刚跑完一次升级」时出现。
			// 之前的版本在进程重启后仍把上一轮的日志当进度渲染，于是一个
			// 停在 9/9、100% 的死进度条会一直挂在那里，既不反映现状也没法操作
			// —— 纯噪音。历史日志挪进「技术细节」折叠区。
			if (running || (job && job.exitCode !== null && job.exitCode !== undefined)) {
				var jobNote = null;
				if (running) {
					jobNote = h("div", { className: "dshm-note", "data-tone": "warn" },
						h("div", { className: "dshm-note-title" },
							stateDot("ongoing"),
							"正在升级到 v" + (job && job.target) + "…"
						),
						h("div", { className: "dshm-note-body" },
							"已运行 " + formatDuration(Date.now() - ((job && job.startedAt) || Date.now())) +
							" · 这一步会现场重编译原生模块，慢是正常的。"
						)
					);
				} else if (job) {
					var succeeded = job.exitCode === 0;
					jobNote = h("div", { className: "dshm-note", "data-tone": succeeded ? "good" : "bad" },
						h("div", { className: "dshm-note-title" },
							h(IconDotState, { state: succeeded ? "done" : "error" }),
							succeeded ? "升级脚本已完成" : "升级脚本退出异常"
						),
						h("div", { className: "dshm-note-body" },
							"目标 v" + (job.target || "?") + " · 退出码 " + job.exitCode +
							(succeeded && restartRequired ? " · 重启后生效" : "")
						)
					);
				}

				var progressActions = null;
				if (job && !running && job.exitCode === 0 && restartRequired) {
					progressActions = h("div", { className: "dshm-actions", style: { marginTop: 10 } },
						h(Button, { variant: "primary", size: "sm", icon: h(PowerGlyph), onClick: doRestart }, "重启生效")
					);
				}

				body.push(h("div", { key: "progress", className: "dshm-card" },
					h("div", { className: "dshm-card-title" }, "升级进度"),
					progressBar(logLines, running, job),
					jobNote,
					progressActions,
					logLines.length
						? h(Fold, {
							title: "升级日志",
							meta: logLines.length + " 行",
							// 升级进行中才默认展开：那时日志就是唯一的进度来源。
							defaultOpen: running,
							children: h("pre", { className: "dshm-log" }, logLines.join("\n"))
						})
						: null
				));
			}

			// ④.5 技术细节已移除。
			//      补丁状态在 hero 副标题里（补丁 13/13），升级日志在 ~/试玩/dsh-update.log，
			//      路径类信息用不上就别占版面 —— 需要时直接问模型要。
			//      下面的 rows 仍然构造但不渲染，将来要加「诊断」页再复用。

			// ⑤ 通知
			if (notice) {
				body.push(h("div", { key: "notice", className: "dshm-note", "data-tone": notice.tone },
					h("div", { className: "dshm-note-title" }, h(IconDotState, { state: notice.tone === "bad" ? "error" : notice.tone === "good" ? "done" : "warning" }), notice.title),
					notice.body ? h("div", { className: "dshm-note-body" }, notice.body) : null
				));
			}

			// ⑥ 待重启横幅
			if (restartRequired) {
				body.push(h("div", { key: "restart", className: "dshm-note", "data-tone": "warn" },
					h("div", { className: "dshm-note-title" }, h(IconDotState, { state: "warning" }), "磁盘上已是 v" + onDiskVersion + "，当前进程仍跑 v" + runningVersion),
					h("div", { className: "dshm-note-body" }, "重启后新版本（以及重新应用的补丁）才会生效。"),
					h("div", { className: "dshm-actions", style: { marginTop: 8 } },
						h(Button, { variant: "outline", size: "sm", icon: h(PowerGlyph), onClick: doRestart }, "立即重启")
					)
				));
			}

			var footer = [
				h(Button, { key: "repair", variant: "ghost", size: "sm", icon: h(WrenchGlyph), onClick: doRepair }, "修复插件"),
				h("span", { key: "spacer", className: "dshm-spacer" }),
				h(Button, { key: "close", variant: "ghost", size: "sm", onClick: function () { setOpen(false); } }, "关闭")
			];

			return h(React.Fragment, null,
				h(Button, {
					variant: "ghost",
					size: "sm",
					className: CLASS,
					"data-tone": tones,
					"data-compact": wide ? "false" : "true",
					"data-spin": "false",
					onClick: function () { setOpen(true); },
					title: triggerTitle,
					"aria-label": triggerTitle
				}, [
					StateGlyph(dotState),
					wide ? h("span", { key: "text", className: CLASS + "-text" }, triggerText) : null
				]),
				renderModal({
					open: open,
					onClose: function () { setOpen(false); },
					children: h("div", { className: "dshm-root" }, body),
					footer: footer
				})
			);
		}

		// ─────────────────────────── 渲染助手 ───────────────────────────

		/**
		 * 可折叠分区：默认收起，点标题展开。
		 *
		 * 面板臃肿的根因不是信息多，而是**同时可见**的信息多。
		 * 折叠把「偶尔才看一次」的东西压成一行标题，首屏只留结论。
		 */
		function Fold(props) {
			var state = React.useState(!!props.defaultOpen);
			var open = state[0];
			var setOpen = state[1];
			function toggle() { setOpen(!open); }
			return h("div", { className: "dshm-fold" },
				h("div", {
					className: "dshm-fold-head",
					role: "button",
					tabIndex: 0,
					"aria-expanded": open,
					onClick: toggle,
					onKeyDown: function (event) {
						if (event.key === "Enter" || event.key === " ") {
							event.preventDefault();
							toggle();
						}
					}
				},
					h("span", { className: "dshm-fold-caret", "data-open": open ? "1" : "0" }, "›"),
					h("span", { className: "dshm-fold-title" }, props.title),
					props.meta ? h("span", { className: "dshm-fold-meta" }, props.meta) : null
				),
				open ? h("div", { className: "dshm-fold-body" }, props.children) : null
			);
		}

		/**
		 * 升级进度条：从日志里的 `==> [3/10]` 标记推算当前阶段。
		 *
		 * 只认最后一条 —— 脚本每进一个阶段打印一次，日志是追加写的，
		 * 前面的标记属于历史跑批。
		 */
		function progressBar(logLines, running, job) {
			var step = null;
			for (var i = logLines.length - 1; i >= 0; i -= 1) {
				var hit = /==> \[(\d+)\/(\d+)\]/.exec(String(logLines[i]));
				if (hit) {
					step = { at: Number(hit[1]), of: Number(hit[2]) };
					break;
				}
			}
			if (!step || !step.of) return null;
			var pct = Math.max(0, Math.min(100, Math.round((step.at / step.of) * 100)));
			var tone = running ? undefined : (job && job.exitCode === 0 ? "good" : "bad");
			return h("div", { key: "progressbar" },
				h("div", { className: "dshm-bar-meta" },
					h("span", null, (running ? "进行中 · 第 " : "停在第 ") + step.at + "/" + step.of + " 步"),
					h("span", null, pct + "%")
				),
				h("div", { className: "dshm-bar" },
					h("div", { className: "dshm-bar-fill", "data-tone": tone, style: { width: pct + "%" } })
				)
			);
		}

		/** 一行「键 —— 值」。 */
		function row(key, value) {
			return h("div", { key: key, className: "dshm-row" },
				h("span", { className: "dshm-row-k" }, key),
				h("span", { className: "dshm-row-v" }, value)
			);
		}

		/** Tag，缺失时退回自绘小标签。 */
		function tag(tone, text) {
			if (Tag) return h(Tag, { tone: tone, key: "tag-" + text }, text);
			return h("span", {
				key: "tag-" + text,
				style: { fontSize: 11, opacity: 0.8 }
			}, text);
		}

		/** StateDot，缺失时退回一个彩色圆点；再缺就退回语义图标。 */
		function stateDot(state, size) {
			if (StateDot) return h(StateDot, { state: state, size: size });
			return h(IconDotState, { state: state });
		}

		/** 状态色 → 设计 token。面板里的小圆点与侧栏胶囊的图标共用这一张表。 */
		function dotColor(state) {
			if (state === "done") return "var(--dsw-alias-state-success-primary)";
			if (state === "error") return "var(--dsw-alias-state-error-primary)";
			if (state === "warning") return "var(--dsw-alias-state-warn-primary)";
			if (state === "ongoing") return "var(--dsw-alias-state-idle-primary)";
			return "var(--dsw-alias-label-tertiary)";
		}

		/**
		 * StateDot 的降级替身：纯 SVG 圆点，颜色按语义取 token。
		 * 只在 primitives 缺组件时用得上，但那时它是唯一的视觉信号。
		 */
		function IconDotState(props) {
			var state = (props && props.state) || "idle";
			return h("svg", {
				key: "dot-" + state,
				width: 10, height: 10, viewBox: "0 0 10 10",
				xmlns: "http://www.w3.org/2000/svg", "aria-hidden": "true",
				style: { flex: "none" }
			}, h("circle", { cx: 5, cy: 5, r: 4, fill: dotColor(state) }));
		}

		/**
		 * 侧栏触发器里的状态圆点，**必须**是 16×16 的内联 SVG。
		 *
		 * 不是审美选择，是对齐的硬要求：`dcu-footer-actions` 是 display:block，
		 * 胶囊是同一行里的 inline-flex 盒子，按 vertical-align:baseline 对齐；
		 * 内联盒子的基线取首个 flex 项。内联 SVG 是替换元素，基线 = 下边缘，
		 * 于是 16px 圆点给出的基线与「重启」胶囊的 16px 图标完全一致。
		 * 换成 8px 的 span（如 StateDot）基线会高 4px，整颗胶囊下沉 4px。
		 */
		function StateGlyph(state) {
			return h("svg", {
				key: "state-" + state,
				width: 16, height: 16, viewBox: "0 0 16 16",
				xmlns: "http://www.w3.org/2000/svg", "aria-hidden": "true",
				style: { flex: "none" }
			}, [
				h("circle", { key: "dot", cx: 8, cy: 8, r: 4, fill: dotColor(state) }),
				state === "ongoing"
					? h("circle", { key: "ring", cx: 8, cy: 8, r: 7, fill: "none", stroke: dotColor(state), strokeWidth: 1, opacity: 0.35 })
					: null
			]);
		}

		/**
		 * Modal，缺失时退回自绘遮罩卡片。
		 *
		 * 降级版没有焦点陷阱与 Escape —— 但至少面板能用。primitives 在真实环境里
		 * 一定存在，这条路只是不让「组件改名」变成整块功能消失。
		 */
		function renderModal(spec) {
			if (Modal) {
				return h(Modal, {
					open: spec.open,
					onClose: spec.onClose,
					title: "DSH 维护",
					closeLabel: "关闭",
					description: "本机 DSH 的运行状态、更新检查与升级",
					className: "dshm-modal",
					contentClassName: "dshm-modal-content",
					children: spec.children,
					footer: spec.footer
				});
			}
			if (!spec.open) return null;
			return h("div", {
				style: {
					position: "fixed", inset: 0, zIndex: 1000, display: "flex",
					alignItems: "center", justifyContent: "center",
					background: "var(--dsw-alias-bg-mask-2, rgba(0,0,0,.5))"
				},
				onClick: spec.onClose
			}, h("div", {
				onClick: function (event) { event.stopPropagation(); },
				style: {
					maxWidth: "92vw", maxHeight: "86vh", overflow: "auto", padding: 18,
					borderRadius: 12, background: "var(--dsw-alias-bg-layer-1, #fff)",
					border: "1px solid var(--dsw-alias-border-l2)"
				}
			},
				h("div", { style: { fontSize: 15, fontWeight: 600, marginBottom: 4, color: "var(--dsw-alias-label-primary)" } }, "DSH 维护"),
				spec.children,
				h("div", { className: "dshm-actions", style: { marginTop: 12 } }, spec.footer)
			));
		}

		/**
		 * 挂按钮。必须走 `ctx.slots.inject` 而不是直接 register：非 root 插槽要先由父
		 * 条目声明，抢在声明之前 register 会抛 `slot "…" is not declared`。
		 */
		function apply(ctx) {
			ensureStyles();
			ctx.slots.inject(SLOT, function () {
				return ctx.slots.register({ name: SLOT, id: "maintenance", order: 101 }, MaintenancePanel);
			});
		}

		var inject = ["slots"];

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
