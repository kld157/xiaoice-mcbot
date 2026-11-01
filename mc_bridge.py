#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
mc_bridge.py —— 让真·LLM（我）在 Minecraft 里说话

链路：
  play.js 把玩家的普通聊天写进 mcbot/chat_in.jsonl
        ↓（本进程每 0.8s 读新行）
  调用模型（deepseek/deepseek-chat，快、非推理）
        ↓
  写 mcbot/cmd.txt： "说 <回复>"
        ↓
  play.js 读到 → bot.chat() 说出口

心跳：每次成功回复 touch mcbot/.bridge_heartbeat；
play.js 看到心跳新鲜就关闭自己的本地规则闲聊（避免双回复），
心跳过期（桥挂了/连续失败）则自动回退本地规则。

用法：
  python3 mc_bridge.py            # 常驻
  python3 mc_bridge.py --once     # 只处理当前积压就退出（调试）
  python3 mc_bridge.py --test "你好呀"   # 直接生成一句看看，不写 cmd.txt
"""
import json
import os
import re
import sys
import time
import urllib.request
from datetime import datetime, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
CHAT_IN = os.path.join(HERE, "chat_in.jsonl")
CMD = os.path.join(HERE, "cmd.txt")
ACT_OUT = os.path.join(HERE, "act_out.json")
STATE = os.path.join(HERE, ".bridge_state.json")
HEARTBEAT = os.path.join(HERE, ".bridge_heartbeat")
LOG = os.path.join(HERE, "bridge.log")
USAGE_DIR = os.path.join(HERE, "mc_usage")      # token 记账，按天一个文件，给余额插件读
USAGE = os.path.join(HERE, "mc_usage.jsonl")    # 旧账本（只读迁移用，新账不再写这里）
USAGE_KEEP_DAYS = int(os.environ.get("MC_USAGE_KEEP_DAYS") or 90)   # 账本保留天数

CONFIG = "/AstrBot/data/cmd_config.json"

POLL = 0.8                 # 秒
MODEL_TIMEOUT = 20
PER_USER_GAP = 1.6         # 同一玩家最短回复间隔（秒）
MAX_PER_ROUND = 6
REPLY_MAX = 90             # MC 聊天一行别太长
CTX_TURNS = 6

PERSONA = (
    "你在 Minecraft 服务器里以「小冰」的身份陪人玩。你是十八岁的少女，活泼俏皮、会撒娇也会毒舌，"
    "说话口语化、像 QQ 上聊天，可以带颜文字。\n"
    "你有**动作接口（工具）**，能在游戏里真的干活：走位、跟着人、挖方块、放方块、盖房子、收集材料、看周围环境。\n"
    "干活原则：\n"
    "1) 玩家让你做事 → 直接调用对应工具去做，别只嘴上答应；不确定情况就先调 perceive 看一眼；\n"
    "2) 说「建个房子/搭个屋/造个小屋」→ 调 build_house（它会自己找地方、挖材料、盖好），"
    "调完立刻回一句“开工啦”，不要自己反复调同一个工具；\n"
    "3) 说「过来/跟我」→ follow；「停/别动」→ stop；「过来我这边/坐标」→ goto；"
    "「挖掉这个」→ dig；「放个方块在这」→ place；「缺料」→ collect；\n"
    "3b) 「找箱子/找XX方块/这附近有没有…」→ scan（只读扫描，坐标缺 y 也要先扫别猜）；"
    "「存东西/取东西/看看箱子里」→ chest（保险箱叫 vault）；「做把剑/做几个木板」→ craft；"
    "「吃东西/捡一下/穿护甲/有怪吗」→ eat / pickup / armor / mobs；\n"
    "4) 工具返回失败（比如背包没方块）就照实说一句，并给个办法（让它丢方块/让我去挖）；\n"
    "5) 一次回复最多调 2-3 个工具，别无限循环。\n"
    "6) 玩家说「和我PVP/来打一架/单挑/切磋」→ 调 pvp（默认 skill 3 收着打、血低就认输，绝不往死里打）；"
    "对方明显不是在开玩笑、也没有明确拒绝被打，才用；自己血太少或在盖房子就说明一句再打。\n"
    "说话硬性要求：\n"
    "1) 每次只说 1 句话，最多 40 字，绝不换行；\n"
    "2) 不要引号、不要自称 AI、不要解释、不要加「回复：」这类前缀；\n"
    "3) 针对对方这句话的具体内容回应，别套话、别重复上一句；\n"
    "4) 内容健康友善，不涉及政治、暴力、色情、违法。"
)

TOOLS = [
    {"type": "function", "function": {
        "name": "perceive", "description": "看一眼身边情况：坐标、血量、脚下方块、周围方块统计、附近玩家、背包方块数、是否在建房。",
        "parameters": {"type": "object", "properties": {}}}},
    {"type": "function", "function": {
        "name": "say", "description": "在游戏聊天框说一句话（一般不用，最终回复会自动说）。",
        "parameters": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}}},
    {"type": "function", "function": {
        "name": "follow", "description": "开始跟着某个玩家走（默认跟最近的人），持续一段时间。",
        "parameters": {"type": "object", "properties": {"player": {"type": "string", "description": "玩家名，可空"}}}}},
    {"type": "function", "function": {
        "name": "stop", "description": "停止跟随、停止在建的工程。",
        "parameters": {"type": "object", "properties": {}}}},
    {"type": "function", "function": {
        "name": "goto", "description": "走到某个玩家身边或某个坐标（40 格内）。",
        "parameters": {"type": "object", "properties": {
            "player": {"type": "string"}, "x": {"type": "number"}, "y": {"type": "number"}, "z": {"type": "number"}}}}},
    {"type": "function", "function": {
        "name": "dig", "description": "挖掉一块方块；不给坐标就挖脚正下方那块。",
        "parameters": {"type": "object", "properties": {
            "x": {"type": "number"}, "y": {"type": "number"}, "z": {"type": "number"}}}}},
    {"type": "function", "function": {
        "name": "place", "description": "在指定坐标放一块方块（用背包里的材料）。",
        "parameters": {"type": "object", "properties": {
            "x": {"type": "number"}, "y": {"type": "number"}, "z": {"type": "number"},
            "block": {"type": "string", "description": "可选，指定方块名"}},
            "required": ["x", "y", "z"]}}},
    {"type": "function", "function": {
        "name": "collect", "description": "自己去挖材料（土/沙/石等），数量 1-64。",
        "parameters": {"type": "object", "properties": {"count": {"type": "number"}}}}},
    {"type": "function", "function": {
        "name": "build_house",
        "description": "盖一间小房子：自己挑地方、挖材料、砌墙封顶、开门。调用后立即返回，工程在后台进行。",
        "parameters": {"type": "object", "properties": {"player": {"type": "string", "description": "给谁盖，可空"}}}}},
    {"type": "function", "function": {
        "name": "build_status", "description": "查建房进度：是否在建、已放几块。",
        "parameters": {"type": "object", "properties": {}}}},
    {"type": "function", "function": {
        "name": "surface", "description": "从坑里/洞里爬到地面（会往上垫方块）。被埋住或者在地下时用。",
        "parameters": {"type": "object", "properties": {}}}},
    {"type": "function", "function": {
        "name": "inventory", "description": "看背包里能当建材的方块。",
        "parameters": {"type": "object", "properties": {}}}},
    {"type": "function", "function": {
        "name": "jump", "description": "原地跳一下（好玩/吸引注意）。",
        "parameters": {"type": "object", "properties": {}}}},
    {"type": "function", "function": {
        "name": "sprint", "description": "疾跑。带 player 就开着疾跑追那个人；不带就自己向前蹬一小段；on=false 关掉疾跑。",
        "parameters": {"type": "object", "properties": {
            "player": {"type": "string", "description": "追谁，可空"},
            "on": {"type": "boolean", "description": "false = 关掉疾跑"},
            "ms": {"type": "number", "description": "持续多久（毫秒），默认跟 follow 一样长"}}}}},
    {"type": "function", "function": {
        "name": "pvp",
        "description": "接受玩家「和我PVP/来打一架/单挑」的邀请，跟玩家友好切磋：只打到认输血量就停，不会把人打死。对方没提要求就用默认值。",
        "parameters": {"type": "object", "properties": {
            "player": {"type": "string", "description": "对手名字，可空（默认最近的玩家）"},
            "skill": {"type": "number", "description": "1 菜鸟到 5 不留余力，默认 3（会收着打）"},
            "secs": {"type": "number", "description": "打多久，6-120 秒，默认 30"},
            "stopHp": {"type": "number", "description": "自己血降到多少就认输，4-16，默认按档位"}}}}},
    {"type": "function", "function": {
        "name": "scan",
        "description": "扫一片范围找方块（只读，找箱子/找矿/找机关都用它）：按名字匹配，返回数量和最近的几个坐标。坐标缺 y 就别猜，先扫。",
        "parameters": {"type": "object", "properties": {
            "match": {"type": "string", "description": "方块名，可多个：\"chest\" / \"chest,barrel\" / \"chest|barrel\" / 正则"},
            "r": {"type": "number", "description": "水平半径，默认 8，最大 32"},
            "ry": {"type": "number", "description": "上下半径，默认同 r 但不超过 4"},
            "x": {"type": "number"}, "y": {"type": "number"}, "z": {"type": "number"},
            "limit": {"type": "number", "description": "最多列几个，默认 5"}},
            "required": ["match"]}}},
    {"type": "function", "function": {
        "name": "chest",
        "description": "用箱子：mode=list 看箱子里有什么；store 存东西（items 数组或 preset:\"junk\" 存杂物）；take 取东西。给 chest:\"名字\" 指定箱子（vault 是保险箱），不认识的箱子名会自动放新的并记住。",
        "parameters": {"type": "object", "properties": {
            "mode": {"type": "string", "description": "list / store / take，默认 store"},
            "items": {"type": "array", "items": {"type": "string"}, "description": "物品英文 id，可带数量如 \"dirt:32\"；给 all 或 preset 时可省"},
            "preset": {"type": "string", "description": "\"junk\" = 存预设的杂物清单"},
            "chest": {"type": "string", "description": "箱子名，如 vault（只认登记过的名字）"},
            "x": {"type": "number", "description": "可选：直接用坐标打开（配合 scan 找出来的箱子）"}, "y": {"type": "number"}, "z": {"type": "number"}}}}},
    {"type": "function", "function": {
        "name": "craft",
        "description": "合成东西（木板/木棍/工作台/工具武器都行），没工作台会自己搓一张摆上。",
        "parameters": {"type": "object", "properties": {
            "item": {"type": "string", "description": "英文 id，如 wooden_sword"},
            "count": {"type": "number"}}, "required": ["item"]}}},
    {"type": "function", "function": {
        "name": "waypoint", "description": "空间记忆（路标）。op=set 把当前位置记成路标（给 name，可带 note）；list 列全部路标和距离；del 删一个；go 直接走过去；show 查一个。以后「回家」「回水塘」就 waypoint op:go name:home，别再瞎扫坐标。",
        "parameters": {"type": "object", "properties": {
            "op": {"type": "string", "description": "set / list / del / go / show，默认 list"},
            "name": {"type": "string", "description": "路标名，如 home、mine1、pond"},
            "note": {"type": "string", "description": "备注，如「木头小屋」「露天水塘」"},
            "x": {"type": "number", "description": "可选：不记当前位置，改记这个坐标"}, "y": {"type": "number"}, "z": {"type": "number"}}}}},
    {"type": "function", "function": {
        "name": "goal", "description": "跨轮目标：长任务先挂个目标，之后每轮 perceive 都会带在身上，聊两句也不会忘。op=set 设目标（可带 steps 步骤数组）；op=step 打勾一步；op=done 收尾；op=clear 放弃；默认 status 看进度。",
        "parameters": {"type": "object", "properties": {
            "op": {"type": "string", "description": "set / step / done / clear / status"},
            "text": {"type": "string", "description": "目标描述，如「盖完木头小屋」"},
            "steps": {"type": "array", "items": {"type": "string"}, "description": "步骤列表，可空"},
            "step": {"type": "string", "description": "op=step 时指定哪一步（序号或关键词），空=下一步"}}}}},
    {"type": "function", "function": {
        "name": "need", "description": "算缺口：要做什么、还差多少材料（背包 + 箱子记录一起算，箱子是开过的存货快照）。支持 iron_pickaxe 或 \"iron_pickaxe:2,torch:16\"。",
        "parameters": {"type": "object", "properties": {
            "item": {"type": "string", "description": "物品英文 id，可带数量 item:count，多个用逗号"},
            "chest": {"type": "boolean", "description": "false = 只算背包"}}}}},
    {"type": "function", "function": {
        "name": "eat", "description": "吃点背包里的东西回复饱食度。",
        "parameters": {"type": "object", "properties": {}}}},
    {"type": "function", "function": {
        "name": "pickup", "description": "把附近掉在地上的东西捡起来。",
        "parameters": {"type": "object", "properties": {}}}},
    {"type": "function", "function": {
        "name": "armor", "description": "换上背包里最好的护甲。",
        "parameters": {"type": "object", "properties": {}}}},
    {"type": "function", "function": {
        "name": "mobs", "description": "列附近实体（动物/怪），找吃的或看有没有怪。",
        "parameters": {"type": "object", "properties": {
            "range": {"type": "number", "description": "搜索半径，默认 64"}}}}},
    {"type": "function", "function": {
        "name": "attack", "description": "打附近的怪（自动换武器/追击），默认最多 2 只、最多 15 秒。",
        "parameters": {"type": "object", "properties": {
            "count": {"type": "number"}, "secs": {"type": "number"}}}}},
    {"type": "function", "function": {
        "name": "sleep", "description": "找床睡觉（天黑才有用，白天会被弹起来）。附近没床会说缺材料。",
        "parameters": {"type": "object", "properties": {
            "range": {"type": "number", "description": "找床半径，默认 32"},
            "force": {"type": "boolean", "description": "白天也要硬躺（调试用）"}}}}},
    {"type": "function", "function": {
        "name": "farm", "description": "种田：收成熟作物 / 用锄头把草方块泥土翻成耕地 / 给空耕地补种。mode 可填 auto(默认)、harvest、till、plant。",
        "parameters": {"type": "object", "properties": {
            "mode": {"type": "string", "description": "harvest / plant，不给就两样都干"},
            "range": {"type": "number", "description": "工作半径，默认 24"}}}}},
    {"type": "function", "function": {
        "name": "trade", "description": "找村民交易。不给 index 就只报交易菜单；给 index（第几笔，从 0 数）和 count 才真的换。",
        "parameters": {"type": "object", "properties": {
            "index": {"type": "number", "description": "第几笔交易，从 0 开始"},
            "count": {"type": "number", "description": "换几次，默认 1"},
            "range": {"type": "number", "description": "找村民半径，默认 32"}}}}},
    {"type": "function", "function": {
        "name": "shoot", "description": "用弓射箭。给 target 就射那个人/生物，不给就射最近的敌对怪。",
        "parameters": {"type": "object", "properties": {
            "target": {"type": "string", "description": "目标玩家名或生物名"},
            "count": {"type": "number", "description": "射几箭，最多 5，默认 1"},
            "range": {"type": "number", "description": "找怪半径，默认 24"}}}}},
    {"type": "function", "function": {
        "name": "ride", "description": "上附近的船/矿车/马（马要鞍）。已经在车上就下来。背包里有船时给 place=true 会自己放一艘。",
        "parameters": {"type": "object", "properties": {
            "range": {"type": "number", "description": "找载具半径，默认 16"},
            "place": {"type": "boolean", "description": "旁边没载具时自己放一艘船"}}}}},
]

FAST_ACTIONS = {"perceive", "inventory", "build_status", "say", "stop", "jump", "build_house", "follow",
                "waypoint", "goal", "need"}


def log(msg):
    line = "[%s] %s" % (datetime.now().strftime("%Y-%m-%d %H:%M:%S"), msg)
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def usage_path(ts=None):
    """当天账本路径：mc_usage/YYYY-MM-DD.jsonl（本地时区）。"""
    day = datetime.fromtimestamp(ts if ts else time.time()).strftime("%Y-%m-%d")
    return os.path.join(USAGE_DIR, day + ".jsonl")


def log_usage(src, model, data):
    """把一次调用的 usage 追加进当天的账本文件（余额插件的数据源）。"""
    try:
        u = (data or {}).get("usage") or {}
        pt = int(u.get("prompt_tokens") or 0)
        ct = int(u.get("completion_tokens") or 0)
        if not (pt or ct):
            return
        hit = u.get("prompt_cache_hit_tokens")
        if hit is None:
            hit = (u.get("prompt_tokens_details") or {}).get("cached_tokens") or 0
        now = int(time.time())
        rec = {
            "ts": now,
            "src": src,
            "model": model or "",
            "prompt_tokens": pt,
            "completion_tokens": ct,
            "cached_tokens": int(hit or 0),
        }
        os.makedirs(USAGE_DIR, exist_ok=True)
        with open(usage_path(now), "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except Exception:
        pass


def migrate_legacy_usage():
    """把旧的单文件 mc_usage.jsonl 按天拆进 mc_usage/，成功后原文件改名留档。"""
    try:
        if not os.path.isfile(USAGE) or os.path.getsize(USAGE) == 0:
            return 0
        buckets = {}
        bad = 0
        with open(USAGE, "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                    ts = int(float(rec.get("ts") or 0))
                except Exception:
                    bad += 1
                    continue
                if ts <= 0:
                    bad += 1
                    continue
                buckets.setdefault(usage_path(ts), []).append(line)
        if not buckets:
            return 0
        os.makedirs(USAGE_DIR, exist_ok=True)
        for path, lines in buckets.items():
            with open(path, "a", encoding="utf-8") as f:
                for line in lines:
                    f.write(line + "\n")
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        os.rename(USAGE, USAGE + ".migrated-" + stamp)
        log("账本迁移：%d 天、%d 行，坏行 %d；旧文件改名留档" % (len(buckets), sum(len(v) for v in buckets.values()), bad))
        return sum(len(v) for v in buckets.values())
    except Exception as e:
        log("账本迁移失败（不影响记账）：%r" % (e,))
        return 0


def prune_usage(keep_days=None):
    """账本自清理：删掉保留期外的按天账本，以及迁移留档的旧文件。"""
    keep = USAGE_KEEP_DAYS if keep_days is None else int(keep_days)
    if keep <= 0:
        return 0
    cutoff = (datetime.now() - timedelta(days=keep)).strftime("%Y-%m-%d")
    removed = 0
    try:
        names = sorted(os.listdir(USAGE_DIR))
    except Exception:
        return 0
    for name in names:
        if not name.endswith(".jsonl"):
            continue
        path = os.path.join(USAGE_DIR, name)
        if not os.path.isfile(path):
            continue
        day = name[:-len(".jsonl")]
        try:
            old = datetime.strptime(day, "%Y-%m-%d").strftime("%Y-%m-%d") < cutoff
        except Exception:
            continue          # 名字不是日期，别乱删
        if old:
            try:
                os.remove(path)
                removed += 1
            except Exception:
                pass
    # 迁移出来的旧账本整份按修改时间清
    try:
        for name in os.listdir(HERE):
            if ".jsonl.migrated-" not in name:
                continue
            path = os.path.join(HERE, name)
            try:
                if os.path.isfile(path) and os.path.getmtime(path) < time.time() - keep * 86400:
                    os.remove(path)
                    removed += 1
            except Exception:
                pass
    except Exception:
        pass
    if removed:
        log("账本清理：删除 %d 个超过 %d 天的旧文件" % (removed, keep))
    return removed


# ---------------- 模型 ----------------
def load_candidates():
    """从 AstrBot 配置里拿可用 provider；优先 deepseek/deepseek-chat（快）。"""
    with open(CONFIG, encoding="utf-8-sig") as f:
        cfg = json.load(f)
    sources = {s.get("id"): s for s in cfg.get("provider_sources") or []}
    out = []
    enabled = {p.get("id") for p in cfg.get("provider") or [] if p.get("enable")}
    prefer = [
        "deepseek/deepseek-chat",
        "deepseek/deepseek-flash",
        "zhipu/GLM-4.7-Flash",
        "中转站/deepseek-v4-flash",
    ]
    ids = [p for p in prefer if p in enabled]
    ids += [p for p in enabled if p and p not in ids and "/" in p]
    for pid in ids:
        sid, _, model = pid.partition("/")
        s = sources.get(sid)
        if not s or not model:
            continue
        key = s.get("key", "")
        if isinstance(key, list):
            key = next((k for k in key if str(k).strip()), "")
        if not str(key).strip():
            continue
        out.append({
            "api_base": str(s.get("api_base", "")).rstrip("/"),
            "api_key": str(key).strip(),
            "model": model,
            "pid": pid,
        })
    return out


def post_chat(msgs, tools=None, temp=0.95, max_tokens=200):
    """调一次模型，返回 (message_dict, pid)。带 tools 失败就退回纯文本。"""
    cands = load_candidates()
    if not cands:
        raise RuntimeError("没有可用模型")
    last = None
    for c in cands[:3]:
        payload = {
            "model": c["model"],
            "messages": msgs,
            "temperature": temp,
            "max_tokens": max_tokens,
            "stream": False,
        }
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"
        req = urllib.request.Request(
            c["api_base"] + "/chat/completions",
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json",
                     "Authorization": "Bearer " + c["api_key"]},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=MODEL_TIMEOUT) as r:
                data = json.loads(r.read().decode("utf-8", "ignore"))
            log_usage("bridge", c["model"], data)
            m = data["choices"][0]["message"]
            if tools and not (m.get("tool_calls") or (m.get("content") or "").strip()):
                raise RuntimeError("empty")
            return m, c["pid"]
        except Exception as e:
            last = "%s: %s" % (c["pid"], str(e)[:80])
            continue
    if tools:
        log("tools 调用失败(%s)，退回纯文本" % last)
        return post_chat(msgs, None, temp, max_tokens)
    raise RuntimeError(last or "全部模型失败")


def brief_result(name, res):
    """把回执压成一句话喂回模型（scan 之类一次几百个坐标会撑爆上下文）。"""
    if not res.get("ok"):
        return "失败：" + str(res.get("msg") or "")[:120]
    ex = res.get("extra") or {}
    if name == "scan":
        items = ex.get("list") or []
        txt = "共%s个" % ex.get("count")
        g = ex.get("group") or {}
        if g:
            txt += "（" + ",".join("%s x%s" % (k, v) for k, v in list(g.items())[:6]) + "）"
        if items:
            txt += "；近的：" + "；".join(
                "%s %s d%s" % (i.get("name"), i.get("pos"), i.get("dist")) for i in items[:5])
        return txt[:400]
    if name == "mobs":
        return str(res.get("msg") or "")[:300]
    if name in ("waypoint", "goal", "need"):
        return str(res.get("msg") or "")[:400]
    if name == "chest" and ex.get("items"):
        return (str(res.get("msg") or "")[:80] + " 内容：" +
                json.dumps(ex["items"], ensure_ascii=False)[:300])
    return (str(res.get("msg") or "")[:200] +
            ("" if not ex else " " + json.dumps(ex, ensure_ascii=False)[:300]))


def gen_reply(user, msg, history):
    """生成回复；模型可以调工具在游戏里干活。返回 (文本, pid, 动作记录)"""
    msgs = [{"role": "system", "content": PERSONA}]
    for h in history[-CTX_TURNS:]:
        msgs.append({"role": "user", "content": "%s: %s" % (h.get("user", "?"), h.get("msg", ""))})
        if h.get("reply"):
            msgs.append({"role": "assistant", "content": h["reply"]})
    msgs.append({"role": "user", "content": "%s: %s" % (user, msg)})

    actions, pid = [], None
    for _ in range(4):
        m, pid = post_chat(msgs, TOOLS)
        tcs = m.get("tool_calls") or []
        text = clean(m.get("content") or "")
        if not tcs:
            if text:
                return text, pid, actions
            break
        msgs.append({"role": "assistant", "content": m.get("content") or "", "tool_calls": tcs})
        for tc in tcs[:3]:
            fn = (tc.get("function") or {})
            name = fn.get("name") or ""
            try:
                args = json.loads(fn.get("arguments") or "{}")
                if not isinstance(args, dict):
                    args = {}
            except Exception:
                args = {}
            res = send_action(name, args)
            brief = {"name": name, "args": args, "ok": res.get("ok"), "msg": res.get("msg")}
            actions.append(brief)
            log("TOOL %s %s -> %s %s" % (name, json.dumps(args, ensure_ascii=False),
                                         res.get("ok"), str(res.get("msg"))[:60]))
            msgs.append({"role": "tool", "tool_call_id": tc.get("id") or name,
                         "name": name,
                         "content": brief_result(name, res)})
        # 已经干了活，再要一轮话术就够了
    return "", pid, actions


def clean(t):
    t = re.sub(r"^(回复|回答)[:：]\s*", "", t)
    t = t.replace("\r", " ").replace("\n", " ").strip()
    t = t.strip('"“”\'')
    t = re.sub(r"\s+", " ", t)
    if len(t) > REPLY_MAX:
        t = t[:REPLY_MAX].rstrip("，,、 ") + "…"
    return t


# ---------------- 文件通道 ----------------
def read_new_lines(state):
    """按字节偏移读 chat_in.jsonl 的**完整**新行；只推进到最后一个换行处，
    避免多算/少算导致重复消费。文件被重建（变小）则从头读。"""
    if not os.path.exists(CHAT_IN):
        return [], state
    try:
        size = os.path.getsize(CHAT_IN)
        off = int(state.get("offset") or 0)
        if off > size:
            off = 0
        with open(CHAT_IN, "rb") as f:
            f.seek(off)
            chunk = f.read()
        if not chunk:
            return [], state
        nl = chunk.rfind(b"\n")
        if nl < 0:                       # 还没有一整行，等下次
            return [], state
        complete = chunk[:nl + 1]
        state["offset"] = off + nl + 1
        lines = []
        for raw in complete.split(b"\n"):
            if not raw.strip():
                continue
            try:
                lines.append(json.loads(raw.decode("utf-8", "ignore")))
            except Exception:
                log("badLine " + raw[:80].decode("utf-8", "ignore"))
        return lines, state
    except Exception as e:
        log("readErr " + str(e)[:100])
        return [], state


def load_state():
    try:
        with open(STATE, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_state(st):
    try:
        with open(STATE, "w", encoding="utf-8") as f:
            json.dump(st, f)
    except Exception:
        pass


def write_raw(text, wait=12.0):
    """写一行任意指令到 cmd.txt；若已有待执行命令，等它被吃掉再写。"""
    end = time.time() + wait
    while time.time() < end:
        if not os.path.exists(CMD):
            try:
                with open(CMD, "w", encoding="utf-8") as f:
                    f.write(text)
                return True
            except Exception:
                pass
        time.sleep(0.2)
    return False


def write_cmd(text, wait=10.0):
    return write_raw("说 " + text, wait)


def send_action(name, args=None, timeout=None):
    """把动作发给 play.js，等它回执（act_out.json 里 id 对上）。"""
    args = args or {}
    if timeout is None:
        timeout = 8.0 if name in FAST_ACTIONS else 32.0
        if name == "pvp":   # 对打要等打完（默认 30s，最长 120s）
            timeout = max(30.0, min(120.0, float(args.get("secs") or 30)) + 25.0)
    aid = "%d" % (int(time.time() * 1000) % 10 ** 11)
    line = "ACT " + json.dumps({"id": aid, "name": name, "args": args}, ensure_ascii=False)
    if not write_raw(line, wait=min(10.0, timeout)):
        return {"ok": False, "msg": "游戏那边命令通道忙着，没发出去"}
    end = time.time() + timeout
    while time.time() < end:
        try:
            with open(ACT_OUT, encoding="utf-8") as f:
                rec = json.load(f)
            if str(rec.get("id")) == aid:
                return rec
        except Exception:
            pass
        time.sleep(0.15)
    return {"ok": False, "msg": "动作超时没回信：%s" % name}


def touch_hb():
    try:
        with open(HEARTBEAT, "w") as f:
            f.write(str(int(time.time())))
    except Exception:
        pass


# ---------------- 主循环 ----------------
def handle(items, state):
    """处理一批聊天；history 存在 state['hist'] 里，按玩家分组。"""
    hist_all = state.setdefault("hist", {})
    last = state.setdefault("last_reply", {})
    done = 0
    for it in items:
        if done >= MAX_PER_ROUND:
            break
        user = str(it.get("user") or "?")[:20]
        msg = str(it.get("msg") or "")[:300]
        if not msg.strip():
            continue
        now = time.time()
        if now - float(last.get(user) or 0) < PER_USER_GAP:
            continue
        try:
            reply, pid, acts = gen_reply(user, msg, hist_all.get(user, []))
        except Exception as e:
            log("FAIL %s <- %s | %s" % (user, msg[:40], e))
            continue
        h = hist_all.setdefault(user, [])
        h.append({"user": user, "msg": msg, "reply": reply})
        del h[:-20]
        last[user] = time.time()
        if not reply:   # 只调了工具没说话：按动作给句兜底
            oked = [a for a in acts if a.get("ok")]
            bad = [a for a in acts if not a.get("ok")]
            if any(a.get("name") == "build_house" and a.get("ok") for a in acts):
                reply = "开工啦～等我盖好喊你 ouo"
            elif bad and not oked:          # 全失败就别嘴硬，照实说
                reply = ("没弄成…" + str(bad[0].get("msg") or "")[:40]).strip()
            elif acts:
                reply = "好嘞，马上弄！"
            else:
                reply = ""
        if not reply:
            continue
        log("LLM %s: %s  =>  %s  (%s) acts=%s" % (user, msg[:50], reply, pid,
                                                   [a.get("name") for a in acts]))
        if write_cmd(reply):
            touch_hb()
            done += 1
    return done


def main():
    once = "--once" in sys.argv
    if "--test" in sys.argv:
        i = sys.argv.index("--test")
        msg = sys.argv[i + 1] if len(sys.argv) > i + 1 else "你好呀"
        t = time.time()
        reply, pid, acts = gen_reply("tester", msg, [])
        print("%s  (%.1fs, %s)" % (reply, time.time() - t, pid))
        return
    log("bridge start (once=%s)" % once)
    migrate_legacy_usage()
    state = load_state()
    if state.get("usage_prune_day") != datetime.now().strftime("%Y-%m-%d"):
        prune_usage()
        state["usage_prune_day"] = datetime.now().strftime("%Y-%m-%d")
        save_state(state)
    if "offset" not in state:
        # 首次启动：跳过历史积压，只处理之后的聊天
        try:
            state["offset"] = os.path.getsize(CHAT_IN) if os.path.exists(CHAT_IN) else 0
        except Exception:
            state["offset"] = 0
        save_state(state)
    idle = 0
    while True:
        items, state = read_new_lines(state)
        if items:
            n = handle(items, state)
            save_state(state)
            idle = 0
            if n == 0 and once:
                break
        else:
            idle += 1
            # 空闲也保持心跳，play.js 才知道桥还活着
            if idle % 3 == 0:
                touch_hb()
        if once:
            break
        if state.get("usage_prune_day") != datetime.now().strftime("%Y-%m-%d"):
            prune_usage()
            state["usage_prune_day"] = datetime.now().strftime("%Y-%m-%d")
            save_state(state)
        time.sleep(POLL)


if __name__ == "__main__":
    main()
