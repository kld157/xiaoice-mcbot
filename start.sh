#!/bin/sh
# start.sh — 薄壳。真正的逻辑在 launcher.js（v0.8.0 起，Windows 也能跑）
# 保留这个文件名是为了：老用户的 `sh start.sh`、面板里的调用、文档里的命令全都不用改。
# 原件在 archive/start.sh.pre-0.8.0.sh
DIR=$(dirname "$0")
if ! command -v node >/dev/null 2>&1; then
  echo "找不到 node，装个 Node.js 18+ 再说" >&2
  exit 1
fi
exec node "$DIR/launcher.js" start "$@"
