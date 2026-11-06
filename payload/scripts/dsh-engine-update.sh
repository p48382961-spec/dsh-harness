#!/data/data/dev.dsh.harness/files/usr/bin/bash
# 由 dsh-shell-b 载荷提供：把「官方 DSH 引擎」换成一个**已经打好补丁**的构建包。
#
# 设计原则（0.9.2 的教训）：App 里绝不再跑 npm install。npm 装的是上游原版，
# 会覆盖掉 Android 需要的补丁（flock/require-builtin/link→rename …），引擎直接起不来。
# 所以引擎包在构建机上打好补丁、冒烟验过，这里只做四件事：
#   下载 → 校验 sha256 → 解包到 staging 并冒烟 → 原子换目录 → 重启引擎
# 任何一步失败都不动现网目录；换完起不来可以跑 dsh-engine-rollback.sh 回滚。
#
# 用法：dsh-engine-update.sh <版本> <tar.gz 地址> <sha256 地址>
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
export OPENSSL_CONF="$PREFIX_DIR/etc/tls/openssl.cnf"
export SSL_CERT_FILE="$PREFIX_DIR/etc/tls/cert.pem"
export SSL_CERT_DIR="$PREFIX_DIR/etc/tls"
export TZ="${TZ:-Asia/Shanghai}"
mkdir -p "$TMPDIR" "$HOME/试玩"

VERSION="${1:-}"
TAR_URL="${2:-}"
SHA_URL="${3:-}"
[ -z "$VERSION" ] || [ -z "$TAR_URL" ] || [ -z "$SHA_URL" ] && { echo "用法: dsh-engine-update.sh <版本> <tar地址> <sha地址>"; exit 2; }

FLAG="$HOME/试玩/.dsh-updating"
STATE="$HOME/试玩/.dsh-update-state.json"
LOG="$HOME/试玩/dsh-engine-update.log"
STAMP="$(date +%Y%m%d-%H%M%S)"
WORK="$HOME/试玩/engine-work-$STAMP"
TARBALL="$WORK/engine.tar.gz"
STAGE="$WORK/stage"
STARTED="$(date +%s)"
CUR="$(node -p "require('$DSH_DIR/package.json').version" 2>/dev/null || echo unknown)"

log() { printf '%s %s\n' "$(date '+%m-%d %H:%M:%S')" "$*" >>"$LOG"; echo "$*"; }
# 把某个文件 POST 到本机 8099 服务（Termux 侧可读）——设备上没有 adb，这是唯一能远程取证的路。
push_file() {
  local file="$1" name="$2"
  [ -f "$file" ] || return 0
  node -e 'const fs=require("fs");const [f,n]=process.argv.slice(1);fetch("http://127.0.0.1:8099/upload?name="+encodeURIComponent(n),{method:"POST",body:fs.readFileSync(f)}).catch(()=>{});' "$file" "$name" >/dev/null 2>&1 &
}
stage() {
  local id="$1" label="$2" pct="$3" done_flag="${4:-false}" err="${5:-}"
  printf '{"stage":"%s","label":"%s","pct":%s,"target":"%s","from":"%s","to":"%s","startedAt":%s,"updatedAt":%s,"done":%s,"error":%s}\n' \
    "$id" "$label" "$pct" "$VERSION" "$CUR" "$VERSION" "$STARTED" "$(date +%s)" "$done_flag" \
    "$([ -n "$err" ] && printf '"%s"' "$err" || printf 'null')" > "$STATE"
  push_file "$STATE" "engine-state.json"
}
cleanup() { rm -rf "$WORK"; }
on_exit() {
  local rc=$?
  rm -f "$FLAG"
  if [ $rc -ne 0 ]; then stage "error" "引擎更新中断（退出码 $rc），现网引擎未被替换" 100 false "退出码 $rc"; fi
  push_file "$LOG" "engine-update.log"
  cleanup
}
trap on_exit EXIT INT TERM

rm -f "$FLAG"
printf '%s 开始更新引擎 → %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$VERSION" > "$FLAG"
stage "prepare" "准备（当前 $CUR → $VERSION）" 3
log "== 引擎更新 $CUR → $VERSION"
mkdir -p "$WORK" "$STAGE"

# ---------- 1. 下载 ----------
if [ -f "$TAR_URL" ]; then
  # App 侧已经用 Java 下载好了（rootfs 里的 node fetch 走不到 GitHub 时用这条路）
  stage "download" "使用 App 已下载的引擎包" 12
  log "本地引擎包：$TAR_URL"
  cp -f "$TAR_URL" "$TARBALL" || { log "复制本地引擎包失败"; exit 1; }
  stage "download" "引擎包就绪" 30
else
stage "download" "下载引擎包（约 170 MB）" 10
log "下载 $TAR_URL"
ENGINE_STATE="$STATE" ENGINE_TARGET="$VERSION" ENGINE_FROM="$CUR" ENGINE_STARTED="$STARTED" node -e '
const fs=require("fs");
const {Readable,Transform}=require("stream");
const {pipeline}=require("stream/promises");
const [url,out]=process.argv.slice(1);
(async()=>{
  const res=await fetch(url,{redirect:"follow"});
  if(!res.ok) throw new Error("HTTP "+res.status);
  const total=Number(res.headers.get("content-length")||0);
  let got=0,lastPct=-1;
  const meter=new Transform({transform(chunk,_enc,cb){
    got+=chunk.length;
    if(total>0){const pct=Math.floor(got/total*100); if(pct>=lastPct+2){lastPct=pct; console.log(`  下载 ${pct}%（${(got/1048576).toFixed(0)}/${(total/1048576).toFixed(0)} MB）`);
      // 把真实下载进度写进状态文件：面板与浮动卡片的进度条据此实时走动（10% → 30% 这一段）
      try{fs.writeFileSync(process.env.ENGINE_STATE, JSON.stringify({stage:"download",label:`下载引擎包 ${pct}%（${(got/1048576).toFixed(0)}/${(total/1048576).toFixed(0)} MB）`,pct:10+Math.round(pct*0.2),target:process.env.ENGINE_TARGET,from:process.env.ENGINE_FROM,to:process.env.ENGINE_TARGET,startedAt:Number(process.env.ENGINE_STARTED),updatedAt:Math.floor(Date.now()/1000),done:false,error:null})+"\n");}catch(e){}}
    cb(null,chunk);
  }});
  // 用 pipeline 把 web 流直接导进文件：手写 write/drain 会触发 undici 的 paused 断言
  await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(out));
  console.log(`  下载完成 ${(got/1048576).toFixed(1)} MB`);
})().catch(e=>{console.error("下载失败: "+e.message); process.exit(1)});
' "$TAR_URL" "$TARBALL" >>"$LOG" 2>&1 || { log "下载失败，放弃"; exit 1; }
stage "download" "下载完成" 30
fi

# ---------- 2. 校验 ----------
stage "verify" "校验 sha256" 36
ACTUAL="$(sha256sum "$TARBALL" | awk '{print $1}')"
if [ "$SHA_URL" = "-" ]; then
  # 本地包没有远端校验文件：靠 gzip CRC + 冒烟 + 失败自动回滚兜底
  log "本地引擎包 sha256 $ACTUAL（未比对远端）"
else
  EXPECT="$(node -e 'fetch(process.argv[1]).then(r=>r.text()).then(t=>process.stdout.write((t.trim().split(/\s+/)[0]||"")))' "$SHA_URL" 2>/dev/null)"
  if [ -z "$EXPECT" ]; then log "拿不到期望 sha256，放弃（不敢装没校验的包）"; exit 1; fi
  if [ "$EXPECT" != "$ACTUAL" ]; then log "sha256 不匹配（期望 $EXPECT 实际 $ACTUAL），放弃"; exit 1; fi
  log "sha256 校验通过 $ACTUAL"
fi
stage "verify" "校验通过" 42

# ---------- 3. 解包 + 冒烟 ----------
stage "extract" "解包到临时目录" 48
tar -xzf "$TARBALL" -C "$STAGE" >>"$LOG" 2>&1 || { log "解包失败"; exit 1; }
STAGED="$STAGE/@deepseek-ai/dsh"
[ -f "$STAGED/package.json" ] || { log "包结构不对：找不到 $STAGED/package.json"; exit 1; }
GOT="$(node -p "require('$STAGED/package.json').version" 2>/dev/null || echo unknown)"
if [ "$GOT" != "$VERSION" ]; then log "版本不符（包内 $GOT，期望 $VERSION）"; exit 1; fi
stage "smoke" "冒烟测试新引擎（起一下看能不能加载）" 62
if ! node --expose-internals "$STAGED/lib/bin.js" --version >/dev/null 2>>"$LOG"; then
  log "冒烟失败：新引擎连 --version 都跑不过，放弃替换"
  exit 1
fi
log "冒烟通过（$GOT）"
stage "smoke" "冒烟通过" 72

# ---------- 4. 原子换目录 ----------
stage "swap" "切换目录（旧版本保留，可回滚）" 80
BACKUP="$MODULES/@deepseek-ai/dsh.old-$STAMP"
mv "$DSH_DIR" "$BACKUP" || { log "备份现网目录失败"; exit 1; }
if ! mv "$STAGED" "$DSH_DIR"; then
  log "切换失败，正在还原"
  mv "$BACKUP" "$DSH_DIR"
  exit 1
fi
log "已切换，旧版本在 $BACKUP"
stage "swap" "已切换，准备重启" 88

# 只留最近 2 份旧版本，别把私有目录撑爆
ls -1dt "$MODULES/@deepseek-ai"/dsh.old-* 2>/dev/null | tail -n +3 | while IFS= read -r old; do rm -rf "$old"; done

# ---------- 5. 重启 ----------
stage "restart" "重启引擎（页面几秒后自己回来）" 93
if [ -x "$HOME/dsh-restart.sh" ]; then bash "$HOME/dsh-restart.sh" >>"$LOG" 2>&1; else log "警告：缺少 dsh-restart.sh，需要手动重启 App"; fi
stage "done" "完成：$CUR → $VERSION" 100 true
log "== 引擎更新完成"
