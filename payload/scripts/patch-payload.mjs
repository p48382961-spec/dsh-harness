#!/usr/bin/env node
// 给 B 路线的载荷打我们自己的补丁。
//
// 和 A 路线 ../dsh-android-patch.mjs 的关系：那边是 15 条规则、打在 Termux 里 npm 装的
// DSH 上；这边只用得上其中「跟 Android 平台无关、纯产品行为」的部分 —— 因为上游快照
// 已经自己解决了 flock / session-persistence / attachment / fs-local / ripgrep 这些
// 平台适配（对照表见 dsh-route-b-preflight.md 第 5 节），我们没必要重复打。
//
// 现在收进来的只有侧栏内置浏览器两条（用户要的「我们自己折腾的内置浏览器」）。
// 用法：node patch-payload.mjs <快照根目录>    例：node patch-payload.mjs ../refs/snapshot/full
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.argv[2];
if (!ROOT || !existsSync(ROOT)) {
  console.error('用法: node patch-payload.mjs <快照根目录>');
  process.exit(2);
}
const DEPS = join(ROOT, 'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai');
const PKG = join(ROOT, 'usr/lib/node_modules/@deepseek-ai/dsh');

function sub(s, old, neu, label) {
  if (!s.includes(old)) throw new Error(`锚点没命中：${label}\n  找：${old.slice(0, 90)}`);
  return s.replace(old, neu);
}

const RULES = [
  {
    // 侧栏「浏览器」标签页的地址栏只接受完整 URL。中文用户第一反应是敲关键词，
    // 而 new URL("https://今天天气") 会被 IDN 规则补成合法主机名（不抛错），
    // 所以不能靠 catch 兜底 —— 必须在解析前先判断「像不像网址」，不像就转百度搜索。
    name: 'SB sidebar browser address -> search fallback',
    file: join(DEPS, 'dsh-client-ui-sidebar-browser', 'lib', 'client.js'),
    detect: '__dshSearchFallback',
    edits: [
      {
        label: 'non-URL input -> Baidu search',
        old: 'const candidate = /^[A-Za-z][A-Za-z\\d+.-]*:(?!\\d+(?:[/?#]|$))/u.test(trimmed) ? trimmed : `https://${trimmed}`;',
        neu:
          '/* __dshSearchFallback: 非网址输入 -> 百度搜索 */\n' +
          '\t\t\tconst __urlish = /^[A-Za-z][A-Za-z\\d+.-]*:(?!\\d+(?:[/?#]|$))/u.test(trimmed) || /^[^\\s/?#]+\\.[A-Za-z]{2,}(?:[/?#:]|$)/u.test(trimmed) || /^localhost(?:[:/]|$)/.test(trimmed);\n' +
          '\t\t\tif (!__urlish) return { ok: true, target: { kind: "https", url: `https://www.baidu.com/s?wd=${encodeURIComponent(trimmed)}`, title: trimmed } };\n' +
          '\t\t\tconst candidate = /^[A-Za-z][A-Za-z\\d+.-]*:(?!\\d+(?:[/?#]|$))/u.test(trimmed) ? trimmed : `https://${trimmed}`;',
      },
    ],
  },
  {
    // 地址栏占位文案（纯观感）。载荷里的中文字面量是 \uXXXX 转义形式，不是裸中文。
    name: 'SB sidebar browser placeholder -> 网址或搜索词',
    file: join(DEPS, 'dsh-client-ui-sidebar-browser', 'lib', 'client.js'),
    detect: '__dshAddrPlaceholder',
    edits: [
      { label: 'placeholder zh', optional: true,
        old: '"address.placeholder": "\\u8F93\\u5165 HTTP(S) \\u5730\\u5740"',
        neu: '"address.placeholder": "\\u8F93\\u5165\\u7F51\\u5740\\u6216\\u641C\\u7D22\\u8BCD" /* __dshAddrPlaceholder */' },
      { label: 'placeholder en', optional: true,
        old: '"address.placeholder": "Enter an HTTP(S) address"',
        neu: '"address.placeholder": "Enter a URL or search term" /* __dshAddrPlaceholder */' },
    ],
  },
  {
    // 上游把 iframe 的 sandbox 写死成固定策略，注释也很直白：
    //   "top navigation and downloads are not granted directly"
    // 缺 allow-downloads 时，沙箱 iframe 里的下载会被浏览器静默丢弃 ——
    // 不报错、不弹窗，表现就是「点下载链接完全没反应」。
    name: 'SB sidebar browser allow-downloads',
    file: join(DEPS, 'dsh-client-ui-sidebar-browser', 'lib', 'client.js'),
    detect: '__dshAllowDownloads',
    edits: [{
      label: 'add allow-downloads to iframe sandbox',
      old: '"allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox"',
      neu: '"allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads" /* __dshAllowDownloads */',
    }],
  },
];

let ok = 0, skipped = 0, failed = 0;
console.log('payload: ' + ROOT);
for (const rule of RULES) {
  if (!existsSync(rule.file)) { console.log('SKIP (缺文件): ' + rule.name); skipped++; continue; }
  let s = readFileSync(rule.file, 'utf8');
  if (s.includes(rule.detect)) { console.log('OK 已打过: ' + rule.name); skipped++; continue; }
  try {
    for (const e of rule.edits) {
      if (e.optional && !s.includes(e.old)) { console.log('  · 跳过（可选锚点不在）: ' + e.label); continue; }
      s = sub(s, e.old, e.neu, rule.name + ' / ' + e.label);
    }
    writeFileSync(rule.file, s);
    console.log('PATCHED: ' + rule.name);
    ok++;
  } catch (err) {
    console.error('FAIL: ' + rule.name + '\n  ' + err.message.split('\n').join('\n  '));
    failed++;
  }
}
console.log(`\n结果：patched=${ok} skipped=${skipped} failed=${failed}`);
if (failed > 0) process.exit(1);
