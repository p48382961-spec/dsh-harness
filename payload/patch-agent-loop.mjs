#!/usr/bin/env node
/**
 * 给载荷里的 dsh-agent-loop 打「调度器缺失」防御补丁（与 Termux 侧 dsh-android-patch.mjs 的
 * `AL scheduler diagnostics` 规则一致，只是直接作用在载荷上）。
 *
 * 为什么要它：`ctx.tools[TOOL_RUNTIME_SCHEDULER]` 为 undefined 时，原代码会抛一行空洞的
 * `TypeError: Cannot read properties of undefined (reading 'prepare')` —— 此时工具调用已经被
 * 记录进日志、结果还没写，会话尾部只能被「修」成一条 "interrupted … no result durably recorded"，
 * 用户看到的就是「工具调用错误、没法继续」。补丁把现场写进 ~/试玩/dsh-run-errors.log 并改抛人话。
 *
 * 用法：node patch-agent-loop.mjs <载荷根目录>     （幂等：打过就跳过）
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
if (!root) {
  console.error("用法：node patch-agent-loop.mjs <载荷根目录>");
  process.exit(2);
}

const file = join(
  root,
  "usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js"
);
if (!existsSync(file)) {
  console.error(`找不到 ${file}`);
  process.exit(1);
}

let source = readFileSync(file, "utf8");
if (source.includes("reportSchedulerMissing")) {
  console.log("  agent-loop：已经有调度器防御补丁，跳过");
  process.exit(0);
}

const edits = [
  {
    label: "helper + guard",
    old: "async function runGroup(ctx, turn, step, group, mode, signal, acceptContext) {\n\tconst { session } = ctx.agents.requireInitiator();\n",
    neu: '/* dsh-android: scheduler diagnostics */\nfunction reportSchedulerMissing(ctx) {\n\tconst line = `[${(/* @__PURE__ */ new Date()).toISOString()}] 工具调度器未注册 symbol=${String(TOOL_RUNTIME_SCHEDULER)} toolsKeys=${Object.keys(ctx.tools ?? {}).join(",")} home=${process.env.DSH_HOME ?? ""}\\n`;\n\ttry {\n\t\tconst fs = process.getBuiltinModule("node:fs");\n\t\tconst os = process.getBuiltinModule("node:os");\n\t\tfs.appendFileSync(`${os.homedir()}/试玩/dsh-run-errors.log`, line);\n\t} catch {}\n\tprocess.stderr.write(`[dsh-agent-loop] ${line}`);\n}\nasync function runGroup(ctx, turn, step, group, mode, signal, acceptContext) {\n\tconst { session } = ctx.agents.requireInitiator();\n\tconst scheduler = ctx.tools?.[TOOL_RUNTIME_SCHEDULER];\n\tif (scheduler === void 0 || typeof scheduler.prepare !== "function") {\n\t\treportSchedulerMissing(ctx);\n\t\tthrow new Error("工具调度器未注册（@deepseek-ai/dsh-tools.scheduler 缺失）：运行时状态异常，重启 DSH 后重试；现场已记入 ~/试玩/dsh-run-errors.log");\n\t}\n',
  },
  {
    label: "finalize/finish",
    old: "const result = slot.needsPost ? await ctx.tools[TOOL_RUNTIME_SCHEDULER].finalize(slot.exec, slot.result) : ctx.tools[TOOL_RUNTIME_SCHEDULER].finish(slot.exec, slot.result);",
    neu: "const result = slot.needsPost ? await scheduler.finalize(slot.exec, slot.result) : scheduler.finish(slot.exec, slot.result);",
  },
  {
    label: "prepare",
    old: "const prepared = await ctx.tools[TOOL_RUNTIME_SCHEDULER].prepare(call.exec);",
    neu: "const prepared = await scheduler.prepare(call.exec);",
  },
  {
    label: "dispatch",
    old: "const promise = ctx.tools[TOOL_RUNTIME_SCHEDULER].dispatch(prepared.exec).then((outcome) => {",
    neu: "const promise = scheduler.dispatch(prepared.exec).then((outcome) => {",
  },
];

let failed = 0;
for (const edit of edits) {
  if (!source.includes(edit.old)) {
    console.error(`  ✗ ${edit.label}：锚点没找到`);
    failed += 1;
    continue;
  }
  source = source.replace(edit.old, edit.neu);
}
if (failed) {
  console.error(`  agent-loop：${failed} 处失败，未写入`);
  process.exit(1);
}
writeFileSync(file, source);
console.log("  agent-loop：调度器防御补丁已打（4 处）");
