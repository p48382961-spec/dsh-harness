#!/data/data/com.termux/files/usr/bin/bash
R=/data/data/com.termux/files/home/试玩/dsh-shell-b/test/rootfs
mkdir -p "$R/home/tmp"
export LD_LIBRARY_PATH="$R/usr/lib"
export HOME="$R/home" DSH_HOME="$R/home/.dsh" TMPDIR="$R/home/tmp"
export PATH="$R/usr/bin:/system/bin:/system/xbin"
cd "$R/home" || exit 1
exec /system/bin/linker64 "$R/usr/bin/node" --expose-internals "$R/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js" web --port 3082
