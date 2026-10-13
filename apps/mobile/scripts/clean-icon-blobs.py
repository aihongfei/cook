#!/usr/bin/env python3
"""
去掉抠图后残留的"碎屑"（连通域过滤），保留真正的画面元素。

为什么需要它：母图是**米色底上的插画**，抠底用的是从四角 floodfill，它只能删掉
**与边缘连通**的背景。画面里那些**被自身轮廓围起来**的元素（这一版是陶锅上方
那几缕蒸汽——浅色描边勾出封闭曲线，内部还是米色）不会被 floodfill 碰到，于是
抠完留下两样东西：

  1. 蒸汽的**轮廓线**（深棕细线）——孤立成小碎块；
  2. 蒸汽**内部的米色**——与背景同色，但因为不连通而留了下来。

叠在深色壁纸/深色启动器上时，这些残渣看起来就像图标上的灰点与划痕（实测截图
确认）。碎片太小、形状已破，修不回来，正确做法是**整块丢掉**（图标尺寸下本来
也看不清蒸汽）。

做法：对 alpha 通道做连通域分析，只保留面积 ≥ MIN_PX 的连通域。这一版母图实测
只有三个是真元素：

    #0  440589px  主体（陶锅 + 厨师帽 + 台面 + 蔬菜）
    #1   63665px  挂着的平底锅（与主体不相连）
    #2    2313px  爱心（与主体不相连）
    #3     136px  ← 蒸汽残渣，丢掉
    其余 297 个 <100px 碎片，合计 479px  ← 丢掉

所以阈值取 1000 能干净地切开"真元素"与"碎屑"。**换母图后要重新确认这个阈值**：
如果新图里有体积小但确实是设计元素的点（星星、小圆点），它们会被一起丢掉，
要么调低阈值、要么改用白名单 bbox。

用法：python3 clean-icon-blobs.py <输入.png> <输出.png> [min_px]
"""
import re
import subprocess
import sys
from collections import deque

DEFAULT_MIN_PX = 1000


def read_alpha(path):
    """用 ImageMagick 把 alpha 通道导出成 ASCII 网格（不依赖 PIL）。"""
    out = subprocess.run(
        ["magick", path, "-alpha", "extract", "-depth", "8", "txt:-"],
        capture_output=True, text=True, check=True,
    ).stdout
    grid = {}
    w = h = 0
    for line in out.splitlines():
        m = re.match(r"(\d+),(\d+): \((\d+)", line)
        if not m:
            continue
        x, y, v = int(m.group(1)), int(m.group(2)), int(m.group(3))
        grid[(x, y)] = v
        w = max(w, x + 1)
        h = max(h, y + 1)
    return grid, w, h


def find_components(grid, w, h, threshold=40):
    """4 邻接连通域，返回 [(面积, [(x,y), ...]), ...]。"""
    seen = set()
    comps = []
    for y in range(h):
        for x in range(w):
            if (x, y) in seen or grid.get((x, y), 0) <= threshold:
                continue
            q = deque([(x, y)])
            seen.add((x, y))
            pts = []
            while q:
                cx, cy = q.popleft()
                pts.append((cx, cy))
                for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                    if not (0 <= nx < w and 0 <= ny < h):
                        continue
                    if (nx, ny) in seen or grid.get((nx, ny), 0) <= threshold:
                        continue
                    seen.add((nx, ny))
                    q.append((nx, ny))
            comps.append(pts)
    return comps


def write_mask(path, kept, w, h):
    """把保留的像素写成灰度 PGM，交给 ImageMagick 当遮罩用。"""
    keep = set()
    for pts in kept:
        keep.update(pts)
    rows = []
    for y in range(h):
        rows.append(" ".join("255" if (x, y) in keep else "0" for x in range(w)))
    ppm = f"P2\n{w} {h}\n255\n" + "\n".join(rows) + "\n"
    with open(path, "w", encoding="ascii") as f:
        f.write(ppm)


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    src, dst = sys.argv[1], sys.argv[2]
    min_px = int(sys.argv[3]) if len(sys.argv) > 3 else DEFAULT_MIN_PX

    grid, w, h = read_alpha(src)
    comps = find_components(grid, w, h)
    comps.sort(key=len, reverse=True)
    kept = [c for c in comps if len(c) >= min_px]
    dropped = [c for c in comps if len(c) < min_px]

    dropped_px = sum(len(c) for c in dropped)
    print(f"   连通域 {len(comps)} 个 → 保留 {len(kept)} 个、丢掉 {len(dropped)} 个碎片（{dropped_px}px）")
    for c in kept:
        xs = [p[0] for p in c]
        ys = [p[1] for p in c]
        print(f"     保留 {len(c):7d}px  bbox x {min(xs)}..{max(xs)} y {min(ys)}..{max(ys)}")

    mask = "/tmp/_clean_mask.pgm"
    write_mask(mask, kept, w, h)
    # 用遮罩裁 alpha：只保留大块元素
    subprocess.run(
        ["magick", src, mask, "-alpha", "off", "-compose", "CopyOpacity", "-composite", dst],
        check=True,
    )
    print(f"   已写入 {dst}")


if __name__ == "__main__":
    main()
