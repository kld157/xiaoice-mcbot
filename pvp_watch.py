#!/usr/bin/env python3
"""待战模式：盯着 ZS_zzz 上线，一出现就用 L5 跟他打一场。
用法: python3 pvp_watch.py [玩家名] [分钟上限]
"""
import json, os, sys, time

BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE)
from runact import send

TARGET = (sys.argv[1] if len(sys.argv) > 1 else 'ZS_zzz')
MINUTES = float(sys.argv[2]) if len(sys.argv) > 2 else 90
LOG = os.path.join(BASE, 'pvp_watch.log')


def log(msg):
    line = '[%s] %s' % (time.strftime('%H:%M:%S'), msg)
    with open(LOG, 'a', encoding='utf-8') as f:
        f.write(line + '\n')


if __name__ == '__main__':
    end = time.time() + MINUTES * 60
    log('待战开始 目标=%s 上限=%d分钟' % (TARGET, MINUTES))
    while time.time() < end:
        d = send({'name': 'perceive'}, timeout=20)
        e = d.get('extra') or {}
        players = e.get('players') or []
        if TARGET in players:
            log('发现 %s 在线，开打 L5' % TARGET)
            r = send({'name': 'pvp', 'args': {'player': TARGET, 'skill': 5, 'secs': 45, 'stopHp': 6}}, timeout=120)
            log('结果 ok=%s %s' % (r.get('ok'), r.get('msg')))
            break
        time.sleep(5)
    else:
        log('超时，%s 一直没上线，待战结束' % TARGET)
