#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""mcscan.py — 通用「方块扫描」对外的调用封装（play.js 里 scan 动作的 Python 壳）

只读工具：不会改动世界，只回答「这片范围里有什么方块、在哪」。
限制：只能扫到服务器**已加载**的区块（bot 视距内），扫太远会返回 unloaded 偏高。

脚本里用：
    import mcscan
    chests = mcscan.scan('chest|barrel', r=12, ry=6)   # 以 bot 当前位置为中心
    far    = mcscan.scan('diamond_ore', x=100, y=12, z=200, r=8)
    near   = mcscan.first('water')                     # 最近的第一个
    n      = mcscan.count('grass_block', r=10)         # 只要数量

    # 扫到容器顺手登记进 chests.json，之后 chest 动作可直接用名字开
    mcscan.register_chests(r=12, prefix='box')

命令行：
    python3 mcscan.py 'chest|barrel' --r 12
    python3 mcscan.py 'diamond_ore|deepslate_diamond_ore' --r 16 --limit 20
    python3 mcscan.py 'chest' --r 12 --register box
"""
import sys
import json
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mc_bridge  # noqa: E402

SCAN_TIMEOUT = 30.0
CONTAINER_PAT = 'chest|trapped_chest|barrel'


def scan(match, x=None, y=None, z=None, r=None, rx=None, ry=None, rz=None,
         y0=None, y1=None, limit=80, sort='dist', timeout=SCAN_TIMEOUT):
    """扫一片方块，返回 [{name, pos:[x,y,z], dist}, ...]（按距离排序，最多 limit 个）。

    match: "chest" / "chest,barrel" / "chest|barrel" / 正则（含正则符号时按正则用）
    不给 x,y,z 就以 bot 当前位置为中心；r 是水平半径，ry 是上下半径。
    """
    args = {'match': str(match), 'limit': limit, 'sort': sort}
    for k, v in (('x', x), ('y', y), ('z', z), ('r', r), ('rx', rx), ('ry', ry),
                 ('rz', rz), ('y0', y0), ('y1', y1)):
        if v is not None:
            args[k] = v
    rec = mc_bridge.send_action('scan', args, timeout)
    if not rec.get('ok'):
        raise RuntimeError(rec.get('msg') or 'scan 失败')
    return (rec.get('extra') or {}).get('list') or []


def scan_full(match, **kw):
    """同 scan()，但要完整回执（含 count/group/unloaded），排查"为啥没扫到"时用它。"""
    args = {'match': str(match)}
    args.update({k: v for k, v in kw.items() if v is not None})
    rec = mc_bridge.send_action('scan', args, SCAN_TIMEOUT)
    return rec.get('extra') if rec.get('ok') else {'error': rec.get('msg')}


def first(match, **kw):
    """最近的一个，没有就返回 None。"""
    kw.setdefault('limit', 1)
    got = scan(match, **kw)
    return got[0] if got else None


def count(match, **kw):
    """只要数量（可能大于 limit，因为 count 是扫描到的总数）。"""
    kw.setdefault('limit', 1)
    full = scan_full(match, **kw)
    return int(full.get('count') or 0)


def group(match, **kw):
    """按方块名统计：{'chest': 2, 'barrel': 1}"""
    full = scan_full(match, **kw)
    return full.get('group') or {}


def chests(r=12, ry=6, **kw):
    """附近所有箱子/木桶。"""
    return scan(CONTAINER_PAT, r=r, ry=ry, **kw)


def register_chests(r=12, ry=6, prefix='box', chests_file=None):
    """把附近扫到的容器写进 chests.json，返回 {名字: [x,y,z]}。

    已登记过同一坐标的名字不会重复写；新名字按 前缀+序号 起。
    """
    chests_file = chests_file or os.path.join(os.path.dirname(os.path.abspath(__file__)), 'chests.json')
    try:
        with open(chests_file, encoding='utf-8') as f:
            reg = json.load(f)
    except Exception:
        reg = {}
    known = set(tuple(v) for v in reg.values())
    added = {}
    i = 0
    for c in chests(r=r, ry=ry):
        pos = list(c['pos'])
        if tuple(pos) in known:
            continue
        while True:
            i += 1
            name = '%s%d' % (prefix, i)
            if name not in reg:
                break
        reg[name] = pos
        known.add(tuple(pos))
        added[name] = pos
    if added:
        with open(chests_file, 'w', encoding='utf-8') as f:
            json.dump(reg, f, ensure_ascii=False, indent=1)
    return added


def main(argv):
    import argparse
    ap = argparse.ArgumentParser(description='扫 Minecraft 附近方块（只读）')
    ap.add_argument('match', nargs='?', default=CONTAINER_PAT, help='名字或正则，默认找容器')
    ap.add_argument('--r', type=int, default=8, help='水平半径（默认 8）')
    ap.add_argument('--ry', type=int, default=None, help='上下半径')
    ap.add_argument('--x', type=int)
    ap.add_argument('--y', type=int)
    ap.add_argument('--z', type=int)
    ap.add_argument('--limit', type=int, default=20)
    ap.add_argument('--register', metavar='PREFIX', help='把扫到的容器登记成 PREFIX+序号')
    a = ap.parse_args(argv)

    if a.register:
        added = register_chests(r=a.r, ry=a.ry or max(2, a.r // 2), prefix=a.register)
        print('登记了 %d 个容器：%s' % (len(added), json.dumps(added, ensure_ascii=False)))
        return 0
    full = scan_full(a.match, x=a.x, y=a.y, z=a.z, r=a.r, ry=a.ry, limit=a.limit)
    if 'error' in full:
        print('失败：', full['error'])
        return 1
    print('中心 %s 范围 %s → 共 %s 个，未加载区块 %s' % (full['center'], full['box'], full['count'], full.get('unloaded')))
    for it in full['list']:
        print('  %-24s %s  距离 %s' % (it['name'], it['pos'], it.get('dist')))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
