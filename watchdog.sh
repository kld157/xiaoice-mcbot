#!/bin/sh
# watchdog.sh — 常驻守护：play.js 挂了就自动拉起来（单实例）
cd "$(dirname "$0")" || exit 1

# 和 start.sh 保持一致：5 分钟决策 + 内存红线（watchdog 兜底重启时也不能丢）
MC_AUTO_MS=${MC_AUTO_MS:-300000}; export MC_AUTO_MS
MC_HEAP_SOFT=${MC_HEAP_SOFT:-419430400}; export MC_HEAP_SOFT
MC_HEAP_HARD=${MC_HEAP_HARD:-734003200}; export MC_HEAP_HARD
NODE_OPTIONS="--max-old-space-size=1024"; export NODE_OPTIONS

PIDFILE=watchdog.pid

# 单实例保护
if [ -f "$PIDFILE" ]; then
  oldpid=$(cat "$PIDFILE" 2>/dev/null)
  if [ -n "$oldpid" ] && [ -r "/proc/$oldpid/cmdline" ]; then
    if tr '\0' ' ' < "/proc/$oldpid/cmdline" | grep -q watchdog.sh; then
      echo "watchdog already running pid $oldpid"
      exit 0
    fi
  fi
fi
echo $$ > "$PIDFILE"
echo "[$(date -u +%FT%TZ)] watchdog up pid $$" >> watchdog.log

is_bot() {
  for p in /proc/[0-9]*; do
    c=$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null)
    case "$c" in
      "node play.js "*|"node --expose-gc play.js "*) return 0 ;;
    esac
  done
  return 1
}

# LLM 桥：挂了就没有"真聊天"，也要守住
is_bridge() {
  for p in /proc/[0-9]*; do
    c=$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null)
    [ "$c" = "python3 mc_bridge.py " ] && return 0
  done
  return 1
}

while true; do
  # 锁体检：.play.lock 里若是一个僵尸/已死进程，直接清掉，否则 play.js 会一直"以为有实例在跑"而秒退
  if [ -f .play.lock ]; then
    lp=$(head -1 .play.lock 2>/dev/null | tr -dc '0-9')
    lock_ok=0
    if [ -n "$lp" ] && [ -r "/proc/$lp/stat" ]; then
      st=$(awk '{print $3}' "/proc/$lp/stat" 2>/dev/null)
      lc=$(tr '\0' ' ' < "/proc/$lp/cmdline" 2>/dev/null)
      if [ "$st" != "Z" ] && [ "$st" != "X" ]; then
        case "$lc" in
          *play.js*) lock_ok=1 ;;
        esac
      fi
    fi
    if [ "$lock_ok" != 1 ]; then
      echo "[$(date -u +%FT%TZ)] watchdog: stale .play.lock (pid ${lp:-?}) removed" >> watchdog.log
      rm -f .play.lock
    fi
  fi

  if ! is_bot; then
    echo "[$(date -u +%FT%TZ)] watchdog: bot not running -> start" >> watchdog.log
    setsid nohup node --expose-gc play.js >/dev/null 2>&1 &
    sleep 15
  fi
  if ! is_bridge; then
    echo "[$(date -u +%FT%TZ)] watchdog: bridge not running -> start" >> watchdog.log
    setsid nohup python3 mc_bridge.py >/dev/null 2>&1 < /dev/null &
    sleep 5
  fi
  sleep 20
done
