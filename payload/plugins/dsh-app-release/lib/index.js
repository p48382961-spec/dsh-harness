import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { existsSync, readFileSync, openSync, writeFileSync, statSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/**
 * dsh-app-release —— 这个 App 的两个「版本」都由它管：
 *
 *   1. **外壳**（这个 APK）：版本看 `files/app-version.txt`（Java 侧启动时写的），
 *      新版本在 GitHub Releases 上，安装包是 APK。
 *   2. **引擎**（DSH 本体 `@deepseek-ai/dsh`）：版本看载荷里的
 *      `files/usr/lib/node_modules/@deepseek-ai/dsh/package.json`，新版本在 npm registry 上，
 *      升级方式是跑 `~/试玩/dsh-update.sh <版本>`（备份 → npm install -g 到载荷 prefix →
 *      重新打我们的载荷补丁 → 重启引擎）。
 *
 * 两者是不同的东西、不同的版本号、不同的分发渠道，用户看到的却是同一句话「有没有新版本」——
 * 所以放在同一个面板、同一个插件里，一起检查、分别升级。
 *
 * @module dsh-app-release
 */

const name = "dsh-app-release";
const inject = ["tools", "connection"];
const API_PREFIX = "/api/dsh-app-release";
const DSH_PACKAGE = "@deepseek-ai/dsh";
const NPM_LATEST = `https://registry.npmjs.org/${DSH_PACKAGE}/latest`;

const Config = z.object({
  /** GitHub 仓库（owner/repo），外壳 APK 的发布地。 */
  repo: z.string().default("p48382961-spec/dsh-harness"),
  /** 网络超时（毫秒）。 */
  timeoutMs: z.number().default(15000)
});

/** App 私有根目录（`files/`）：homedir 是 `files/home`。 */
function filesRoot() {
  return dirname(homedir());
}

function readTrimmed(file) {
  try {
    return readFileSync(file, "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** 本地版本：外壳版本、载荷标记、引擎（DSH 本体）版本。 */
function localInfo() {
  const root = filesRoot();
  const dshPkg = join(root, "usr", "lib", "node_modules", "@deepseek-ai", "dsh", "package.json");
  let engine = null;
  try {
    engine = JSON.parse(readFileSync(dshPkg, "utf8")).version ?? null;
  } catch {
    engine = null;
  }
  return {
    app: readTrimmed(join(root, "app-version.txt")),
    payload: readTrimmed(join(root, ".rootfs-installed")),
    engine
  };
}

function parseVersion(value) {
  const m = String(value ?? "").match(/(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!m) return null;
  return { nums: m.slice(1, 4).map(Number), pre: m[4] ?? null };
}

/** semver 粗比：数字段 + 预发布（有预发布 < 无预发布）。返回 >0 表示 a 更新。 */
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (x.nums[i] !== y.nums[i]) return x.nums[i] - y.nums[i];
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre > y.pre ? 1 : -1;
}

const bare = (value) => String(value ?? "").replace(/\s*\(.*$/, "").replace(/^v/, "");

/** 外壳：GitHub Releases。 */
async function checkApp(config) {
  const response = await fetch(`https://api.github.com/repos/${config.repo}/releases?per_page=20`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "dsh-harness-android" },
    signal: AbortSignal.timeout(config.timeoutMs)
  });
  if (!response.ok) throw new Error(`GitHub 返回 ${response.status}`);
  const releases = await response.json();
  const usable = releases
    .filter((r) => !r.draft && Array.isArray(r.assets))
    .map((r) => ({
      tag: bare(r.tag_name),
      pageUrl: r.html_url,
      title: r.name ?? "",
      publishedAt: r.published_at,
      prerelease: Boolean(r.prerelease),
      notes: String(r.body ?? "").slice(0, 2000),
      assets: r.assets.map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size }))
    }))
    .filter((r) => parseVersion(r.tag))
    .sort((a, b) => compareVersions(b.tag, a.tag));
  if (!usable.length) throw new Error("没有找到任何带版本的 release");
  const latest = usable[0];
  return {
    latest,
    apk: latest.assets.find((a) => a.name.endsWith(".apk")) ?? null,
    sum: latest.assets.find((a) => a.name.endsWith(".apk.sha256")) ?? null
  };
}

/** 引擎：npm registry 的 latest 标签。 */
async function checkEngine(config) {
  const response = await fetch(NPM_LATEST, {
    headers: { accept: "application/json", "user-agent": "dsh-harness-android" },
    signal: AbortSignal.timeout(config.timeoutMs)
  });
  if (!response.ok) throw new Error(`npm registry 返回 ${response.status}`);
  const meta = await response.json();
  return {
    latest: meta.version ?? null,
    publishedAt: meta.time ?? null,
    pageUrl: `https://www.npmjs.com/package/${DSH_PACKAGE}`
  };
}

function updatingFlag() {
  return join(homedir(), "试玩", ".dsh-updating");
}

/** 15 分钟还没结束的标记视为残留（脚本被强杀、崩溃之类），顺手清掉，别把更新永久锁死。 */
const UPDATING_TTL_MS = 15 * 60 * 1000;

function updatingNow() {
  const flag = updatingFlag();
  try {
    const mtime = statSync(flag).mtimeMs;
    if (Date.now() - mtime > UPDATING_TTL_MS) {
      try {
        unlinkSync(flag);
      } catch {
        /* 删不掉就当作没在更新 */
      }
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function buildStatus(config, { network }) {
  const local = localInfo();
  const appCurrent = bare(local.app) || null;

  const app = {
    current: appCurrent,
    raw: local.app,
    payload: local.payload,
    latest: null,
    updateAvailable: false,
    checked: false,
    error: null
  };
  const engine = {
    current: local.engine,
    latest: null,
    updateAvailable: false,
    checked: false,
    error: null,
    updating: updatingNow(),
    log: join(homedir(), "试玩", "dsh-update.log")
  };

  if (!network) {
    return { ok: true, checked: false, app, engine };
  }

  const [appResult, engineResult] = await Promise.allSettled([checkApp(config), checkEngine(config)]);

  if (appResult.status === "fulfilled") {
    const { latest, apk, sum } = appResult.value;
    Object.assign(app, {
      checked: true,
      latest: latest.tag,
      updateAvailable: Boolean(appCurrent) && compareVersions(latest.tag, appCurrent) > 0,
      prerelease: latest.prerelease,
      publishedAt: latest.publishedAt,
      pageUrl: latest.pageUrl,
      notes: latest.notes,
      apkUrl: apk?.url ?? null,
      apkSize: apk?.size ?? null,
      sha256Url: sum?.url ?? null
    });
  } else {
    app.checked = true;
    app.error = String(appResult.reason?.message ?? appResult.reason);
  }

  if (engineResult.status === "fulfilled") {
    const { latest, pageUrl } = engineResult.value;
    Object.assign(engine, {
      checked: true,
      latest,
      updateAvailable: Boolean(local.engine && latest) && compareVersions(latest, local.engine) > 0,
      pageUrl
    });
  } else {
    engine.checked = true;
    engine.error = String(engineResult.reason?.message ?? engineResult.reason);
  }

  return { ok: true, checked: true, app, engine };
}

function mb(bytes) {
  return bytes ? `${(bytes / 1048576).toFixed(1)} MB` : "大小未知";
}

function summarizeApp(app) {
  if (!app.current) {
    return "读不到外壳版本（files/app-version.txt 不存在）—— 这不是 App 里跑的？";
  }
  if (!app.checked) return `当前外壳 ${app.current}`;
  if (app.error) return `外壳检查失败：${app.error}`;
  if (!app.updateAvailable) return `外壳已是最新：${app.current}（远端 v${app.latest}）`;
  return [
    `外壳有新版本 v${app.latest}（当前 ${app.current}，${app.prerelease ? "预发布" : "正式"}）`,
    `APK：${app.apkUrl ?? "该 release 没有 APK 资产"}（${mb(app.apkSize)}）`,
    app.sha256Url ? `校验：${app.sha256Url}` : "",
    `发布页：${app.pageUrl}`
  ].filter(Boolean).join("\n");
}

function summarizeEngine(engine) {
  if (!engine.current) return "读不到引擎版本（载荷里没有 @deepseek-ai/dsh/package.json）";
  if (engine.updating) return `引擎 ${engine.current} 正在更新中…`;
  if (!engine.checked) return `引擎（DSH 本体）${engine.current}`;
  if (engine.error) return `引擎检查失败：${engine.error}`;
  if (!engine.updateAvailable) return `引擎已是最新：${engine.current}（npm latest ${engine.latest}）`;
  return `引擎有新版本 ${engine.latest}（当前 ${engine.current}）—— 可一键更新，完成后引擎自动重启`;
}

/** 触发 `~/试玩/dsh-update.sh <版本>`：备份 → npm install -g → 重打补丁 → 重启引擎。 */
function startEngineUpdate(config, version) {
  const target = String(version ?? "").trim();
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(target)) {
    throw new Error(`版本号不合法：${target}`);
  }
  const script = join(homedir(), "试玩", "dsh-update.sh");
  if (!existsSync(script)) {
    throw new Error(`找不到升级脚本 ${script}`);
  }
  if (updatingNow()) {
    throw new Error("已经有一次引擎更新在进行中");
  }
  const local = localInfo();
  if (local.engine && bare(local.engine) === bare(target)) {
    throw new Error(`引擎已经是 ${target}，无需更新`);
  }
  const logPath = join(homedir(), "试玩", "dsh-update.log");
  const fd = openSync(logPath, "a");
  const bash = join(filesRoot(), "usr", "bin", "bash");
  const shell = existsSync(bash) ? bash : "bash";
  try {
    writeFileSync(updatingFlag(), `${new Date().toISOString()} → ${target}\n`);
  } catch {
    /* 标记文件写不进去不影响更新本身 */
  }
  const child = spawn(shell, [script, target], {
    detached: true,
    stdio: ["ignore", fd, fd],
    env: { ...process.env, HOME: homedir(), TMPDIR: join(homedir(), "tmp") },
    cwd: homedir()
  });
  child.unref();
  return { target, script, logPath, pid: child.pid ?? null };
}

function versionTool(config) {
  return defineTool({
    name: "app_version",
    description: "Report this Android app's own shell version, the runtime payload marker, and the bundled DSH engine version. Read-only, no network.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          current: { type: "string" },
          payload: { type: "string" },
          engine: { type: "string" },
          note: { type: "string", required: true }
        }
      },
      render: (_args, value) => [{ type: "text", text: value.note }]
    },
    async execute() {
      const status = await buildStatus(config, { network: false });
      return {
        current: status.app.current,
        payload: status.app.payload,
        engine: status.engine.current,
        note: [
          summarizeApp(status.app),
          summarizeEngine(status.engine),
          status.app.payload ? `载荷 ${status.app.payload}` : ""
        ].filter(Boolean).join("\n")
      };
    },
    presentCall: () => ({ card: "generic", title: "查看版本", kind: "other" })
  });
}

function checkTool(config) {
  return defineTool({
    name: "app_check_update",
    description: "Check for updates of both the app shell (GitHub Releases, APK) and the bundled DSH engine (@deepseek-ai/dsh on npm). Read-only; does not download or install anything.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          appUpdateAvailable: { type: "boolean", required: true },
          engineUpdateAvailable: { type: "boolean", required: true },
          note: { type: "string", required: true }
        }
      },
      render: (_args, value) => [{ type: "text", text: value.note }]
    },
    async execute() {
      const status = await buildStatus(config, { network: true });
      return {
        appUpdateAvailable: Boolean(status.app.updateAvailable),
        engineUpdateAvailable: Boolean(status.engine.updateAvailable),
        app: status.app,
        engine: status.engine,
        note: [summarizeApp(status.app), summarizeEngine(status.engine)].join("\n")
      };
    },
    presentCall: () => ({ card: "generic", title: "检查更新", kind: "other" })
  });
}

function apply(ctx, rawConfig) {
  const config = {
    repo: rawConfig?.repo ?? "p48382961-spec/dsh-harness",
    timeoutMs: rawConfig?.timeoutMs ?? 15000
  };
  for (const factory of [versionTool, checkTool]) {
    try {
      const tool = factory(config);
      ctx.tools.register(tool);
      process.stderr.write(`[dsh-app-release] 已注册工具 ${tool.name}\n`);
    } catch (error) {
      process.stderr.write(`[dsh-app-release] 工具注册失败: ${error?.message ?? error}\n`);
    }
  }
  try {
    ctx.effect(
      () => ctx.connection.fetch.register({
        path: API_PREFIX,
        methods: ["GET", "POST"],
        requestBody: "buffered",
        fetch: async (request) => {
          const url = new URL(request.url, "http://localhost");
          const action = url.searchParams.get("action") ?? "status";
          try {
            if (action === "status") return Response.json(await buildStatus(config, { network: false }));
            if (action === "check") return Response.json(await buildStatus(config, { network: true }));
            if (action === "update-engine") {
              const started = startEngineUpdate(config, url.searchParams.get("version"));
              process.stderr.write(`[dsh-app-release] 引擎更新已启动 → ${started.target}（pid ${started.pid}）\n`);
              return Response.json({ ok: true, started, note: `已开始更新引擎到 ${started.target}，完成后会自动重启` });
            }
            return Response.json({ ok: false, error: `未知 action: ${action}` }, { status: 400 });
          } catch (error) {
            return Response.json({ ok: false, error: String(error?.message ?? error) }, { status: 500 });
          }
        }
      }),
      `dsh-app-release: ${API_PREFIX}`
    );
    process.stderr.write(`[dsh-app-release] 接口已注册（${API_PREFIX}）\n`);
  } catch (error) {
    process.stderr.write(`[dsh-app-release] 接口注册失败: ${error?.message ?? error}\n`);
  }
}

export { Config, apply, inject, name };
