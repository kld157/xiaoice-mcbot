#!/usr/bin/env python3
"""走 GitHub REST API 推送当前分支（绕开 git push 被墙 / 超时）。

原理：用 Git Data API 把本地 commit 的 blob / tree / commit 逐层在远端重建。
因为 git 对象哈希由内容决定，重建出来的 commit SHA 与本地完全一致，
所以推完以后本地和远端对得上，不需要也没有改写历史。

用法:
  python3 gh_push.py              # 推当前分支到 origin（覆盖远端）
  python3 gh_push.py --dry-run    # 只打印计划，不发请求
  python3 gh_push.py -b main      # 指定分支

token 来源（优先顺序）：环境变量 GH_TOKEN / GITHUB_TOKEN，或本目录 .gh_token 文件。
token 只在本机读写，绝不进仓库（.gitignore 已忽略）。
"""

import argparse
import base64
import datetime as dt
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
API = "https://api.github.com"
SIG_RE = re.compile(r"^(.*?) <(.*?)> (\d+) ([+-]\d{4})$")

_blob_done = set()
_tree_done = set()
_commit_done = set()

OWNER = REPO = BRANCH = TOKEN = ""


# ---------- 基础 ----------

def git(*args):
    """跑 git，返回 stdout 文本。文件名一律不做引号转义（中文名）。"""
    p = subprocess.run(
        ["git", "-c", "core.quotepath=false", *args],
        cwd=HERE, capture_output=True,
    )
    if p.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} 失败: {p.stderr.decode(errors='replace').strip()}")
    return p.stdout.decode(errors="surrogateescape")


def git_bytes(*args):
    p = subprocess.run(["git", *args], cwd=HERE, capture_output=True)
    if p.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} 失败: {p.stderr.decode(errors='replace').strip()}")
    return p.stdout


def api(method, path, payload=None, ok404=False):
    url = API + path
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", "Bearer " + TOKEN)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    req.add_header("User-Agent", "mcbot-gh-push")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            raw = r.read().decode() or "{}"
            return json.loads(raw)
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        if ok404 and e.code == 404:
            return None
        raise RuntimeError(f"{method} {path} -> {e.code}\n{body[:500]}")


def load_token():
    for k in ("GH_TOKEN", "GITHUB_TOKEN"):
        if os.environ.get(k, "").strip():
            return os.environ[k].strip()
    path = os.path.join(HERE, ".gh_token")
    if os.path.isfile(path):
        with open(path, "r", encoding="utf-8") as f:
            return f.read().strip()
    return ""


def parse_sig(text):
    m = SIG_RE.match(text.strip())
    if not m:
        raise RuntimeError(f"看不懂的签名行: {text!r}")
    name, email, ts, tz = m.groups()
    off = dt.timezone(dt.timedelta(hours=int(tz[:3]), minutes=int(tz[0] + tz[3:])))
    iso = dt.datetime.fromtimestamp(int(ts), off).isoformat()
    return {"name": name, "email": email, "date": iso}


# ---------- 对象重建 ----------

def ensure_tree(sha):
    """把本地 tree 递归灌到远端，返回 sha（应与本地相同）。"""
    if sha in _tree_done:
        return sha
    entries = []
    for line in git("cat-file", "-p", sha).splitlines():
        if not line.strip():
            continue
        meta, name = line.split("\t", 1)
        mode, typ, obj = meta.split()
        if typ == "blob":
            if obj not in _blob_done:
                content = git_bytes("cat-file", "blob", obj)
                r = api("POST", f"/repos/{OWNER}/{REPO}/git/blobs",
                        {"content": base64.b64encode(content).decode(), "encoding": "base64"})
                _blob_done.add(obj)
                if r["sha"] != obj:
                    raise RuntimeError(f"blob 重建后哈希不一致: {obj} != {r['sha']}")
            entries.append({"path": name, "mode": mode, "type": "blob", "sha": obj})
        elif typ == "tree":
            ensure_tree(obj)
            entries.append({"path": name, "mode": mode, "type": "tree", "sha": obj})
        else:  # submodule / commit
            entries.append({"path": name, "mode": mode, "type": "commit", "sha": obj})
    r = api("POST", f"/repos/{OWNER}/{REPO}/git/trees", {"tree": entries})
    if r["sha"] != sha:
        raise RuntimeError(f"tree 重建后哈希不一致: {sha} != {r['sha']}")
    _tree_done.add(sha)
    return sha


def ensure_commit(sha):
    """确保远端存在该 commit（含父链），返回 sha。"""
    if sha in _commit_done:
        return sha
    if api("GET", f"/repos/{OWNER}/{REPO}/git/commits/{sha}", ok404=True):
        _commit_done.add(sha)
        return sha

    raw = git("cat-file", "commit", sha)
    header, _, message = raw.partition("\n\n")
    tree, parents, author, committer = None, [], None, None
    for line in header.splitlines():
        if line.startswith("tree "):
            tree = line.split()[1]
        elif line.startswith("parent "):
            parents.append(line.split()[1])
        elif line.startswith("author "):
            author = parse_sig(line[len("author "):])
        elif line.startswith("committer "):
            committer = parse_sig(line[len("committer "):])
    if not tree or not author:
        raise RuntimeError(f"commit {sha} 解析失败")

    ensure_tree(tree)
    for p in parents:
        ensure_commit(p)

    r = api("POST", f"/repos/{OWNER}/{REPO}/git/commits", {
        # 注意：message 末尾的换行必须原样保留，否则 commit 哈希对不上
        "message": message,
        "tree": tree,
        "parents": parents,
        "author": author,
        "committer": committer or author,
    })
    if r["sha"] != sha:
        raise RuntimeError(f"commit 重建后哈希不一致: {sha} != {r['sha']}")
    _commit_done.add(sha)
    return sha


def update_ref(head, dry_run):
    ref = f"/repos/{OWNER}/{REPO}/git/ref/heads/{BRANCH}"
    cur = api("GET", ref, ok404=True)
    if dry_run:
        return "would-patch" if cur else "would-create"
    if cur is None:
        api("POST", f"/repos/{OWNER}/{REPO}/git/refs",
            {"ref": f"refs/heads/{BRANCH}", "sha": head})
        return "created"
    if cur["object"]["sha"] == head:
        return "already-up-to-date"
    api("PATCH", f"/repos/{OWNER}/{REPO}/git/refs/heads/{BRANCH}",
        {"sha": head, "force": True})
    return "updated"


def main():
    global OWNER, REPO, BRANCH, TOKEN
    ap = argparse.ArgumentParser()
    ap.add_argument("--branch", "-b", default="")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--remote", default="origin")
    args = ap.parse_args()

    BRANCH = args.branch or git("rev-parse", "--abbrev-ref", "HEAD").strip()
    if BRANCH in ("", "HEAD"):
        print("PUSH_FAIL 处于 detached HEAD，用 -b 指定分支")
        return 1

    url = git("remote", "get-url", args.remote).strip()
    m = re.search(r"github\.com[:/](?P<o>[^/]+)/(?P<r>[^/]+?)(?:\.git)?/?$", url)
    if not m:
        print(f"PUSH_FAIL 解析不了远端地址: {url}")
        return 1
    OWNER, REPO = m.group("o"), m.group("r")

    TOKEN = load_token()
    if not TOKEN:
        print("PUSH_FAIL 没有 token（环境变量 GH_TOKEN 或 .gh_token 文件）")
        return 1

    head = git("rev-parse", "HEAD").strip()
    ahead = [x for x in git("log", "--format=%h %s", f"origin/{BRANCH}..HEAD").splitlines() if x.strip()]
    print(f"repo   : {OWNER}/{REPO}  branch: {BRANCH}")
    print(f"head   : {head[:10]}  待推 {len(ahead)} 个 commit")
    for line in ahead:
        print("  -", line)

    if args.dry_run:
        print("dry-run：不发送任何请求")
        return 0

    try:
        ensure_commit(head)
        state = update_ref(head, False)
    except RuntimeError as e:
        print(f"PUSH_FAIL {e}")
        return 1
    print(f"PUSH_OK {state} {BRANCH}@{head[:10]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
