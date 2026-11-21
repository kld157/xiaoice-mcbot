# -*- coding: utf-8 -*-
"""离线自测：用一个假的 play.js 连上适配器，验证收发两个方向。

不启动 AstrBot，直接构造适配器实例 + 假的 unix socket 服务端。
"""
import asyncio
import importlib.util
import json
import os
import sys

SOCK = "/tmp/mc_test_ipc.sock"
sys.path.insert(0, "/AstrBot")

spec = importlib.util.spec_from_file_location(
    "mcn", "/AstrBot/data/plugins/astrbot_plugin_mc_native/main.py"
)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

from astrbot.api.message_components import Plain
from astrbot.core.message.message_event_result import MessageChain


def log(*a):
    print("[test]", *a, flush=True)


async def main():
    if os.path.exists(SOCK):
        os.unlink(SOCK)

    got = []          # 服务端（假 play.js）收到的 say
    connected = asyncio.Event()

    async def handle(reader, writer):
        connected.set()
        buf = b""
        while True:
            chunk = await reader.read(4096)
            if not chunk:
                break
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                if not line.strip():
                    continue
                obj = json.loads(line)
                got.append(obj)
                log("<- adapter:", obj)
                if obj.get("t") == "say":
                    writer.write((json.dumps({"t": "self", "msg": obj["text"]}) + "\n").encode())
                    await writer.drain()
        writer.close()

    server = await asyncio.start_unix_server(handle, path=SOCK)

    cfg = {
        "id": "minecraft",
        "socket_path": SOCK,
        "bot_name": "xiaoice_bot",
        "always_names": ["小冰"],
        "reply_prob": 1.0,       # 测试里放行闲聊
        "cooldown": 0,
        "max_lines": 3,
        "seg_len": 20,
        "roll_size": 24,
    }
    q = asyncio.Queue()
    ad = m.MCPlatformAdapter(cfg, None, q)
    task = asyncio.create_task(ad.run())
    await asyncio.wait_for(connected.wait(), 5)
    log("已连上 ✓")
    await asyncio.sleep(0.2)

    # 1) 收：公屏闲聊应该被丢进事件队列
    await ad.send_chain(MessageChain([Plain("（我先确认一下通道是否通畅）")]))
    ad._last_reply = 0
    await ad._on_chat("Steve", "小冰你在干嘛呀")
    try:
        ev = await asyncio.wait_for(q.get(), 3)
        log("事件队列收到：", ev.message_str, "| session =", ev.message_obj.session_id,
            "| platform =", ev.get_platform_name())
    except asyncio.TimeoutError:
        log("!! 没收到事件")

    # 2) 发：长回复要切句、逐条发
    ad._last_reply = 0
    await ad.send_chain(
        MessageChain([Plain("（歪头）你好呀！今天想玩点什么？我陪你呀～咱们去挖矿吧不然天就黑了，**快去**")])
    )
    await asyncio.sleep(1.5)

    says = [o["text"] for o in got if o.get("t") == "say"]
    log("play.js 侧收到 say：", says)
    log("公屏池：")
    print(m.ROLL.render())

    assert len(says) >= 2, "应该切成多条"
    assert all(len(s) <= 40 for s in says), "单条不该过长"
    assert any("我" in line for line in [m.ROLL.render()]), "公屏池该有自己说的话"

    ad._closing = True
    task.cancel()
    server.close()
    await asyncio.sleep(0.2)
    if os.path.exists(SOCK):
        os.unlink(SOCK)
    print("\nALL PASS ✅")


asyncio.run(main())
