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

/**
 * 下载镜像（可选）：`~/试玩/.dsh-mirror` 的首行 URL。
 *
 * 为什么需要它：GitHub 的 `github.com` 在某些网络下连不上（资产下载要经过它 302 到
 * objects.githubusercontent.com），但 `api.github.com` 往往还是通的 —— 于是「能查到有新版本、
 * 却下不动」。把 APK 放到自己的服务器/局域网/隧道上，在这里写一行地址就能装。
 */
/** 写/清镜像地址（客户端面板里改）。空串 = 清除。 */
function setMirror(next) {
  const file = join(homedir(), "试玩", ".dsh-mirror");
  const value = String(next ?? "").trim();
  if (!value) {
    try {
      unlinkSync(file);
    } catch {
      /* 本来就没有 */
    }
    return null;
  }
  if (!/^https?:\/\//i.test(value)) throw new Error("镜像地址必须是 http(s) 链接");
  writeFileSync(file, value + "\n", "utf8");
  return value;
}

function mirrorUrl() {
  try {
    const text = readFileSync(join(homedir(), "试玩", ".dsh-mirror"), "utf8");
    const first = String(text).split(/\r?\n/)[0].trim();
    return /^https?:\/\//i.test(first) ? first : null;
  } catch {
    return null;
  }
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

/** 外壳（主通道）：GitHub Releases API。 */
async function checkAppViaApi(config) {
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

function unescapeXml(value) {
  return String(value ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** 资产名模式：dsh-harness-<version>-arm64.apk（release.sh 生成时就是这个形状）。 */
function artifactName(tag) {
  return `dsh-harness-${tag}-arm64.apk`;
}

/**
 * 外壳（备用通道）：`releases.atom`。
 *
 * 为什么需要它：GitHub REST API 对**未认证请求**按出口 IP 限流（60 次/小时），
 * 本机走代理时出口 IP 是共享的，经常一上来就是 403 rate limit —— 用户看到「检查更新失败」。
 * atom 订阅源不是 API，不限流、也不需要 token，条目里有 tag 和链接，够我们判断版本。
 * 代价：拿不到资产大小和 release notes，所以按约定好的文件名拼出下载地址。
 */
async function checkAppViaAtom(config) {
  const response = await fetch(`https://github.com/${config.repo}/releases.atom`, {
    headers: { accept: "application/atom+xml, application/xml;q=0.9", "user-agent": "dsh-harness-android" },
    signal: AbortSignal.timeout(config.timeoutMs)
  });
  if (!response.ok) throw new Error(`releases.atom 返回 ${response.status}`);
  const text = await response.text();
  const entries = String(text).split("<entry>").slice(1);
  const parsed = [];
  for (const raw of entries) {
    const title = unescapeXml((raw.match(/<title>([\s\S]*?)<\/title>/) || [])[1] ?? "");
    const href = (raw.match(/<link[^>]*href="([^"]+)"/) || [])[1] ?? "";
    const updated = (raw.match(/<updated>([^<]+)<\/updated>/) || [])[1] ?? null;
    const fromHref = href.match(/\/releases\/tag\/([^/?#]+)/);
    const tag = bare(fromHref ? decodeURIComponent(fromHref[1]) : title);
    if (!parseVersion(tag)) continue;
    parsed.push({
      tag,
      pageUrl: href || `https://github.com/${config.repo}/releases/tag/v${tag}`,
      title,
      publishedAt: updated,
      prerelease: null,
      notes: "",
      assets: []
    });
  }
  parsed.sort((a, b) => compareVersions(b.tag, a.tag));
  if (!parsed.length) throw new Error("atom 里没有带版本的 release");
  const latest = parsed[0];
  const base = `https://github.com/${config.repo}/releases/download/v${latest.tag}`;
  const name = artifactName(latest.tag);
  const apk = { name, url: `${base}/${name}`, size: null };
  const sum = { name: `${name}.sha256`, url: `${base}/${name}.sha256`, size: null };
  return { latest, apk, sum, via: "atom" };
}

/** 外壳：先 API，失败自动退到 atom（限流时仍然能查到版本）。 */
async function checkApp(config) {
  try {
    const result = await checkAppViaApi(config);
    return { ...result, via: "api" };
  } catch (apiError) {
    const result = await checkAppViaAtom(config).catch((atomError) => {
      throw new Error(`${apiError.message}；atom 通道也不可用：${atomError.message}`);
    });
    result.degraded = `REST API 不可用（${apiError.message}），已改用 releases.atom`;
    return result;
  }
}

/** 引擎：npm registry 的 latest 标签。 */
/** 引擎包的版本只看我们自己发布过的包：npm 上有新版 ≠ 我们已打出带补丁的包。 */
const ENGINE_TAG_RE = /engine-v([0-9A-Za-z][0-9A-Za-z.+-]*)/;

async function checkEngineViaApi(config) {
  const response = await fetch(`https://api.github.com/repos/${ENGINE_REPO}/releases?per_page=30`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "dsh-harness-android" },
    signal: AbortSignal.timeout(config.timeoutMs)
  });
  if (!response.ok) throw new Error(`GitHub 返回 ${response.status}`);
  const list = await response.json();
  const found = [];
  for (const rel of Array.isArray(list) ? list : []) {
    if (rel.draft) continue;
    const m = ENGINE_TAG_RE.exec(String(rel.tag_name ?? ""));
    if (m) found.push({ version: m[1], pageUrl: rel.html_url ?? null, publishedAt: rel.published_at ?? null, via: "api" });
  }
  if (!found.length) throw new Error("还没有发布过任何引擎包");
  found.sort((a, b) => compareVersions(b.version, a.version));
  return found[0];
}

async function checkEngineViaAtom(config) {
  const response = await fetch(`https://github.com/${ENGINE_REPO}/releases.atom`, {
    headers: { "user-agent": "dsh-harness-android" },
    signal: AbortSignal.timeout(config.timeoutMs)
  });
  if (!response.ok) throw new Error(`GitHub 返回 ${response.status}`);
  const xml = await response.text();
  const found = [];
  for (const entry of xml.split("<entry>").slice(1)) {
    const m = ENGINE_TAG_RE.exec(entry);
    if (m) {
      const link = /<link[^>]+href="([^"]+)"/.exec(entry);
      found.push({ version: m[1], pageUrl: link ? link[1] : null, publishedAt: null, via: "atom" });
    }
  }
  if (!found.length) throw new Error("还没有发布过任何引擎包");
  found.sort((a, b) => compareVersions(b.version, a.version));
  return found[0];
}

async function checkEngine(config) {
  try {
    return await checkEngineViaApi(config);
  } catch (apiError) {
    try {
      return await checkEngineViaAtom(config);
    } catch (atomError) {
      throw new Error(`${apiError.message}；atom 兜底也失败：${atomError.message}`);
    }
  }
}

function updatingFlag() {
  return join(homedir(), "试玩", ".dsh-updating");
}

/** 15 分钟还没结束的标记视为残留（脚本被强杀、崩溃之类），顺手清掉，别把更新永久锁死。 */
const UPDATING_TTL_MS = 15 * 60 * 1000;
/** 升级脚本每完成一步就覆盖写这份状态；面板靠它画进度。 */
const UPDATE_STATE = "dsh-update-state.json";
const UPDATE_LOG = "dsh-update.log";
/** 状态超过这个时间没更新，就当脚本卡住了（不是失败，可能只是在 npm 下载）。 */
const STALE_MS = 2 * 60 * 1000;

function updateStatePath() {
  return join(homedir(), "试玩", UPDATE_STATE);
}

/** 读升级脚本写的状态文件；没有就返回 null。 */
function readUpdateState() {
  try {
    const raw = readFileSync(updateStatePath(), "utf8");
    const state = JSON.parse(raw);
    const now = Date.now();
    const idleSec = state.updatedAt ? Math.round(now / 1000 - state.updatedAt) : null;
    return {
      stage: state.stage ?? null,
      label: state.label ?? null,
      pct: typeof state.pct === "number" ? state.pct : null,
      target: state.target ?? null,
      from: state.from ?? null,
      to: state.to ?? null,
      done: Boolean(state.done),
      error: state.error ?? null,
      startedAt: state.startedAt ?? null,
      updatedAt: state.updatedAt ?? null,
      elapsedMs: state.startedAt ? Math.max(0, now - state.startedAt * 1000) : null,
      idleSec,
      stale: idleSec === null ? true : idleSec * 1000 > STALE_MS
    };
  } catch {
    return null;
  }
}

/** 升级日志的最后几行（面板里显示「最后在干什么」）。 */
function updateLogTail(lines = 6) {
  try {
    return readFileSync(join(homedir(), "试玩", UPDATE_LOG), "utf8").trimEnd().split("\n").slice(-lines);
  } catch {
    return [];
  }
}


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
    error: null,
    mirror: mirrorUrl()
  };
  const engine = {
    current: local.engine,
    latest: null,
    updateAvailable: false,
    checked: false,
    error: null,
    updating: updatingNow(),
    progress: null,
    logTail: [],
    log: join(homedir(), "试玩", UPDATE_LOG)
  };

  // 引擎包来源：GitHub 直连还是自建镜像（自测时指向本机 8099）
  engine.source = engineSourceBase() ? "mirror" : "github";

  // 进度：只要脚本写过状态就带上（不管更新是否已结束），面板据此显示第几步/百分比/耗时
  const progress = readUpdateState();
  if (progress) {
    engine.progress = progress;
    engine.logTail = updateLogTail(6);
  }

  if (!network) {
    return { ok: true, checked: false, app, engine };
  }

  const [appResult, engineResult] = await Promise.allSettled([checkApp(config), checkEngine(config)]);

  if (appResult.status === "fulfilled") {
    const { latest, apk, sum, via, degraded } = appResult.value;
    Object.assign(app, {
      checked: true,
      latest: latest.tag,
      updateAvailable: Boolean(appCurrent) && compareVersions(latest.tag, appCurrent) > 0,
      prerelease: latest.prerelease,
      publishedAt: latest.publishedAt,
      pageUrl: latest.pageUrl,
      notes: latest.notes,
      apkUrl: app.mirror ?? apk?.url ?? null,
      apkUrlOriginal: apk?.url ?? null,
      apkSize: apk?.size ?? null,
      sha256Url: sum?.url ?? null,
      via: via ?? "api",
      degraded: degraded ?? null
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
      bundleOnly: true,
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
/** 引擎包来源：GitHub 的 engine-v<版本> release；可在 ~/试玩/.dsh-engine-source 里覆盖成本地/镜像地址。 */
const ENGINE_REPO = "p48382961-spec/dsh-harness";
const ENGINE_SOURCE_FILE = "dsh-engine-source";

function engineSourceBase() {
  try {
    const raw = readFileSync(join(homedir(), "试玩", ENGINE_SOURCE_FILE), "utf8").trim();
    const first = raw.split("\n")[0].trim().replace(/\/+$/, "");
    if (/^https?:\/\//.test(first)) return first;
  } catch {
    /* 没配置就走默认 */
  }
  return "";
}

function engineAssetName(version) {
  return `dsh-engine-${version}-android-arm64.tar.gz`;
}

/** 引擎包的下载地址与校验文件地址。 */
function engineUrls(version) {
  const asset = engineAssetName(version);
  const base = engineSourceBase();
  const url = base
    ? `${base}/${asset}`
    : `https://github.com/${ENGINE_REPO}/releases/download/engine-v${version}/${asset}`;
  return { asset, url, shaUrl: `${url}.sha256`, via: base ? "mirror" : "github" };
}

function startEngineUpdate(config, version) {
  const target = String(version ?? "").trim();
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(target)) {
    throw new Error(`版本号不合法：${target}`);
  }
  const script = join(homedir(), "试玩", "dsh-engine-update.sh");
  if (!existsSync(script)) {
    throw new Error(`找不到引擎更新脚本 ${script}`);
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
  const urls = engineUrls(target);
  const child = spawn(shell, [script, target, urls.url, urls.shaUrl], {
    detached: true,
    stdio: ["ignore", fd, fd],
    env: { ...process.env, HOME: homedir(), TMPDIR: join(homedir(), "tmp") },
    cwd: homedir()
  });
  child.unref();
  // 设备上没有 adb：把「已开始」这件事也推到本机 8099，Termux 侧才能远程确认脚本真的被拉起
  try {
    const payload = JSON.stringify({ target, pid: child.pid ?? null, url: urls.url, via: urls.via, at: new Date().toISOString() });
    void fetch(`http://127.0.0.1:8099/upload?name=engine-start.json`, { method: "POST", body: payload }).catch(() => {});
  } catch {
    /* 取证用，失败不影响更新 */
  }
  return { target, script, logPath, url: urls.url, via: urls.via, pid: child.pid ?? null };
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
            if (action === "log") {
              return Response.json({ ok: true, logTail: updateLogTail(40), progress: readUpdateState() });
            }
            if (action === "check") return Response.json(await buildStatus(config, { network: true }));
            if (action === "mirror") {
              const next = url.searchParams.get("url") ?? "";
              const saved = setMirror(next);
              return Response.json({
                ok: true,
                mirror: saved,
                note: saved ? `镜像已设为 ${saved}` : "镜像已清除，改回 GitHub 直连"
              });
            }
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
