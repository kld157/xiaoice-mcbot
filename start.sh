#!/bin/sh
# start.sh — 安全启动/重启 play.js（不误杀自己）
cd "$(dirname "$0")" || exit 1
# 真实连接参数（服务器地址/账号密码）放 mc.env，不进仓库
if [ -f ./mc.env ]; then
  set -a; . ./mc.env; set +a
elif [ -f "$(dirname "$0")/mc.env" ]; then
  set -a; . "$(dirname "$0")/mc.env"; set +a
fi

# 自主决策间隔：5 分钟
MC_AUTO_MS=300000
export MC_AUTO_MS
# 内存红线：V8 老生代最多 1GB，配合 play.js 里的 MEM 看门狗，绝不会再把整机吃到 96%
MC_HEAP_SOFT=${MC_HEAP_SOFT:-419430400}
MC_HEAP_HARD=${MC_HEAP_HARD:-734003200}
export MC_HEAP_SOFT MC_HEAP_HARD
NODE_OPTIONS="--max-old-space-size=1024"
export NODE_OPTIONS

# 只认"node 跑的那个 play.js"：否则任何命令行里带 play.js 的进程（node --check / vim / grep）
# 都会被一起杀掉，重启时容易连带砍掉自己的 shell
pidof_play() {
  for p in /proc/[0-9]*; do
    c=$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null)
    case "$c" in
      node*"play.js"*) echo "${p#/proc/}" ;;
    esac
  done
}
for p in $(pidof_play); do kill -TERM "$p"; done
sleep 2
for p in $(pidof_play); do kill -KILL "$p" 2>/dev/null; done
sleep 1
setsid nohup node --expose-gc play.js >/dev/null 2>&1 &
sleep 1
for p in $(pidof_play); do echo "started pid $p"; done
