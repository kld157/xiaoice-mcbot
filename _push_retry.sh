#!/bin/bash
# 推送本仓库到 GitHub：优先走 REST API（gh_push.py），不通再回退 git push。
#
# 为什么要 API：这台机器连 github.com:443 的 git 智能协议经常超时/掐断，
# 但 api.github.com 是通的，所以用 Git Data API 把对象一层层灌上去。
# 重建出来的 commit SHA 与本地完全一致，不会改写历史。
#
# 用法: ./_push_retry.sh [最多尝试次数] [间隔秒]
# token: 环境变量 GH_TOKEN / GITHUB_TOKEN，或本目录 .gh_token（已 gitignore）

cd "$(dirname "$0")" || exit 2

MAX=${1:-3}
GAP=${2:-30}
LOG=../_scratch/push_retry.log
mkdir -p ../_scratch

for i in $(seq 1 "$MAX"); do
  echo "[$(date '+%F %T')] try $i/$MAX (api)" >> "$LOG"

  # ① 先走 API
  out=$(timeout 180 python3 gh_push.py 2>&1)
  rc=$?
  echo "$out" >> "$LOG"
  if echo "$out" | grep -q "^PUSH_OK"; then
    echo "$out" | grep "^PUSH_OK"
    exit 0
  fi

  # ② 回退：直连 git push（短超时，别傻等）
  echo "[$(date '+%F %T')] api failed, fallback to git push" >> "$LOG"
  out=$(GIT_TERMINAL_PROMPT=0 timeout 90 \
        git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=15 \
        push origin HEAD:main 2>&1)
  rc=$?
  echo "$out" >> "$LOG"
  if [ $rc -eq 0 ]; then
    echo "[$(date '+%F %T')] PUSH_OK (git)" >> "$LOG"
    echo "PUSH_OK (git)"
    exit 0
  fi
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
