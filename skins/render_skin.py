"""MC 皮肤等距渲染器（纯 PIL，无依赖）。

用法: python render_skin.py <skin.png> [out.png]
"""
import math
import sys
from PIL import Image, ImageDraw, ImageFilter

LIGHT = (0.30, 0.86, 0.41)
_l = math.sqrt(sum(c * c for c in LIGHT))
LIGHT = tuple(c / _l for c in LIGHT)

# name, cx, cy, cz, sx, sy, sz, uv_u, uv_v, inflate
PARTS = [
    ("body",   0, 18, 0, 8, 12, 4, 16, 16, 0.0),
    ("head",   0, 28, 0, 8,  8, 8,  0,  0, 0.0),
    ("rarm",  -6, 18, 0, 4, 12, 4, 40, 16, 0.0),
    ("larm",   6, 18, 0, 4, 12, 4, 32, 48, 0.0),
    ("rleg",  -2,  6, 0, 4, 12, 4,  0, 16, 0.0),
    ("lleg",   2,  6, 0, 4, 12, 4, 16, 48, 0.0),
    ("hat",    0, 28, 0, 8,  8, 8, 32,  0, 0.55),
    ("jacket", 0, 18, 0, 8, 12, 4, 16, 32, 0.30),
    ("rarm_o",-6, 18, 0, 4, 12, 4, 40, 32, 0.30),
    ("larm_o", 6, 18, 0, 4, 12, 4, 48, 48, 0.30),
    ("rleg_o",-2,  6, 0, 4, 12, 4,  0, 32, 0.30),
    ("lleg_o", 2,  6, 0, 4, 12, 4, 16, 32, 0.30),
]


def _faces(cx, cy, cz, sx, sy, sz, u0, v0):
    hx, hy, hz = sx / 2, sy / 2, sz / 2
    x0, x1 = cx - hx, cx + hx
    y0, y1 = cy - hy, cy + hy
    z0, z1 = cz - hz, cz + hz
    F = []
    fu, fv = u0 + sx, v0 + sz
    F.append(((0, 0, 1), [(x0, y1, z1), (x1, y1, z1), (x1, y0, z1), (x0, y0, z1)], (fu, fv, fu + sx, fv + sy)))
    ru, rv = u0, v0 + sz
    F.append(((1, 0, 0), [(x1, y1, z1), (x1, y1, z0), (x1, y0, z0), (x1, y0, z1)], (ru, rv, ru + sz, rv + sy)))
    bu, bv = u0 + 2 * sx + sz, v0 + sz
    F.append(((0, 0, -1), [(x1, y1, z0), (x0, y1, z0), (x0, y0, z0), (x1, y0, z0)], (bu, bv, bu + sx, bv + sy)))
    lu, lv = u0 + sx + sz, v0 + sz
    F.append(((-1, 0, 0), [(x0, y1, z0), (x0, y1, z1), (x0, y0, z1), (x0, y0, z0)], (lu, lv, lu + sz, lv + sy)))
    tu, tv = u0 + sx, v0
    F.append(((0, 1, 0), [(x0, y1, z0), (x1, y1, z0), (x1, y1, z1), (x0, y1, z1)], (tu, tv, tu + sx, tv + sz)))
    return F


def render(skin, yaw_deg, pitch_deg, S=15, shade_lo=0.74, shade_hi=0.36):
    """返回 RGBA 图。yaw 负值 = 露出正脸。"""
    SP = skin.load()
    Ws, Hs = skin.size

    def sample(u, v):
        return SP[max(0, min(Ws - 1, int(u))), max(0, min(Hs - 1, int(v)))]

    yaw, pitch = math.radians(yaw_deg), math.radians(pitch_deg)
    CY, SY = math.cos(yaw), math.sin(yaw)
    CP, SPI = math.cos(pitch), math.sin(pitch)

    def rot(p):
        x, y, z = p
        x1 = x * CY + z * SY
        z1 = -x * SY + z * CY
        return (x1, y * CP - z1 * SPI, y * SPI + z1 * CP)

    Wv, Hv = int(26 * S), int(46 * S)
    img = Image.new("RGBA", (Wv, Hv), (0, 0, 0, 0))
    px = img.load()
    OX, OY = Wv / 2, 40 * S

    items = []
    for _n, cx, cy, cz, sx, sy, sz, u0, v0, inf in PARTS:
        for nrm, corners, uv in _faces(cx, cy, cz, sx + 2 * inf, sy + 2 * inf, sz + 2 * inf, u0, v0):
            rn = rot(nrm)
            if rn[2] <= 0.002:
                continue
            rc = [rot(c) for c in corners]
            items.append((sum(p[2] for p in rc) / 4.0, rn, rc, uv))
    items.sort(key=lambda t: t[0])

    for _dep, rn, rc, uv in items:
        pts = [(p[0] * S + OX, -p[1] * S + OY) for p in rc]
        P00, P10, _P11, P01 = pts
        dA = (P10[0] - P00[0], P10[1] - P00[1])
        dB = (P01[0] - P00[0], P01[1] - P00[1])
        det = dA[0] * dB[1] - dA[1] * dB[0]
        if abs(det) < 1e-9:
            continue
        u0, v0, u1, v1 = uv
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        xa = max(int(min(xs)), 0)
        xb = min(int(max(xs)) + 1, Wv - 1)
        ya = max(int(min(ys)), 0)
        yb = min(int(max(ys)) + 1, Hv - 1)
        nl = max(0.0, sum(rn[i] * LIGHT[i] for i in range(3)))
        sh = shade_lo + shade_hi * nl
        for py in range(ya, yb):
            for pxx in range(xa, xb):
                dx = pxx + 0.5 - P00[0]
                dy = py + 0.5 - P00[1]
                a = (dx * dB[1] - dy * dB[0]) / det
                b = (dA[0] * dy - dA[1] * dx) / det
                if a < -0.002 or a > 1.002 or b < -0.002 or b > 1.002:
                    continue
                c = sample(u0 + a * (u1 - u0), v0 + b * (v1 - v0))
                if c[3] < 128:
                    continue
                px[pxx, py] = (
                    min(255, int(c[0] * sh)),
                    min(255, int(c[1] * sh)),
                    min(255, int(c[2] * sh)),
                    255,
                )
    return img


def compose(skin, views, S=15, bg_top=(234, 243, 252), bg_bot=(252, 250, 246)):
    imgs = [render(skin, *v, S=S) for v in views]
    w = sum(i.width for i in imgs) + 40
    h = max(i.height for i in imgs) + 40
    out = Image.new("RGB", (w, h), bg_bot)
    dr = ImageDraw.Draw(out)
    for y in range(h):
        t = y / h
        dr.line([(0, y), (w, y)], fill=tuple(int(bg_top[k] + (bg_bot[k] - bg_top[k]) * t) for k in range(3)))
    ox = 20
    for im in imgs:
        sh = Image.new("RGBA", (im.width, im.height), (0, 0, 0, 0))
        sd = ImageDraw.Draw(sh)
        sd.ellipse([im.width / 2 - 78, im.height - 30, im.width / 2 + 78, im.height - 8], fill=(60, 70, 90, 60))
        sh = sh.filter(ImageFilter.GaussianBlur(7))
        base = out.crop((ox, 20, ox + im.width, 20 + im.height)).convert("RGB")
        base.paste(Image.new("RGB", (im.width, im.height), (238, 240, 244)), (0, 0), sh)
        out.paste(base, (ox, 20))
        out.paste(im, (ox, 20), im)
        ox += im.width
    return out


if __name__ == "__main__":
    src = sys.argv[1] if len(sys.argv) > 1 else "xiaoice.png"
    dst = sys.argv[2] if len(sys.argv) > 2 else "shot.png"
    sk = Image.open(src).convert("RGBA")
    compose(sk, [(-22, 9), (0, 6), (158, 10)]).save(dst)
    print("saved", dst)
