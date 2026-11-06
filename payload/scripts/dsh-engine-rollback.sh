#!/data/data/dev.dsh.harness/files/usr/bin/bash
# 引擎换装后起不来时用：把最近一份 dsh.old-* 换回去。
# App 侧在连续启动失败后会自动调用它；也可以手动跑。
set -uo pipefail
ROOT="/data/data/dev.dsh.harness/files"
PREFIX_DIR="$ROOT/usr"
MODULES="$PREFIX_DIR/lib/node_modules"
DSH_DIR="$MODULES/@deepseek-ai/dsh"
export HOME="$ROOT/home"
export TMPDIR="$HOME/tmp"
export PREFIX="$PREFIX_DIR"
export PATH="$PREFIX_DIR/bin:$PATH"
export LD_LIBRARY_PATH="$PREFIX_DIR/lib"
export TZ="${TZ:-Asia/Shanghai}"
LOG="$HOME/试玩/dsh-engine-update.log"
STAMP="$(date +%Y%m%d-%H%M%S)"
log() { printf '%s %s\n' "$(date '+%m-%d %H:%M:%S')" "$*" >>"$LOG"; echo "$*"; }

OLD="$(ls -1dt "$MODULES/@deepseek-ai"/dsh.old-* 2>/dev/null | head -1)"
if [ -z "$OLD" ]; then log "没有可回滚的旧版本（dsh.old-*）"; exit 1; fi
log "回滚：$DSH_DIR ← $OLD"
if [ -d "$DSH_DIR" ]; then mv "$DSH_DIR" "$MODULES/@deepseek-ai/dsh.failed-$STAMP"; fi
mv "$OLD" "$DSH_DIR" || { log "回滚失败：移动目录出错"; exit 1; }
V="$(node -p "require('$DSH_DIR/package.json').version" 2>/dev/null || echo unknown)"
log "已回滚到 $V"
printf '{"stage":"rollback","label":"已回滚到 %s","pct":100,"target":null,"from":null,"to":"%s","startedAt":%s,"updatedAt":%s,"done":true,"error":null}\n' \
  "$V" "$V" "$(date +%s)" "$(date +%s)" > "$HOME/试玩/.dsh-update-state.json"
if [ -x "$HOME/dsh-restart.sh" ]; then bash "$HOME/dsh-restart.sh" >>"$LOG" 2>&1; fi
log "== 回滚完成"
