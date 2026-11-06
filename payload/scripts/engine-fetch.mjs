// 引擎包下载器（脚本里被 `node engine-fetch.mjs <url> <out>` 调用）。
// 之所以从 `node -e '...'` 挪成独立文件：内联源码要穿过 bash 的单引号，
// 稍微复杂一点就拼出语法错误（0.10.21/22 的引擎更新就是这么秒退的）。
import fs from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const [url, out] = process.argv.slice(2);
if (!url || !out) {
  console.error("用法: engine-fetch.mjs <url> <out>");
  process.exit(2);
}

const statePath = process.env.ENGINE_STATE;
const target = process.env.ENGINE_TARGET || "";
const from = process.env.ENGINE_FROM || "";
const started = Number(process.env.ENGINE_STARTED || Math.floor(Date.now() / 1000));

function writeState(pct, label) {
  if (!statePath) return;
  try {
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        stage: "download",
        label,
        pct,
        target,
        from,
        to: target,
        startedAt: started,
        updatedAt: Math.floor(Date.now() / 1000),
        done: false,
        error: null
      }) + "\n"
    );
  } catch {
    /* 状态写不进去不影响下载 */
  }
}

const res = await fetch(url, { redirect: "follow" });
if (!res.ok) {
  console.error(`下载失败: HTTP ${res.status}`);
  process.exit(1);
}
const total = Number(res.headers.get("content-length") || 0);
let got = 0;
let lastPct = -1;
const meter = new Transform({
  transform(chunk, _enc, cb) {
    got += chunk.length;
    if (total > 0) {
      const pct = Math.floor((got / total) * 100);
      if (pct >= lastPct + 2) {
        lastPct = pct;
        const label = `下载引擎包 ${pct}%（${(got / 1048576).toFixed(0)}/${(total / 1048576).toFixed(0)} MB）`;
        console.log("  " + label);
        writeState(10 + Math.round(pct * 0.2), label);
      }
    }
    cb(null, chunk);
  }
});

try {
  await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(out));
  console.log(`  下载完成 ${(got / 1048576).toFixed(1)} MB`);
} catch (err) {
  console.error("下载中断: " + (err && err.message ? err.message : err));
  process.exit(1);
}
