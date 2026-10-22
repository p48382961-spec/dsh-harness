#!/data/data/com.termux/files/usr/bin/bash
# 一条命令发版：构建 → 算 SHA-256 → 建 tag → 传 GitHub Release。
#
# 用法：bash release.sh ["额外说明"]
# 前置：
#   * ~/.gh-token 里有带 contents:write 的 GitHub token
#   * 账号有仓库写权限
#   * 已 repack 过载荷（dist/dshb-rootfs.tar.gz 存在）
set -euo pipefail
PROJ="$(cd "$(dirname "$0")" && pwd)"
OWNER="${GH_OWNER:-p48382961-spec}"
REPO="${GH_REPO:-dsh-harness}"
TOK="${GH_TOKEN:-$(cat "$HOME/.gh-token")}"
EXTRA_NOTE="${1:-}"

cd "$PROJ"
CODE=$(sed -n 's/^CODE=//p' version.txt)
NAME=$(sed -n 's/^NAME=//p' version.txt)
APK="$PROJ/dist/dshb-latest.apk"
[ -f "$APK" ] || { echo "✗ 没有 $APK，先跑 build-apk.sh" >&2; exit 1; }

SHA=$(sha256sum "$APK" | awk '{print $1}')
SIZE=$(stat -c%s "$APK")
ASSET="dsh-harness-${NAME}-arm64.apk"
echo "版本 $NAME ($CODE) · $((SIZE/1048576)) MB · sha256 ${SHA:0:16}…"

# 1) 建 release（不存在则建；已存在则复用，避免重复上传报错）
BODY=$(python3 - "$NAME" "$CODE" "$SHA" "$EXTRA_NOTE" <<'PY'
import json, sys
name, code, sha, extra = sys.argv[1:5]
body = f"""自带运行时的 Android App：不需要 Termux、不需要 root。

### 安装
1. 下载 `dsh-harness-{name}-arm64.apk`（约 243 MB，建议 Wi-Fi）
2. 允许「安装未知应用」后安装
3. 首次启动自动解包运行环境（约 60 秒）
4. 用 DeepSeek 账号登录，或填自己的 API Key

### 校验
```
sha256: {sha}
```

### 说明
{extra or '见 README。'}
"""
print(json.dumps({"tag_name": f"v{name}", "name": f"DSH Harness v{name}", "body": body,
                  "draft": False, "prerelease": False, "make_latest": "true"}))
PY
)
RESP=$(curl -s -X POST -H "Authorization: bearer $TOK" -H 'Accept: application/vnd.github+json' \
  "https://api.github.com/repos/$OWNER/$REPO/releases" -d "$BODY")
REL_ID=$(printf '%s' "$RESP" | python3 -c "import json,sys;print(json.load(sys.stdin).get('id') or '')")
if [ -z "$REL_ID" ]; then
  # tag 已存在：取现成的 release
  REL_ID=$(curl -s -H "Authorization: bearer $TOK" "https://api.github.com/repos/$OWNER/$REPO/releases/tags/v$NAME" \
    | python3 -c "import json,sys;print(json.load(sys.stdin).get('id') or '')")
fi
[ -n "$REL_ID" ] || { echo "✗ 建 release 失败：$RESP" >&2; exit 1; }
echo "release id=$REL_ID"

# 2) 传资产（同名先删，保证可重跑）
for f in "$APK" "$PROJ/dist/dshb-latest.apk.sha256"; do
  [ -f "$f" ] || continue
  UP_NAME="$ASSET"; case "$f" in *.sha256) UP_NAME="$ASSET.sha256" ;; esac
  curl -s -H "Authorization: bearer $TOK" "https://api.github.com/repos/$OWNER/$REPO/releases/$REL_ID/assets" \
    | python3 -c "
import json,sys
name='$UP_NAME'
for a in json.load(sys.stdin):
    if a['name']==name: print(a['id'])
" | while read -r aid; do
    [ -n "$aid" ] && curl -s -X DELETE -H "Authorization: bearer $TOK" \
      "https://api.github.com/repos/$OWNER/$REPO/releases/assets/$aid" > /dev/null && echo "  删旧资产 $UP_NAME"
  done
  echo "  上传 $UP_NAME（$(( $(stat -c%s "$f") /1048576 )) MB）…"
  curl -s --progress-bar -X POST \
    -H "Authorization: bearer $TOK" \
    -H "Content-Type: application/octet-stream" \
    --data-binary "@$f" \
    "https://uploads.github.com/repos/$OWNER/$REPO/releases/$REL_ID/assets?name=$UP_NAME" \
    -o /dev/null
  echo "  完成"
done

echo "✓ https://github.com/$OWNER/$REPO/releases/tag/v$NAME"
