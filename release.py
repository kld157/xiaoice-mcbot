#!/usr/bin/env python3
"""按 conventional commit 前缀自动生成 GitHub Release（不需要 PR 流程）。

用法:
  python3 release.py --dry-run                 # 只打印会上什么，不发请求
  python3 release.py -t v0.4.0                 # 建 tag + release
  python3 release.py -t v0.4.0 --name "..."    # 自定义标题
  python3 release.py -t v0.4.0 --from v0.3.0   # 指定起点（默认自动取最近一个 tag）
  python3 release.py -t v0.4.0 --note-extra notes.md   # 追加一段自定义说明

提交信息前缀映射（大小写不敏感，可带 scope，如 `feat(chest): ...`）:
  feat / add / 新增        -> 新功能
  fix / bug / 修复         -> 修复
  perf / refactor / 重构   -> 性能与重构
  docs / 文档              -> 文档
  chore / build / ci / test / style -> 其它
  无前缀                    -> 其它

token 来源：环境变量 GH_TOKEN / GITHUB_TOKEN，或本目录 .gh_token。
"""

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
API = "https://api.github.com"

CATS = [
    ("新功能", {"feat", "feature", "add", "新增", "新功能"}),
    ("修复", {"fix", "bug", "bugfix", "hotfix", "修复"}),
    ("性能与重构", {"perf", "refactor", "重构", "优化"}),
    ("文档", {"docs", "doc", "文档"}),
    ("其它", {"chore", "build", "ci", "test", "style", "revert", "其它"}),
]
ORDER = [c[0] for c in CATS]
PREFIX_RE = re.compile(r"^([a-zA-Z\u4e00-\u9fa5]+)(?:\([^)]*\))?!?\s*[:：]\s*(.+)$")


def token():
    t = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if not t:
        p = os.path.join(HERE, ".gh_token")
        if os.path.exists(p):
            t = open(p, encoding="utf-8").read().strip()
    return t


def sh(*args):
    return subprocess.run(args, cwd=HERE, capture_output=True, text=True, check=True).stdout


def repo_slug():
    url = sh("git", "remote", "get-url", "origin").strip()
    m = re.search(r"github\.com[:/](.+?)(?:\.git)?$", url)
    if not m:
        sys.exit("解析不到 origin 的 GitHub 仓库地址: " + url)
    return m.group(1)


def latest_tag():
    try:
        return sh("git", "describe", "--tags", "--abbrev=0").strip()
    except subprocess.CalledProcessError:
        return ""


def collect(since):
    rng = f"{since}..HEAD" if since else "HEAD"
    raw = sh("git", "log", rng, "--no-merges", "--date=short",
             "--pretty=format:%h\x1f%ad\x1f%s\x1f%an")
    commits = []
    for line in raw.splitlines():
        if not line.strip():
            continue
        h, d, s, a = (line.split("\x1f") + ["", "", "", ""])[:4]
        m = PREFIX_RE.match(s)
        if m:
            kind, msg = m.group(1).lower(), m.group(2).strip()
        else:
            kind, msg = "", s
        cat = next((c for c, kws in CATS if kind in kws), "其它")
        commits.append({"h": h, "d": d, "msg": msg, "raw": s, "cat": cat, "by": a})
    return commits


def build_body(commits, since, repo, extra=""):
    groups = {}
    for c in commits:
        groups.setdefault(c["cat"], []).append(c)
    lines = []
    if since:
        n = len(commits)
        lines.append(f"`{since}` 以来 {n} 个提交。\n")
    else:
        lines.append(f"共 {len(commits)} 个提交。\n")
    for cat in ORDER:
        if cat not in groups:
            continue
        lines.append(f"### {cat}")
        for c in groups[cat]:
            lines.append(f"- {c['msg']} (`{c['h']}`, {c['d']})")
        lines.append("")
    if extra.strip():
        lines.append(extra.strip())
        lines.append("")
    lines.append(f"**完整改动**：https://github.com/{repo}/compare/{since or 'HEAD'}...HEAD")
    return "\n".join(lines).strip()


def api(method, path, data=None, tok=None):
    req = urllib.request.Request(
        API + path, method=method,
        headers={"Authorization": "Bearer " + tok,
                 "Accept": "application/vnd.github+json",
                 "User-Agent": "mcbot-release",
                 "Content-Type": "application/json"},
        data=json.dumps(data).encode() if data else None)
    try:
        return json.load(urllib.request.urlopen(req, timeout=25))
    except urllib.error.HTTPError as e:
        body = e.read().decode()[:400]
        if e.code == 422 and "already_exists" in body:
            return {"SKIP": "tag 已存在"}
        sys.exit(f"API {method} {path} 失败 {e.code}: {body}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-t", "--tag", required=True, help="版本号，如 v0.4.0")
    ap.add_argument("--name", default="", help="release 标题，默认 '<tag> — 自动生成'")
    ap.add_argument("--from", dest="since", default="", help="起点 tag，默认最近一个")
    ap.add_argument("--target", default="main", help="目标分支，默认 main")
    ap.add_argument("--note-extra", default="", help="追加一段文件内容")
    ap.add_argument("--draft", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    since = a.since or latest_tag()
    repo = repo_slug()
    commits = collect(since)
    extra = open(a.note_extra, encoding="utf-8").read() if a.note_extra else ""
    body = build_body(commits, since, repo, extra)
    name = a.name or f"{a.tag} — 自动生成"

    if a.dry_run:
        print(f"repo   : {repo}")
        print(f"tag    : {a.tag}   起点: {since or '(仓库首个 commit)'}   目标: {a.target}")
        print(f"title  : {name}")
        print("-" * 60)
        print(body)
        return

    tok = token()
    if not tok:
        sys.exit("没有 token：设置 GH_TOKEN / GITHUB_TOKEN，或写入 .gh_token")
    sha = api("GET", f"/repos/{repo}/commits/{a.target}", tok=tok)["sha"]
    ref = api("POST", f"/repos/{repo}/git/refs",
              {"ref": f"refs/tags/{a.tag}", "sha": sha}, tok=tok)
    if "SKIP" not in ref:
        # fetch 常被墙；拉不到就本地补一个同名 tag，保证下次 latest_tag() 认得
        try:
            subprocess.run(["git", "fetch", "--tags", "--force", "origin"],
                           cwd=HERE, capture_output=True, timeout=20, check=True)
        except Exception:
            subprocess.run(["git", "tag", "-f", a.tag, sha], cwd=HERE,
                           capture_output=True)
            print(f"note: 远端 fetch 不通，已在本地打 tag {a.tag}")
    rel = api("POST", f"/repos/{repo}/releases",
              {"tag_name": a.tag, "name": name, "body": body,
               "target_commitish": a.target, "draft": bool(a.draft),
               "prerelease": "-" in a.tag}, tok=tok)
    print("OK", rel.get("html_url", rel))


if __name__ == "__main__":
    main()
