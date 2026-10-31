"""生成 xiaoice 的 Minecraft 皮肤（64x64, Alex/Steve 通用布局）"""
from PIL import Image

# ---------- 配色 ----------
SKIN      = (245, 224, 208, 255)
HAIR      = (242, 248, 253, 255)
HAIR_ICE  = (150, 212, 238, 255)
DRESS     = (74, 127, 191, 255)
DRESS_DARK= (56, 98, 152, 255)
SCARF     = (255, 255, 255, 255)
SCARF_SH  = (222, 234, 246, 255)
EYE       = (54, 104, 176, 255)
BLUSH     = (240, 162, 162, 255)
SOCK      = (250, 250, 255, 255)
BOOT      = (68, 104, 156, 255)

img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))


def box(x0, y0, x1, y1, c):
    for y in range(y0, y1):
        for x in range(x0, x1):
            img.putpixel((x, y), c)


def rect(x0, y0, w, h, c):
    box(x0, y0, x0 + w, y0 + h, c)


# ---------- 头部 ----------
box(8, 0, 16, 8, HAIR)        # 顶
box(16, 0, 24, 8, HAIR)       # 底（发根）
box(0, 8, 8, 16, HAIR)        # 右
box(24, 8, 32, 16, HAIR)      # 后
box(16, 8, 24, 16, HAIR)      # 左

# 脸 8x8  @ (8,8)
box(8, 8, 16, 16, SKIN)
box(8, 8, 16, 10, HAIR)              # 刘海 2 行
# 鬓角 + 刘海碎
rect(8, 10, 2, 1, HAIR); rect(14, 10, 2, 1, HAIR)
rect(8, 11, 1, 2, HAIR); rect(15, 11, 1, 2, HAIR)
# 眼睛 2x1 x2
rect(9, 12, 2, 1, EYE); rect(13, 12, 2, 1, EYE)
# 腮红
rect(9, 14, 1, 1, BLUSH); rect(14, 14, 1, 1, BLUSH)

# 发梢冰蓝
box(24, 14, 32, 16, HAIR_ICE)
box(0, 14, 8, 16, HAIR_ICE)
box(16, 14, 24, 16, HAIR_ICE)

# ---------- 身体 8x12x4 ----------
box(20, 16, 28, 20, SCARF)          # 顶
box(28, 16, 36, 20, DRESS_DARK)     # 底
box(16, 20, 20, 32, DRESS)          # 右
box(28, 20, 32, 32, DRESS)          # 左
box(32, 20, 40, 32, DRESS)          # 后
box(20, 20, 28, 32, DRESS)          # 前
# 围巾 + 裙摆
for ax, ay in ((16, 20), (28, 20), (32, 20), (20, 20)):
    rect(ax, ay, 8 if ax in (32, 20) else 4, 2, SCARF)
    rect(ax, ay + 10, 8 if ax in (32, 20) else 4, 2, DRESS_DARK)
# 前襟一点白
rect(23, 22, 2, 8, SCARF_SH)

# ---------- 右腿 ----------
box(4, 16, 8, 20, SOCK); box(8, 16, 12, 20, SOCK)
for ax, w in ((0, 4), (4, 4), (8, 4), (12, 4)):
    rect(ax, 20, w, 12, SOCK)
    rect(ax, 26, w, 6, BOOT)

# ---------- 左腿 ----------
box(20, 48, 24, 52, SOCK); box(24, 48, 28, 52, SOCK)
for ax in (16, 20, 24, 28):
    rect(ax, 52, 4, 12, SOCK)
    rect(ax, 58, 4, 6, BOOT)

# ---------- 右臂 ----------
box(44, 16, 48, 20, SKIN); box(48, 16, 52, 20, SKIN)
for ax in (40, 44, 48, 52):
    rect(ax, 20, 4, 2, DRESS)      # 袖口
    rect(ax, 22, 4, 10, SKIN)

# ---------- 左臂 ----------
box(36, 48, 40, 52, SKIN); box(40, 48, 44, 52, SKIN)
for ax in (32, 36, 40, 44):
    rect(ax, 52, 4, 2, DRESS)
    rect(ax, 54, 4, 10, SKIN)

img.save("mcbot/skins/xiaoice.png")

# ---------- 正视图预览 ----------
pv = Image.new("RGBA", (16, 32), (238, 241, 247, 255))
pv.paste(img.crop((8, 8, 16, 16)), (4, 0))     # 头
pv.paste(img.crop((20, 20, 28, 32)), (4, 8))   # 身体
pv.paste(img.crop((44, 20, 48, 32)), (0, 8))   # 右臂
pv.paste(img.crop((36, 52, 40, 64)), (12, 8))  # 左臂
pv.paste(img.crop((4, 20, 8, 32)), (4, 20))    # 右腿
pv.paste(img.crop((20, 52, 24, 64)), (8, 20))  # 左腿

pv.resize((16 * 12, 32 * 12), Image.NEAREST).save("mcbot/skins/preview.png")
print("OK")
