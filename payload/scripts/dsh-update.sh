#!/data/data/dev.dsh.harness/files/usr/bin/bash
# 由 dsh-shell-b 载荷提供：App 里「更新引擎并重启」真正干活的脚本。
# 传一个版本号（或 latest）。
#
# 和 Termux 里的区别：那边升级的是 Termux 前缀里 npm 装的 DSH，这边升级的是 App 私有目录
# 里随载荷带的 prefix。流程一样：备份 → npm install -g → 重打我们的载荷补丁 → 重启引擎。
#
# 0.9.2 起：全程把进度写进 ~/试玩/.dsh-update-state.json，插件读它，面板就能显示
# 「现在在干嘛 / 到哪一步了 / 卡住时最后几行日志」—— 而不是一个转圈转到天荒地老。
set -uo pipefail

ROOT="/data/data/dev.dsh.harness/files"
PREFIX_DIR="$ROOT/usr"
export HOME="$ROOT/home"
export TMPDIR="$HOME/tmp"
export PREFIX="$PREFIX_DIR"
export PATH="$PREFIX_DIR/bin:$PATH"
export LD_LIBRARY_PATH="$PREFIX_DIR/lib"
export TZ="${TZ:-Asia/Shanghai}"
mkdir -p "$TMPDIR" "$HOME/试玩/dsh-backups"

TARGET="${1:-latest}"
FLAG="$HOME/试玩/.dsh-updating"
STATE="$HOME/试玩/.dsh-update-state.json"
LOG="$HOME/试玩/dsh-update.log"
DSH_DIR="$PREFIX_DIR/lib/node_modules/@deepseek-ai/dsh"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$HOME/试玩/dsh-backups/dsh-$STAMP"
STARTED="$(date +%s)"

CUR="$(node -p "require('$DSH_DIR/package.json').version" 2>/dev/null || echo unknown)"
NEW_VER=""

log() { printf '%s %s\n' "$(date '+%m-%d %H:%M:%S')" "$*" >>"$LOG"; echo "$*"; }

# stage <阶段id> <给人看的一句话> <百分比> [done]
# 每步覆盖写一次状态文件；面板据此画进度条与步骤清单。
stage() {
  local id="$1" label="$2" pct="$3" done_flag="${4:-false}" err="${5:-}"
  printf '{"stage":"%s","label":"%s","pct":%s,"target":"%s","from":"%s","to":"%s","startedAt":%s,"updatedAt":%s,"done":%s,"error":%s}\n' \
    "$id" "$label" "$pct" "$TARGET" "$CUR" "$NEW_VER" "$STARTED" "$(date +%s)" "$done_flag" \
    "$([ -n "$err" ] && printf '"%s"' "$err" || printf 'null')" > "$STATE"
}

on_exit() {
  local rc=$?
  rm -f "$FLAG"
  if [ $rc -ne 0 ]; then
    stage "error" "升级中断（退出码 $rc）" 100 false "退出码 $rc"
  fi
}
trap on_exit EXIT INT TERM

rm -f "$FLAG"
printf '%s 开始更新 → %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$TARGET" > "$FLAG"

stage "prepare" "检查环境（当前 $CUR → $TARGET）" 3
log "== 开始升级 → $TARGET（当前 $CUR）"

if [ ! -x "$PREFIX_DIR/bin/npm" ]; then
  log "载荷里没有可执行的 npm，放弃"
  stage "error" "载荷里没有可执行的 npm" 100 false "缺少 npm"
  exit 3
fi

stage "backup" "备份旧引擎（889 MB，约 10–30 秒）" 10
mkdir -p "$BACKUP"
if ! cp -a "$DSH_DIR" "$BACKUP/dsh"; then
  log "备份失败，放弃升级（不敢在没有退路的情况下覆盖）"
  stage "error" "备份失败，已放弃（磁盘没被改动）" 100 false "cp -a 失败"
  exit 4
fi
log "旧版本已备份到 $BACKUP/dsh"
stage "backup" "旧引擎已备份，开始下载新版本" 28

stage "install" "npm 安装 @deepseek-ai/dsh@$TARGET（最慢的一步，没有进度输出）" 35
npm install -g "@deepseek-ai/dsh@$TARGET" --prefix "$PREFIX_DIR" --no-audit --no-fund --loglevel=warn >>"$LOG" 2>&1
RC=$?
tail -n 8 "$LOG" | sed 's/^/  /'
if [ $RC -ne 0 ]; then
  stage "rollback" "安装失败，正在回滚到备份" 80
  log "npm 安装失败（rc=$RC）—— 回滚到备份"
  rm -rf "$DSH_DIR"
  cp -a "$BACKUP/dsh" "$DSH_DIR"
  ROLLED="$(node -p "require('$DSH_DIR/package.json').version" 2>/dev/null || echo unknown)"
  log "已回滚，磁盘版本 $ROLLED"
  stage "error" "安装失败，已回滚到 $ROLLED" 100 false "npm rc=$RC"
  exit 1
fi

NEW_VER="$(node -p "require('$DSH_DIR/package.json').version" 2>/dev/null || echo unknown)"
log "安装完成，磁盘版本 $NEW_VER"
stage "patch" "重新应用我们的载荷补丁（侧栏浏览器）" 78

PATCHER="$HOME/试玩/patch-payload.mjs"
if [ -f "$PATCHER" ]; then
  if node "$PATCHER" "$ROOT" >>"$LOG" 2>&1; then
    log "载荷补丁已重新应用"
    stage "patch" "载荷补丁已应用" 84
  else
    log "警告：载荷补丁没完全应用（新版本可能改了锚点），内置浏览器可能失效"
    stage "patch" "载荷补丁只应用了一部分（锚点可能变了）" 84
  fi
else
  log "警告：找不到 $PATCHER，跳过载荷补丁"
fi

stage "prune" "清理旧备份（只留最近 3 份）" 88
ls -1dt "$HOME/试玩/dsh-backups"/dsh-* 2>/dev/null | tail -n +4 | while IFS= read -r old; do
  rm -rf "$old" && log "清理旧备份 $old"
done

stage "restart" "重启引擎（页面几秒后自动回来）" 93
log "升级完成，重启引擎"
if [ -x "$HOME/dsh-restart.sh" ]; then
  bash "$HOME/dsh-restart.sh" >>"$LOG" 2>&1
else
  log "警告：找不到 $HOME/dsh-restart.sh，需要手动重启 App"
fi

stage "done" "完成：$CUR → $NEW_VER" 100 true
log "== 全部完成"
