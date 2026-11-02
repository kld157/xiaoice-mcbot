#!/usr/bin/env bash
# MC 陪玩面板（astrbot_plugin_mc_panel）：本机安装目录 ⇄ 独立仓库
#
# 用法：
#   ./sync_panel.sh              拉取仓库最新版到本机插件目录（默认动作）
#   ./sync_panel.sh --status     看看本地改动 / 落后几个提交，不实际改动
#   ./sync_panel.sh --push "msg" 把本机插件目录里的改动提交并推回 GitHub
#   ./sync_panel.sh --tag v1.0.3 打 tag 并推送（发布用，之后去 GitHub 发 Release）
#
# 插件本体现在住在 https://github.com/kld157/astrbot_plugin_mc_panel
# 改代码可以直接改本机安装目录里那份，再用 --push 推回去。

set -euo pipefail

PLUGIN_DIR="${PLUGIN_DIR:-/AstrBot/data/plugins/astrbot_plugin_mc_panel}"
REPO_HTTPS="https://github.com/kld157/astrbot_plugin_mc_panel.git"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOKEN_FILE="$HERE/.gh_token"

note() { printf '\033[36m[panel]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[panel]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m[panel]\033[0m %s\n' "$*" >&2; exit 1; }

auth_url() {
  [ -f "$TOKEN_FILE" ] || die "找不到 $TOKEN_FILE，没法认证推送"
  local tok; tok="$(tr -d ' \r\n' < "$TOKEN_FILE")"
  printf 'https://x-access-token:%s@github.com/kld157/astrbot_plugin_mc_panel.git' "$tok"
}

ensure_clone() {
  if [ ! -d "$PLUGIN_DIR/.git" ]; then
    warn "本机插件目录不是 git 仓库（或是插件市场装的），重新 clone 一份"
    [ -d "$PLUGIN_DIR" ] && mv "$PLUGIN_DIR" "${PLUGIN_DIR}.bak.$(date +%s)"
    git clone "$REPO_HTTPS" "$PLUGIN_DIR"
  fi
  # 容器里通常没有全局 git 身份，缺了就用本仓库局部配置兜底
  git -C "$PLUGIN_DIR" config user.name  >/dev/null 2>&1 || git -C "$PLUGIN_DIR" config user.name  "kld157"
  git -C "$PLUGIN_DIR" config user.email >/dev/null 2>&1 || git -C "$PLUGIN_DIR" config user.email "kld157@users.noreply.github.com"
}

reload_hint() {
  note "代码已就位。去 AstrBot 管理面板 → 插件管理 → 对「MC 陪玩面板」点重载（或重启 AstrBot），页面才会用上新代码。"
}

cmd_status() {
  ensure_clone
  cd "$PLUGIN_DIR"
  git fetch -q origin
  echo "目录：$PLUGIN_DIR"
  echo "当前分支：$(git rev-parse --abbrev-ref HEAD)   HEAD：$(git log -1 --format='%h %s')"
  local ahead behind
  ahead=$(git rev-list --count "origin/main..HEAD")
  behind=$(git rev-list --count "HEAD..origin/main")
  echo "未推送提交：$ahead    落后远端：$behind"
  if [ -n "$(git status --porcelain)" ]; then
    echo "本地改动："
    git status --short
  else
    echo "本地改动：无"
  fi
  echo "最新 tag：$(git describe --tags --abbrev=0 2>/dev/null || echo 无)"
}

cmd_pull() {
  ensure_clone
  cd "$PLUGIN_DIR"
  if ! git fetch -q origin; then
    warn "连不上 github.com（这条线路经常被卡），过会儿再试"
    exit 1
  fi
  # 历史对不上但工作区内容其实和远端一致（比如改动是走 API 提交的），直接对齐，无损
  if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ] && git diff --quiet origin/main -- .; then
    git reset --hard -q origin/main
    note "已与远端对齐：$(git log -1 --format='%h %s')"
  fi
  if [ -n "$(git status --porcelain)" ]; then
    die "本地有未提交改动，先 --push 推上去，或手动 stash 后再拉"
  fi
  local before; before="$(git rev-parse --short HEAD)"
  git pull -q --ff-only origin main
  local after; after="$(git rev-parse --short HEAD)"
  if [ "$before" = "$after" ]; then
    note "已经是最新（$after）"
  else
    note "更新：$before → $after"
    git log --oneline "$before..$after" | sed 's/^/  /'
    echo
    head -n 12 CHANGELOG.md
  fi
  reload_hint
}

cmd_push() {
  local msg="${1:-}"
  [ -n "$msg" ] || die "给个提交说明，例如：./sync_panel.sh --push \"feat: 面板加个按钮\""
  ensure_clone
  cd "$PLUGIN_DIR"
  if [ -z "$(git status --porcelain)" ]; then
    note "没有改动，不用推"
    return 0
  fi
  git add -A
  git commit -q -m "$msg"
  git push -q "$(auth_url)" HEAD:main
  note "已推送：$(git log -1 --format='%h %s')"
  note "别忘了顺手更新 CHANGELOG.md 和 metadata.yaml 里的 version"
}

cmd_tag() {
  local tag="${1:-}"
  [ -n "$tag" ] || die "给个 tag，例如：./sync_panel.sh --tag v1.0.3"
  cd "$PLUGIN_DIR"
  git tag -a "$tag" -m "$tag" 2>/dev/null || git tag "$tag"
  git push -q "$(auth_url)" "refs/tags/$tag"
  note "tag $tag 已推到 GitHub，接着去 https://github.com/kld157/astrbot_plugin_mc_panel/releases/new?tag=$tag 发 Release"
}

case "${1:-}" in
  ""|--pull)     cmd_pull ;;
  --status)      cmd_status ;;
  --push)        shift; cmd_push "${1:-}" ;;
  --tag)         shift; cmd_tag "${1:-}" ;;
  -h|--help)     sed -n '2,12p' "$0" ;;
  *)             die "不认识的参数：$1（用 --help 看用法）" ;;
esac
