import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/**
 * dsh-app-release —— 查「外壳（这个 APK）」有没有新版本。
 *
 * 为什么单独一个插件：`dsh-maintenance` 查的是 npm 上的 **DSH 本体**（`@deepseek-ai/dsh`），
 * 而用户手里这个 App 的版本走的是 GitHub Releases（APK）。两者是不同的东西、不同的版本号。
 *
 * 当前版本从哪来：Java 侧启动时把 `versionName (versionCode)` 写到 `files/app-version.txt`
 * （homedir 是 `files/home`，所以文件在 `homedir/../app-version.txt`）。
 *
 * @module dsh-app-release
 */

const name = "dsh-app-release";
const inject = ["tools", "connection"];
const API_PREFIX = "/api/dsh-app-release";

const Config = z.object({
  /** GitHub 仓库（owner/repo）。 */
  repo: z.string().default("p48382961-spec/dsh-harness"),
  /** 网络超时（毫秒）。 */
  timeoutMs: z.number().default(15000)
});

/** App 私有根目录（`files/`）：homedir 是 `files/home`。 */
function filesRoot() {
  return dirname(homedir());
}

/** 读本地版本：外壳版本 + 运行环境载荷标记。 */
function localInfo() {
  const root = filesRoot();
  const read = (file) => {
    try {
      return readFileSync(join(root, file), "utf8").trim() || null;
    } catch {
      return null;
    }
  };
  return { app: read("app-version.txt"), payload: read(".rootfs-installed") };
}

/** "0.8.0" / "0.8.0 (39)" → [0,8,0]。 */
function parseVersion(value) {
  const m = String(value ?? "").match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? m.slice(1).map(Number) : null;
}

function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (x[i] !== y[i]) return x[i] - y[i];
  }
  return 0;
}

async function checkRelease(config) {
  const response = await fetch(`https://api.github.com/repos/${config.repo}/releases?per_page=20`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "dsh-harness-android" },
    signal: AbortSignal.timeout(config.timeoutMs)
  });
  if (!response.ok) throw new Error(`GitHub 返回 ${response.status}`);
  const releases = await response.json();
  const usable = releases
    .filter((r) => !r.draft && Array.isArray(r.assets))
    .map((r) => ({
      tag: String(r.tag_name ?? "").replace(/^v/, ""),
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
  const apk = latest.assets.find((a) => a.name.endsWith(".apk")) ?? null;
  const sum = latest.assets.find((a) => a.name.endsWith(".apk.sha256")) ?? null;
  return { latest, apk, sum };
}

async function buildStatus(config, { network }) {
  const local = localInfo();
  const current = parseVersion(local.app) ? local.app.replace(/\s*\(.*$/, "") : null;
  if (!network) {
    return { ok: true, current, local, checked: false };
  }
  try {
    const { latest, apk, sum } = await checkRelease(config);
    const updateAvailable = Boolean(current) && compareVersions(latest.tag, current) > 0;
    return {
      ok: true,
      current,
      local,
      checked: true,
      latest: latest.tag,
      updateAvailable,
      prerelease: latest.prerelease,
      publishedAt: latest.publishedAt,
      pageUrl: latest.pageUrl,
      notes: latest.notes,
      apkUrl: apk?.url ?? null,
      apkSize: apk?.size ?? null,
      sha256Url: sum?.url ?? null
    };
  } catch (error) {
    return { ok: false, current, local, checked: true, error: String(error?.message ?? error) };
  }
}

function summarize(status) {
  if (!status.current) {
    return "读不到外壳版本（files/app-version.txt 不存在）—— 这不是 App 里跑的？";
  }
  if (!status.checked) return `当前外壳 ${status.current}`;
  if (status.error) return `检查失败：${status.error}`;
  if (!status.updateAvailable) return `已是最新：外壳 ${status.current}（远端最新 v${status.latest}）`;
  const size = status.apkSize ? `${(status.apkSize / 1048576).toFixed(1)} MB` : "大小未知";
  return [
    `发现新版本 v${status.latest}（当前 ${status.current}，${status.prerelease ? "预发布" : "正式"}）`,
    `APK：${status.apkUrl ?? "该 release 没有 APK 资产"}（${size}）`,
    status.sha256Url ? `校验：${status.sha256Url}` : "",
    `发布页：${status.pageUrl}`
  ].filter(Boolean).join("\n");
}

function versionTool(config) {
  return defineTool({
    name: "app_version",
    description: "Report this Android app shell's own version (from files/app-version.txt) plus the runtime payload marker. Read-only, no network.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          current: { type: "string" },
          payload: { type: "string" },
          note: { type: "string", required: true }
        }
      },
      render: (_args, value) => [{ type: "text", text: value.note }]
    },
    async execute() {
      const status = await buildStatus(config, { network: false });
      return { current: status.current, payload: status.local.payload, note: summarize(status) + (status.local.payload ? `；载荷 ${status.local.payload}` : "") };
    },
    presentCall: () => ({ card: "generic", title: "查看 App 版本", kind: "other" })
  });
}

function checkTool(config) {
  return defineTool({
    name: "app_check_update",
    description: "Check GitHub Releases for a newer APK of this Android app shell. Returns the download URL and SHA-256 file URL; does not download or install anything.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          current: { type: "string" },
          latest: { type: "string" },
          updateAvailable: { type: "boolean", required: true },
          note: { type: "string", required: true }
        }
      },
      render: (_args, value) => [{ type: "text", text: value.note }]
    },
    async execute() {
      const status = await buildStatus(config, { network: true });
      return { ...status, updateAvailable: Boolean(status.updateAvailable), note: summarize(status) };
    },
    presentCall: () => ({ card: "generic", title: "检查 App 更新", kind: "other" })
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
