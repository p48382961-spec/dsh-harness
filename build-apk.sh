#!/data/data/com.termux/files/usr/bin/bash
# 路线 B（独立 APK）M1 构建 —— 不用 Gradle / 不用 Android SDK / 不用 CI
# 用法: bash build-apk.sh
set -euo pipefail

PROJ="$(cd "$(dirname "$0")" && pwd)"
SDK="${ANDROID_JAR_DIR:-$PROJ/../.sdk}"
ANDROID_JAR="$SDK/android.jar"
APP="$PROJ/app/src/main"
BUILD="$PROJ/build"
OUT="$PROJ/dist"

KS="$PROJ/shellb.keystore"
KS_PASS="dshbpass"
KS_ALIAS="dshb"

PKG="dev.dsh.harness"

VERSION_CODE=0
VERSION_NAME="0.0.0"
if [ -f "$PROJ/version.txt" ]; then
  # shellcheck disable=SC1091
  . "$PROJ/version.txt"
  VERSION_CODE="${CODE:-0}"
  VERSION_NAME="${NAME:-0.0.0}"
fi

MIN_SDK=26
TARGET_SDK=28

say() { printf '\n\033[1m== %s ==\033[0m\n' "$*"; }

[ -f "$ANDROID_JAR" ] || { echo "缺 android.jar: $ANDROID_JAR" >&2; exit 1; }
echo "构建 $PKG $VERSION_NAME（versionCode $VERSION_CODE）"

rm -rf "$BUILD"
# 注意：只清构建目录，别 rm -rf "$OUT" —— 里面有 242 MB 的 dshb-rootfs.tar.gz
mkdir -p "$BUILD/gen" "$BUILD/classes" "$BUILD/dex" "$OUT" "$APP/assets/engine"

say "0/6 准备 assets"
# M2 起不再打包假引擎（heartbeat 只留在 M1 的 git 历史/engine/ 目录里当证据）。
# 载荷改为：首启从 $ROOTFS_URL 下载 tar.gz，由 Rootfs.java 解包。
rm -rf "$APP/assets"; mkdir -p "$APP/assets"
echo "  assets 留空即可（aapt2 仍要这个目录）"

say "1/6 aapt2 compile（资源）"
aapt2 compile --dir "$APP/res" -o "$BUILD/res.zip"

say "2/6 aapt2 link（二进制清单 + resources.arsc + assets）"
aapt2 link \
  -o "$BUILD/base.apk" \
  -I "$ANDROID_JAR" \
  --manifest "$APP/AndroidManifest.xml" \
  --java "$BUILD/gen" \
  -A "$APP/assets" \
  --min-sdk-version "$MIN_SDK" \
  --target-sdk-version "$TARGET_SDK" \
  --version-code "$VERSION_CODE" \
  --version-name "$VERSION_NAME" \
  --auto-add-overlay \
  "$BUILD/res.zip"

say "3/6 javac（源码 → class）"
SRCS=$(find "$APP/java" "$BUILD/gen" -name '*.java')
echo "$SRCS" | sed 's/^/   /'
# shellcheck disable=SC2086
javac --release 17 -encoding UTF-8 -Xlint:-options \
  -classpath "$ANDROID_JAR" -d "$BUILD/classes" $SRCS

say "4/6 d8（class → dex）"
CLASSES=$(find "$BUILD/classes" -name '*.class')
# shellcheck disable=SC2086
d8 --lib "$ANDROID_JAR" --min-api "$MIN_SDK" --output "$BUILD/dex" $CLASSES
ls -l "$BUILD/dex"

say "5/6 把 classes.dex（+ 可选载荷）塞进 APK"
PAYLOAD="$PROJ/dist/dshb-rootfs.tar.gz"
if [ -f "$PAYLOAD" ] && [ "${SKIP_PAYLOAD:-0}" != "1" ]; then
  echo "  内嵌载荷: $(du -h "$PAYLOAD" | cut -f1) → assets/dshb-rootfs.tar.gz（store，不重复压缩）"
  python3 - "$BUILD/base.apk" "$BUILD/dex/classes.dex" "$BUILD/unsigned.apk" "$PAYLOAD" <<'PY'
import sys, zipfile, shutil, os, time
src, dex, dst, payload = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zout:
    for item in zin.infolist():
        zout.writestr(item, zin.read(item.filename))
    zout.write(dex, "classes.dex")
    # 已经是 gzip，再 deflate 一遍既费时又没收益：直接 store
    zi = zipfile.ZipInfo("assets/dshb-rootfs.tar.gz")
    zi.compress_type = zipfile.ZIP_STORED
    zi.date_time = time.localtime(os.stat(payload).st_mtime)[:6]
    zi.external_attr = 0o644 << 16
    with open(payload, "rb") as fin, zout.open(zi, "w", force_zip64=True) as fout:
        shutil.copyfileobj(fin, fout, 1024 * 1024)
print("  写出", dst)
PY
else
  echo "  跳过内嵌载荷（SKIP_PAYLOAD=1 或 dist/dshb-rootfs.tar.gz 不存在）"
  python3 - "$BUILD/base.apk" "$BUILD/dex/classes.dex" "$BUILD/unsigned.apk" <<'PY'
import sys, zipfile
src, dex, dst = sys.argv[1], sys.argv[2], sys.argv[3]
with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zout:
    for item in zin.infolist():
        zout.writestr(item, zin.read(item.filename))
    zout.write(dex, "classes.dex")
print("  写出", dst)
PY
fi

say "6/6 签名"
if [ ! -f "$KS" ]; then
  keytool -genkeypair -keystore "$KS" -alias "$KS_ALIAS" \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "$KS_PASS" -keypass "$KS_PASS" \
    -dname "CN=DSH Shell B, OU=personal, O=none, L=none, ST=none, C=CN"
  echo "  生成自签 keystore: $KS"
fi
apksigner sign \
  --ks "$KS" --ks-pass "pass:$KS_PASS" --key-pass "pass:$KS_PASS" \
  --ks-key-alias "$KS_ALIAS" \
  --out "$OUT/${PKG}-${VERSION_NAME}.apk" \
  "$BUILD/unsigned.apk"
apksigner verify --print-certs "$OUT/${PKG}-${VERSION_NAME}.apk" | head -5 || true

say "自检 + 发布到固定地址"
aapt2 dump badging "$OUT/${PKG}-${VERSION_NAME}.apk" | head -3 || true
unzip -l "$OUT/${PKG}-${VERSION_NAME}.apk" | grep -E 'assets/dshb-rootfs|classes.dex' || true

# 固定文件名：用户只需要刷新这一个地址，永远拿到最新包（下载服务带 Cache-Control: no-store）
cp -f "$OUT/${PKG}-${VERSION_NAME}.apk" "$OUT/dshb-latest.apk"
# 下载服务的 ROOT 就是这个 dist 目录（dsh-dl-server.py 里 os.path.join(脚本目录, "dsh-shell-b", "dist")）
echo "  已发布: http://127.0.0.1:8099/dshb-latest.apk  ↔  $OUT/dshb-latest.apk"

# 载荷现在整个塞进 APK 里了，每个包 243 MB —— 默认只留 dshb-latest.apk 与载荷，
# 版本号副本只在 KEEP_VERSIONED=1 时保留（历史包想留就留，但要自己管磁盘）。
if [ "${KEEP_VERSIONED:-0}" != "1" ]; then
  for f in "$OUT/${PKG}-"*.apk "$OUT/${PKG}-"*.apk.idsig; do
    [ -e "$f" ] || continue
    [ "$f" = "$OUT/${PKG}-${VERSION_NAME}.apk.idsig" ] && continue
    [ "$f" = "$OUT/${PKG}-${VERSION_NAME}.apk" ] && continue
    rm -f "$f"
  done
  # 当前版本的版本号副本与 latest 内容相同，只留 latest 省 243 MB；idsig 保留给 apksigner 校验用
  if [ "${KEEP_VERSIONED:-0}" != "1" ] && [ -f "$OUT/${PKG}-${VERSION_NAME}.apk" ]; then
    rm -f "$OUT/${PKG}-${VERSION_NAME}.apk"
  fi
fi

# 落地页 + 校验和：每次构建自动更新版本号/大小/SHA-256，避免页面和包对不上
if [ -f "$PROJ/landing.template.html" ]; then
  RENDER=$(python3 - "$PROJ/landing.template.html" "$OUT" "$PROJ/dist/index.html" "$VERSION_NAME" "$VERSION_CODE" "${PKG}-${VERSION_NAME}.apk" <<'PYLAND'
import hashlib, os, sys, time
tpl, out, dst, ver, code, apk = sys.argv[1:7]
path = os.path.join(out, "dshb-latest.apk")
size = os.path.getsize(path)
h = hashlib.sha256()
with open(path, "rb") as f:
    for chunk in iter(lambda: f.read(1 << 20), b""):
        h.update(chunk)
html = open(tpl, encoding="utf-8").read()
html = (html.replace("{{VERSION}}", ver)
            .replace("{{CODE}}", code)
            .replace("{{SIZE_MB}}", "%.0f" % (size / 1048576))
            .replace("{{SIZE_BYTES}}", format(size, ","))
            .replace("{{SHA256}}", h.hexdigest())
            .replace("{{DATE}}", time.strftime("%Y-%m-%d")))
open(dst, "w", encoding="utf-8").write(html)
open(os.path.join(out, "dshb-latest.apk.sha256"), "w").write(h.hexdigest() + "  dshb-latest.apk\n")
print("  index.html %.0f KB, sha256 %s" % (len(html) / 1024, h.hexdigest()[:16]))
PYLAND
)
  echo "$RENDER"
fi

# 构建中间产物里的 unsigned.apk 是 243 MB（含载荷），留着没意义，别让磁盘随构建次数涨
rm -rf "$BUILD"

say "完成"
ls -l "$OUT"
