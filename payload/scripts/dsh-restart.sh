#!/data/data/dev.dsh.harness/files/usr/bin/bash
# 由 dsh-shell-b 载荷提供：「重启 DSH」在 App 里的正确含义。
#
# Termux 版的 dsh-restart.sh 会自己 exec 一个新服务进程；App 里不行 —— 引擎是
# EngineService 前台服务掌管的孩子，外部脚本只负责「把它放倒」，看门狗
# （EngineService.startSupervisor，5 秒一轮）会把它重新拉起来，拉起来之后
# MainActivity 通过 Engine.onRestarted 回调把页面重新加载。
#
# 所以这个脚本只做一件事：按 files/engine.pid 精确杀引擎，不猜、不用 pkill -f
# （pkill -f 会连执行它的 shell 一起杀掉，本项目已经踩过三次）。
set -uo pipefail

ROOT="/data/data/dev.dsh.harness/files"
PIDFILE="$ROOT/engine.pid"
LOGFILE="$ROOT/home/试玩/dsh-update.log"

log() { printf '%s %s\n' "$(date '+%m-%d %H:%M:%S')" "$*" >>"$LOGFILE"; echo "$*"; }

if [ ! -f "$PIDFILE" ]; then
  log "重启：没有 engine.pid，改由 App 看门狗自行判断"
  exit 0
fi

PID="$(tr -dc '0-9' < "$PIDFILE")"
case "$PID" in
  ''|*[!0-9]*) log "重启：engine.pid 内容不合法（$(cat "$PIDFILE" 2>/dev/null)）"; exit 0 ;;
esac

# 校验这个 pid 真的是我们的引擎（防 pid 复用误杀别人）
if ! tr '\0' ' ' < "/proc/$PID/cmdline" 2>/dev/null | grep -q "$ROOT/usr"; then
  log "重启：pid $PID 已经不是我们的引擎（cmdline 不匹配），跳过"
  exit 0
fi

log "重启：向引擎 pid $PID 发 SIGTERM，等看门狗拉起"
kill -TERM "$PID" 2>/dev/null || true

# 最多等 10 秒确认它真的走了；不走就补一刀
for i in $(seq 1 20); do
  if ! kill -0 "$PID" 2>/dev/null; then
    log "重启：引擎已退出（等了 $((i * 500)) ms）"
    exit 0
  fi
  sleep 0.5
done
log "重启：SIGTERM 没生效，改用 SIGKILL"
kill -KILL "$PID" 2>/dev/null || true
exit 0
