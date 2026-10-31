#!/bin/sh
# install_mineflayer.sh — 一键安装 / 校验 mineflayer 运行环境（幂等，可重复执行）
#
# 用法：
#   sh mcbot/install_mineflayer.sh              # 缺什么装什么
#   sh mcbot/install_mineflayer.sh --force      # 强制重装（删掉 node_modules 里的包再装）
#   MINEFLAYER_VERSION=4.39.0 sh mcbot/install_mineflayer.sh   # 锁版本
#
# 退出码：0 = 环境可用；1 = 失败（附原因）

set -u

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

# 工作区根目录（package.json 所在处）
ROOT=$(cd "$(dirname "$0")/.." && pwd) || exit 1
cd "$ROOT" || exit 1

MF_VER="${MINEFLAYER_VERSION:-}"
PF_VER="${MINEFLAYER_PATHFINDER_VERSION:-}"

log()  { echo "[install] $*"; }
warn() { echo "[install][warn] $*" >&2; }
die()  { echo "[install][ERROR] $*" >&2; exit 1; }

# ---------- 1. Node / npm ----------
command -v node >/dev/null 2>&1 || die "没找到 node，请先安装 Node.js >= 18（推荐 20+）"
command -v npm  >/dev/null 2>&1 || die "没找到 npm，请先安装 npm"

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
[ "$NODE_MAJOR" -ge 18 ] 2>/dev/null || warn "Node 版本偏低（$(node -v)），mineflayer 建议 >= 18"
log "node $(node -v) / npm $(npm -v)"

# ---------- 2. 依赖规格 ----------
SPEC_MF="mineflayer"
SPEC_PF="mineflayer-pathfinder"
[ -n "$MF_VER" ] && SPEC_MF="mineflayer@${MF_VER}"
[ -n "$PF_VER" ] && SPEC_PF="mineflayer-pathfinder@${PF_VER}"

# ---------- 3. 是否已可用 ----------
check_require() {
  node -e "require('$1'); process.exit(0)" >/dev/null 2>&1
}

if [ "$FORCE" -eq 0 ] && check_require mineflayer && check_require mineflayer-pathfinder; then
  log "mineflayer 已就绪：$(node -p "require('mineflayer/package.json').version" 2>/dev/null)"
  log "pathfinder：$(node -p "require('mineflayer-pathfinder/package.json').version" 2>/dev/null)"
  log "无需安装，直接退出 ✅"
  exit 0
fi

# ---------- 4. 安装 ----------
if [ "$FORCE" -eq 1 ]; then
  log "--force：清理旧包"
  rm -rf node_modules/mineflayer node_modules/mineflayer-pathfinder
fi

# 无 package.json 时先生成一个，避免 npm 报错
if [ ! -f package.json ]; then
  log "未找到 package.json，创建最小清单"
  printf '{\n  "private": true,\n  "dependencies": {}\n}\n' > package.json
fi

log "开始安装：${SPEC_MF} ${SPEC_PF}"
if ! npm install --no-audit --no-fund "$SPEC_MF" "$SPEC_PF"; then
  warn "常规源安装失败，尝试国内镜像重试…"
  npm install --no-audit --no-fund --registry=https://registry.npmmirror.com "$SPEC_MF" "$SPEC_PF" \
    || die "安装失败：请检查网络 / npm 代理设置（可手动执行：npm install mineflayer mineflayer-pathfinder）"
fi

# ---------- 5. 校验 ----------
check_require mineflayer || die "安装完成但 require('mineflayer') 失败"
log "mineflayer $(node -p "require('mineflayer/package.json').version") ✅"

if check_require mineflayer-pathfinder; then
  log "pathfinder $(node -p "require('mineflayer-pathfinder/package.json').version") ✅"
else
  warn "pathfinder 未就绪（寻路/挖矿类动作会不可用）"
fi

# ---------- 6. 可选：minecraft-data 版本表 ----------
if check_require minecraft-data; then
  log "minecraft-data $(node -p "require('minecraft-data/package.json').version") ✅"
else
  log "补装 minecraft-data（协议数据表，探针脚本需要）"
  npm install --no-audit --no-fund minecraft-data >/dev/null 2>&1 \
    && log "minecraft-data $(node -p "require('minecraft-data/package.json').version") ✅" \
    || warn "minecraft-data 安装失败（drift.js / chunk_scan.js 会受影响）"
fi

log "全部就绪，可以跑 mcbot/start.sh 了 Ｏ(≧▽≦)Ｏ"
exit 0
