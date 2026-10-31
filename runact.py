#!/usr/bin/env python3
"""向 mcbot 发一个 ACT 并等结果。用法: python3 runact.py '{"name":"say","args":{"text":"/time set day"}}'"""
import json, os, sys, time

BASE = os.path.dirname(os.path.abspath(__file__))
CMD = os.path.join(BASE, 'cmd.txt')
OUT = os.path.join(BASE, 'act_out.json')


def send(act, timeout=90):
    act = dict(act)
    act.setdefault('id', 'p%d' % int(time.time() * 1000))
    try:
        os.remove(OUT)
    except OSError:
        pass
    with open(CMD, 'w') as f:
        f.write('ACT ' + json.dumps(act) + '\n')
    t0 = time.time()
    while time.time() - t0 < timeout:
        time.sleep(0.4)
        try:
            with open(OUT) as f:
                d = json.load(f)
        except Exception:
            continue
        if str(d.get('id')) == str(act['id']):
            return d
    return {'ok': False, 'msg': 'timeout', 'id': act['id']}


if __name__ == '__main__':
    acts = [json.loads(a) for a in sys.argv[1:]] or [json.load(sys.stdin)]
    for a in acts:
        d = send(a)
        print(('OK ' if d.get('ok') else 'NO ') + a.get('name', '?') + ' :: ' + str(d.get('msg'))[:160])
