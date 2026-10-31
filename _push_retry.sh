#!/bin/bash
# 自动重试 push：连不上 GitHub 时反复试，成功即退出 0
# 用法: ./_push_retry.sh [最多尝试次数] [间隔秒]
cd "$(dirname "$0")" || exit 2

MAX=${1:-3}
GAP=${2:-30}
LOG=../_scratch/push_retry.log
mkdir -p ../_scratch

for i in $(seq 1 "$MAX"); do
  echo "[$(date '+%F %T')] try $i/$MAX" >> "$LOG"
  # 连不上就别傻等，60s 超时 + 低速 15s 断开
  out=$(GIT_TERMINAL_PROMPT=0 timeout 90 \
        git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=15 \
        push origin HEAD 2>&1)
  rc=$?
  echo "$out" >> "$LOG"
  if [ $rc -eq 0 ]; then
    echo "[$(date '+%F %T')] PUSH_OK" >> "$LOG"
    echo "PUSH_OK"
    exit 0
  fi
  # 已经是最新（nothing to push）也算成功
  if echo "$out" | grep -q "Everything up-to-date"; then
    echo "[$(date '+%F %T')] ALREADY_UP_TO_DATE" >> "$LOG"
    echo "ALREADY_UP_TO_DATE"
    exit 0
  fi
  [ "$i" -lt "$MAX" ] && sleep "$GAP"
done

echo "[$(date '+%F %T')] PUSH_FAIL" >> "$LOG"
echo "PUSH_FAIL"
exit 1
