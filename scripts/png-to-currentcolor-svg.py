#!/usr/bin/env python3
"""将 src/assets/paperplane.png 转成一个 fill="currentColor" 的 SVG 剪影,
这样发送按钮图标才能跟 InputBar.tsx 里另外五个 inline <svg> 一样跟随主题变色。

做法:
  1. 用 alpha 通道做阈值, 得到一张二值 mask(纸飞机 = 前景, 透明 = 背景)。
  2. 在像素网格的"缝隙"(像素之间的边)上收集前景/背景交界的边, 再把这些边
     首尾相连, 走出一条闭合的边界折线 —— 这是标准的 crack-following /
     boundary-tracing 思路, 比在像素中心做 Moore-neighbor 更不容易在斜线上
     产生锯齿噪声。
  3. 用 Douglas-Peucker 简化折线, 去掉边缘反锯齿造成的碎台阶, 保留纸飞机
     本身的折角。
  4. 把简化后的多边形坐标线性映射进 24x24 的 viewBox(留白规则跟其余五个
     图标一致), 写成一个只有 <path fill="currentColor" d="..."/> 的 SVG。

用法:
  python scripts/png-to-currentcolor-svg.py
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

REPO_ROOT = Path(__file__).resolve().parent.parent
SRC_PNG = REPO_ROOT / "src" / "assets" / "paperplane.png"
DST_SVG = REPO_ROOT / "src" / "assets" / "paperplane.svg"

ALPHA_THRESHOLD = 128
VIEWBOX_SIZE = 24
MARGIN = 3  # 跟 settings-btn 齿轮图标(半径 3, 圆心 12,12)的留白量级保持一致
SIMPLIFY_EPSILON_PX = 2.5  # 单位是原图像素, 阈值越大折线越简单


def load_mask(png_path: Path) -> list[list[bool]]:
    """读 PNG, 按 alpha 阈值转成 mask[row][col] 的二维布尔数组。"""
    img = Image.open(png_path).convert("RGBA")
    w, h = img.size
    px = img.load()
    mask = [[False] * w for _ in range(h)]
    for y in range(h):
        for x in range(w):
            mask[y][x] = px[x, y][3] >= ALPHA_THRESHOLD
    return mask


def is_fg(mask: list[list[bool]], w: int, h: int, x: int, y: int) -> bool:
    if x < 0 or y < 0 or x >= w or y >= h:
        return False
    return mask[y][x]


def collect_boundary_edges(
    mask: list[list[bool]], w: int, h: int
) -> dict[tuple[int, int], list[tuple[int, int]]]:
    """收集前景/背景交界的"缝隙"边, 用像素角点(corner)坐标表示每条边的两端,
    再建一张邻接表, 方便后面首尾相连走出闭合折线。"""
    adjacency: dict[tuple[int, int], list[tuple[int, int]]] = {}

    def add_edge(p1: tuple[int, int], p2: tuple[int, int]) -> None:
        adjacency.setdefault(p1, []).append(p2)
        adjacency.setdefault(p2, []).append(p1)

    for y in range(h):
        for x in range(w):
            fg = is_fg(mask, w, h, x, y)
            # 右边: 跟 (x+1, y) 比较 -> 竖直缝隙在角点 (x+1,y)-(x+1,y+1)
            if fg != is_fg(mask, w, h, x + 1, y):
                add_edge((x + 1, y), (x + 1, y + 1))
            # 下边: 跟 (x, y+1) 比较 -> 水平缝隙在角点 (x,y+1)-(x+1,y+1)
            if fg != is_fg(mask, w, h, x, y + 1):
                add_edge((x, y + 1), (x + 1, y + 1))
            # 左边界只在 x==0 时补(x>0 时已经被邻居像素的"右边"处理过)
            if x == 0 and fg:
                add_edge((x, y), (x, y + 1))
            # 上边界只在 y==0 时补
            if y == 0 and fg:
                add_edge((x, y), (x + 1, y))

    return adjacency


def walk_closed_loop(
    adjacency: dict[tuple[int, int], list[tuple[int, int]]],
) -> list[tuple[int, int]]:
    """假设只有一个不带洞的连通前景色块(已经用预览图确认过), 从任意一条边
    出发首尾相连走完整圈。每个角点在这种情况下都恰好有 2 条边, 走到起点即
    完成闭合。"""
    start = next(iter(adjacency))
    loop = [start]
    prev = None
    current = start
    while True:
        neighbors = adjacency[current]
        nxt = neighbors[0] if neighbors[0] != prev else neighbors[1]
        if nxt == start:
            break
        loop.append(nxt)
        prev, current = current, nxt
        if len(loop) > 4 * sum(len(v) for v in adjacency.values()):
            raise RuntimeError("boundary walk did not close - mask is not a simple single blob")
    return loop


def perpendicular_distance(
    point: tuple[float, float], a: tuple[float, float], b: tuple[float, float]
) -> float:
    (px, py), (ax, ay), (bx, by) = point, a, b
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return ((px - ax) ** 2 + (py - ay) ** 2) ** 0.5
    t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)
    proj_x, proj_y = ax + t * dx, ay + t * dy
    return ((px - proj_x) ** 2 + (py - proj_y) ** 2) ** 0.5


def douglas_peucker(
    points: list[tuple[float, float]], epsilon: float
) -> list[tuple[float, float]]:
    if len(points) < 3:
        return points
    max_dist = 0.0
    index = 0
    for i in range(1, len(points) - 1):
        d = perpendicular_distance(points[i], points[0], points[-1])
        if d > max_dist:
            index, max_dist = i, d
    if max_dist > epsilon:
        left = douglas_peucker(points[: index + 1], epsilon)
        right = douglas_peucker(points[index:], epsilon)
        return left[:-1] + right
    return [points[0], points[-1]]


def simplify_closed_loop(
    loop: list[tuple[int, int]], epsilon: float
) -> list[tuple[float, float]]:
    """对闭合折线做 Douglas-Peucker: 把首点复制到末尾, 当成一条首尾相接的
    开放折线来简化, 再去掉复制的收尾点。"""
    pts = [(float(x), float(y)) for x, y in loop] + [(float(loop[0][0]), float(loop[0][1]))]
    simplified = douglas_peucker(pts, epsilon)
    return simplified[:-1]


def fit_to_viewbox(
    points: list[tuple[float, float]], img_w: int, img_h: int
) -> list[tuple[float, float]]:
    min_x = min(p[0] for p in points)
    max_x = max(p[0] for p in points)
    min_y = min(p[1] for p in points)
    max_y = max(p[1] for p in points)
    bbox_w = max_x - min_x
    bbox_h = max_y - min_y
    available = VIEWBOX_SIZE - 2 * MARGIN
    scale = min(available / bbox_w, available / bbox_h)
    drawn_w = bbox_w * scale
    drawn_h = bbox_h * scale
    offset_x = MARGIN + (available - drawn_w) / 2
    offset_y = MARGIN + (available - drawn_h) / 2
    out = []
    for x, y in points:
        out.append((round((x - min_x) * scale + offset_x, 2), round((y - min_y) * scale + offset_y, 2)))
    return out


def build_svg(points: list[tuple[float, float]]) -> str:
    d = f"M{points[0][0]} {points[0][1]} " + " ".join(
        f"L{x} {y}" for x, y in points[1:]
    ) + " Z"
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {VIEWBOX_SIZE} {VIEWBOX_SIZE}">\n'
        f'  <path fill="currentColor" d="{d}" />\n'
        "</svg>\n"
    )


def main() -> None:
    if not SRC_PNG.exists():
        print(f"source PNG not found: {SRC_PNG}", file=sys.stderr)
        sys.exit(1)

    mask = load_mask(SRC_PNG)
    h = len(mask)
    w = len(mask[0])

    adjacency = collect_boundary_edges(mask, w, h)
    loop = walk_closed_loop(adjacency)
    simplified = simplify_closed_loop(loop, SIMPLIFY_EPSILON_PX)
    fitted = fit_to_viewbox(simplified, w, h)
    svg = build_svg(fitted)

    DST_SVG.write_text(svg, encoding="utf-8")
    print(f"wrote {DST_SVG} ({len(fitted)} points)")


if __name__ == "__main__":
    main()
