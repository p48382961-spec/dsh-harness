import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFile, spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

/**
 * dsh-maintenance —— 把「维护 DSH 装机环境」的几件杂活收进一个插件：
 *
 *   ① `dsh_version`      查看当前版本 + 运行时环境 + 补丁/插件健康状况
 *   ② `dsh_check_update` 查 npm registry，比对 dist-tags，给出是否有新版
 *   ③ `dsh_repair`       把被 pnpm 修剪掉的 dsh-plugin-restart 装回并补登记 bundle
 *      （原 `~/试玩/dsh-restore-restart-plugin.sh` 的插件化版本，且默认在加载时自动跑一次）
 *
 * 还有一块浏览器端 `lib/client.js`：侧栏底部一行「版本 / 检查更新」按钮。
 *
 * ── 为什么这件事非得插件来干 ──────────────────────────────────────────────
 * agent 的 bash 工具跑在 Landlock 沙箱里，写不了 workspace 之外的路径；而修复动作
 * 恰恰要写 `~/.dsh/profiles/...`。插件跑在**服务进程内部**，不受沙箱约束，是唯一
 * 能在无人值守下完成修复的位置。
 *
 * ── 一个必须说清的边界 ────────────────────────────────────────────────────
 * 如果 dsh-plugin-restart 在本进程**启动之前**就已被修剪，profile 的
 * `restart-server` 那一行在本进程里已经被禁用，`restart_server` 工具这次仍然缺席。
 * 本插件在加载时补回文件与登记，**下一次重启**该行即恢复。要根治这一点，应当让
 * dsh-plugin-restart 也走「锁文件内安装」，而不是 cp —— 见 README。
 *
 * @module dsh-maintenance
 */

const name = "dsh-maintenance";

/** 依赖注入：工具注册表 + 共享 `/api` 通道（自带鉴权栅栏）。 */
const inject = ["tools", "connection"];

const Config = z.object({
  /** DSH 主目录，profile 与 sessions 都在下面。 */
  home: z.string().default(join(homedir(), ".dsh")),
  /** 补丁集目录（dsh-android-patch.mjs / dsh-update.sh / 各插件源的所在地）。 */
  patchDir: z.string().default(join(homedir(), "试玩")),
  /** 要守护的插件名。 */
  guardedPlugin: z.string().default("dsh-plugin-restart"),
  /** 本插件自己的包名（用于自检自身是否在主份里）。 */
  selfName: z.string().default("dsh-maintenance"),
  /** DSH 的 npm registry 元数据地址。 */
  registry: z.string().default("https://registry.npmjs.org/@deepseek-ai/dsh"),
  /** 加载时是否自动执行一次修复（守护的核心）。 */
  autoRepair: z.boolean().default(true),
  /** 更新检查的网络超时（毫秒）。 */
  fetchTimeoutMs: z.number().default(15000),
  /** 升级脚本；收到版本号作为唯一参数。 */
  updateScript: z.string().default(join(homedir(), "试玩", "dsh-update.sh")),
  /** 重启脚本。 */
  restartScript: z.string().default(join(homedir(), "dsh-restart.sh")),
  /** 升级日志落盘位置（放在 workspace 内，沙箱里的 agent 也读得到）。 */
  updateLog: z.string().default(join(homedir(), "试玩", "dsh-update.log")),
  /** 升级前的 profile 备份根目录。 */
  backupRoot: z.string().default(join(homedir(), "试玩", "dsh-backups")),
  /** 是否允许通过工具/接口真的执行升级（关掉即只剩「检查」）。 */
  allowUpgrade: z.boolean().default(true)
});

/** 共享的 `/api` 路由前缀。 */
const API_PREFIX = "/api/dsh-maintenance";

const STARTED_AT = Date.now();

// ─────────────────────────── 版本 ───────────────────────────

/**
 * 从某个目录逐级向上找一个 package.json，名字命中 `wantedName` 就返回。
 * 用于拿 DSH 自身的版本：它可能是全局安装，不在 profile 的解析路径上。
 *
 * @param startDir - 起始目录。
 * @param wantedName - 期望的 `name` 字段值。
 * @returns `{ dir, json, path }`，找不到返回 undefined。
 */
function findPackageUp(startDir, wantedName) {
  let dir = resolve(startDir);
  for (let depth = 0; depth < 16; depth += 1) {
    const path = join(dir, "package.json");
    if (existsSync(path)) {
      try {
        const json = JSON.parse(readFileSync(path, "utf8"));
        if (json?.name === wantedName) return { dir, json, path };
      } catch {
        // 坏 JSON 跳过，继续向上找
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * 定位 DSH 本体。三条线索按可信度排序：
 *
 *   ① `process.argv[1]` 的目录向上找 —— 那是**这个进程**实际加载的 bin，
 *      不会与 PATH 上另一个 dsh 混淆（最可信）。
 *   ② `$PREFIX/lib/node_modules/@deepseek-ai/dsh` —— Termux 全局安装的常规位置，
 *      兜住「argv[1] 被 wrapper 遮住」的情况。
 *   ③ 当前工作目录向上找 —— 最后兜底。
 *
 * @returns `{ version, dir }`，找不到时 `version` 为 `"unknown"`。
 */
function resolveDshVersion() {
  const starts = [];
  if (process.argv[1]) starts.push(dirname(resolve(process.argv[1])));
  if (process.env.PREFIX) starts.push(join(process.env.PREFIX, "lib", "node_modules", "@deepseek-ai", "dsh"));
  starts.push(process.cwd());
  for (const start of starts) {
    const found = findPackageUp(start, "@deepseek-ai/dsh");
    if (found) return { version: String(found.json.version ?? "unknown"), dir: found.dir };
  }
  return { version: "unknown", dir: undefined };
}

// ─────────────────────────── 补丁 / 插件健康 ───────────────────────────

/** 读补丁器的验证记录（`VALIDATED.json`）。 */
function readPatchRecord(config) {
  const path = join(config.patchDir, "VALIDATED.json");
  if (!existsSync(path)) return { present: false, path };
  try {
    return { present: true, path, ...JSON.parse(readFileSync(path, "utf8")) };
  } catch (error) {
    return { present: true, path, error: String(error?.message ?? error) };
  }
}

/** 读 profile 清单里的 bundles 列表。 */
function readBundles(pkgPath) {
  try {
    return JSON.parse(readFileSync(pkgPath, "utf8"))?.dsh?.profile?.bundles ?? [];
  } catch {
    return [];
  }
}

/**
 * 采集「守护对象 + 本插件自身」的落位状况。
 *
 * 三处路径的含义：
 *   primary   `profiles/web/node_modules/<name>`  ← pnpm 的辖区，随时可能被修剪
 *   fallback  `profiles/node_modules/<name>`      ← pnpm 辖区之外，能兜住
 *   ignored   `profiles/web/node_modules/.ignored/<name>` ← 被修剪过的残骸（证据）
 *   source    `待定 patchDir/<name>`              ← 权威源，修复时从这里拷
 *
 * @returns 一份可 JSON 化的健康报告。
 */
function inspect(config) {
  const profileDir = join(config.home, "profiles", "web");
  const pkgPath = join(profileDir, "package.json");
  const bundles = readBundles(pkgPath);

  const locate = (pluginName) => {
    const primary = join(profileDir, "node_modules", pluginName);
    const fallback = join(config.home, "profiles", "node_modules", pluginName);
    const ignored = join(profileDir, "node_modules", ".ignored", pluginName);
    const source = join(config.patchDir, pluginName);
    const present = (dir) => existsSync(join(dir, "package.json"));
    return {
      name: pluginName,
      primary: { path: primary, present: present(primary) },
      fallback: { path: fallback, present: present(fallback) },
      ignored: { path: ignored, present: existsSync(ignored) },
      source: { path: source, present: present(source) },
      bundleRegistered: bundles.includes(pluginName),
      // 能被 Node 解析到就算可用（primary 或 fallback 任一在位）。
      loadable: present(primary) || present(fallback)
    };
  };

  const guarded = locate(config.guardedPlugin);
  const self = locate(config.selfName);

  return {
    profileDir,
    pkgPath,
    bundles,
    guarded,
    self,
    // 守护对象健康 = 能加载 且 登记在案 且 没有残骸
    healthy: guarded.loadable && guarded.bundleRegistered && !guarded.ignored.present
  };
}

// ─────────────────────────── 目录比较 / 修复 ───────────────────────────

/** 递归列出一个目录下的相对文件路径（跳过 node_modules）。 */
function listTree(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(relative(root, full));
    }
  };
  if (existsSync(root)) walk(root);
  return out.sort();
}

/** 两棵目录树内容是否一致（文件名集合 + 逐字节）。 */
function sameTree(a, b) {
  if (!existsSync(a) || !existsSync(b)) return false;
  const la = listTree(a);
  const lb = listTree(b);
  if (la.length !== lb.length) return false;
  for (let i = 0; i < la.length; i += 1) {
    if (la[i] !== lb[i]) return false;
    try {
      if (!readFileSync(join(a, la[i])).equals(readFileSync(join(b, lb[i])))) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * 把 `source` 目录原样拷到 `destination`。目录已在且一致时跳过，不做无谓的写。
 *
 * @returns 一行人类可读的步骤结果。
 */
function syncTree(source, destination, label) {
  if (sameTree(source, destination)) return `已一致，跳过 ${label}: ${destination}`;
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true });
  return `已安装 ${label}: ${destination}`;
}

/**
 * 执行守护修复：
 *   ① 从权威源把被守护插件装回主份与回退份
 *   ② 清理 `.ignored` 残骸
 *   ③ 补登记 `dsh.profile.bundles`（改前留 `.dshbak`）
 *
 * 全程幂等：状态正确时只报告「无需修复」，不写任何文件。
 *
 * @returns `{ steps, changed }`。
 */
function repair(config) {
  const steps = [];
  const before = inspect(config);
  let changed = false;

  // ① 文件落位
  for (const pluginName of [config.guardedPlugin, config.selfName]) {
    const source = join(config.patchDir, pluginName);
    if (!existsSync(join(source, "package.json"))) {
      steps.push(`跳过 ${pluginName}：权威源不存在 ${source}`);
      continue;
    }
    for (const destination of [
      join(config.home, "profiles", "web", "node_modules", pluginName),
      join(config.home, "profiles", "node_modules", pluginName)
    ]) {
      const line = syncTree(source, destination, pluginName);
      steps.push(line);
      if (!line.startsWith("已一致")) changed = true;
    }
  }

  // ② 残骸
  for (const pluginName of [config.guardedPlugin, config.selfName]) {
    const ignored = join(config.home, "profiles", "web", "node_modules", ".ignored", pluginName);
    if (existsSync(ignored)) {
      rmSync(ignored, { recursive: true, force: true });
      steps.push(`已清理残骸: ${ignored}`);
      changed = true;
    }
  }

  // ③ bundle 登记（守护对象 + 自身）
  const pkgPath = join(config.home, "profiles", "web", "package.json");
  try {
    const json = JSON.parse(readFileSync(pkgPath, "utf8"));
    const bundles = json?.dsh?.profile?.bundles;
    if (!Array.isArray(bundles)) {
      steps.push("⚠️ profile 清单里没有 dsh.profile.bundles，未登记");
    } else {
      const missing = [config.guardedPlugin, config.selfName].filter((entry) => !bundles.includes(entry));
      if (missing.length === 0) {
        steps.push("bundle 登记已完整，跳过");
      } else {
        if (!existsSync(`${pkgPath}.dshbak`)) cpSync(pkgPath, `${pkgPath}.dshbak`);
        bundles.push(...missing);
        writeFileSync(pkgPath, `${JSON.stringify(json, null, 2)}\n`);
        steps.push(`已补登记 ${missing.join(", ")}（共 ${bundles.length} 项）`);
        changed = true;
      }
    }
  } catch (error) {
    steps.push(`⚠️ bundle 登记失败: ${error?.message ?? error}`);
  }

  const after = inspect(config);
  return { steps, changed, before, after };
}

// ─────────────────────────── 版本比对 / 更新检查 ───────────────────────────

/** 解析 semver（含预发布标识）。非法返回 undefined。 */
function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(value ?? "").trim());
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ? match[4].split(".") : undefined
  };
}

/** 标准 semver 比较：a<b 返回 -1，a==b 返回 0，a>b 返回 1。 */
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) {
    if (a === b) return 0;
    return String(a) < String(b) ? -1 : 1;
  }
  for (const key of ["major", "minor", "patch"]) {
    if (x[key] !== y[key]) return x[key] < y[key] ? -1 : 1;
  }
  if (!x.pre && !y.pre) return 0;
  if (!x.pre) return 1; // 有预发布标识的 < 无预发布标识的
  if (!y.pre) return -1;
  const length = Math.max(x.pre.length, y.pre.length);
  for (let i = 0; i < length; i += 1) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) {
      if (Number(p) !== Number(q)) return Number(p) < Number(q) ? -1 : 1;
    } else if (pn !== qn) {
      return pn ? -1 : 1;
    } else if (p !== q) {
      return p < q ? -1 : 1;
    }
  }
  return 0;
}

/**
 * 查 npm registry 并比对。用 global fetch（Node 18+ 内置），带 AbortController 超时。
 *
 * @returns 一份结构化结果：当前版本、各 dist-tag、是否有更新、推荐目标。
 */
async function checkUpdate(config, currentVersion) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.fetchTimeoutMs);
  let data;
  try {
    const response = await fetch(config.registry, {
      headers: { accept: "application/json" },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`registry 返回 HTTP ${response.status}`);
    data = await response.json();
  } finally {
    clearTimeout(timer);
  }

  const tags = data?.["dist-tags"] ?? {};
  const publishedAt = data?.time ?? {};
  const tags_ = {};
  for (const [tag, version] of Object.entries(tags)) {
    tags_[tag] = { version, publishedAt: publishedAt[version] ?? undefined };
  }

  // 候选 = 所有比当前新的 tag；推荐优先级 latest > next > alpha。
  const candidates = Object.entries(tags)
    .filter(([, version]) => compareVersions(currentVersion, version) < 0)
    .map(([tag, version]) => ({ tag, version }));
  const priority = ["latest", "next", "alpha"];
  candidates.sort((a, b) => priority.indexOf(a.tag) - priority.indexOf(b.tag));
  const recommended = candidates[0];

  return {
    current: currentVersion,
    /** 当前版本的发布时间——界面用它算「新版本比现在新几天」。 */
    currentPublishedAt: publishedAt[currentVersion] ?? undefined,
    tags: tags_,
    newer: candidates,
    updateAvailable: candidates.length > 0,
    recommended: recommended ? { ...recommended, isStable: recommended.tag === "latest" } : undefined,
    registry: config.registry
  };
}

// ─────────────────────────── 升级 / 重启 ───────────────────────────

/**
 * 进程启动那一刻载入的版本。
 *
 * 与 `resolveDshVersion()` 的实时值分开是有意的：升级会把磁盘上的 package.json
 * 改掉，但**本进程跑的仍是旧代码**。两个值不一致 = 「已升级，待重启生效」，
 * 这正是界面需要显示、而单看一个版本号看不出来的状态。
 */
const STARTED_VERSION = resolveDshVersion();

/** 升级任务状态。只活在进程内，重启即清空（但日志文件还在）。 */
const upgradeJob = {
  running: false,
  exitCode: undefined,
  target: undefined,
  startedAt: undefined,
  error: undefined,
  backup: undefined
};

/** 只读文件尾部若干行——升级日志会长到不适合整份读。 */
function tailFile(path, maxLines) {
  if (!existsSync(path)) return { path, present: false, lines: [], bytes: 0 };
  try {
    const text = readFileSync(path, "utf8");
    return { path, present: true, lines: text.split("\n").slice(-maxLines), bytes: Buffer.byteLength(text) };
  } catch (error) {
    return { path, present: true, lines: [`⚠️ 日志读取失败: ${error?.message ?? error}`], bytes: 0 };
  }
}

/**
 * 升级前的轻量备份：profile 三件套 + 补丁记录。
 *
 * 刻意不备份 node_modules —— 上游版本本身可以从 npm 重装，回滚路径是
 * `bash dsh-update.sh <旧版本>`；真正不可再生的是清单、锁文件与补丁锚点记录。
 * 失败只记录，不阻断升级（脚本自身仍是完整的升级流程）。
 */
function backupBeforeUpgrade(config, fromVersion) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
  const dir = join(config.backupRoot, `${fromVersion}__${stamp}`);
  try {
    mkdirSync(dir, { recursive: true });
    const profileDir = join(config.home, "profiles", "web");
    for (const file of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
      const source = join(profileDir, file);
      if (existsSync(source)) cpSync(source, join(dir, file));
    }
    const record = join(config.patchDir, "VALIDATED.json");
    if (existsSync(record)) cpSync(record, join(dir, "VALIDATED.json"));
    return { ok: true, dir };
  } catch (error) {
    return { ok: false, dir, error: String(error?.message ?? error) };
  }
}

/**
 * 启动一次升级：脱离本进程执行 `bash <updateScript> <version>`，
 * 输出追加进日志文件。**立即返回**，进度由 `upgrade-status` 轮询。
 *
 * @returns `{ ok, ... }`；`ok=false` 时带 `error`，不会抛。
 */
function startUpgrade(config, version) {
  if (upgradeJob.running) return { ok: false, error: "已有升级任务在进行中" };
  if (!config.allowUpgrade) return { ok: false, error: "配置已关闭升级（allowUpgrade=false）" };
  if (typeof version !== "string" || !/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version)) {
    return { ok: false, error: `版本号不合法: ${String(version)}` };
  }
  if (!existsSync(config.updateScript)) return { ok: false, error: `升级脚本不存在: ${config.updateScript}` };

  const backup = backupBeforeUpgrade(config, STARTED_VERSION.version);
  mkdirSync(dirname(config.updateLog), { recursive: true });

  let child;
  let fd;
  try {
    fd = openSync(config.updateLog, "a");
    writeFileSync(
      fd,
      `\n===== ${new Date().toISOString()} 升级 ${STARTED_VERSION.version} → ${version} =====\n`
    );
    child = spawn("bash", [config.updateScript, version], {
      detached: true,
      stdio: ["ignore", fd, fd],
      cwd: dirname(config.updateScript),
      env: process.env
    });
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    return { ok: false, error: String(error?.message ?? error), backup };
  }
  closeSync(fd);

  Object.assign(upgradeJob, {
    running: true,
    exitCode: undefined,
    target: version,
    startedAt: Date.now(),
    error: undefined,
    backup
  });
  child.on("exit", (code) => {
    upgradeJob.running = false;
    upgradeJob.exitCode = code;
  });
  child.on("error", (error) => {
    upgradeJob.running = false;
    upgradeJob.error = String(error?.message ?? error);
  });
  child.unref();

  return { ok: true, target: version, backup, log: config.updateLog, script: config.updateScript };
}

/** 重启：脱离本进程执行重启脚本；宿主重开后才会加载升级后的代码。 */
function startRestart(config) {
  if (!existsSync(config.restartScript)) return { ok: false, error: `重启脚本不存在: ${config.restartScript}` };
  try {
    const child = spawn("bash", [config.restartScript], {
      detached: true,
      stdio: "ignore",
      cwd: dirname(config.restartScript),
      env: process.env
    });
    child.unref();
    return { ok: true, script: config.restartScript };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/**
 * 组装界面与工具共用的状态快照。
 *
 * @param config - 已解析配置。
 * @param options.network - 是否顺带跑一次 registry 检查。
 */
/**
 * 把 `--dump-config` 的 stderr 里「被跳过的 bundle」摘成结构化条目。
 *
 * 行格式（dsh-app-boot 打印）：
 *   dsh: skipping profile bundle "@michengai/dsh-codex-ui": Error: Plugin ...@1.1.37
 *        is incompatible with dsh 0.2.1-alpha.3: peerDependencies {...}
 */
function parseSkippedBundles(stderr) {
  const items = [];
  const seen = new Set();
  for (const line of String(stderr ?? "").split("\n")) {
    const hit = /skipping profile bundle "([^"]+)"/.exec(line);
    if (!hit || seen.has(hit[1])) continue;
    seen.add(hit[1]);
    // 包名本身以 "@" 开头，所以版本号只能从 "@<数字>" 处切开：用 [^@]+ 会一个都匹配不上。
    const detail = /Plugin (\S+)@(\d[^\s]*) is incompatible with dsh (\S+?):/.exec(line);
    items.push({
      bundle: hit[1],
      name: detail ? detail[1] : hit[1],
      version: detail ? detail[2] : null,
      runtime: detail ? detail[3] : null
    });
  }
  return items;
}

/**
 * 插件兼容性体检：跑一次 `dsh --profile web --dump-config`，数它跳过了谁。
 *
 * 这是**唯一权威**的判定——dsh 自己怎么判，这里就怎么判，不另起一套规则。
 * 同步执行：实测 1～2 秒，换来的是一条不可能与启动结果矛盾的结论。
 */
function pluginCompat() {
  const dsh = resolveDshVersion();
  const bin = join(dsh.dir, "lib", "bin.js");
  if (!existsSync(bin)) {
    return { ok: false, error: `找不到 dsh 入口：${bin}`, runtime: dsh.version, count: 0, items: [] };
  }
  const run = spawnSync(process.execPath, [bin, "--profile", "web", "--dump-config"], {
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024
  });
  const items = parseSkippedBundles(run.stderr);
  return {
    ok: true,
    runtime: dsh.version,
    count: items.length,
    items,
    // 空结果也要能自证：没拿到 stderr 时不许装作"全部兼容"。
    note: run.error ? String(run.error.message ?? run.error) : null
  };
}

/** 跑一次插件对齐脚本；restore 为真时改为恢复上次升级前的版本。 */
function runAlignScript(config, restore) {
  return new Promise((resolve) => {
    const script = join(config.patchDir, "dsh-plugin-align.mjs");
    if (!existsSync(script)) {
      resolve({ ok: false, error: `找不到对齐脚本：${script}` });
      return;
    }
    const args = restore ? [script, "--restore"] : [script];
    execFile(process.execPath, args, { timeout: 180_000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      const out = String(stdout ?? "");
      const err = String(stderr ?? "");
      const code = error && typeof error.code === "number" ? error.code : (error ? 1 : 0);
      let failure = null;
      if (error) {
        const tail = (err || out).trim().split("\n").filter(Boolean).slice(-3).join(" / ");
        failure = tail || String(error.message ?? error) || `退出码 ${code}`;
      }
      resolve({ ok: !failure, exitCode: code, error: failure, output: out.slice(-8000), errors: err.slice(-8000) });
    });
  });
}

async function statusPayload(config, options = {}) {
  const onDisk = resolveDshVersion();
  const health = inspect(config);
  const patches = readPatchRecord(config);
  const payload = {
    runningVersion: STARTED_VERSION.version,
    onDiskVersion: onDisk.version,
    restartRequired: onDisk.version !== STARTED_VERSION.version,
    node: process.version,
    pid: process.pid,
    startedAt: STARTED_AT,
    patchDir: config.patchDir,
    packageDir: onDisk.dir ?? STARTED_VERSION.dir,
    updateLog: config.updateLog,
    patchRecord: patches,
    health: {
      guarded: health.guarded.name,
      loadable: health.guarded.loadable,
      registered: health.guarded.bundleRegistered,
      ignored: health.guarded.ignored.present,
      healthy: health.healthy
    },
    upgrade: {
      running: upgradeJob.running,
      exitCode: upgradeJob.exitCode ?? null,
      target: upgradeJob.target ?? null,
      startedAt: upgradeJob.startedAt ?? null,
      error: upgradeJob.error ?? null,
      backup: upgradeJob.backup ?? null,
      allowUpgrade: config.allowUpgrade,
      script: config.updateScript
    }
  };
  if (options.network) {
    // 比对基准用**磁盘版本**：刚升级完还没重启时，不该再诱导用户重装同一个版本。
    try {
      payload.update = await checkUpdate(config, onDisk.version);
    } catch (error) {
      payload.update = { error: String(error?.message ?? error), current: onDisk.version };
    }
  }
  return payload;
}

// ─────────────────────────── 工具与路由注册 ───────────────────────────

/** 把结果压成一行话，工具卡片与日志共用。 */
function summarizeUpdate(result) {
  if (!result.updateAvailable) return `已是最新（当前 ${result.current}）。`;
  const head = result.recommended
    ? `发现新版本：${result.recommended.version}（${result.recommended.tag}）`
    : "发现新版本";
  const all = result.newer.map((entry) => `${entry.tag}=${entry.version}`).join("、");
  return `${head}；当前 ${result.current}。可用 tag：${all}。`;
}

const versionTool = (config) => defineTool({
  name: "dsh_version",
  description: [
    "Report the running DSH version and the health of this installation: ",
    "DSH version and package directory, Node and process id, the Android patch record ",
    "(rules/patched counts from VALIDATED.json), and whether the guarded maintenance plugins ",
    "are loadable and registered as profile bundles. Read-only."
  ].join(""),
  parameters: {},
  output: {
    schema: {
      type: "object",
      additionalProperties: true,
      properties: {
        version: { type: "string", required: true },
        note: { type: "string", required: true }
      }
    },
    render: (_args, value) => [{ type: "text", text: value.note }]
  },
  execute() {
    const dsh = resolveDshVersion();
    const patches = readPatchRecord(config);
    const health = inspect(config);
    const restartRequired = dsh.version !== STARTED_VERSION.version;
    const payload = {
      version: dsh.version,
      runningVersion: STARTED_VERSION.version,
      onDiskVersion: dsh.version,
      restartRequired,
      packageDir: dsh.dir,
      node: process.version,
      pid: process.pid,
      startedAt: new Date(STARTED_AT).toISOString(),
      patchRecord: patches,
      guardedPlugin: health.guarded.name,
      guardedLoadable: health.guarded.loadable,
      guardedRegistered: health.guarded.bundleRegistered,
      bundles: health.bundles,
      healthy: health.healthy
    };
    const patchLine = patches.present
      ? `补丁记录 v${patches.version ?? "?"}（rules=${patches.rules ?? "?"} patched=${patches.patched ?? "?"} failed=${patches.failed ?? "?"}）`
      : "补丁记录缺失";
    return Promise.resolve({
      ...payload,
      note: [
        restartRequired
          ? `磁盘上已是 DSH ${dsh.version}，但本进程仍跑 ${STARTED_VERSION.version} —— 需重启生效`
          : `DSH ${dsh.version}（node ${process.version}，pid ${process.pid}）`,
        patchLine,
        `守护插件 ${health.guarded.name}：${health.guarded.loadable ? "可加载" : "不可加载"}、${health.guarded.bundleRegistered ? "已登记" : "未登记"}`,
        health.healthy ? "总体：健康" : "总体：需要修复（可调用 dsh_repair）"
      ].join("；")
    });
  },
  presentCall: () => ({ card: "generic", title: "查看 DSH 版本", kind: "other" })
});

const checkUpdateTool = (config) => defineTool({
  name: "dsh_check_update",
  description: [
    "Check whether a newer DSH version exists on the npm registry. ",
    "Fetches the package metadata, compares every dist-tag against the running version with ",
    "semver precedence (prerelease-aware), and reports whether an update is available and which ",
    "tag to prefer. Read-only, but performs a network request."
  ].join(""),
  parameters: {},
  output: {
    schema: {
      type: "object",
      additionalProperties: true,
      properties: {
        current: { type: "string", required: true },
        updateAvailable: { type: "boolean", required: true },
        note: { type: "string", required: true }
      }
    },
    render: (_args, value) => [{ type: "text", text: value.note }]
  },
  async execute() {
    // 以磁盘上的版本为基准：刚装完还没重启时，不该再报同一个版本可升级。
    const dsh = resolveDshVersion();
    const result = await checkUpdate(config, dsh.version);
    return { ...result, runningVersion: STARTED_VERSION.version, note: summarizeUpdate(result) };
  },
  presentCall: () => ({ card: "generic", title: "检查 DSH 更新", kind: "other" })
});

const repairTool = (config) => defineTool({
  name: "dsh_repair",
  description: [
    "Repair the maintenance plugins after a pnpm operation pruned them. ",
    "Restores the guarded plugin (dsh-plugin-restart) and this plugin into both the profile's ",
    "node_modules and the fallback directory, clears .ignored remnants, and re-registers any ",
    "missing dsh.profile.bundles entry. Idempotent: a healthy installation reports no changes. ",
    "A restored plugin row only loads after the next server restart."
  ].join(""),
  parameters: {},
  output: {
    schema: {
      type: "object",
      additionalProperties: true,
      properties: {
        changed: { type: "boolean", required: true },
        note: { type: "string", required: true }
      }
    },
    render: (_args, value) => [{ type: "text", text: value.note }]
  },
  execute() {
    const result = repair(config);
    return Promise.resolve({
      changed: result.changed,
      steps: result.steps,
      healthyBefore: result.before.healthy,
      healthyAfter: result.after.healthy,
      note: (result.changed
        ? `已执行修复（${result.steps.length} 步）`
        : "无需修复，环境已是正确状态") + `；健康：${result.before.healthy ? "是" : "否"} → ${result.after.healthy ? "是" : "否"}`
    });
  },
  presentCall: () => ({ card: "generic", title: "修复 DSH 维护插件", kind: "other" })
});

const upgradeTool = (config) => defineTool({
  name: "dsh_upgrade",
  description: [
    "Upgrade the installed DSH to another npm version by running the on-device update script ",
    "(npm install + Android patch re-apply + landlock rebuild + restart-plugin reinstall). ",
    "This modifies the machine: it takes a lightweight profile backup first, then runs detached, ",
    "so the call returns immediately and progress is read from the upgrade log. ",
    "Pass version='latest' to resolve the newest dist-tag. The new version only takes effect ",
    "after a server restart. Requires confirm=true."
  ].join(""),
  parameters: {
    version: {
      type: "string",
      required: true,
      description: "Target version, or 'latest' to use the newest dist-tag."
    },
    confirm: {
      type: "boolean",
      required: true,
      description: "Must be true; guards against an accidental upgrade."
    }
  },
  output: {
    schema: {
      type: "object",
      additionalProperties: true,
      properties: {
        ok: { type: "boolean", required: true },
        note: { type: "string", required: true }
      }
    },
    render: (_args, value) => [{ type: "text", text: value.note }]
  },
  async execute(args) {
    if (args?.confirm !== true) {
      return { ok: false, note: "已取消：dsh_upgrade 需要显式传 confirm=true。" };
    }
    let version = String(args?.version ?? "").trim();
    if (version === "latest" || version === "") {
      const check = await checkUpdate(config, STARTED_VERSION.version);
      version = String(check.recommended?.version ?? check.current);
    }
    const result = startUpgrade(config, version);
    if (!result.ok) return { ...result, note: `升级未启动：${result.error}` };
    return {
      ...result,
      note: [
        `已在后台启动升级 → ${result.target}（当前运行 ${STARTED_VERSION.version}）`,
        result.backup?.ok ? `备份：${result.backup.dir}` : "备份：跳过（非致命）",
        `日志：${result.log}`,
        "升级完成后需要重启才会生效。"
      ].join("；")
    };
  },
  presentCall: () => ({ card: "generic", title: "升级 DSH", kind: "other" })
});

/**
 * 注册插件的全部入口。每段单独 try/catch：本插件是纯增益的，任一段失败只应
 * 退化成「少一个入口」，绝不能把 profile 启动或整个 Web 拖下水。
 *
 * @param ctx - 携带工具注册表与 connection 的 ctx。
 * @param rawConfig - 已解析配置。
 */
function apply(ctx, rawConfig) {
  const config = {
    home: rawConfig?.home ?? join(homedir(), ".dsh"),
    patchDir: rawConfig?.patchDir ?? join(homedir(), "试玩"),
    guardedPlugin: rawConfig?.guardedPlugin ?? "dsh-plugin-restart",
    selfName: rawConfig?.selfName ?? "dsh-maintenance",
    registry: rawConfig?.registry ?? "https://registry.npmjs.org/@deepseek-ai/dsh",
    autoRepair: rawConfig?.autoRepair ?? true,
    fetchTimeoutMs: rawConfig?.fetchTimeoutMs ?? 15000,
    updateScript: rawConfig?.updateScript ?? join(homedir(), "试玩", "dsh-update.sh"),
    restartScript: rawConfig?.restartScript ?? join(homedir(), "dsh-restart.sh"),
    updateLog: rawConfig?.updateLog ?? join(homedir(), "试玩", "dsh-update.log"),
    backupRoot: rawConfig?.backupRoot ?? join(homedir(), "试玩", "dsh-backups"),
    allowUpgrade: rawConfig?.allowUpgrade ?? true
  };

  // ① 加载时自动修复一次：这是「守护脚本变成插件」的核心——
  //    不再需要任何人记得在 pnpm 操作后手动跑脚本。
  if (config.autoRepair) {
    try {
      const result = repair(config);
      const kept = result.steps.filter((line) => !line.startsWith("已一致")).length;
      process.stderr.write(
        `[dsh-maintenance] 自动守护：${result.changed ? `已修复 ${kept} 处` : "环境正确，无需改动"}` +
        `（守护对象 ${config.guardedPlugin}：${result.after.guarded.loadable ? "可加载" : "不可加载"}）\n`
      );
    } catch (error) {
      process.stderr.write(`[dsh-maintenance] 自动守护失败: ${error?.message ?? error}\n`);
    }
  }

  // ② 模型入口：四个工具。逐个注册，互不牵连。
  for (const factory of [versionTool, checkUpdateTool, repairTool, upgradeTool]) {
    try {
      const tool = factory(config);
      ctx.tools.register(tool);
      process.stderr.write(`[dsh-maintenance] 已注册工具 ${tool.name}\n`);
    } catch (error) {
      process.stderr.write(`[dsh-maintenance] 工具注册失败: ${error?.message ?? error}\n`);
    }
  }

  // ③ 界面入口：共享 `/api` 通道（自带鉴权栅栏，handler 不必自己校验 token）。
  try {
    ctx.effect(
      () => ctx.connection.fetch.register({
        path: API_PREFIX,
        methods: ["GET", "POST"],
        requestBody: "buffered",
        fetch: async (request) => {
          const url = new URL(request.url, "http://localhost");
          const action = url.searchParams.get("action") ?? (request.method === "GET" ? "status" : "");
          try {
            // 本地快照：不碰网络，界面打开即可用。
            if (action === "status" || action === "version") {
              return Response.json({ ok: true, ...(await statusPayload(config)) });
            }
            // 显式检查更新：带一次 registry 请求。
            if (action === "check-update" || action === "refresh") {
              return Response.json({ ok: true, ...(await statusPayload(config, { network: true })) });
            }
            if (action === "upgrade-status") {
              return Response.json({
                ok: true,
                upgrade: {
                  running: upgradeJob.running,
                  exitCode: upgradeJob.exitCode ?? null,
                  target: upgradeJob.target ?? null,
                  startedAt: upgradeJob.startedAt ?? null,
                  error: upgradeJob.error ?? null,
                  backup: upgradeJob.backup ?? null
                },
                runningVersion: STARTED_VERSION.version,
                onDiskVersion: resolveDshVersion().version,
                restartRequired: resolveDshVersion().version !== STARTED_VERSION.version,
                log: tailFile(config.updateLog, 40)
              });
            }
            if (action === "plugin-compat") {
              return Response.json({ ok: true, ...pluginCompat() });
            }
            if (action === "plugin-align" || action === "plugin-restore") {
              return Response.json(await runAlignScript(config, action === "plugin-restore"));
            }
            if (action === "upgrade") {
              const version = url.searchParams.get("version");
              if (!version) return Response.json({ ok: false, error: "缺少 version 参数" }, { status: 400 });
              const result = startUpgrade(config, version);
              return Response.json(result, { status: result.ok ? 200 : 400 });
            }
            if (action === "restart") {
              const result = startRestart(config);
              return Response.json(result, { status: result.ok ? 200 : 400 });
            }
            if (action === "repair") {
              const result = repair(config);
              return Response.json({ ok: true, changed: result.changed, steps: result.steps, healthy: result.after.healthy });
            }
            if (action === "log") {
              return Response.json({ ok: true, ...tailFile(config.updateLog, 40) });
            }
            // 布局探针：本机没有浏览器，agent 看不到真实渲染结果。
            // 客户端把 getBoundingClientRect 量到的几何 POST 到这里落盘，agent 再读文件。
            // 纯诊断，不参与任何 UI 行为。
            if (action === "report-layout") {
              const probePath = join(dirname(config.updateLog), "dsh-layout-probe.json");
              let payload;
              try {
                payload = await request.json();
              } catch {
                payload = { error: "body 不是合法 JSON" };
              }
              try {
                writeFileSync(probePath, JSON.stringify(payload, null, 2));
              } catch (error) {
                return Response.json({ ok: false, error: String(error?.message ?? error) }, { status: 500 });
              }
              return Response.json({ ok: true, path: probePath });
            }
            if (action === "layout-probe") {
              const probePath = join(dirname(config.updateLog), "dsh-layout-probe.json");
              if (!existsSync(probePath)) return Response.json({ ok: true, probe: null });
              try {
                return Response.json({ ok: true, probe: JSON.parse(readFileSync(probePath, "utf8")) });
              } catch (error) {
                return Response.json({ ok: false, error: String(error?.message ?? error) }, { status: 500 });
              }
            }
            return Response.json({ ok: false, error: `未知 action: ${action}` }, { status: 400 });
          } catch (error) {
            return Response.json({ ok: false, error: String(error?.message ?? error) }, { status: 500 });
          }
        }
      }),
      `dsh-maintenance: ${API_PREFIX}`
    );
    process.stderr.write(`[dsh-maintenance] 接口已注册（GET/POST ${API_PREFIX}）\n`);
  } catch (error) {
    process.stderr.write(`[dsh-maintenance] 接口注册失败: ${error?.message ?? error}\n`);
  }
}

export { Config, apply, inject, name };
