/**
 * dsh-plugin-restart 的浏览器端：在侧栏底部放一颗「重启」按钮。
 *
 * 这是一个**手写的客户端 bundle**，不是构建产物。DSH Web 的客户端插件是浏览器
 * 运行时按需加载的同源经典脚本（`<script src="/plugins/...">`），所以完全不需要
 * pnpm / vite / tsdown —— 在 Termux 上这一点是决定性的，那套构建链在这里装不起来。
 * 代价是不能用 JSX，只能用 `React.createElement`。
 *
 * 形态契约（与 @michengai/dsh-codex-ui、@deepseek-ai/dsh-client-connection 等一致）：
 *   - 入口固定为 `window.__ModuleLoader__.load({ id, factory })`，`id` 必须是包名；
 *   - `factory(require)` 返回 `module.exports`；
 *   - 导出具名 `apply` / `inject`，**没有 default**；
 *   - 这里的 `inject` 是 **cordis 服务名**（`slots`），与 package.json 里
 *     `dsh.client.inject` 的**包名数组**是两回事，别混。
 *
 * 可以裸 require 的「基座种子词」：react / react/jsx-runtime / react-dom /
 * @deepseek-ai/cordis / dsh-client-store / dsh-client-ui-slots /
 * dsh-client-ui-primitives / dsh-client-ui-dockkit。
 *
 * ── 每一次改版都是因为「它说了谎」 ─────────────────────────────────────────
 *
 * v1：点完显示一个 ✓。坏信号 —— ✓ 在所有人的直觉里都等于「做完了」，可服务其实
 *     还没重启、页面马上要断。
 *
 * v2：换成倒计时 5→4→3→2→1，归零后转圈，**8 秒内没被掐断就判失败**。
 *     那套判据在真机上是错的：用户点了一次，重启**成功**了（pid 从 19920 变成
 *     21245），界面却亮起了红色感叹号。原因是「页面被掐断」根本不是可靠信号 ——
 *     旧进程优雅退出（最长 5s）+ 新进程启动（+0.5~1s），浏览器还握着那条 keep-alive
 *     连接，8 秒到了页面照样活着。**把「我没观察到 A」当成「A 没发生」，是逻辑错误。**
 *
 * v3（当前）：
 *   - **文字**：每个相位都带一句中文（「重启中」「已重启」「重启失败」），
 *     侧栏展开时显示；收起成窄条时只剩图标（沿用侧栏自己对 `wide` 的处理）。
 *     手机上既没有 hover 也没有 tooltip，只靠图标和数字就是在让人猜。
 *   - **结论不再靠猜**：POST 会返回**旧进程的 pid**，之后轮询 GET 读**当前 pid**，
 *     pid 变了才算重启成功。服务在重启过程中连不上是**预期**（正是它该死的时候），
 *     不判失败；60 秒都没等到新 pid 才报失败。这样「✓/已重启」才是一个真的结论。
 *
 * ── 图标为什么是内联 SVG ─────────────────────────────────────────────────
 * 路径数据是从 `dsh-client-ui-primitives` 的 `IconRefreshOutlineArtwork` /
 * `IconCheckOutlineArtwork` / `IconWarningOutlineArtwork` 里原样抄来的，所以画出来和
 * 原生图标**逐字节一致**，而又不必多 require 一个模块。描边用 `currentColor`，
 * 因此仍跟随主题色变量。
 */

window.__ModuleLoader__.load({
	id: "dsh-plugin-restart",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/** 侧栏底部动作区：kind=list / scope=root，只需提供一个 id。 */
		var SLOT = "sidebar.footer.action";
		/** 服务端插件注册的同一条路由；路径含 /api 前缀。POST 触发，GET 报 pid。 */
		var API_PATH = "/api/restart-server";

		/** 挂在按钮上的类名；下方 STYLE 里用 `button.` 前缀提高优先级去压过 primitives。 */
		var CLASS = "dsh-restart-btn";
		var STYLE_ID = "dsh-plugin-restart-style";

		/** 轮询间隔。 */
		var POLL_INTERVAL_MS = 1000;
		/** 单次 GET 最多等这么久；超时就当「连不上」，即服务正在死或正在起。 */
		var POLL_TIMEOUT_MS = 2000;
		/** 最多等这么久还没看到新 pid，才判失败。给足优雅退出 + 冷启动的时间。 */
		var POLL_WINDOW_MS = 60000;
		/** 服务端没告诉我们秒数时的兜底倒计时。 */
		var FALLBACK_SECONDS = 5;
		/** 确认重启成功后，「已重启」停留多久再变回「重启」。 */
		var RESET_DONE_MS = 4000;
		/** 判定失败后，「重启失败」停留多久再变回「重启」。比成功留得久一些。 */
		var RESET_ERROR_MS = 10000;

		// react 的种子值可能是模块命名空间（带 default），也可能是 React 本体，两种都兜住。
		var reactNamespace = require("react");
		var React = (reactNamespace && reactNamespace.default) || reactNamespace;
		var h = React.createElement;

		// 基座 UI 组件（自研 primitives，不是 antd）。拿不到就退化成一个原生 button，
		// 这样按钮最坏情况下仍然可点，而不是让整个插槽渲染炸掉。
		var primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		var Button = (primitives && primitives.Button) ||
			(primitives && primitives.default && primitives.default.Button) ||
			"button";

		/**
		 * 图标外壳：16×16 的 viewBox，1px 描边，颜色继承按钮的 color。
		 * 结构与 primitives 的图标完全一致，只是把 jsx 换成 h。
		 *
		 * @param children - 单个 path 或 path 数组。
		 */
		function glyph(children) {
			return h("svg", {
				width: 16,
				height: 16,
				viewBox: "0 0 16 16",
				fill: "none",
				xmlns: "http://www.w3.org/2000/svg",
				strokeWidth: 1,
				"aria-hidden": "true"
			}, children);
		}

		/** 环形箭头 —— 与 primitives 的 IconRefreshOutline 同源。 */
		function RefreshGlyph() {
			return glyph([
				h("path", {
					key: "arc",
					d: "M14.5001 8C14.5 9.28552 14.1188 10.5422 13.4045 11.611C12.6903 12.6799 11.6752 13.5129 10.4875 14.0049C9.29982 14.4968 7.99295 14.6255 6.73212 14.3747C5.4713 14.124 4.31314 13.505 3.4041 12.596C2.49514 11.687 1.87614 10.5288 1.62537 9.26798C1.37459 8.00716 1.50331 6.70028 1.99525 5.51261C2.48719 4.32494 3.32025 3.30981 4.3891 2.59557C5.45795 1.88134 6.71458 1.50008 8.0001 1.5C9.9001 1.5 11.7001 2.3 13.0001 3.6L14.5001 5.1",
					stroke: "currentColor"
				}),
				h("path", {
					key: "head",
					d: "M14.4999 1.5V5.1H10.8999",
					stroke: "currentColor"
				})
			]);
		}

		/** 对勾 —— 与 primitives 的 IconCheckOutline 同源。只在「确认已重启」后用。 */
		function CheckGlyph() {
			return glyph(h("path", {
				key: "tick",
				d: "M13.5 4L6 11.5L2.5 8",
				stroke: "currentColor",
				strokeLinecap: "round",
				strokeLinejoin: "round"
			}));
		}

		/** 感叹号圆环 —— 与 primitives 的 IconWarningOutline 同源，用于失败。 */
		function WarningGlyph() {
			return glyph([
				h("path", {
					key: "ring",
					d: "M8 14.5C11.5899 14.5 14.5 11.5899 14.5 8C14.5 4.41015 11.5899 1.5 8 1.5C4.41015 1.5 1.5 4.41015 1.5 8C1.5 11.5899 4.41015 14.5 8 14.5Z",
					stroke: "currentColor"
				}),
				h("path", {
					key: "stem",
					d: "M8 4.29199V9.79199",
					stroke: "currentColor"
				}),
				h("path", {
					key: "dot",
					d: "M8 12.3V12.2",
					stroke: "currentColor",
					strokeLinecap: "round"
				})
			]);
		}

		/**
		 * 六个相位。每个都自带一句中文 —— 图标和数字只是辅助，话得说清楚。
		 *
		 * `text` 是窄条（侧栏收起）之外的可见文案；`Glyph` 缺省即环形箭头；
		 * `num: true` 表示图标位改显示倒计时数字；`spin` 单独抽出来绑 `data-spin`，
		 * 因为转圈出现在两个相位里，绑相位容易写漏。
		 */
		var PHASES = {
			idle: { Glyph: RefreshGlyph, text: "重启", hint: "重启 DSH Web" },
			busy: { Glyph: RefreshGlyph, text: "请求中", spin: true, hint: "正在请求重启…" },
			countdown: { num: true, text: "秒后重启", hint: "即将重启，页面稍后会断开" },
			waiting: { Glyph: RefreshGlyph, text: "重启中", spin: true, hint: "正在重启，等新进程起来…" },
			done: { Glyph: CheckGlyph, text: "已重启", hint: "重启完成（已确认进程号变了）" },
			error: { Glyph: WarningGlyph, text: "重启失败", hint: "等不到新进程，重启可能没发生" }
		};

		/**
		 * 注入样式。客户端插件只能带一个 .js，没有配套 css 的加载机制，所以自己塞
		 * 一个 <style>。选择器都写成 `button.dsh-restart-btn`（0,1,1）以便稳定压过
		 * primitives 里 `.button` / `.sm` 那些单类规则（0,1,0）—— 不依赖插入顺序。
		 *
		 * 尺寸沿用侧栏自己的图标按钮惯例：高 28、次级文字色、hover 出底色。
		 * 展开时是一枚带文字的胶囊；收起（`data-compact`）时收成 28×28 的圆，
		 * 与侧栏折叠态的处理一致 —— 侧栏自己也是靠 `wide` 决定要不要渲染文字。
		 */
		var STYLE = [
			"button.dsh-restart-btn{display:inline-flex;align-items:center;justify-content:center;",
			"gap:6px;height:28px;min-width:28px;max-width:100%;flex:none;padding:0 10px;",
			"border-radius:14px;font-family:inherit;font-size:12px;line-height:18px;",
			"white-space:nowrap;color:var(--dsw-alias-label-secondary);}",
			'button.dsh-restart-btn[data-compact="true"]{width:28px;padding:0;border-radius:50%;}',
			"button.dsh-restart-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary);",
			"background:var(--dsw-alias-interactive-bg-hover);}",
			// 非 idle 相位都是 disabled；默认的 0.4 透明度会把文字洗淡，这里保留实色。
			"button.dsh-restart-btn:disabled{opacity:1;cursor:default;}",
			// 倒计时用主文字色：它是此刻唯一在动的信息，不该比图标还淡。
			'button.dsh-restart-btn[data-phase="countdown"]{color:var(--dsw-alias-label-primary);}',
			'button.dsh-restart-btn[data-phase="done"]{color:var(--dsw-alias-state-success-primary);}',
			'button.dsh-restart-btn[data-phase="error"]{color:var(--dsw-alias-state-error-primary);}',
			'button.dsh-restart-btn[data-spin="true"] .dsh-restart-btn-glyph{',
			"animation:dsh-restart-spin .9s linear infinite;}",
			".dsh-restart-btn-glyph{display:inline-flex;align-items:center;justify-content:center;flex:none;}",
			".dsh-restart-btn-text{overflow:hidden;text-overflow:ellipsis;}",
			// 等宽数字，否则 1 比 5 窄，倒计时会左右跳。
			".dsh-restart-btn-count{font-size:12px;font-weight:500;line-height:1;",
			"font-variant-numeric:tabular-nums;}",
			"@keyframes dsh-restart-spin{to{transform:rotate(360deg);}}",
			"@media (prefers-reduced-motion:reduce){",
			'button.dsh-restart-btn[data-spin="true"] .dsh-restart-btn-glyph{animation:none;}}'
		].join("");

		/** 幂等注入；在 SSR / 无 document 的环境下静默跳过。 */
		function ensureStyles() {
			if (typeof document === "undefined" || !document.head) return;
			if (document.getElementById(STYLE_ID)) return;
			var el = document.createElement("style");
			el.id = STYLE_ID;
			el.textContent = STYLE;
			document.head.appendChild(el);
		}

		/**
		 * 按钮本体。侧栏渲染时会传入 `{ wide }`，用它决定要不要显示文字：
		 * 侧栏展开时有整行宽度，收起时只有一个 36px 的竖条，塞不下字。
		 */
		function RestartAction(props) {
			var wide = !!(props && props.wide);

			var state = React.useState("idle");
			var phase = state[0];
			var setPhase = state[1];

			var count = React.useState(0);
			var remaining = count[0];
			var setRemaining = count[1];

			// 点下那一刻旧进程的 pid。只有看到 pid 变了，才算真的重启了。
			var base = React.useState(null);
			var baselinePid = base[0];
			var setBaselinePid = base[1];

			// 倒计时：每秒 -1，归零后转入 waiting。
			React.useEffect(function () {
				if (phase !== "countdown") return undefined;
				var left = remaining;
				var tick = setInterval(function () {
					left -= 1;
					if (left > 0) {
						setRemaining(left);
						return;
					}
					clearInterval(tick);
					setRemaining(0);
					setPhase("waiting");
				}, 1000);
				return function () { clearInterval(tick); };
			}, [phase]);

			// 轮询当前 pid，与 baseline 比对。
			//
			// 关键：**请求失败不算失败**。服务正在死的这半秒、正在起的这一秒，连不上
			// 是预期行为；把它当成错误，就又回到「把没观察到当成没发生」的老毛病。
			// 只有「整整一个窗口过去，服务还活着且 pid 没变」才是真的失败。
			React.useEffect(function () {
				if (phase !== "waiting") return undefined;
				var stopped = false;

				var poll = function () {
					if (stopped) return;
					var ctl = typeof AbortController === "function" ? new AbortController() : null;
					var guard = setTimeout(function () { if (ctl) ctl.abort(); }, POLL_TIMEOUT_MS);
					fetch(API_PATH, { method: "GET", signal: ctl ? ctl.signal : undefined })
						.then(function (response) { return response.ok ? response.json() : null; })
						.then(function (data) {
							if (stopped) return;
							if (data && data.ok && data.pid !== baselinePid) setPhase("done");
						})
						.catch(function () {
							// 连不上 = 旧进程已走或新进程还没起来，继续等。
						})
						.then(function () { clearTimeout(guard); });
				};

				var iv = setInterval(poll, POLL_INTERVAL_MS);
				poll();
				var giveUp = setTimeout(function () { if (!stopped) setPhase("error"); }, POLL_WINDOW_MS);
				return function () {
					stopped = true;
					clearInterval(iv);
					clearTimeout(giveUp);
				};
			}, [phase, baselinePid]);

			// 「已重启」和「重启失败」都是**通知**，不是常驻状态 —— 停一会儿就回到
			// 「重启」。否则按钮会永远顶着上一次的结论：重启明明已经成功，侧栏底部却
			// 一直挂着一个「已重启」，既没意义，也让人以为卡住了。
			//
			// 失败留得比成功久（RESET_ERROR_MS > RESET_DONE_MS）：成功是给人一颗定心丸，
			// 瞥一眼就够；失败得让人来得及看清发生了什么。
			React.useEffect(function () {
				if (phase !== "done" && phase !== "error") return undefined;
				var delay = phase === "done" ? RESET_DONE_MS : RESET_ERROR_MS;
				var timer = setTimeout(function () {
					setPhase("idle");
					setRemaining(FALLBACK_SECONDS);
					setBaselinePid(null);
				}, delay);
				return function () { clearTimeout(timer); };
			}, [phase]);

			var onClick = React.useCallback(function () {
				if (phase !== "idle" && phase !== "done" && phase !== "error") return;
				setPhase("busy");
				setBaselinePid(null);
				fetch(API_PATH, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: "{}"
				}).then(function (response) {
					if (!response.ok) {
						setPhase("error");
						return;
					}
					return response.json().then(function (data) {
						setBaselinePid(data && typeof data.pid === "number" ? data.pid : null);
						var seconds = Math.ceil(Number(data && data.scheduledInSeconds));
						if (!Number.isFinite(seconds) || seconds <= 0) seconds = FALLBACK_SECONDS;
						setRemaining(seconds);
						setPhase("countdown");
					}, function () {
						// 响应不可解析，但状态码是 ok —— 重启确实排上了，只是没法倒数。
						setPhase("waiting");
					});
				}).catch(function () {
					// 服务在响应途中被 SIGTERM 掉，这次 fetch 就会失败——那恰恰是
					// 成功的样子。把它判成 error 会骗用户再点一次。
					setPhase("waiting");
				});
			}, [phase]);

			var current = PHASES[phase] || PHASES.idle;
			var glyphNode = current.num
				? h("span", { className: "dsh-restart-btn-count" }, String(remaining))
				: h("span", { className: "dsh-restart-btn-glyph" }, h(current.Glyph));

			var body = [glyphNode];
			if (wide) {
				body.push(h("span", { key: "text", className: "dsh-restart-btn-text" }, current.text));
			}

			return h(Button, {
				variant: "ghost",
				size: "sm",
				className: CLASS,
				"data-phase": phase,
				"data-spin": current.spin === true ? "true" : "false",
				"data-compact": wide ? "false" : "true",
				onClick: onClick,
				disabled: phase === "busy" || phase === "countdown" || phase === "waiting",
				title: current.hint,
				"aria-label": current.hint
			}, body);
		}

		/**
		 * 挂按钮。
		 *
		 * 必须走 `ctx.slots.inject(key, cb)` 而不是直接 `register`：任何非 root 的插槽
		 * 都要先由父条目声明，抢在声明之前 register 会抛 `slot "…" is not declared`。
		 * `inject` 会等声明出现再执行回调，并用 ctx.effect 托管其生命周期——回调返回
		 * 的 disposer 就是卸载路径。
		 *
		 * @param ctx - 客户端 cordis 上下文。
		 */
		function apply(ctx) {
			ensureStyles();
			ctx.slots.inject(SLOT, function () {
				return ctx.slots.register({ name: SLOT, id: "restart", order: 100 }, RestartAction);
			});
		}

		var inject = ["slots"];

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
