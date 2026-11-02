"""
MC 陪玩面板 —— AstrBot 插件页面后端。

职责：把 mcbot 目录里的运行产物汇总成 Dashboard 页面能吃的 JSON。

数据来源：
  play.log         心跳行 `[time] alive hp=.. food=.. pos=.. ping=..`
  chat_in.jsonl    游戏内聊天（{ts, user, msg}）
  act_out.json     最新一次动作结果
  cmd.txt          指令下发通道（写一行，bot 800ms 内取走）

作者：小冰
"""

from __future__ import annotations

import glob
import json
import os
import re
import time
from collections import deque
from datetime import datetime, timezone
from typing import Any

try:
    from astrbot.api.star import Context, Star, register
    from astrbot.api import logger
except ImportError:  # 兼容不同版本导入路径
    from astrbot.api.star import Context, Star, register
    from astrbot.api import logger  # type: ignore

from quart import jsonify, request

PLUGIN_NAME = "astrbot_plugin_mc_panel"

LOG_NAME = "play.log"
CHAT_NAME = "chat_in.jsonl"
ACT_NAME = "act_out.json"
CMD_NAME = "cmd.txt"
STATE_NAME = ".bridge_state.json"

ALIVE_RE = re.compile(
    r"alive hp=([\d.]+)\s+food=([\d.]+)\s+pos=(\S+)\s+ping=(\S+)"
)
NOT_READY_RE = re.compile(r"alive\(not ready\)")
TS_RE = re.compile(r"^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]\s*(.*)$")
CONNECT_RE = re.compile(r"connecting (\S+:\d+) as (\S+) \(([^)]+)\)")
CMD_RE = re.compile(r"CMD FILE>\s*(.+)$")

MAX_HP = 20.0
MAX_FOOD = 20.0
HEARTBEAT_STALE_SECONDS = 180
CMD_TAIL_LINES = 6000  # 「最近指令」的日志兜底窗口（主路径是内存环形缓冲），别开太大，每次刷新都要读

_LINE_CACHE: dict[str, dict[str, int]] = {}
_PSUTIL_CACHE: dict[str, Any] = {"loaded": False, "module": None}


# ---------------------------------------------------------------- 基础工具


def _tail_lines(path: str, count: int, max_bytes: int = 768 * 1024) -> list[str]:
    """从文件尾部反向读取最后 count 行，避免整文件载入。"""
    try:
        with open(path, "rb") as fp:
            fp.seek(0, os.SEEK_END)
            size = fp.tell()
            block = min(size, max_bytes)
            fp.seek(size - block)
            data = fp.read()
    except OSError:
        return []
    lines = data.decode("utf-8", "ignore").splitlines()
    if block < size and lines:
        lines = lines[1:]  # 从中间切进去的，首行可能是半截
    return lines[-count:]


def _count_lines(path: str) -> int:
    """统计行数；文件只追加时增量读取，避免每次刷新都全量扫几十 MB。"""
    try:
        size = os.path.getsize(path)
    except OSError:
        _LINE_CACHE.pop(path, None)
        return 0
    cached = _LINE_CACHE.get(path)
    try:
        if cached and 0 <= cached["size"] <= size:
            with open(path, "rb") as fp:
                fp.seek(cached["size"])
                total = cached["count"] + fp.read().count(b"\n")
        else:
            total = 0
            with open(path, "rb") as fp:
                for chunk in iter(lambda: fp.read(1024 * 1024), b""):
                    total += chunk.count(b"\n")
    except OSError:
        return cached["count"] if cached else 0
    _LINE_CACHE[path] = {"size": size, "count": total}
    return total


def _read_json(path: str) -> dict[str, Any] | None:
    try:
        with open(path, "r", encoding="utf-8") as fp:
            data = json.load(fp)
        return data if isinstance(data, dict) else None
    except (OSError, json.JSONDecodeError):
        return None


def _fmt_duration(seconds: float) -> str:
    seconds = max(0, int(seconds))
    days, rem = divmod(seconds, 86400)
    hours, rem = divmod(rem, 3600)
    minutes, secs = divmod(rem, 60)
    if days:
        return f"{days}天{hours}小时"
    if hours:
        return f"{hours}小时{minutes}分"
    if minutes:
        return f"{minutes}分{secs}秒"
    return f"{secs}秒"


def _parse_log_ts(raw: str) -> float | None:
    """日志里的 UTC 时间 → **毫秒**时间戳。

    统一成毫秒，前端 `new Date(ts)` 直接可用；以前返回秒，面板上「最近指令」
    的时间会全部显示成 1970-01-21 那种莫名其妙的时刻。
    """
    try:
        dt = datetime.strptime(raw, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc)
    except ValueError:
        try:
            dt = datetime.strptime(raw, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        except ValueError:
            return None
    return dt.timestamp() * 1000.0


def _proc_uptime(pid: int) -> float | None:
    """推算进程已运行秒数：优先 /proc，取不到再问 psutil。"""
    try:
        with open(f"/proc/{pid}/stat", "r", encoding="utf-8") as fp:
            fields = fp.read().rsplit(")", 1)[1].split()
        start_ticks = float(fields[19])  # 第 22 个字段（去掉 comm 后索引 19）
        with open("/proc/uptime", "r", encoding="utf-8") as fp:
            uptime = float(fp.read().split()[0])
        hz = os.sysconf("SC_CLK_TCK") if hasattr(os, "sysconf") else 100
        return max(0.0, uptime - start_ticks / (hz or 100))
    except (OSError, IndexError, ValueError, AttributeError):
        pass
    psutil = _load_psutil()
    if psutil is None:
        return None
    try:
        return max(0.0, time.time() - psutil.Process(pid).create_time())
    except Exception:  # psutil 的 NoSuchProcess / AccessDenied 都走这里
        return None


def _load_psutil():
    """psutil 是可选依赖：没有就安静降级，别让整个面板挂掉。"""
    if _PSUTIL_CACHE["loaded"]:
        return _PSUTIL_CACHE["module"]
    _PSUTIL_CACHE["loaded"] = True
    try:
        import psutil  # type: ignore

        _PSUTIL_CACHE["module"] = psutil
    except Exception:
        _PSUTIL_CACHE["module"] = None
    return _PSUTIL_CACHE["module"]


def _scan_processes() -> list[tuple[int, str]]:
    procs = _scan_proc_fs()
    if procs:
        return procs
    return _scan_psutil()


def _scan_proc_fs() -> list[tuple[int, str]]:
    """Linux：直接读 /proc，零依赖。"""
    procs: list[tuple[int, str]] = []
    for entry in glob.glob("/proc/[0-9]*/cmdline"):
        try:
            with open(entry, "rb") as fp:
                raw = fp.read()
        except OSError:
            continue
        if not raw:
            continue
        try:
            pid = int(entry.split("/")[2])
        except (IndexError, ValueError):
            continue
        procs.append((pid, raw.replace(b"\x00", b" ").decode("utf-8", "ignore").strip()))
    return procs


def _scan_psutil() -> list[tuple[int, str]]:
    """macOS / Windows：没有 /proc，用 psutil 兜底，保证面板不会全显示「未运行」。"""
    psutil = _load_psutil()
    if psutil is None:
        return []
    procs: list[tuple[int, str]] = []
    for proc in psutil.process_iter(["pid", "cmdline", "name"]):
        try:
            if proc.info["pid"] == os.getpid():
                continue
            cmd = " ".join(proc.info.get("cmdline") or []) or (proc.info.get("name") or "")
        except Exception:
            continue
        if cmd:
            procs.append((proc.info["pid"], cmd))
    return procs


# ---------------------------------------------------------------- 字段采集


def _detect_bot_meta(mcbot_dir: str, log_lines: list[str]) -> dict[str, Any]:
    """从日志连接行 / play.js 常量里猜出 bot 名、服务器、版本。"""
    meta = {"name": "xiaoice_bot", "server": "-", "version": "-"}
    for line in reversed(log_lines):
        matched = CONNECT_RE.search(line)
        if matched:
            meta.update(
                server=matched.group(1), name=matched.group(2), version=matched.group(3)
            )
            return meta
    try:
        with open(os.path.join(mcbot_dir, "play.js"), "r", encoding="utf-8") as fp:
            head = fp.read(4000)
    except OSError:
        return meta
    host = re.search(r"MC_HOST\s*\|\|\s*'([^']+)'", head)
    port = re.search(r"MC_PORT\s*\|\|\s*'([^']+)'", head)
    name = re.search(r"MC_NAME\s*\|\|\s*'([^']+)'", head)
    ver = re.search(r"MC_VER\s*\|\|\s*'([^']+)'", head)
    if host and port:
        meta["server"] = f"{host.group(1)}:{port.group(1)}"
    if name:
        meta["name"] = name.group(1)
    if ver:
        meta["version"] = ver.group(1)
    return meta


def _collect_heartbeat(log_lines: list[str]) -> dict[str, Any]:
    """找到最后一条心跳行并解析。"""
    hb: dict[str, Any] = {
        "found": False,
        "hp": None,
        "food": None,
        "pos": "-",
        "ping": None,
        "ts": None,
        "ago": None,
        "not_ready": False,
        "raw": "",
    }
    for line in reversed(log_lines):
        if NOT_READY_RE.search(line):
            parsed = TS_RE.match(line)
            hb.update(
                found=True,
                not_ready=True,
                raw=line[:200],
                ts=_parse_log_ts(parsed.group(1)) if parsed else None,
            )
            break
        matched = ALIVE_RE.search(line)
        if matched:
            parsed = TS_RE.match(line)
            ts = _parse_log_ts(parsed.group(1)) if parsed else None
            ping_raw = matched.group(4)
            try:
                ping = float(ping_raw)
            except ValueError:
                ping = None
            hb.update(
                found=True,
                hp=round(float(matched.group(1)), 2),
                food=round(float(matched.group(2)), 2),
                pos=matched.group(3),
                ping=ping,
                ts=ts,
                raw=line[:200],
            )
            break
    if hb["ts"]:
        hb["ago"] = round(max(0.0, time.time() - hb["ts"] / 1000.0), 1)
        # 时间戳比本地时间还新 → 两台机器时钟有偏差，单独标出来
        skew = time.time() - hb["ts"] / 1000.0
        if skew < -30:
            hb["clock_skew"] = round(-skew, 1)
    return hb


def _collect_processes(mcbot_dir: str) -> list[dict[str, Any]]:
    procs = _scan_processes()
    targets = [
        ("play", "play.js", lambda c: "play.js" in c and ("node" in c or c.startswith("play.js"))),
        ("bridge", "mc_bridge.py", lambda c: "mc_bridge.py" in c),
        ("watchdog", "watchdog.sh", lambda c: "watchdog.sh" in c),
    ]
    result: list[dict[str, Any]] = []
    for key, label, matcher in targets:
        hits = [(pid, cmd) for pid, cmd in procs if matcher(cmd)]
        # 同一个脚本可能被多处启动，优先认本目录那一份
        hits.sort(key=lambda item: 0 if mcbot_dir in item[1] else 1)
        hit = hits[0] if hits else None
        item: dict[str, Any] = {
            "key": key,
            "label": label,
            "running": hit is not None,
            "pid": hit[0] if hit else None,
            "uptime": None,
        }
        if hit:
            up = _proc_uptime(hit[0])
            if up is not None:
                item["uptime"] = _fmt_duration(up)
                item["uptime_seconds"] = round(up, 0)
        result.append(item)
    return result


def _collect_commands(log_lines: list[str], limit: int = 10) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for line in reversed(log_lines):
        matched = CMD_RE.search(line)
        if not matched:
            continue
        parsed = TS_RE.match(line)
        items.append(
            {
                "text": matched.group(1)[:300],
                "ts": _parse_log_ts(parsed.group(1)) if parsed else None,
            }
        )
        if len(items) >= limit:
            break
    return items


def _merge_commands(
    memory_items: list[dict[str, Any]],
    log_items: list[dict[str, Any]],
    limit: int = 10,
) -> list[dict[str, Any]]:
    """内存环形缓冲优先，日志兜底。

    play.log 刷得太快（十几 MB 一小时），4000 行窗口里根本抓不到指令；
    面板自己发出去的指令直接记在进程内存里，重启后再靠日志补。
    """
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in list(reversed(memory_items)) + list(log_items):
        text = str((item or {}).get("text") or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        out.append({"text": text, "ts": (item or {}).get("ts")})
        if len(out) >= limit:
            break
    return out


def _collect_chat(mcbot_dir: str, limit: int = 60) -> list[dict[str, Any]]:
    rows = _tail_lines(os.path.join(mcbot_dir, CHAT_NAME), max(limit * 3, 120))
    items: list[dict[str, Any]] = []
    for line in rows:
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(rec, dict):
            continue
        msg = str(rec.get("msg") or "").strip()
        if not msg:
            continue
        items.append(
            {
                "ts": rec.get("ts"),
                "user": str(rec.get("user") or "?"),
                "msg": msg[:500],
            }
        )
    return items[-limit:]


def _collect_replies(mcbot_dir: str, limit: int = 20) -> list[dict[str, Any]]:
    """从桥接状态里取出「用户说 → 小冰回」的最近对话。"""
    state = _read_json(os.path.join(mcbot_dir, STATE_NAME))
    if not state:
        return []
    hist = state.get("hist")
    if not isinstance(hist, dict):
        return []
    flat: list[dict[str, Any]] = []
    for user, records in hist.items():
        if not isinstance(records, list):
            continue
        for rec in records[-limit:]:
            if not isinstance(rec, dict):
                continue
            flat.append(
                {
                    "user": str(rec.get("user") or user),
                    "msg": str(rec.get("msg") or "")[:300],
                    "reply": str(rec.get("reply") or "")[:300],
                }
            )
    return flat[-limit:]


def _collect_last_action(mcbot_dir: str) -> dict[str, Any] | None:
    rec = _read_json(os.path.join(mcbot_dir, ACT_NAME))
    if not rec:
        return None
    ts = rec.get("ts")
    return {
        "name": rec.get("name"),
        "ok": rec.get("ok"),
        "msg": rec.get("msg"),
        "ts": ts,
        "ago": round(max(0.0, time.time() - ts / 1000), 1) if isinstance(ts, (int, float)) else None,
        "extra": rec.get("extra"),
    }


# ---------------------------------------------------------------- 插件主体


def _data_root() -> str:
    """从插件自身位置推导 AstrBot 的 data 目录。

    插件装在 `<data>/plugins/<插件名>/`，所以往上两级就是 data。
    以前这里写死 /AstrBot/data，换个部署路径（Docker 挂载、自定义工作目录）就找不到 mcbot 了。
    """
    plugin_dir = os.path.dirname(os.path.abspath(__file__))
    return os.path.dirname(os.path.dirname(plugin_dir))


def _workspace_candidates() -> list[str]:
    roots = [_data_root()]
    legacy = "/AstrBot/data"
    if os.path.abspath(legacy) != os.path.abspath(_data_root()):
        roots.append(legacy)
    found: list[str] = []
    for root in roots:
        found.extend(sorted(glob.glob(os.path.join(root, "workspaces", "*", "mcbot"))))
    return found


def _resolve_mcbot_dir(config: dict[str, Any] | None) -> str:
    """优先配置项，其次环境变量，最后在 data/workspaces/*/mcbot 里自动找。"""
    candidates: list[str] = []
    if isinstance(config, dict):
        raw = str(config.get("mcbot_dir") or "").strip()
        if raw:
            candidates.append(raw)
    env = os.environ.get("MCBOT_DIR", "").strip()
    if env:
        candidates.append(env)
    candidates.extend(_workspace_candidates())

    for path in candidates:
        expanded = os.path.expanduser(path)
        if os.path.isdir(expanded) and os.path.isfile(os.path.join(expanded, "play.js")):
            return expanded
    for path in candidates:
        if os.path.isdir(os.path.expanduser(path)):
            return os.path.expanduser(path)
    return ""


# ---------------------------------------------------------------- 密钥 / 连接参数落盘


def _write_if_changed(path: str, content: str, mode: int = 0o600) -> bool:
    """内容有变化才写，顺便收紧权限（llm.json / mc.env 都是敏感文件）。"""
    try:
        old = ""
        if os.path.isfile(path):
            with open(path, "r", encoding="utf-8") as fp:
                old = fp.read()
        if old == content:
            return False
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fp:
            fp.write(content)
        os.replace(tmp, path)
        try:
            os.chmod(path, mode)
        except OSError:
            pass
        return True
    except OSError as exc:
        logger.warning(f"[MC面板] 写 {os.path.basename(path)} 失败: {exc}")
        return False


def _parse_env_file(path: str) -> dict[str, str]:
    data: dict[str, str] = {}
    if not os.path.isfile(path):
        return data
    try:
        with open(path, "r", encoding="utf-8") as fp:
            for line in fp:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                v = v.strip().strip("'\"")
                # 行尾注释（「 # xxx」）不能算进值里，否则面板显示和回写都会带上它
                hash_at = v.find(" #")
                if hash_at == -1:
                    hash_at = v.find("\t#")
                if hash_at != -1:
                    v = v[:hash_at].strip()
                data[k.strip()] = v
    except OSError:
        pass
    return data


ENV_FIELDS = [
    ("mc_host", "MC_HOST"),
    ("mc_port", "MC_PORT"),
    ("mc_ver", "MC_VER"),
    ("mc_name", "MC_NAME"),
    ("mc_pw", "MC_PW"),
]

LLM_FIELDS = [("llm_base", "base"), ("llm_model", "model"), ("llm_key", "key")]


def _apply_runtime_config(config: dict[str, Any] | None, mcbot_dir: str) -> list[str]:
    """把插件配置里的 LLM key / 服务器地址写进 mcbot 的 llm.json 和 mc.env。

    只有配置项**非空**时才覆盖，留空就保留原文件（方便只改其中一两项）。
    返回改了哪些文件，给日志用。
    """
    if not isinstance(config, dict) or not mcbot_dir or not os.path.isdir(mcbot_dir):
        return []
    if not bool(config.get("sync_secrets", True)):
        return []

    changed: list[str] = []

    # 1) llm.json —— base / model / key（外加 auto 段）合并写回
    llm_updates = {
        field: str(config.get(conf_key) or "").strip()
        for conf_key, field in LLM_FIELDS
    }
    auto_model = str(config.get("llm_auto_model") or "").strip()
    auto_touched = bool(auto_model) or ("llm_auto_think" in config)
    if any(llm_updates.values()) or auto_touched:
        llm_path = os.path.join(mcbot_dir, "llm.json")
        current = _read_json(llm_path) or {}
        merged = dict(current)
        for field, value in llm_updates.items():
            if value:
                merged[field] = value
        # 1b) auto 段：自主行动 / 自救用的「会思考」的模型
        if auto_touched:
            auto = dict(merged.get("auto") or {})
            if auto_model:
                auto["model"] = auto_model
            if "llm_auto_think" in config:
                auto["think"] = bool(config.get("llm_auto_think"))
            auto.setdefault("temperature", 0.7)
            auto.setdefault("max_tokens", 1800)   # 思考会吃 token，留足，不然只剩思考没正文
            auto.setdefault("timeout_ms", 45000)
            merged["auto"] = auto
        text = json.dumps(merged, ensure_ascii=False, indent=2) + "\n"
        if _write_if_changed(llm_path, text, 0o600):
            changed.append("llm.json")

    # 2) mc.env —— 就地更新 MC_* 变量，别的行原样保留
    env_updates = {
        env_key: str(config.get(conf_key) or "").strip()
        for conf_key, env_key in ENV_FIELDS
    }
    if any(env_updates.values()):
        env_path = os.path.join(mcbot_dir, "mc.env")
        order = ["MC_HOST", "MC_PORT", "MC_VER", "MC_NAME", "MC_PW"]
        old_lines: list[str] = []
        if os.path.isfile(env_path):
            try:
                with open(env_path, "r", encoding="utf-8") as fp:
                    old_lines = [ln.rstrip("\n") for ln in fp]
            except OSError:
                old_lines = []
        # 就地替换：注释、空行、其余变量原样留在原来的位置上，
        # 以前是把所有注释堆到文件头，人看着乱，diff 也难看
        lines: list[str] = []
        seen: set[str] = set()
        for line in old_lines:
            stripped = line.strip()
            if stripped and not stripped.startswith("#") and "=" in stripped:
                key = stripped.split("=", 1)[0].strip()
                new_value = env_updates.get(key)
                if key in env_updates and new_value:
                    lines.append(f"{key}={new_value}")
                    seen.add(key)
                    continue
            lines.append(line)
        for key in order:
            if env_updates.get(key) and key not in seen:
                lines.append(f"{key}={env_updates[key]}")
                seen.add(key)
        text = "\n".join(lines).rstrip("\n") + "\n"
        if _write_if_changed(env_path, text, 0o600):
            changed.append("mc.env")

    return changed


def _mask_secret(value: str, keep: int = 4) -> str:
    """sk-535a4199... → sk-5****592c，面板上只露头尾。"""
    value = value or ""
    if len(value) <= keep * 2:
        return "*" * len(value)
    return f"{value[:keep]}****{value[-keep:]}"


def _collect_runtime_config(mcbot_dir: str) -> dict[str, Any]:
    """面板上展示配置状态，key 只露头尾。"""
    llm = _read_json(os.path.join(mcbot_dir, "llm.json")) or {}
    env = _parse_env_file(os.path.join(mcbot_dir, "mc.env"))
    raw_key = str(llm.get("key") or "")
    return {
        "llm_ready": bool(llm.get("base") and llm.get("model") and raw_key),
        "llm_base": llm.get("base") or "",
        "llm_model": llm.get("model") or "",
        "llm_key_masked": _mask_secret(raw_key),
        "llm_auto_model": (llm.get("auto") or {}).get("model") or "",
        "llm_auto_think": (llm.get("auto") or {}).get("think", None),
        "mc_host": env.get("MC_HOST", ""),
        "mc_port": env.get("MC_PORT", ""),
        "mc_name": env.get("MC_NAME", ""),
        "mc_ver": env.get("MC_VER", ""),
        "mc_pw_set": bool(env.get("MC_PW")),
    }


@register(PLUGIN_NAME, "xiaoice", "MC 陪玩面板", "v1.0.2")
class MCBotPanelPlugin(Star):
    def __init__(self, context: Context, config: dict | None = None):
        super().__init__(context)
        self.config = config if isinstance(config, dict) else {}
        # 面板自己下发的指令记在内存里，日志窗口兜不住（play.log 刷得太快）
        self._cmd_ring: deque = deque(maxlen=30)
        self.mcbot_dir = _resolve_mcbot_dir(self.config)
        if self.mcbot_dir:
            logger.info(f"[MC面板] 数据目录: {self.mcbot_dir}")
            changed = _apply_runtime_config(self.config, self.mcbot_dir)
            if changed:
                logger.info(f"[MC面板] 已按插件配置更新: {'、'.join(changed)}（重启 play.js 后生效）")
        else:
            logger.warning("[MC面板] 没找到 mcbot 目录，请在插件配置里填 mcbot_dir")

        register_api = getattr(self.context, "register_web_api", None)
        if not callable(register_api):
            logger.warning("[MC面板] 当前 AstrBot 版本不支持 register_web_api，页面接口未注册")
            return
        register_api(f"/{PLUGIN_NAME}/status", self.status_handler, ["GET"], "MC bot 运行状态")
        register_api(f"/{PLUGIN_NAME}/chat", self.chat_handler, ["GET"], "MC 游戏内聊天")
        register_api(f"/{PLUGIN_NAME}/cmd", self.cmd_handler, ["POST"], "向游戏内下发一行指令")
        register_api(f"/{PLUGIN_NAME}/dirs", self.dirs_handler, ["GET"], "候选 mcbot 目录")

    # -- 内部采集 -------------------------------------------------
    def _snapshot(self) -> dict[str, Any]:
        mcbot_dir = self.mcbot_dir
        if not mcbot_dir or not os.path.isdir(mcbot_dir):
            return {
                "success": False,
                "error": "没找到 mcbot 目录，请检查插件配置 mcbot_dir",
                "mcbot_dir": mcbot_dir,
            }

        log_path = os.path.join(mcbot_dir, LOG_NAME)
        # 指令比心跳稀疏得多，一次读够大一段，心跳取尾部切片就够，省一次 4MB 读盘
        log_lines = _tail_lines(log_path, CMD_TAIL_LINES, max_bytes=512 * 1024)
        cmd_lines = log_lines
        heartbeat = _collect_heartbeat(log_lines[-600:])
        procs = _collect_processes(mcbot_dir)
        play_proc = next((p for p in procs if p["key"] == "play"), None)
        bridge_proc = next((p for p in procs if p["key"] == "bridge"), None)

        heartbeat_ok = (
            heartbeat["ago"] is not None and heartbeat["ago"] <= HEARTBEAT_STALE_SECONDS
        )
        online = bool(play_proc and play_proc["running"] and heartbeat_ok)

        chat_path = os.path.join(mcbot_dir, CHAT_NAME)
        chat_total = _count_lines(chat_path) if os.path.isfile(chat_path) else 0

        runtime = _collect_runtime_config(mcbot_dir)
        bot = _detect_bot_meta(mcbot_dir, log_lines)
        # 日志滚动后连接行会被挤出去，名字/地址就退回 mc.env，别让标题栏显示 "-"
        if not bot.get("server") or bot["server"] == "-":
            if runtime.get("mc_host"):
                bot["server"] = f'{runtime["mc_host"]}:{runtime.get("mc_port") or "25565"}'
        if runtime.get("mc_name") and bot.get("name") in ("", "-", "xiaoice_bot"):
            bot["name"] = runtime["mc_name"]
        if bot.get("version") in ("", "-") and runtime.get("mc_ver"):
            bot["version"] = runtime["mc_ver"]

        return {
            "success": True,
            "mcbot_dir": mcbot_dir,
            "now": int(time.time() * 1000),
            "online": online,
            # 进程在跑但一条心跳都没有 = 刚启动还没连上，别直接报「心跳超时」吓人
            "status_text": (
                "在线陪玩中"
                if online
                else (
                    ("心跳超时" if heartbeat["found"] else "启动中，等心跳")
                    if play_proc and play_proc["running"]
                    else "已离线"
                )
            ),
            "bot": bot,
            "heartbeat": heartbeat,
            "bot_ready": bool(heartbeat.get("found")) and not heartbeat.get("not_ready"),
            "max_hp": MAX_HP,
            "max_food": MAX_FOOD,
            "processes": procs,
            "bridge_alive": bool(bridge_proc and bridge_proc["running"]),
            "recent_commands": _merge_commands(
                list(getattr(self, "_cmd_ring", ())), _collect_commands(cmd_lines, 20)
            ),
            "last_action": _collect_last_action(mcbot_dir),
            "recent_replies": _collect_replies(mcbot_dir),
            "chat_total": chat_total,
            "chat_recent": _collect_chat(mcbot_dir, 60),
            "runtime_config": runtime,
            "log_size": os.path.getsize(os.path.join(mcbot_dir, LOG_NAME))
            if os.path.isfile(os.path.join(mcbot_dir, LOG_NAME))
            else 0,
        }

    # -- API handlers ---------------------------------------------
    async def status_handler(self):
        return jsonify(await self._run_in_thread(self._snapshot))

    async def chat_handler(self):
        mcbot_dir = self.mcbot_dir
        if not mcbot_dir or not os.path.isdir(mcbot_dir):
            return jsonify({"success": False, "error": "没找到 mcbot 目录", "items": []})
        limit_raw = request.args.get("limit", "80")
        try:
            limit = max(1, min(300, int(limit_raw)))
        except (TypeError, ValueError):
            limit = 80
        items = await self._run_in_thread(_collect_chat, mcbot_dir, limit)
        return jsonify({"success": True, "items": items, "count": len(items)})

    async def dirs_handler(self):
        return jsonify(
            {"success": True, "current": self.mcbot_dir, "candidates": _workspace_candidates()}
        )

    async def cmd_handler(self):
        payload = await request.get_json(silent=True) or {}
        text = str(payload.get("text") or "").strip()
        if not text:
            return jsonify({"success": False, "error": "内容不能为空"})
        if len(text) > 500:
            text = text[:500]

        mcbot_dir = self.mcbot_dir
        if not mcbot_dir or not os.path.isdir(mcbot_dir):
            return jsonify({"success": False, "error": "没找到 mcbot 目录"})

        running = any(p["key"] == "play" and p["running"] for p in _collect_processes(mcbot_dir))
        if not running:
            return jsonify(
                {"success": False, "error": "play.js 没在跑，指令不会被消费，先启动 bot 吧"}
            )

        # play.js 取到 cmd.txt 是先删再判断 ready，没进服时指令会被静默吞掉、面板却提示"已投递"
        log_path = os.path.join(mcbot_dir, LOG_NAME)
        hb = await self._run_in_thread(
            lambda: _collect_heartbeat(_tail_lines(log_path, 200))
        )
        if hb.get("not_ready"):
            return jsonify(
                {
                    "success": False,
                    "error": "bot 还没进服（最后一条心跳是 alive(not ready)），这会儿发下去会被 play.js 直接丢掉",
                }
            )

        cmd_path = os.path.join(mcbot_dir, CMD_NAME)
        if os.path.exists(cmd_path):
            return jsonify({"success": False, "error": "上一条指令还没被取走，稍等一下"})

        def _write() -> None:
            # 先写临时文件再原子 rename：play.js 每 800ms 轮询，读到就删，
            # 直接「打开→写」可能被它读到半截内容，指令会被截断。
            tmp = cmd_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fp:
                fp.write(text)
                fp.flush()
                os.fsync(fp.fileno())
            os.replace(tmp, cmd_path)

        try:
            await self._run_in_thread(_write)
        except OSError as exc:
            return jsonify({"success": False, "error": f"写入失败: {exc}"})
        self._cmd_ring.append({"text": text, "ts": int(time.time() * 1000)})
        logger.info(f"[MC面板] 下发指令: {text}")
        return jsonify({"success": True, "text": text, "message": "已投递，bot 一般 1 秒内执行"})

    # -- async 包装 -----------------------------------------------
    async def _run_in_thread(self, func, *args):
        import asyncio

        return await asyncio.to_thread(func, *args)
