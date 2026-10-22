import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * dsh-plugin-restart —— 把「重启 DSH Web 服务」变成**两个入口、一条实现**：
 *
 *   ① 模型可调用的工具 `restart_server`（本文件）
 *   ② 侧栏底部的一颗按钮（`lib/client.js` + 本文件注册的 `/api/restart-server`）
 *
 * 二者共用同一个 `scheduleRestart()`，所以「按钮」和「让模型重启」在行为上不可能
 * 走偏——包括延迟时长、脱管方式、脚本路径。
 *
 * 为什么这件事非要插件不可：agent 的 bash 工具跑在 Landlock 沙箱里，而
 * Landlock 域**继承且不可放宽**，所以 agent 自己 spawn 出的任何进程都写不了
 * workspace 之外（实测：直接子进程与 setsid 脱离的都被 EACCES 拒绝），
 * 因而无法重新引导服务。本插件跑在**服务进程内部**，不受沙箱约束，是唯一
 * 有能力拉起后继进程的位置。
 *
 * 实际停机/启动逻辑不在这里，而在 ~/dsh-restart.sh —— 插件只负责**延迟触发**，
 * 这样工具结果（或按钮的 HTTP 响应）能先送达客户端，避免「重启把自己的响应吃掉」。
 *
 * @module dsh-plugin-restart
 */

const name = "restart-server";

/**
 * 依赖注入。
 *
 * `connection` 是按钮那条路要用的：`ctx.connection.fetch.register()` 把路由挂在
 * 共享的 `/api` 通道上，而那层通道**自带鉴权栅栏**（`admit()` → 信任检查 + cookie），
 * 所以我们的 handler 不需要自己校验 token。这也是为什么不图省事直接用
 * `ctx.webServer.register()`——那条路是零鉴权，得自己调 `requestRejection()`。
 */
const inject = ["tools", "connection"];

const Config = z.object({
  script: z.string().default(join(homedir(), "dsh-restart.sh")),
  delayMs: z.number().default(5000)
});

/** 按钮打的路由。注意路径**包含** `/api` 前缀：connection 用完整 pathname 匹配 `fetchRoutes`。 */
const RESTART_API_PATH = "/api/restart-server";

/**
 * 本进程的启动时刻。模块在 profile 引导时被求值一次，所以这就是「这个服务进程」
 * 的出生时间。配合 `process.pid` 一起回报，让客户端有一个不靠猜的成功判据。
 */
const STARTED_AT = Date.now();

const DESCRIPTION = [
  "Restart the DSH Web server process. ",
  "The server shuts down gracefully (SIGTERM, full plugin-tree dispose), a detached successor starts with an environment ",
  "re-sourced from ~/.bashrc, and the browser reopens on the new URL. ",
  "Use this after changing anything the running server read at STARTUP — installed files under node_modules, environment ",
  "variables, or the profile's bundle list — because those only take effect in a new process. ",
  "The current session disconnects when the restart fires; the conversation is persisted and continues after reconnect. ",
  "The restart is deliberately delayed a few seconds so this tool's own result reaches the client first."
].join("");

/**
 * Locate an absolute bash. The server inherits PATH from the Termux shell it was
 * launched from, so the bare name would usually work, but a restart must not fail
 * on a PATH that drifted.
 * @returns an absolute path when one exists, else the bare program name.
 */
function resolveBash() {
  const candidates = [];
  if (process.env.PREFIX) candidates.push(join(process.env.PREFIX, "bin", "bash"));
  candidates.push("/bin/bash", "/usr/bin/bash");
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return "bash";
}

/**
 * 排程一次重启：起一个脱管的助手，`sleep` 之后 exec 重启脚本。
 *
 * detached → setsid，新会话；unref → 父进程不必等它；stdio ignore → 不占 fd。
 * 三者合起来才保证：服务进程被 SIGTERM 掉之后，这个助手仍然活着去拉起后继。
 *
 * `sleep` 是刻意放在**助手**里而不是在调用方等：调用方（工具或 HTTP 路由）必须
 * 立刻返回，让响应先送达，否则重启会把自己的响应吃掉。
 *
 * @param config - 已解析的 `{ script, delayMs }`。
 * @returns `{ script, seconds, literal }`，`seconds` 是数字、`literal` 是给 shell 的字面量。
 * @throws 当脚本不存在时——宁可让调用方拿到明确错误，也不要静默地重启失败。
 */
function scheduleRestart(config) {
  const script = config.script;
  if (!existsSync(script)) throw new Error(`restart_server: 重启脚本不存在: ${script}`);

  const seconds = Math.max(0, config.delayMs / 1000);
  const literal = seconds.toFixed(1);

  const child = spawn(resolveBash(), ["-c", `sleep ${literal}; exec "$1"`, "dsh-restart", script], {
    detached: true,
    stdio: "ignore",
    cwd: homedir()
  });
  child.unref();

  return { script, seconds, literal };
}

/**
 * 注册「重启」的两个入口。
 *
 * 每一段都单独 try/catch：本插件是纯增益的，注册失败应当退化成「少一个入口」，
 * 绝不能把 profile 启动或整个 Web 拖下水。
 *
 * @param ctx - registrant context carrying the tool registry and the connection.
 * @param config - resolved plugin configuration.
 */
function apply(ctx, config) {
  const resolved = {
    script: config?.script ?? join(homedir(), "dsh-restart.sh"),
    delayMs: Number.isFinite(config?.delayMs) ? config.delayMs : 5000
  };
  const literal = Math.max(0, resolved.delayMs / 1000).toFixed(1);

  // ① 模型入口：restart_server 工具。
  try {
    ctx.tools.register(defineTool({
      name: "restart_server",
      description: DESCRIPTION,
      parameters: {
        reason: {
          type: "string",
          description: "Short note on why the restart is needed; recorded in the transcript."
        }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            scheduledInSeconds: { type: "number", required: true },
            script: { type: "string", required: true },
            note: { type: "string", required: true }
          }
        },
        render: (_args, value) => [{ type: "text", text: value.note }]
      },
      execute() {
        const { script, seconds, literal: delay } = scheduleRestart(resolved);
        return Promise.resolve({
          scheduledInSeconds: Number(delay),
          script,
          note: `DSH Web 将在约 ${seconds.toFixed(1)}s 后重启（会话会短暂断开，浏览器会自动重开）。触发脚本: ${script}`
        });
      },
      presentCall: (args) => ({
        card: "generic",
        title: "重启 DSH Web",
        kind: "other",
        rawInput: args
      })
    }));

    // 成功路径也要留痕：本插件唯一的可见症状就是「工具列表里多了一项」，
    // 没有日志时「压根没加载」和「加载正常」在日志里长得一模一样，
    // 事后无从区分——验证只能靠盲猜工具存不存在。
    process.stderr.write(`[dsh-plugin-restart] restart_server 已注册（脚本 ${resolved.script}，延迟 ${literal}s）\n`);
  } catch (error) {
    process.stderr.write(`[dsh-plugin-restart] restart_server 注册失败: ${error?.message ?? error}\n`);
  }

  // ② 界面入口：给侧栏那颗按钮提供一条路由。
  //
  // POST = 触发重启；GET = 报「当前服务是哪个进程」。
  //
  // GET 看着多余，其实是**结论的唯一可靠来源**。按钮过去靠「页面是否被掐断」猜
  // 结果，而旧进程优雅退出最长 5s、新进程还要冷启动，浏览器那条 keep-alive 连接
  // 未必在窗口内断掉 —— 于是重启明明成功，界面却报失败。改成报 pid 之后，
  // 客户端只需比较「点之前的 pid」与「现在的 pid」，变了才算成功。
  // POST 的响应里带回 pid，正是为了让客户端拿到这个基线。
  try {
    ctx.effect(
      () => ctx.connection.fetch.register({
        path: RESTART_API_PATH,
        methods: ["GET", "POST"],
        requestBody: "buffered",
        fetch: (request) => {
          if (request.method === "GET") {
            return Promise.resolve(Response.json({
              ok: true,
              pid: process.pid,
              startedAt: STARTED_AT
            }));
          }
          try {
            const { script, seconds, literal: delay } = scheduleRestart(resolved);
            return Promise.resolve(Response.json({
              ok: true,
              // 这是**当前**（即将退场的）进程号，客户端拿它当基线。
              pid: process.pid,
              scheduledInSeconds: Number(delay),
              script,
              note: `DSH Web 将在约 ${seconds.toFixed(1)}s 后重启（页面会短暂断开，浏览器会自动重开）。`
            }));
          } catch (error) {
            return Promise.resolve(Response.json(
              { ok: false, error: String(error?.message ?? error) },
              { status: 500 }
            ));
          }
        }
      }),
      "dsh-plugin-restart: /api/restart-server"
    );
    process.stderr.write(`[dsh-plugin-restart] 按钮接口已注册（GET/POST ${RESTART_API_PATH}）\n`);
  } catch (error) {
    process.stderr.write(`[dsh-plugin-restart] 按钮接口注册失败: ${error?.message ?? error}\n`);
  }
}

export { Config, apply, inject, name };
