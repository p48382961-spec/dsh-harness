#!/data/data/dev.dsh.harness/files/usr/bin/bash
# 由 dsh-shell-b 载荷提供：App 里「检查更新 → 升级」真正干活的脚本。
# dsh-maintenance 插件按默认路径 ~/试玩/dsh-update.sh 找它，传一个版本号（或 latest）。
#
# 和 Termux 里的 dsh-update.sh 的区别：那边升级的是 Termux 前缀里 npm 装的 DSH，
# 这边升级的是 App 私有目录里随载荷带的 /data/data/dev.dsh.harness/files/usr。
# 流程一样：备份 → npm install -g 到同一个 prefix → 重打我们的载荷补丁 → 重启引擎。
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
DSH_DIR="$PREFIX_DIR/lib/node_modules/@deepseek-ai/dsh"
STAMP="$(date +%Y%m%d-%H%M%S)"
LOG="$HOME/试玩/dsh-update.log"
BACKUP="$HOME/试玩/dsh-backups/dsh-$STAMP"

log() { printf '%s %s\n' "$(date '+%m-%d %H:%M:%S')" "$*" >>"$LOG"; echo "$*"; }

CUR="$(node -p "require('$DSH_DIR/package.json').version" 2>/dev/null || echo unknown)"
log "== 开始升级 → $TARGET（当前 $CUR）"

if [ ! -x "$PREFIX_DIR/bin/npm" ]; then
  log "载荷里没有可执行的 npm，放弃"
  exit 3
fi

mkdir -p "$BACKUP"
if ! cp -a "$DSH_DIR" "$BACKUP/dsh"; then
  log "备份失败，放弃升级（不敢在没有退路的情况下覆盖）"
  exit 4
fi
log "旧版本已备份到 $BACKUP/dsh"

# npm install -g 直接覆盖 $PREFIX/lib/node_modules/@deepseek-ai/dsh
npm install -g "@deepseek-ai/dsh@$TARGET" --prefix "$PREFIX_DIR" --no-audit --no-fund --loglevel=warn >>"$LOG" 2>&1
RC=$?
tail -n 8 "$LOG" | sed 's/^/  /'
if [ $RC -ne 0 ]; then
  log "npm 安装失败（rc=$RC）—— 回滚到备份"
  rm -rf "$DSH_DIR"
  cp -a "$BACKUP/dsh" "$DSH_DIR"
  log "已回滚，磁盘版本 $(node -p "require('$DSH_DIR/package.json').version" 2>/dev/null || echo unknown)"
  exit 1
fi

NEW="$(node -p "require('$DSH_DIR/package.json').version" 2>/dev/null || echo unknown)"
log "安装完成，磁盘版本 $NEW"

# 新版会覆盖我们的载荷补丁 —— 重新打一遍（侧栏内置浏览器：搜索回落 / 允许下载 / 占位文案）
PATCHER="$HOME/试玩/patch-payload.mjs"
if [ -f "$PATCHER" ]; then
  log "重新应用载荷补丁…"
  if node "$PATCHER" "$ROOT" >>"$LOG" 2>&1; then
    log "载荷补丁已重新应用"
  else
    log "警告：载荷补丁没完全应用（新版本可能改了锚点），内置浏览器可能失效"
  fi
else
  log "警告：找不到 $PATCHER，跳过载荷补丁"
fi

# 旧版备份只留最近 3 份，别把私有目录撑爆
ls -1dt "$HOME/试玩/dsh-backups"/dsh-* 2>/dev/null | tail -n +4 | while IFS= read -r old; do
  rm -rf "$old" && log "清理旧备份 $old"
done

log "升级完成，重启引擎"
if [ -x "$HOME/dsh-restart.sh" ]; then
  bash "$HOME/dsh-restart.sh" >>"$LOG" 2>&1
else
  log "警告：找不到 $HOME/dsh-restart.sh，需要手动重启 App"
fi
