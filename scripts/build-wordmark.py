#!/usr/bin/env python3
"""
Generates the Lumo wordmark PNG into public/lumo-wordmark.png.

Reference: bright sky-cyan body (#1FB8E8) with darker same-hue
paper-fold creases (#0F7FAE), each letter shaped as a chunky
geometric form with rounded corners.

Strategy: for each glyph, build an L-mode silhouette mask (the
letter shape) and a separate fold mask (the diagonal/vertical
crease). Apply BASE color through the silhouette mask, then FOLD
color through the intersection of fold and silhouette masks. This
keeps each layer compositing-correct (no leaky rectangles, no
black backgrounds peeking through).
"""

from __future__ import annotations

from pathlib import Path
from PIL import Image, ImageDraw, ImageChops

OUT_DIR = Path(__file__).resolve().parent.parent / "public"
OUT_DIR.mkdir(parents=True, exist_ok=True)

# Render at 2x then downsample for antialiasing.
SS = 2
W, H = 1600 * SS, 384 * SS  # final 1600x384 ≈ 4.17:1 aspect

BASE = (31, 184, 232, 255)   # #1FB8E8
FOLD = (15, 127, 174, 255)   # #0F7FAE

PAD_X = int(50 * SS)
PAD_Y = int(50 * SS)
INNER_W = W - 2 * PAD_X
INNER_H = H - 2 * PAD_Y

L_W = int(INNER_W * 0.18)
U_W = int(INNER_W * 0.22)
M_W = int(INNER_W * 0.30)
O_W = int(INNER_W * 0.22)
gap_total = INNER_W - (L_W + U_W + M_W + O_W)
GAP = gap_total // 3

x_l = PAD_X
x_u = x_l + L_W + GAP
x_m = x_u + U_W + GAP
x_o = x_m + M_W + GAP

y_top = PAD_Y
y_bot = PAD_Y + INNER_H

STROKE = int(INNER_H * 0.32)
ROUND_S = STROKE // 2          # rounded cap radius
ROUND_BIG = STROKE              # bigger rounded corners on U/O
FOLD_W = int(STROKE * 0.85)


def make_mask() -> tuple[Image.Image, ImageDraw.ImageDraw]:
    m = Image.new("L", (W, H), 0)
    return m, ImageDraw.Draw(m)


def apply(silhouette: Image.Image, fold: Image.Image, target: Image.Image) -> Image.Image:
    """Apply BASE through silhouette + FOLD through (fold ∩ silhouette)."""
    base_layer = Image.new("RGBA", (W, H), BASE)
    base_layer.putalpha(silhouette)
    out = Image.alpha_composite(target, base_layer)

    fold_clipped = ImageChops.multiply(fold, silhouette)
    fold_layer = Image.new("RGBA", (W, H), FOLD)
    fold_layer.putalpha(fold_clipped)
    return Image.alpha_composite(out, fold_layer)


canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))

# ─── L ────────────────────────────────────────────────────────
l_sil, l_d = make_mask()
# Vertical bar
l_d.rounded_rectangle((x_l, y_top, x_l + STROKE, y_bot), radius=ROUND_S, fill=255)
# Foot bar
l_d.rounded_rectangle((x_l, y_bot - STROKE, x_l + L_W, y_bot), radius=ROUND_S, fill=255)
l_fold = Image.new("L", (W, H), 0)  # L has no fold
canvas = apply(l_sil, l_fold, canvas)

# ─── U ────────────────────────────────────────────────────────
u_sil, u_d = make_mask()
# Outer rounded rect
u_d.rounded_rectangle((x_u, y_top, x_u + U_W, y_bot), radius=ROUND_BIG, fill=255)
# Subtract inner notch (top-aligned, leaves a U)
u_d.rounded_rectangle(
    (x_u + STROKE, y_top - 1, x_u + U_W - STROKE, y_bot - STROKE),
    radius=ROUND_S,
    fill=0,
)
# Diagonal fold
u_fold, ufd = make_mask()
ufd.polygon(
    [
        (x_u + int(STROKE * 0.4), y_top),
        (x_u + int(STROKE * 0.4) + FOLD_W, y_top),
        (x_u + U_W - int(STROKE * 0.2), y_bot),
        (x_u + U_W - int(STROKE * 0.2) - FOLD_W, y_bot),
    ],
    fill=255,
)
canvas = apply(u_sil, u_fold, canvas)

# ─── M ────────────────────────────────────────────────────────
m_sil, m_d = make_mask()
# Left arm
m_d.rounded_rectangle((x_m, y_top, x_m + STROKE, y_bot), radius=ROUND_S, fill=255)
# Right arm
m_d.rounded_rectangle((x_m + M_W - STROKE, y_top, x_m + M_W, y_bot), radius=ROUND_S, fill=255)
# Top connector with V notch
mid_x = x_m + M_W // 2
v_depth = int(INNER_H * 0.55)
m_d.polygon(
    [
        (x_m, y_top),
        (x_m + M_W, y_top),
        (x_m + M_W, y_top + STROKE),
        (mid_x + STROKE // 3, y_top + STROKE),
        (mid_x, y_top + v_depth),
        (mid_x - STROKE // 3, y_top + STROKE),
        (x_m, y_top + STROKE),
    ],
    fill=255,
)
# Diagonal fold
m_fold, mfd = make_mask()
mfd.polygon(
    [
        (x_m + int(STROKE * 0.6), y_top),
        (x_m + int(STROKE * 0.6) + FOLD_W, y_top),
        (x_m + M_W - int(STROKE * 0.2), y_bot),
        (x_m + M_W - int(STROKE * 0.2) - FOLD_W, y_bot),
    ],
    fill=255,
)
canvas = apply(m_sil, m_fold, canvas)

# ─── O ────────────────────────────────────────────────────────
o_cx = x_o + O_W // 2
o_cy = (y_top + y_bot) // 2
o_r_outer = min(O_W, INNER_H) // 2
o_r_inner = o_r_outer - STROKE
o_sil, od = make_mask()
od.ellipse(
    (o_cx - o_r_outer, o_cy - o_r_outer, o_cx + o_r_outer, o_cy + o_r_outer),
    fill=255,
)
od.ellipse(
    (o_cx - o_r_inner, o_cy - o_r_inner, o_cx + o_r_inner, o_cy + o_r_inner),
    fill=0,
)
# Vertical fold band on right side
o_fold, ofd = make_mask()
o_fold_w = int(STROKE * 0.65)
o_fold_x0 = o_cx + o_r_inner - o_fold_w // 2
ofd.rectangle(
    (o_fold_x0, o_cy - o_r_outer, o_fold_x0 + o_fold_w, o_cy + o_r_outer),
    fill=255,
)
canvas = apply(o_sil, o_fold, canvas)

# ─── Output ───────────────────────────────────────────────────
out_png = OUT_DIR / "lumo-wordmark.png"
final = canvas.resize((W // SS, H // SS), resample=Image.LANCZOS)
final.save(out_png, "PNG", optimize=True)
print(f"wrote {out_png} ({final.size[0]}x{final.size[1]})")
