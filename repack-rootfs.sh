#!/data/data/com.termux/files/usr/bin/bash
# 把上游快照重打包成"我们自己的"载荷：
#   1. 把写死的 com.dsharnessmobile.shell 换成我们的包名（cordis 配置里的 bashPath/prefix/
#      workspaceRoot、dsh-node 里的 LD_LIBRARY_PATH 与 linker64 路径，全指着它）
#   2. 写一份干净的默认设置（模型档位）；**不带任何凭据** —— 每个用户用自己的账号登录
#   3. 重新压成 tar.gz（App 里用 JDK 的 GZIPInputStream 解，Android 没有 xz）
#
# 用法: bash repack-rootfs.sh [源目录]
#   源目录默认 ../refs/snapshot/full（由 tar -xJf snapshot-arm64.tar.xz -C full 解出）
set -euo pipefail

PROJ="$(cd "$(dirname "$0")" && pwd)"
SRC="${1:-$PROJ/../refs/snapshot/full}"
OUT="$PROJ/dist/dshb-rootfs.tar.gz"
PKG="dev.dsh.harness"
OLD="com.dsharnessmobile.shell"

say() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

[ -d "$SRC/usr" ] || { echo "源目录不对: $SRC" >&2; exit 1; }
[ -d "$SRC/home/.dsh" ] || { echo "缺快照 home/.dsh" >&2; exit 1; }

say "1/4 换包名（$OLD → $PKG）"
COUNT=$(grep -rlI "$OLD" "$SRC/usr" "$SRC/home" 2>/dev/null | wc -l || true)
echo "  命中 $COUNT 个文本文件"
grep -rlI "$OLD" "$SRC/usr" "$SRC/home" 2>/dev/null \
  | while IFS= read -r f; do sed -i "s/$OLD/$PKG/g" "$f" || true; done || true
LEFT=$(grep -rlI "$OLD" "$SRC/usr" "$SRC/home" 2>/dev/null | wc -l || true)
echo "  剩余命中 $LEFT（应为 0）"

say "1b/5 换 Termux 前缀（/data/data/com.termux → /data/data/$PKG）"
# 快照是从 Termux 的 deb 包里抽出来的，usr/etc/profile、bash.bashrc、profile.d 这些
# 脚本里**硬编码**了 /data/data/com.termux/files/usr。不改的话，bash 一启动就把 PATH
# 指回 Termux 的目录（App 里根本看不见），表现为：
#   subprocess-local: command "/data/data/com.termux/files/usr/bin/bash" is not an executable file
# 只改文本文件（grep -I 跳过二进制：.so 里也有这个串，但长度一变二进制就坏）。
OLDPREFIX="/data/data/com.termux"
NEWPREFIX="/data/data/$PKG"
COUNT=$(grep -rlI "$OLDPREFIX" "$SRC/usr" "$SRC/home" 2>/dev/null | wc -l || true)
echo "  命中 $COUNT 个文本文件"
grep -rlI "$OLDPREFIX" "$SRC/usr" "$SRC/home" 2>/dev/null \
  | while IFS= read -r f; do sed -i "s|$OLDPREFIX|$NEWPREFIX|g" "$f" || true; done || true
LEFT=$(grep -rlI "$OLDPREFIX" "$SRC/usr" "$SRC/home" 2>/dev/null | wc -l || true)
echo "  剩余命中 $LEFT（应为 0）"

say "2b/5 换配置文件：只用官方原生插件，丢掉 @dsh-android/* 那套"
# 上游快照的 cordis.patch.yml 有 17 KB Android 适配，insert 了 9 个 @dsh-android 插件：
# shell-termux / host-web-compat / ui-responsive(皮肤+Shizuku UI) / android-bridge / manage /
# linux-env / file-open / browser / vdisplay。这些都要连 Kotlin 壳里的服务，我们的 Java 壳没有。
# 换成我们自己的最小补丁（profile/cordis.patch.yml），插件树回到 package.json 里声明的
# @deepseek-ai/dsh-base + @deepseek-ai/dsh-web-app 官方 bundle。
install -m 600 "$PROJ/profile/cordis.patch.yml" "$SRC/home/.dsh/profiles/web/cordis.patch.yml"
for d in "$SRC"/home/.dsh/profiles/*/node_modules/@dsh-android "$SRC"/home/.dsh/profiles/node_modules/@dsh-android; do
  [ -e "$d" ] && rm -rf "$d" && echo "  移除 $d"
done
echo "  补丁层: $(wc -c < "$SRC/home/.dsh/profiles/web/cordis.patch.yml") 字节"

say "2/4 确保载荷里没有凭据（分发给别人，每个人用自己的账号登录）"
# 之前这里会把开发者自己的 ~/.dsh/.credentials.yaml 塞进载荷 —— 那等于把自己的账号
# 和额度一起发给别人。现在反过来：删掉上游可能带的、以及本地测试残留的任何凭据。
rm -f "$SRC/home/.dsh/.credentials.yaml" "$SRC/home/.dsh/.credentials.yaml.imported"
if grep -rIl "DEEPSEEK_API_KEY\|sk-" "$SRC/home/.dsh" 2>/dev/null | head -5 | grep -q .; then
  echo "  警告：home/.dsh 里还有疑似密钥的文本：" >&2
  grep -rIl "DEEPSEEK_API_KEY\|sk-" "$SRC/home/.dsh" 2>/dev/null | head -5 >&2
fi
echo "  凭据已移除，首启会走 DSH 自己的登录流程"

say "2c/5 打我们自己的载荷补丁（侧栏内置浏览器：搜索回落 + 允许下载 + 占位文案）"
node "$PROJ/patch-payload.mjs" "$SRC" || { echo "载荷补丁失败" >&2; exit 1; }

say "2d/5 装维护/更新插件（dsh-maintenance + dsh-plugin-restart + dsh-app-release）+ 我们的升级/重启脚本"

# 用户要的「版本 / 检查更新」：Termux 里这两个插件提供了侧栏底部版本号、检查 npm 新版本、
# 一键升级、重启服务。搬到 App 里的关键不是拷文件，而是**路径要落在默认值上**：
#   ~/.dsh/profiles/web/node_modules/<plugin>      ← 插件主份
#   ~/试玩/dsh-update.sh                           ← 升级脚本（插件默认找这里）
#   ~/dsh-restart.sh                               ← 重启脚本（插件默认找这里）
# App 的 homedir 是 /data/data/dev.dsh.harness/files/home，所以正好一一对上，不用改配置。
NM="$SRC/home/.dsh/profiles/web/node_modules"
mkdir -p "$NM/@deepseek-ai" "$SRC/home/试玩"
for p in dsh-maintenance dsh-plugin-restart dsh-app-release; do
  rm -rf "$NM/$p"
  cp -a "$PROJ/payload/plugins/$p" "$NM/$p"
  echo "  插件 $p → profiles/web/node_modules/$p"
done
# 插件 import 的 @deepseek-ai/schemastery 与 dsh-tools 由 DSH 自带，profile 里没有则解析不到
for d in schemastery dsh-tools; do
  src="$SRC/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/$d"
  if [ -d "$src" ]; then
    rm -rf "$NM/@deepseek-ai/$d"; cp -a "$src" "$NM/@deepseek-ai/$d"
    echo "  依赖 @deepseek-ai/$d → profile"
  else
    echo "  警告：找不到 $src" >&2
  fi
done
cp -a "$PROJ/payload/scripts/dsh-update.sh" "$SRC/home/试玩/dsh-update.sh"
cp -a "$PROJ/payload/scripts/dsh-restart.sh" "$SRC/home/dsh-restart.sh"
cp -a "$PROJ/payload/scripts/patch-payload.mjs" "$SRC/home/试玩/patch-payload.mjs"
chmod 755 "$SRC/home/试玩/dsh-update.sh" "$SRC/home/dsh-restart.sh"
echo "  脚本 → home/试玩/dsh-update.sh、home/dsh-restart.sh、home/试玩/patch-payload.mjs"
# bundle 登记：profile 的 dsh.profile.bundles 里没有它俩，DSH 就不会加载
python3 - "$SRC/home/.dsh/profiles/web/package.json" <<'PYJSON'
import json, sys
path = sys.argv[1]
with open(path) as f:
    pkg = json.load(f)
bundles = pkg.setdefault('dsh', {}).setdefault('profile', {}).setdefault('bundles', [])
for name in ('dsh-plugin-restart', 'dsh-maintenance', 'dsh-app-release'):
    if name not in bundles:
        bundles.append(name)
with open(path, 'w') as f:
    json.dump(pkg, f, ensure_ascii=False, indent=2)
    f.write('\n')
print('  bundles: ' + ', '.join(bundles))
PYJSON

say "3/4 写模型设置"
cat > "$SRC/home/.dsh/settings.yaml" <<'YAML'
# 由 dsh-shell-b/repack-rootfs.sh 生成：模型与推理档位跟 Termux 里那个 DSH 保持一致
llm-deepseek: {}
llm-pi-ai:
  providers: {}
ui-onboarding:
  welcomeNoticeVersion: 2026-08-13.1
agent-default-model:
  provider: deepseek-official
  model: deepseek-flash
  reasoningEffort: low
YAML
chmod 600 "$SRC/home/.dsh/settings.yaml"
head -12 "$SRC/home/.dsh/settings.yaml"
# DSH 首次启动会把 settings.yaml 导入 storages/ 并改名成 .imported —— 本地冒烟测试跑过一次，
# 那些残留（storages/、.anonymous-user-id、.imported）不能进载荷，否则设备上首启就不是干净状态。
rm -rf "$SRC/home/.dsh/storages" "$SRC/home/.dsh/.anonymous-user-id" "$SRC/home/.dsh/settings.yaml.imported"
rm -rf "$SRC/home/tmp"/* 2>/dev/null || true

say "3b/5 对齐 @opentelemetry（从 npm registry 取固定版本，不再依赖开发机）"
# 证据：快照自带的 @opentelemetry 0.220 缺 dsh-otel 要的具名导出
#   SyntaxError: Named export 'LogsExporterMetricsHelper' not found
# 引擎启动即崩。这里换成 0.222/2.11 这一套（已在真机上验证可用）。
# 早期版本是直接 `cp` 开发机 Termux 里的副本 —— 那是个人环境依赖，别人克隆仓库打不出包。
DST_OTEL="$SRC/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@opentelemetry"
rm -rf "$DST_OTEL"
mkdir -p "$DST_OTEL"
OTEL_TMP=$(mktemp -d)
OTEL_SPECS="api@1.9.1 api-logs@0.222.0 core@2.11.0 otlp-exporter-base@0.222.0 otlp-transformer@0.222.0 resources@2.11.0 sdk-logs@0.222.0 sdk-metrics@2.11.0 sdk-trace@2.11.0 semantic-conventions@1.43.0"
for spec in $OTEL_SPECS; do
  pkg="${spec%@*}"
  ver="${spec##*@}"
  url="https://registry.npmjs.org/@opentelemetry/${pkg}/-/${pkg}-${ver}.tgz"
  curl -fsSL --max-time 60 "$url" -o "$OTEL_TMP/pkg.tgz" \
    || { echo "下载失败: $url" >&2; rm -rf "$OTEL_TMP"; exit 1; }
  mkdir -p "$DST_OTEL/$pkg"
  tar -xzf "$OTEL_TMP/pkg.tgz" -C "$DST_OTEL/$pkg" --strip-components=1
done
rm -rf "$OTEL_TMP"
echo "  已换成 registry 上的 $(ls "$DST_OTEL" | wc -l) 个包：otlp-transformer $(python3 -c "import json;print(json.load(open('$DST_OTEL/otlp-transformer/package.json'))['version'])")"

say "3c/5 预置一个工作区（首启就有聊天入口，不用用户手动建文件夹）"
# 我们删掉上游 @dsh-android/* 之后，没有任何东西替用户创建默认工作区了：首启打开只有
# 「选择/新建文件夹」，用户得手动建一个才能聊天。这里直接种一份 workspace.json 注册表
# （schema 见 Termux 侧 ~/.dsh/storages/workspace.json，unit version 2）。
mkdir -p "$SRC/home/workspace" "$SRC/home/.dsh/storages"
WS_UUID=$(cat /proc/sys/kernel/random/uuid)
NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
cat > "$SRC/home/.dsh/storages/workspace.json" <<JSON
{
  "unit": {
    "name": "workspace",
    "version": 2
  },
  "global": {
    "initialized": true,
    "workspaceIds": [
      "$WS_UUID"
    ],
    "archivedSessionIds": [],
    "pinnedSessionIds": []
  },
  "tables": {
    "workspaces": {
      "$WS_UUID": {
        "path": "/data/data/$PKG/files/home/workspace",
        "title": "工作区",
        "sessionIds": [],
        "createdAt": "$NOW",
        "updatedAt": "$NOW"
      }
    }
  }
}
JSON
chmod 600 "$SRC/home/.dsh/storages/workspace.json"
echo "  工作区: /data/data/$PKG/files/home/workspace"

say "4/4 重新压缩"
mkdir -p "$PROJ/dist"
rm -f "$OUT"
( cd "$SRC" && tar -czf "$OUT" usr home )
ls -l "$OUT"
echo "  用时见上面；目标: App 首启下载这个文件"

echo
echo "载荷就绪：$OUT（只在没有内置载荷的构建方式下会被下载）"
