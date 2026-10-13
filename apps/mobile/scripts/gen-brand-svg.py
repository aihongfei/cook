#!/usr/bin/env python3
"""
从量测数据生成 public/favicon.svg（矢量版品牌图标）。

为什么用脚本而不是手写 path：手写时每个坐标都要人工做一次「原图 → 64 视图」的
换算，两个方向各一次、十来个点，很容易错一个（本文件的前身就把门的右边界算错，
渲染出来门糊住了半个房子）。这里把量测值原样保留、换算交给一个函数，
改一个数就整体一致。

量测来源：assets/icon-foreground.png 裁到内容框后逐行扫红/黄两色的 x 区间
（做法见 RUNBOOK R-060）。坐标记在 ORIG_W × ORIG_H 的内容框里。
"""
import pathlib

ORIG_W, ORIG_H = 100.0, 112.0   # 量测时用的归一化内容框
BOX = 64.0                      # 输出 viewBox
ART_H_RATIO = 0.573             # 房子高度占图标的比例（与位图 favicon.png 一致）

def make_transform():
    scale = BOX * ART_H_RATIO / ORIG_H
    ox = (BOX - ORIG_W * scale) / 2
    oy = (BOX - ORIG_H * scale) / 2
    def T(x, y):
        return ox + x * scale, oy + y * scale
    return T

T = make_transform()
def pts(*pairs):
    return " ".join(f"{x:.2f},{y:.2f}" for x, y in (T(a, b) for a, b in pairs))

# --- 量测值（内容框坐标）---
ROOF_APEX   = (49.5, 8.0)
ROOF_L      = (0.0, 62.0)     # 屋檐「浪与浪相接」的高度
ROOF_R      = (99.5, 59.0)
EAVE_DIP    = 4.0       # 每个浪头往下探多少（内容框单位）。
                        # 实测：房身黄色从 row 62 起、红色在 row 66 全部消失，
                        # 所以浪深 ≈ 4 行。这个值直接决定屋檐的"手绘感"，
                        # 设成 1 就完全看不出波浪（第一版就是这个毛病）
CHIM_L, CHIM_R = (67.0, 16.0), (84.0, 62.0)
DOOR_L, DOOR_R = (26.0, 79.0), (46.0, 111.0)
DOOR_TOP    = 79.0
BODY_L, BODY_R = (10.0, 62.0), (89.0, 111.0)
WIN_L       = (58.0, 76.0, 67.0, 95.0)   # x0,y0,x1,y1 左窗（右上那格）
WIN_R       = (69.0, 76.0, 77.0, 95.0)
HEART       = (75.0, 7.5, 5.0)           # 中心 x, 中心 y, 半宽

def build():
    ax, ay = T(*ROOF_APEX)
    lx, ly = T(*ROOF_L)
    rx, ry = T(*ROOF_R)
    cx0, cy0 = T(*CHIM_L)
    cx1, cy1 = T(*CHIM_R)
    bx0, by0 = T(*BODY_L)
    bx1, by1 = T(*BODY_R)
    dx0, dy0 = T(*DOOR_L)
    dx1, dy1 = T(*DOOR_R)
    dty = T(0, DOOR_TOP)[1]
    eave = T(0, ROOF_L[1] + EAVE_DIP)[1]
    # 六个波浪：把屋檐宽度六等分
    n = 6
    wave_w = (rx - lx) / n
    waves = []
    for i in range(n):
        x0 = lx + i * wave_w
        x1 = x0 + wave_w
        waves.append(f"Q {(x0+x1)/2:.2f} {eave:.2f} {x1:.2f} {ly:.2f}")
    wave_path = "\n           ".join(waves)
    # 窗：四格（左右两列 × 上下两行）
    wx0, wy0, wx1, wy1 = WIN_L
    xr0, yr0, xr1, yr1 = WIN_R
    win_l = T(wx0, wy0); win_r = T(wx1, wy1)
    winR_l = T(xr0, yr0); winR_r = T(xr1, yr1)
    win_w = max(1.6, (win_r[0] - win_l[0]) / 2 - 0.35)
    win_h = (win_r[1] - win_l[1]) / 2 - 0.35
    hx, hy = T(HEART[0], HEART[1])
    hr = T(HEART[2], 0)[0] - T(0, 0)[0]
    hr *= 1.12   # 光学补偿：原图爱心只有 ~3px（64 视图下），纯按比例缩会糊成一团

    door_r = (dx1 - dx0) / 2
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <!--
    御膳 · 品牌图标（矢量版）。

    ⚠️ 本文件由 scripts/gen-brand-svg.py 生成，不要手改——改量测值再重跑那个脚本。
    它按 assets/icon-foreground.png 的实测形状绘制（逐行扫红/黄两色取边界），
    房子高度占 {ART_H_RATIO:.1%}，与位图 favicon.png 同一造型、同一大小，
    区别只是没有水粉颗粒，且任意放大不糊。

    改图标时：改母图 docs/brand/icon-master-1024.png → 重跑
    scripts/build-brand-assets.sh（重画 favicon.png）→ 重跑本脚本。
    真要重画形状，先按量测流程重新量一遍，见 RUNBOOK R-060。
  -->
  <rect width="64" height="64" rx="13" fill="#FCF1DA"/>

  <!-- 烟囱（在屋顶后面） -->
  <rect x="{cx0:.2f}" y="{cy0:.2f}" width="{cx1-cx0:.2f}" height="{cy1-cy0:.2f}" fill="#DD3B11"/>

  <!-- 房身（先画，屋檐盖在它上面） -->
  <rect x="{bx0:.2f}" y="{by0:.2f}" width="{bx1-bx0:.2f}" height="{by1-by0:.2f}" rx="0.7" fill="#FDCE51"/>

  <!-- 门：圆头，下沿与房身齐平 -->
  <path d="M{dx0:.2f} {dy1:.2f} L{dx0:.2f} {dty + door_r:.2f}
           A {door_r:.2f} {door_r*1.05:.2f} 0 0 1 {dx1:.2f} {dty + door_r:.2f}
           L{dx1:.2f} {dy1:.2f} Z" fill="#DD3910"/>

  <!-- 窗：四格（两列两行，中间横竖留缝） -->
  <rect x="{win_l[0]:.2f}" y="{win_l[1]:.2f}" width="{win_w:.2f}" height="{win_h:.2f}" rx="0.45" fill="#C12F0D"/>
  <rect x="{winR_l[0]:.2f}" y="{winR_l[1]:.2f}" width="{winR_r[0]-winR_l[0]:.2f}" height="{win_h:.2f}" rx="0.45" fill="#C12F0D"/>
  <rect x="{win_l[0]:.2f}" y="{win_l[1]+win_h+0.6:.2f}" width="{win_w:.2f}" height="{win_r[1]-win_l[1]-win_h-0.6:.2f}" rx="0.45" fill="#C12F0D"/>
  <rect x="{winR_l[0]:.2f}" y="{winR_l[1]+win_h+0.6:.2f}" width="{winR_r[0]-winR_l[0]:.2f}" height="{win_r[1]-win_l[1]-win_h-0.6:.2f}" rx="0.45" fill="#C12F0D"/>

  <!-- 屋顶：左右两条外鼓的弧 + 六段波浪屋檐（实测量得，不是直线三角） -->
  <path d="M{ax:.2f} {ay:.2f}
           Q{lx + (ax-lx)*0.55:.2f} {ay + (ly-ay)*0.55:.2f} {lx:.2f} {ly:.2f}
           {wave_path}
           Q{rx - (rx-ax)*0.55:.2f} {ay + (ry-ay)*0.55:.2f} {ax:.2f} {ay:.2f} Z"
        fill="#E23D11"/>

  <!-- 烟囱顶上浮着的爱心 -->
  <path d="M{hx:.2f} {hy + hr:.2f}
           C{hx - hr*1.35:.2f} {hy - hr*0.15:.2f} {hx - hr*1.45:.2f} {hy - hr*0.75:.2f} {hx - hr*1.45:.2f} {hy - hr*1.25:.2f}
           C{hx - hr*1.45:.2f} {hy - hr*2.1:.2f} {hx - hr*0.6:.2f} {hy - hr*2.5:.2f} {hx:.2f} {hy - hr*1.75:.2f}
           C{hx + hr*0.6:.2f} {hy - hr*2.5:.2f} {hx + hr*1.45:.2f} {hy - hr*2.1:.2f} {hx + hr*1.45:.2f} {hy - hr*1.25:.2f}
           C{hx + hr*1.45:.2f} {hy - hr*0.75:.2f} {hx + hr*1.35:.2f} {hy - hr*0.15:.2f} {hx:.2f} {hy + hr:.2f} Z"
        fill="#F4561E"/>
</svg>
'''

if __name__ == "__main__":
    out = pathlib.Path(__file__).resolve().parent.parent / "public" / "favicon.svg"
    out.write_text(build(), encoding="utf-8")
    print(f"written {out}")
    # 顺带打印换算后的关键点，便于人工核对
    for name, val in [("屋顶顶点", T(*ROOF_APEX)), ("左底角", T(*ROOF_L)), ("右底角", T(*ROOF_R)),
                      ("房身 TL", T(*BODY_L)), ("房身 BR", T(*BODY_R)),
                      ("门 TL", T(*DOOR_L)), ("门 BR", T(*DOOR_R))]:
        print(f"  {name:8s} ({val[0]:5.2f}, {val[1]:5.2f})")
