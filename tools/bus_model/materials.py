"""Materials and procedural packed PNG textures for Kyoto City Bus PDG-AA273KAN.

Fleet #1771 (京都200か17-71), Yokooji Depot / Route 18 specification.
All Principled BSDF nodes are looked up by `n.type == 'BSDF_PRINCIPLED'` (never by name),
and all sRGB hex colors are converted to linear RGB for Principled Base Color.
All generated textures are packed as PNGs inside `bpy.data.images` so glTF export
embeds them automatically and `lambertize.js` can preserve `m.map`.
"""
import math

import bpy
import numpy as np

from . import spec

# Non-bus materials in tools/bus-model.blend that must NEVER be removed.
KEEP_MATERIALS = frozenset({
    "CarGlass", "CarHub", "CarLight", "CarPaint", "CarRed", "CarTire", "CarTrim",
    "CargoWhite", "PaxBody", "PaxDark", "PaxSkin", "PlateWhite",
    "TreeLeafA", "TreeLeafB", "TreeTrunk", "TruckCab",
})

FONT_BOLD_PATH = "/System/Library/Fonts/ヒラギノ角ゴシック W8.ttc"
FONT_MED_PATH = "/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc"


# ---------------------------------------------------------------- color helpers
def srgb_to_linear(c):
    """Convert a single sRGB channel [0..1] to linear RGB."""
    c = max(0.0, min(1.0, float(c)))
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_to_srgb(hex_str):
    """Return (r, g, b) in sRGB [0..1] from '#RRGGBB'."""
    h = hex_str.lstrip("#")
    return (int(h[0:2], 16) / 255.0, int(h[2:4], 16) / 255.0, int(h[4:6], 16) / 255.0)


def hex_to_linear_rgb(hex_str):
    """Return (r, g, b) in linear RGB [0..1] for Blender Principled BSDF."""
    r, g, b = hex_to_srgb(hex_str)
    return (srgb_to_linear(r), srgb_to_linear(g), srgb_to_linear(b))


def hex_to_linear_rgba(hex_str, alpha=1.0):
    r, g, b = hex_to_linear_rgb(hex_str)
    return (r, g, b, float(alpha))


def hex_to_srgb_rgba(hex_str, alpha=1.0):
    r, g, b = hex_to_srgb(hex_str)
    return (r, g, b, float(alpha))


def get_principled_bsdf(mat):
    """Look up Principled BSDF node by type, NEVER by name."""
    if not mat.use_nodes:
        mat.use_nodes = True
    bsdf = next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if bsdf is None:
        bsdf = mat.node_tree.nodes.new("ShaderNodeBsdfPrincipled")
        out = next((n for n in mat.node_tree.nodes if n.type == "OUTPUT_MATERIAL"), None)
        if out is None:
            out = mat.node_tree.nodes.new("ShaderNodeOutputMaterial")
        mat.node_tree.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    return bsdf


def _set_input(node, names, val):
    for name in names:
        if name in node.inputs:
            node.inputs[name].default_value = val
            return


# ---------------------------------------------------------------- 2D numpy canvas + font rasterizer
_FONT_CACHE = {}


def _get_font(path=FONT_BOLD_PATH):
    if path in _FONT_CACHE and _FONT_CACHE[path].name in bpy.data.fonts:
        return _FONT_CACHE[path]
    for candidate in (path, FONT_MED_PATH, "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"):
        try:
            f = bpy.data.fonts.load(candidate, check_existing=True)
            _FONT_CACHE[path] = f
            return f
        except Exception:
            continue
    return bpy.data.fonts[0]


class Canvas:
    """2x-supersampled numpy RGBA canvas in sRGB [0..1], bottom-up (row 0 = v=0)."""

    def __init__(self, width, height, bg_hex="#000000", bg_alpha=1.0, ss=2):
        self.w = int(width)
        self.h = int(height)
        self.ss = int(ss)
        self.W = self.w * self.ss
        self.H = self.h * self.ss
        self.buf = np.empty((self.H, self.W, 4), dtype=np.float32)
        self.buf[:, :] = hex_to_srgb_rgba(bg_hex, bg_alpha)

    def rect(self, x0, y0, x1, y1, hex_color, alpha=1.0):
        """Fill rectangle in normalized [0..1] or pixel coordinates (auto-detected if >1.5)."""
        if max(abs(x0), abs(y0), abs(x1), abs(y1)) <= 1.0001:
            x0, x1 = x0 * self.W, x1 * self.W
            y0, y1 = y0 * self.H, y1 * self.H
        else:
            x0, x1 = x0 * self.ss, x1 * self.ss
            y0, y1 = y0 * self.ss, y1 * self.ss
        ix0, ix1 = max(0, int(round(min(x0, x1)))), min(self.W, int(round(max(x0, x1))))
        iy0, iy1 = max(0, int(round(min(y0, y1)))), min(self.H, int(round(max(y0, y1))))
        if ix1 <= ix0 or iy1 <= iy0:
            return
        c = hex_to_srgb_rgba(hex_color, alpha)
        if alpha >= 0.999:
            self.buf[iy0:iy1, ix0:ix1] = c
        else:
            self.buf[iy0:iy1, ix0:ix1, :3] = (
                self.buf[iy0:iy1, ix0:ix1, :3] * (1.0 - alpha) + np.array(c[:3], dtype=np.float32) * alpha
            )

    def border(self, x0, y0, x1, y1, thickness, hex_color, alpha=1.0):
        """Draw rectangular border in normalized [0..1] coordinates."""
        t_x = thickness / self.w if thickness > 1.0 else thickness
        t_y = thickness / self.h if thickness > 1.0 else thickness * (self.w / self.h)
        self.rect(x0, y0, x1, y0 + t_y, hex_color, alpha)
        self.rect(x0, y1 - t_y, x1, y1, hex_color, alpha)
        self.rect(x0, y0, x0 + t_x, y1, hex_color, alpha)
        self.rect(x1 - t_x, y0, x1, y1, hex_color, alpha)

    def circle(self, cx, cy, r, hex_color, alpha=1.0, r_in=0.0):
        """Circle / ring with cx, cy in [0..1] and radius r as fraction of min(w, h)."""
        px = cx * self.W
        py = cy * self.H
        scale = min(self.W, self.H)
        pr = r * scale
        pr_in = r_in * scale
        ix0, ix1 = max(0, int(px - pr - 1)), min(self.W, int(px + pr + 2))
        iy0, iy1 = max(0, int(py - pr - 1)), min(self.H, int(py + pr + 2))
        if ix1 <= ix0 or iy1 <= iy0:
            return
        yy, xx = np.ogrid[iy0:iy1, ix0:ix1]
        d2 = (xx + 0.5 - px) ** 2 + (yy + 0.5 - py) ** 2
        m = (d2 <= pr * pr) & (d2 >= pr_in * pr_in)
        sub = self.buf[iy0:iy1, ix0:ix1]
        c = np.array(hex_to_srgb_rgba(hex_color, alpha), dtype=np.float32)
        sub[m] = c

    def arc(self, cx, cy, r, r_in, deg0, deg1, hex_color, alpha=1.0):
        """Circular arc ring in degrees (0 = +X right, 90 = +Y up)."""
        px, py = cx * self.W, cy * self.H
        scale = min(self.W, self.H)
        pr, pr_in = r * scale, r_in * scale
        ix0, ix1 = max(0, int(px - pr - 1)), min(self.W, int(px + pr + 2))
        iy0, iy1 = max(0, int(py - pr - 1)), min(self.H, int(py + pr + 2))
        if ix1 <= ix0 or iy1 <= iy0:
            return
        yy, xx = np.ogrid[iy0:iy1, ix0:ix1]
        dx = xx + 0.5 - px
        dy = yy + 0.5 - py
        d2 = dx * dx + dy * dy
        ang = (np.degrees(np.arctan2(dy, dx)) - deg0) % 360.0
        span = (deg1 - deg0) % 360.0 or 360.0
        m = (d2 <= pr * pr) & (d2 >= pr_in * pr_in) & (ang <= span)
        self.buf[iy0:iy1, ix0:ix1][m] = np.array(hex_to_srgb_rgba(hex_color, alpha), dtype=np.float32)

    def line(self, x0, y0, x1, y1, thickness, hex_color, alpha=1.0):
        """Capsule line segment with (x0,y0)-(x1,y1) in [0..1] and thickness as fraction of min(w,h)."""
        ax, ay = x0 * self.W, y0 * self.H
        bx, by = x1 * self.W, y1 * self.H
        r = 0.5 * thickness * min(self.W, self.H)
        ix0 = max(0, int(min(ax, bx) - r - 1))
        ix1 = min(self.W, int(max(ax, bx) + r + 2))
        iy0 = max(0, int(min(ay, by) - r - 1))
        iy1 = min(self.H, int(max(ay, by) + r + 2))
        if ix1 <= ix0 or iy1 <= iy0:
            return
        yy, xx = np.ogrid[iy0:iy1, ix0:ix1]
        px, py = xx + 0.5, yy + 0.5
        vx, vy = bx - ax, by - ay
        l2 = vx * vx + vy * vy
        if l2 < 1e-9:
            t = 0.0
        else:
            t = np.clip(((px - ax) * vx + (py - ay) * vy) / l2, 0.0, 1.0)
        dx = px - (ax + t * vx)
        dy = py - (ay + t * vy)
        m = (dx * dx + dy * dy) <= r * r
        self.buf[iy0:iy1, ix0:ix1][m] = np.array(hex_to_srgb_rgba(hex_color, alpha), dtype=np.float32)

    def poly(self, pts, hex_color, alpha=1.0):
        """Fill convex or fan polygon given list of (x, y) in [0..1]."""
        P = np.array([(x * self.W, y * self.H) for x, y in pts], dtype=np.float32)
        for i in range(1, len(P) - 1):
            self._fill_tri(P[0], P[i], P[i + 1], hex_to_srgb_rgba(hex_color, alpha))

    def _fill_tri(self, a, b, c, rgba):
        ix0 = max(0, int(math.floor(min(a[0], b[0], c[0]))))
        ix1 = min(self.W, int(math.ceil(max(a[0], b[0], c[0]))) + 1)
        iy0 = max(0, int(math.floor(min(a[1], b[1], c[1]))))
        iy1 = min(self.H, int(math.ceil(max(a[1], b[1], c[1]))) + 1)
        if ix1 <= ix0 or iy1 <= iy0:
            return
        det = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
        if abs(det) < 1e-8:
            return
        yy, xx = np.ogrid[iy0:iy1, ix0:ix1]
        px, py = xx + 0.5, yy + 0.5
        w0 = (b[0] - px) * (c[1] - py) - (b[1] - py) * (c[0] - px)
        w1 = (c[0] - px) * (a[1] - py) - (c[1] - py) * (a[0] - px)
        w2 = (a[0] - px) * (b[1] - py) - (a[1] - py) * (b[0] - px)
        if det > 0:
            m = (w0 >= 0) & (w1 >= 0) & (w2 >= 0)
        else:
            m = (w0 <= 0) & (w1 <= 0) & (w2 <= 0)
        self.buf[iy0:iy1, ix0:ix1][m] = rgba

    def text(self, body, cx, cy, max_w, max_h, hex_color, alpha=1.0, bold=True):
        """Render Japanese/ASCII text via Blender Font tessellation into box (max_w, max_h) at (cx, cy) in [0..1]."""
        if not body:
            return
        cu = bpy.data.curves.new("_tmp_font_cu", "FONT")
        cu.font = _get_font(FONT_BOLD_PATH if bold else FONT_MED_PATH)
        cu.body = str(body)
        cu.align_x = "CENTER"
        cu.align_y = "CENTER"
        cu.resolution_u = 3
        ob = bpy.data.objects.new("_tmp_font_ob", cu)
        bpy.context.scene.collection.objects.link(ob)
        dg = bpy.context.evaluated_depsgraph_get()
        ob_eval = ob.evaluated_get(dg)
        me = bpy.data.meshes.new_from_object(ob_eval)
        me.calc_loop_triangles()

        if len(me.vertices) >= 3 and len(me.loop_triangles) >= 1:
            verts = np.array([(v.co.x, v.co.y) for v in me.vertices], dtype=np.float32)
            tris = np.array([lt.vertices[:] for lt in me.loop_triangles], dtype=np.int32)
            vmin = verts.min(axis=0)
            vmax = verts.max(axis=0)
            span = np.maximum(vmax - vmin, 1e-4)
            center = 0.5 * (vmin + vmax)
            sx = (max_w * self.W) / span[0]
            sy = (max_h * self.H) / span[1]
            s = min(sx, sy)
            sx_use = min(sx, s * 1.28)
            sy_use = min(sy, s * 1.15)
            verts_px = np.empty_like(verts)
            verts_px[:, 0] = (verts[:, 0] - center[0]) * sx_use + cx * self.W
            verts_px[:, 1] = (verts[:, 1] - center[1]) * sy_use + cy * self.H
            rgba = np.array(hex_to_srgb_rgba(hex_color, alpha), dtype=np.float32)
            for t in tris:
                self._fill_tri(verts_px[t[0]], verts_px[t[1]], verts_px[t[2]], rgba)

        bpy.data.meshes.remove(me)
        bpy.data.objects.remove(ob, do_unlink=True)
        bpy.data.curves.remove(cu)

    def to_image(self, name):
        """Downsample supersampled buffer and pack as PNG in bpy.data.images."""
        if self.ss > 1:
            arr = self.buf.reshape(self.h, self.ss, self.w, self.ss, 4).mean(axis=(1, 3))
        else:
            arr = self.buf
        arr = np.clip(arr, 0.0, 1.0).astype(np.float32)
        old = bpy.data.images.get(name)
        if old is not None:
            bpy.data.images.remove(old)
        img = bpy.data.images.new(name, width=self.w, height=self.h, alpha=True)
        img.colorspace_settings.name = "sRGB"
        img.pixels.foreach_set(arr.ravel())
        img.file_format = "PNG"
        img.pack()
        return img


# ---------------------------------------------------------------- texture generators
def _build_floor_texture():
    """Grey-brown speckled non-slip bus floor (`tex_bus_floor`, matching step_60_shot_1 & step_32_shot_1)."""
    w, h = 256, 256
    rng = np.random.default_rng(1771)
    base = np.array(hex_to_srgb("#585754"), dtype=np.float32)
    arr = np.empty((h, w, 4), dtype=np.float32)
    arr[:, :, :3] = base
    arr[:, :, 3] = 1.0
    noise = rng.normal(0.0, 0.032, size=(h, w, 1)).astype(np.float32)
    arr[:, :, :3] += noise
    for col, prob in (("#84827D", 0.045), ("#A4A098", 0.020), ("#353432", 0.04)):
        m = rng.random((h, w)) < prob
        arr[m, :3] = hex_to_srgb(col)
    arr = np.clip(arr, 0.0, 1.0)
    old = bpy.data.images.get("tex_bus_floor")
    if old is not None:
        bpy.data.images.remove(old)
    img = bpy.data.images.new("tex_bus_floor", width=w, height=h, alpha=True)
    img.colorspace_settings.name = "sRGB"
    img.pixels.foreach_set(arr.ravel())
    img.file_format = "PNG"
    img.pack()
    return img


def _build_moquette_texture(name, base_hex, dark_hex, accent1_hex, accent2_hex, seed):
    """Woven Kyoto City Bus seat moquette fabric with checked/grid pattern (step_60_shot_1 & step_32_shot_1)."""
    w, h = 256, 256
    rng = np.random.default_rng(seed)
    c_base = np.array(hex_to_srgb(base_hex), dtype=np.float32)
    c_dark = np.array(hex_to_srgb(dark_hex), dtype=np.float32)
    c_a1 = np.array(hex_to_srgb(accent1_hex), dtype=np.float32)
    c_a2 = np.array(hex_to_srgb(accent2_hex), dtype=np.float32)

    yy, xx = np.mgrid[0:h, 0:w]
    weave = 0.5 + 0.5 * np.sin(xx * (2 * math.pi / 4.0)) * np.cos(yy * (2 * math.pi / 4.0))
    arr = np.empty((h, w, 4), dtype=np.float32)
    arr[:, :, :3] = c_dark * (1.0 - 0.68 * weave[..., None]) + c_base * (0.68 * weave[..., None])
    arr[:, :, 3] = 1.0

    # Checked square grid motif matching step_60_shot_1.png
    gx = xx % 16
    gy = yy % 16
    grid_line = (gx < 3) | (gy < 3)
    arr[grid_line, :3] = c_a1
    inner_dot = (gx >= 6) & (gx <= 9) & (gy >= 6) & (gy <= 9)
    arr[inner_dot, :3] = c_a2

    arr[:, :, :3] += rng.normal(0.0, 0.022, size=(h, w, 3)).astype(np.float32)
    arr = np.clip(arr, 0.0, 1.0)

    old = bpy.data.images.get(name)
    if old is not None:
        bpy.data.images.remove(old)
    img = bpy.data.images.new(name, width=w, height=h, alpha=True)
    img.colorspace_settings.name = "sRGB"
    img.pixels.foreach_set(arr.ravel())
    img.file_format = "PNG"
    img.pack()
    return img


def _build_license_plate():
    """Commercial green license plate: 京都 200 / か 17-71 (`tex_license_plate`)."""
    cv = Canvas(512, 256, bg_hex="#134629")
    cv.border(0.02, 0.03, 0.98, 0.97, 0.025, "#E8ECE9")
    cv.circle(0.18, 0.84, 0.025, "#B8C0BC")
    cv.circle(0.82, 0.84, 0.025, "#B8C0BC")
    cv.text(spec.PLATE_TOP, 0.50, 0.73, 0.62, 0.23, "#F4F7F5", bold=True)
    cv.text(spec.PLATE_KANA, 0.14, 0.34, 0.16, 0.28, "#F4F7F5", bold=True)
    cv.text(spec.PLATE_NUM, 0.59, 0.34, 0.70, 0.46, "#F4F7F5", bold=True)
    return cv.to_image("tex_license_plate")


def _build_kyoto_crest():
    """Silver 3-Winged Kyoto City Transportation Bureau Emblem (交通局章) on dark green #3B4F43 (`tex_kyoto_crest`).
    Matches step_56_shot_2.png and step_60_shot_2.png (3 swept silver wings + center star/ring, NOT a gold circle!)."""
    cv = Canvas(256, 256, bg_hex="#3B4F43")
    silver = "#D8E0DC"
    hi = "#F2F6F4"
    dark = "#3B4F43"
    # Upper-left wing
    cv.poly([(0.46, 0.54), (0.08, 0.78), (0.18, 0.84), (0.48, 0.64)], silver)
    cv.poly([(0.44, 0.48), (0.14, 0.67), (0.22, 0.73), (0.46, 0.55)], hi)
    # Upper-right wing
    cv.poly([(0.54, 0.54), (0.92, 0.78), (0.82, 0.84), (0.52, 0.64)], silver)
    cv.poly([(0.56, 0.48), (0.86, 0.67), (0.78, 0.73), (0.54, 0.55)], hi)
    # Bottom vertical wing point
    cv.poly([(0.50, 0.10), (0.37, 0.48), (0.50, 0.56), (0.63, 0.48)], silver)
    cv.poly([(0.50, 0.18), (0.46, 0.46), (0.50, 0.50), (0.54, 0.46)], dark)
    # Top crown diamond / 京 stylized center
    cv.poly([(0.50, 0.88), (0.43, 0.68), (0.50, 0.58), (0.57, 0.68)], hi)
    cv.circle(0.50, 0.53, 0.13, silver, r_in=0.075)
    return cv.to_image("tex_kyoto_crest")


def _build_kyoto_bus_text():
    """'京 都 市 交 通 局' lower-skirt dark-green lettering on #C8D5BB (`tex_kyoto_bus_text`)."""
    cv = Canvas(512, 128, bg_hex="#C8D5BB")
    cv.text("京 都 市 交 通 局", 0.50, 0.50, 0.92, 0.64, "#2B3D33", bold=True)
    return cv.to_image("tex_kyoto_bus_text")


def _build_fleet_number(name, bg_hex, fg_hex, border_hex=None):
    """'1771' 4-digit fleet number decal."""
    cv = Canvas(256, 128, bg_hex=bg_hex)
    if border_hex:
        cv.border(0.03, 0.05, 0.97, 0.95, 0.04, border_hex)
    cv.text(spec.FLEET_NO, 0.50, 0.50, 0.84, 0.72, fg_hex, bold=True)
    return cv.to_image(name)


def _build_mlit_nonstep_decal():
    """Green rectangular '標準仕様ノンステップバス' sticker on front-right nose (`tex_mlit_nonstep`)."""
    cv = Canvas(256, 160, bg_hex="#238854")
    cv.border(0.03, 0.04, 0.97, 0.96, 0.035, "#E8F5EE")
    cv.rect(0.08, 0.14, 0.92, 0.68, "#D9EFE2")
    # Stylized green bus outline inside
    cv.rect(0.18, 0.28, 0.82, 0.58, "#238854")
    cv.rect(0.22, 0.38, 0.42, 0.54, "#E8F5EE")
    cv.rect(0.46, 0.38, 0.64, 0.54, "#E8F5EE")
    cv.rect(0.68, 0.38, 0.78, 0.54, "#E8F5EE")
    cv.circle(0.32, 0.25, 0.08, "#165B37")
    cv.circle(0.68, 0.25, 0.08, "#165B37")
    cv.text("標準仕様ノンステップバス", 0.50, 0.82, 0.86, 0.18, "#FFFFFF", bold=True)
    return cv.to_image("tex_mlit_nonstep")


def _build_wheelchair_decal():
    """Blue & white International Symbol of Access wheelchair decal (`tex_wheelchair`)."""
    cv = Canvas(256, 256, bg_hex="#0D5BB5")
    cv.border(0.04, 0.04, 0.96, 0.96, 0.04, "#FFFFFF")
    cv.circle(0.54, 0.77, 0.07, "#FFFFFF")
    cv.line(0.52, 0.68, 0.52, 0.46, 0.055, "#FFFFFF")
    cv.line(0.52, 0.58, 0.68, 0.58, 0.048, "#FFFFFF")
    cv.line(0.52, 0.46, 0.70, 0.46, 0.055, "#FFFFFF")
    cv.line(0.70, 0.46, 0.77, 0.25, 0.052, "#FFFFFF")
    cv.arc(0.45, 0.36, 0.20, 0.145, 115, 355, "#FFFFFF")
    return cv.to_image("tex_wheelchair")


def _build_entrance_decal():
    """White '[↑入口 ENTRANCE]' sticker ahead of middle door (`tex_decal_entrance`, step_56_shot_1 & step_35_shot_2)."""
    cv = Canvas(256, 128, bg_hex="#F4F7F4")
    cv.border(0.02, 0.04, 0.98, 0.96, 0.025, "#3B4F43")
    # Blue upward arrow on left
    cv.poly([(0.18, 0.84), (0.07, 0.54), (0.29, 0.54)], "#1D4ED8")
    cv.rect(0.14, 0.18, 0.22, 0.56, "#1D4ED8")
    cv.text("入 口", 0.62, 0.64, 0.58, 0.44, "#181B1E", bold=True)
    cv.text("ENTRANCE", 0.62, 0.22, 0.58, 0.22, "#181B1E", bold=True)
    return cv.to_image("tex_decal_entrance")


def _build_exit_decal():
    """White '[⊖出口 EXIT]' sticker behind front door (`tex_decal_exit`, step_56_shot_1 & step_35_shot_2)."""
    cv = Canvas(256, 128, bg_hex="#F4F7F4")
    cv.border(0.02, 0.04, 0.98, 0.96, 0.025, "#3B4F43")
    # Red no-entry circle with white bar on left
    cv.circle(0.18, 0.54, 0.24, "#DC2626")
    cv.rect(0.09, 0.49, 0.27, 0.59, "#FFFFFF")
    cv.text("出 口", 0.62, 0.64, 0.58, 0.44, "#B91C1C", bold=True)
    cv.text("EXIT", 0.62, 0.22, 0.46, 0.22, "#181B1E", bold=True)
    return cv.to_image("tex_decal_exit")


def _build_emergency_decal():
    """'非常口 / EMERGENCY EXIT' placard (`tex_decal_emergency`)."""
    cv = Canvas(256, 128, bg_hex="#F4F6F4")
    cv.border(0.03, 0.05, 0.97, 0.95, 0.035, "#15803D")
    cv.text("非常口", 0.50, 0.62, 0.76, 0.46, "#DC2626", bold=True)
    cv.text("EMERGENCY EXIT", 0.50, 0.20, 0.86, 0.20, "#15803D", bold=True)
    return cv.to_image("tex_decal_emergency")


def _build_gauges_texture():
    """Aero Star-S PDG-AA273KAN 3-Dial Instrument Cluster (`tex_ud_gauges`, matching step_76_shot_1.png)."""
    cv = Canvas(512, 256, bg_hex="#7A8086")
    cv.border(0.01, 0.02, 0.99, 0.98, 0.02, "#1E2226")
    # Top dark warning telltale bar
    cv.rect(0.05, 0.83, 0.95, 0.94, "#181B20")
    for tx, col, lbl in (
        (0.14, "#22C55E", "◀"),
        (0.26, "#F59E0B", "扉"),
        (0.42, "#EF4444", "P"),
        (0.56, "#EF4444", "●"),
        (0.70, "#38BDF8", "ABS"),
        (0.86, "#22C55E", "▶"),
    ):
        cv.rect(tx - 0.04, 0.85, tx + 0.04, 0.92, col)
        cv.text(lbl, tx, 0.885, 0.06, 0.05, "#111317", bold=True)

    # 3 main circular analog gauge dials (Left: Speedometer, Center: Tachometer, Right: Multi-gauge)
    dials = [
        (0.20, 0.48, 0.27, "km/h", ["0", "20", "40", "60", "80", "100", "120"], False),
        (0.50, 0.48, 0.27, "x100rpm", ["0", "5", "10", "15", "20", "25", "30"], True),
        (0.80, 0.48, 0.27, "F / AIR", ["E", "1/2", "F", "0", "5", "10"], False),
    ]
    for cx, cy, r, unit_lbl, ticks, has_green in dials:
        cv.circle(cx, cy, r, "#181C22")
        cv.circle(cx, cy, r, "#3E444C", r_in=r - 0.018)
        n_t = len(ticks)
        for k, t_str in enumerate(ticks):
            ang = math.radians(215 - k * (250.0 / max(1, n_t - 1)))
            col = "#22C55E" if (has_green and 2 <= k <= 4) else ("#EF4444" if (has_green and k >= 5) else "#F1F5F9")
            x0 = cx + (r - 0.06) * 0.5 * math.cos(ang)
            y0 = cy + (r - 0.06) * math.sin(ang)
            x1 = cx + (r - 0.018) * 0.5 * math.cos(ang)
            y1 = cy + (r - 0.018) * math.sin(ang)
            cv.line(x0, y0, x1, y1, 0.012, col)
            lx = cx + (r - 0.115) * 0.5 * math.cos(ang)
            ly = cy + (r - 0.115) * math.sin(ang)
            cv.text(t_str, lx, ly, 0.045, 0.055, col, bold=True)
        cv.text(unit_lbl, cx, cy - 0.09, 0.09, 0.05, "#94A3B8", bold=True)
        cv.line(cx, cy, cx - 0.055, cy + 0.11, 0.016, "#F8FAFC")
        cv.circle(cx, cy, 0.028, "#334155")

    # Bottom red caution label strip seen in step_76_shot_1.png
    cv.rect(0.30, 0.05, 0.88, 0.15, "#D97777")
    cv.text("駅・操車所でブレーキを確認", 0.59, 0.10, 0.54, 0.07, "#7F1D1D", bold=True)
    return cv.to_image("tex_ud_gauges")


def _build_steering_emblem():
    """Small silver/white Mitsubishi 3-Diamond emblem in black horizontal recess (`tex_fuso_steering_emblem`, step_76_shot_1)."""
    cv = Canvas(256, 128, bg_hex="#181B20")
    cv.border(0.04, 0.08, 0.96, 0.92, 0.04, "#2D3239")
    cx, cy = 0.50, 0.52
    r = 0.28
    h = r * 0.46
    for deg in (90, 210, 330):
        a = math.radians(deg)
        ux, uy = math.cos(a), math.sin(a)
        px, py = -uy, ux
        p0 = (cx + 0.02 * r * ux, cy + 0.02 * r * uy)
        p1 = (cx + 0.52 * r * ux + h * px * 0.5, cy + 0.52 * r * uy + h * py)
        p2 = (cx + r * ux * 0.5, cy + r * uy)
        p3 = (cx + 0.52 * r * ux - h * px * 0.5, cy + 0.52 * r * uy - h * py)
        cv.poly([p0, p1, p2, p3], "#E2E8F0")
    return cv.to_image("tex_fuso_steering_emblem")


def _build_farebox_display():
    """Kyoto City Bus farebox top & front deck (`tex_farebox_display`, matching step_34_shot_2.png)."""
    cv = Canvas(256, 256, bg_hex="#989C94")
    cv.border(0.02, 0.02, 0.98, 0.98, 0.02, "#5A5E58")
    # Top-center red-rimmed coin hopper ('運賃')
    cv.rect(0.28, 0.68, 0.72, 0.94, "#B91C1C")
    cv.rect(0.32, 0.72, 0.68, 0.90, "#CBD5E1")
    cv.text("運 賃", 0.50, 0.70, 0.30, 0.07, "#FFFFFF", bold=True)
    # Yellow caution strip across middle
    cv.rect(0.10, 0.58, 0.90, 0.65, "#FACC15")
    # Left: light-grey IC card reader pad + green magnetic card slot below
    cv.rect(0.08, 0.30, 0.48, 0.55, "#DCE0DC")
    cv.border(0.10, 0.32, 0.46, 0.53, 0.015, "#94A3B8")
    cv.circle(0.28, 0.42, 0.08, "#3B82F6")
    cv.rect(0.08, 0.06, 0.48, 0.28, "#2A2E30")
    cv.rect(0.14, 0.19, 0.42, 0.26, "#FEF2F2")
    cv.text("↓カード", 0.28, 0.225, 0.24, 0.055, "#B91C1C", bold=True)
    cv.rect(0.14, 0.09, 0.42, 0.16, "#84A97C")
    # Right: blue-purple coin/bill changer ('両替')
    cv.rect(0.52, 0.06, 0.92, 0.55, "#434A78")
    cv.rect(0.54, 0.38, 0.90, 0.53, "#CBD5E1")
    cv.text("両替", 0.72, 0.28, 0.28, 0.09, "#E2E8F0", bold=True)
    return cv.to_image("tex_farebox_display")


def _build_next_stop_display():
    """Overhead passenger next-stop LED & fare display (`tex_next_stop_display`, matching step_60_shot_2.png)."""
    cv = Canvas(512, 256, bg_hex="#181C22")
    cv.border(0.02, 0.04, 0.98, 0.96, 0.025, "#475569")
    # Top black LED matrix showing route & next stop in amber/orange LED
    cv.rect(0.05, 0.54, 0.95, 0.90, "#0C0F14")
    cv.text("18系統 久我石原町行き", 0.50, 0.81, 0.76, 0.11, "#FDE047", bold=True)
    cv.text("次は 四条大宮", 0.50, 0.65, 0.80, 0.18, "#FB923C", bold=True)
    # Numbered fare table boxes below (matching step_60_shot_2.png)
    cv.rect(0.05, 0.10, 0.95, 0.50, "#1E293B")
    for k in range(7):
        x0 = 0.07 + k * 0.125
        cv.border(x0, 0.30, x0 + 0.115, 0.47, 0.008, "#94A3B8")
        cv.text(str(k + 1), x0 + 0.057, 0.385, 0.08, 0.11, "#F8FAFC", bold=True)
        cv.border(x0, 0.12, x0 + 0.115, 0.29, 0.008, "#94A3B8")
        cv.text("230", x0 + 0.057, 0.205, 0.09, 0.11, "#EF4444", bold=True)
    return cv.to_image("tex_next_stop_display")


def _build_stop_request_sign():
    """Suspended ceiling 'BUS / つぎ止まります / STOP' illuminated sign (`tex_bus_stop_sign`, step_60_shot_1.png)."""
    cv = Canvas(256, 128, bg_hex="#C86D85")
    cv.border(0.02, 0.04, 0.98, 0.96, 0.035, "#23272E")
    cv.circle(0.32, 0.50, 0.38, "#F8FAFC", r_in=0.33)
    cv.rect(0.14, 0.41, 0.50, 0.59, "#4A2535")
    cv.text("BUS", 0.32, 0.72, 0.22, 0.16, "#F8FAFC", bold=True)
    cv.text("つぎ止まります", 0.32, 0.50, 0.33, 0.14, "#F8FAFC", bold=True)
    cv.text("STOP", 0.32, 0.28, 0.24, 0.16, "#F8FAFC", bold=True)
    cv.text("STOP REQUESTED", 0.74, 0.62, 0.36, 0.14, "#3B1926", bold=True)
    cv.text("次一站停車", 0.74, 0.38, 0.32, 0.14, "#3B1926", bold=True)
    return cv.to_image("tex_bus_stop_sign")


def _build_dash_stop_lamp_texture():
    """Dashboard cylindrical barrel-mounted '停車' round stop indicator lens (`tex_dash_stop_lamp`, unlit default)."""
    cv = Canvas(128, 128, bg_hex="#220B0E")
    cv.arc(0.50, 0.50, 0.50, 0.45, 0, 360, "#120608")
    cv.text("停車", 0.50, 0.50, 0.68, 0.42, "#4A181E", bold=True)
    return cv.to_image("tex_dash_stop_lamp")


def _build_dash_wheelchair_lamp_texture():
    """Dashboard cylindrical barrel-mounted wheelchair round stop indicator lens (`tex_dash_wheelchair_lamp`, unlit default)."""
    cv = Canvas(128, 128, bg_hex="#22170A")
    cv.arc(0.50, 0.50, 0.50, 0.45, 0, 360, "#120D06")
    # Stylized unlit wheelchair icon facing right (bottom-up Canvas Y in [0..1], kept within r < 0.36)
    c = "#4E3714"
    cv.circle(0.53, 0.70, 0.065, c)
    cv.line(0.49, 0.60, 0.49, 0.43, 0.055, c)
    cv.line(0.49, 0.43, 0.62, 0.43, 0.055, c)
    cv.line(0.62, 0.43, 0.67, 0.27, 0.055, c)
    cv.arc(0.46, 0.37, 0.16, 0.105, 115, 345, c)
    return cv.to_image("tex_dash_wheelchair_lamp")


def _build_rear_boarding_lamp_texture():
    """Rear vertical '乗降中' (black panel, dark-green unlit LED) indicator lamp (`tex_rear_boarding_lamp`, unlit default)."""
    cv = Canvas(96, 256, bg_hex="#070A09")
    cv.border(0.04, 0.02, 0.96, 0.98, 0.03, "#151B18")
    cv.text("乗", 0.50, 0.78, 0.76, 0.24, "#13261A", bold=True)
    cv.text("降", 0.50, 0.50, 0.76, 0.24, "#13261A", bold=True)
    cv.text("中", 0.50, 0.22, 0.76, 0.24, "#13261A", bold=True)
    return cv.to_image("tex_rear_boarding_lamp")


def _build_driver_monitor_texture():
    """Right-console blue LCD route/schedule monitor (`tex_driver_monitor`, step_76_shot_1.png)."""
    cv = Canvas(256, 160, bg_hex="#1E242B")
    cv.border(0.03, 0.04, 0.97, 0.96, 0.03, "#475569")
    cv.rect(0.08, 0.18, 0.92, 0.88, "#2B5B9E")
    cv.rect(0.08, 0.76, 0.92, 0.88, "#E2E8F0")
    cv.text("000002  京都市バス", 0.50, 0.82, 0.76, 0.09, "#0F172A", bold=True)
    cv.text("08:13  四条大宮", 0.50, 0.54, 0.76, 0.18, "#FFFFFF", bold=True)
    cv.rect(0.10, 0.20, 0.48, 0.30, "#F59E0B")
    return cv.to_image("tex_driver_monitor")


def _build_route18_sign_texture():
    """Kyoto City Bus Route 18 destination sign curtain (`tex_sign_route18`) for Cycles renders."""
    cv = Canvas(512, 128, bg_hex="#14181F")
    # Right blue route-number box (matching real photos step_35_shot_2 / step_60_shot_1)
    cv.rect(0.75, 0.04, 0.98, 0.96, "#1D63B8")
    cv.border(0.75, 0.04, 0.98, 0.96, 0.015, "#E2E8F0")
    cv.text("18", 0.865, 0.50, 0.19, 0.78, "#FFFFFF", bold=True)
    # Left route destination text
    cv.text("大宮・四条大宮", 0.24, 0.76, 0.40, 0.18, "#E2E8F0", bold=True)
    cv.text("久我石原町", 0.40, 0.52, 0.64, 0.36, "#FFFFFF", bold=True)
    cv.text("Koga-Ishiharacho", 0.40, 0.16, 0.56, 0.18, "#CBD5E1", bold=True)
    return cv.to_image("tex_sign_route18")


# ---------------------------------------------------------------- material constructors
def _make_mat(
    name,
    hex_color="#FFFFFF",
    roughness=0.4,
    metallic=0.0,
    emissive_hex=None,
    emissive_strength=0.0,
    alpha=1.0,
    image=None,
    double_sided=False,
):
    mat = bpy.data.materials.get(name)
    if mat is None:
        mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    mat.use_backface_culling = not double_sided

    nt = mat.node_tree
    bsdf = get_principled_bsdf(mat)
    for n in list(nt.nodes):
        if n.type == "TEX_IMAGE":
            nt.nodes.remove(n)

    if image is not None:
        _set_input(bsdf, ("Base Color",), (1.0, 1.0, 1.0, 1.0))
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = image
        tex.interpolation = "Linear"
        nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    else:
        _set_input(bsdf, ("Base Color",), hex_to_linear_rgba(hex_color, 1.0))

    _set_input(bsdf, ("Roughness",), float(roughness))
    _set_input(bsdf, ("Metallic",), float(metallic))

    if emissive_hex is not None and emissive_strength > 0.0:
        _set_input(bsdf, ("Emission Color", "Emission"), hex_to_linear_rgba(emissive_hex, 1.0))
        _set_input(bsdf, ("Emission Strength",), float(emissive_strength))
    else:
        _set_input(bsdf, ("Emission Color", "Emission"), (0.0, 0.0, 0.0, 1.0))
        _set_input(bsdf, ("Emission Strength",), 0.0)

    _set_input(bsdf, ("Alpha",), float(alpha))
    if alpha < 0.999:
        if hasattr(mat, "blend_method"):
            mat.blend_method = "BLEND"
        if hasattr(mat, "surface_render_method"):
            mat.surface_render_method = "BLENDED"
        _set_input(bsdf, ("Transmission Weight", "Transmission"), 1.0 - alpha)
    else:
        if hasattr(mat, "blend_method"):
            mat.blend_method = "OPAQUE"
        if hasattr(mat, "surface_render_method"):
            mat.surface_render_method = "DITHERED"

    mat.diffuse_color = hex_to_linear_rgba(hex_color, alpha)
    return mat


def build_materials():
    """Create/update all Kyoto City Bus PDG-AA273KAN materials and packed textures.

    Returns a dictionary mapping canonical material names (plus convenient aliases)
    to `bpy.types.Material` instances. Never touches `KEEP_MATERIALS`.
    """
    img_floor = _build_floor_texture()
    img_moq_blue = _build_moquette_texture(
        "tex_moquette_blue", "#1D4E9E", "#133570", "#3B73C8", "#689CE8", seed=2007
    )
    img_moq_prio = _build_moquette_texture(
        "tex_moquette_priority", "#8E1B2B", "#64101C", "#AB2639", "#C43C4F", seed=2008
    )
    img_plate = _build_license_plate()
    img_crest = _build_kyoto_crest()
    img_kyoto_txt = _build_kyoto_bus_text()
    img_fleet_sage = _build_fleet_number("tex_fleet_1771", "#C8D5BB", "#1A241E")
    img_fleet_dark = _build_fleet_number("tex_fleet_1771_dark", "#25362C", "#F4F8F2", border_hex="#E2EAE0")
    img_nonstep = _build_mlit_nonstep_decal()
    img_wheelchair = _build_wheelchair_decal()
    img_entrance = _build_entrance_decal()
    img_exit = _build_exit_decal()
    img_emergency = _build_emergency_decal()
    img_gauges = _build_gauges_texture()
    img_steering = _build_steering_emblem()
    img_farebox = _build_farebox_display()
    img_nextstop = _build_next_stop_display()
    img_stopsign = _build_stop_request_sign()
    img_dash_stop = _build_dash_stop_lamp_texture()
    img_dash_wc = _build_dash_wheelchair_lamp_texture()
    img_rear_boarding = _build_rear_boarding_lamp_texture()
    img_drivermon = _build_driver_monitor_texture()
    img_sign18 = _build_route18_sign_texture()

    mats = {}

    # --- Exterior Livery & Trim (Matched to Real Photos) ---
    mats["BusCream"] = _make_mat("BusCream", "#C8D5BB", roughness=0.30)
    mats["BusGreen"] = _make_mat("BusGreen", "#3B4F43", roughness=0.32)
    mats["BusBumperSilver"] = _make_mat("BusBumperSilver", "#A8AEB5", roughness=0.28, metallic=0.72)
    mats["BusMirrorWhite"] = _make_mat("BusMirrorWhite", "#DCE4D4", roughness=0.32)
    mats["BusTrim"] = _make_mat("BusTrim", "#181B1E", roughness=0.42)
    mats["BusRubber"] = _make_mat("BusRubber", "#202326", roughness=0.78)
    mats["BusWhite"] = _make_mat("BusWhite", "#C8D5BB", roughness=0.32)  # roof & Thermo King AC pod are pale sage-cream!
    mats["BusPureWhite"] = _make_mat("BusPureWhite", "#ECEFE8", roughness=0.36)
    mats["BusGray"] = _make_mat("BusGray", "#586068", roughness=0.52)
    mats["BusHvacGrille"] = _make_mat("BusHvacGrille", "#262B30", roughness=0.55, metallic=0.35)
    mats["BusChrome"] = _make_mat("BusChrome", "#D6DCE0", roughness=0.20, metallic=0.85)
    mats["BusSign"] = _make_mat("BusSign", "#0D1116", roughness=0.22)
    mats["BusSignBlank"] = _make_mat("BusSignBlank", "#0E1217", roughness=0.18)
    mats["BusMonitorBlank"] = _make_mat("BusMonitorBlank", "#101419", roughness=0.22)

    # --- Glass (preserved by lambertize.js) ---
    mats["BusGlass"] = _make_mat("BusGlass", "#3C4852", roughness=0.08, alpha=0.28, double_sided=True)
    mats["BusGlassDark"] = _make_mat("BusGlassDark", "#181E24", roughness=0.10, alpha=0.62, double_sided=True)

    # --- Exterior Lighting ---
    mats["BusLightWhite"] = _make_mat(
        "BusLightWhite", "#F5F8FA", roughness=0.15, emissive_hex="#FFF8E7", emissive_strength=0.65
    )
    mats["BusFogYellow"] = _make_mat(
        "BusFogYellow", "#FFF2B2", roughness=0.15, emissive_hex="#FFE580", emissive_strength=0.55
    )
    mats["BusAmber"] = _make_mat(
        "BusAmber", "#F59E0B", roughness=0.18, emissive_hex="#F59E0B", emissive_strength=0.55
    )
    mats["BusRed"] = _make_mat(
        "BusRed", "#DC2626", roughness=0.18, emissive_hex="#DC2626", emissive_strength=0.55
    )
    mats["BusReflectorRed"] = _make_mat("BusReflectorRed", "#881313", roughness=0.25)
    mats["BusGreenLamp"] = _make_mat(
        "BusGreenLamp", "#16A34A", roughness=0.18, emissive_hex="#22C55E", emissive_strength=0.45
    )
    mats["BusTurnL"] = _make_mat("BusTurnL", "#9A5B06", roughness=0.20)
    mats["BusTurnR"] = _make_mat("BusTurnR", "#9A5B06", roughness=0.20)
    mats["BusBrakeLamp"] = _make_mat("BusBrakeLamp", "#7A1212", roughness=0.20)
    mats["BusReverseLamp"] = _make_mat("BusReverseLamp", "#949EA8", roughness=0.20)
    mats["BusRearBoardingLamp"] = _make_mat(
        "BusRearBoardingLamp", "#070A09", roughness=0.22, image=img_rear_boarding
    )

    # --- Wheels & Tires (Body-color pale sage-green steel rims #BAC8AC!) ---
    mats["BusTire"] = _make_mat("BusTire", "#1C1E20", roughness=0.82)
    mats["BusWheelRim"] = _make_mat("BusWheelRim", "#BAC8AC", roughness=0.34, metallic=0.22)
    mats["BusHub"] = mats["BusWheelRim"]
    mats["BusAxleDark"] = _make_mat("BusAxleDark", "#222528", roughness=0.55, metallic=0.45)

    # --- Interior Solid Materials (Matched to Real Cabin & Cockpit Photos) ---
    mats["BusInterior"] = _make_mat("BusInterior", "#D6DAD4", roughness=0.52)
    mats["BusInteriorDark"] = _make_mat("BusInteriorDark", "#2A2E34", roughness=0.58)
    mats["BusSeatShell"] = _make_mat("BusSeatShell", "#C8CED4", roughness=0.45)  # light-grey plastic seatback!
    mats["BusDriverSeat"] = _make_mat("BusDriverSeat", "#282C32", roughness=0.75)
    mats["BusPole"] = _make_mat("BusPole", "#E26826", roughness=0.36)
    mats["BusSteel"] = _make_mat("BusSteel", "#C8CFD6", roughness=0.24, metallic=0.82)
    mats["BusYellowEdge"] = _make_mat("BusYellowEdge", "#EAB308", roughness=0.44)
    mats["BusStrap"] = _make_mat("BusStrap", "#ECEEE8", roughness=0.55)
    mats["BusStopButton"] = _make_mat(
        "BusStopButton", "#DC2626", roughness=0.28, emissive_hex="#EF4444", emissive_strength=0.45
    )
    mats["BusCeilingLight"] = _make_mat(
        "BusCeilingLight", "#F8FAFC", roughness=0.20, emissive_hex="#FFFDF5", emissive_strength=0.85
    )
    mats["BusFareboxBody"] = _make_mat("BusFareboxBody", "#90948C", roughness=0.45, metallic=0.30)
    mats["BusFareboxChanger"] = _make_mat("BusFareboxChanger", "#434A78", roughness=0.45)
    mats["BusCardSlotGreen"] = _make_mat("BusCardSlotGreen", "#84A97C", roughness=0.45)
    mats["BusSwitchPanelWhite"] = _make_mat("BusSwitchPanelWhite", "#E6EAE2", roughness=0.40)
    mats["BusIcReader"] = _make_mat(
        "BusIcReader", "#1D4ED8", roughness=0.30, emissive_hex="#2563EB", emissive_strength=0.35
    )

    # --- Textured Materials (full UV 0..1 mapped packed PNGs) ---
    mats["BusFloor"] = _make_mat("BusFloor", "#585754", roughness=0.75, image=img_floor)
    mats["BusSeat"] = _make_mat("BusSeat", "#1D4E9E", roughness=0.82, image=img_moq_blue)
    mats["BusSeatPriority"] = _make_mat("BusSeatPriority", "#8E1B2B", roughness=0.82, image=img_moq_prio)
    mats["BusPlate"] = _make_mat("BusPlate", "#134629", roughness=0.35, image=img_plate)
    mats["BusCrest"] = _make_mat("BusCrest", "#3B4F43", roughness=0.32, image=img_crest)
    mats["BusDecalKyotoText"] = _make_mat("BusDecalKyotoText", "#C8D5BB", roughness=0.30, image=img_kyoto_txt)
    mats["BusDecalFleet"] = _make_mat("BusDecalFleet", "#C8D5BB", roughness=0.30, image=img_fleet_sage)
    mats["BusDecalFleetDark"] = _make_mat("BusDecalFleetDark", "#25362C", roughness=0.32, image=img_fleet_dark)
    mats["BusDecalNonStep"] = _make_mat("BusDecalNonStep", "#238854", roughness=0.35, image=img_nonstep)
    mats["BusDecalWheelchair"] = _make_mat("BusDecalWheelchair", "#0D5BB5", roughness=0.35, image=img_wheelchair)
    mats["BusDecalEntrance"] = _make_mat("BusDecalEntrance", "#F4F7F4", roughness=0.35, image=img_entrance)
    mats["BusDecalExit"] = _make_mat("BusDecalExit", "#F4F7F4", roughness=0.35, image=img_exit)
    mats["BusDecalEmergency"] = _make_mat("BusDecalEmergency", "#F4F6F4", roughness=0.40, image=img_emergency)
    mats["BusGauges"] = _make_mat(
        "BusGauges", "#181C22", roughness=0.25, image=img_gauges, emissive_hex="#1E293B", emissive_strength=0.15
    )
    mats["BusSteeringEmblem"] = _make_mat("BusSteeringEmblem", "#181B20", roughness=0.42, image=img_steering)
    mats["BusFareboxDisplay"] = _make_mat("BusFareboxDisplay", "#989C94", roughness=0.35, image=img_farebox)
    mats["BusNextStopDisplay"] = _make_mat(
        "BusNextStopDisplay", "#181C22", roughness=0.25, image=img_nextstop, emissive_hex="#1E293B", emissive_strength=0.15
    )
    mats["BusStopSign"] = _make_mat(
        "BusStopSign", "#C86D85", roughness=0.28, image=img_stopsign, emissive_hex="#C86D85", emissive_strength=0.25
    )
    mats["BusDashStopLamp"] = _make_mat(
        "BusDashStopLamp", "#240D10", roughness=0.22, image=img_dash_stop
    )
    mats["BusDashWheelchairLamp"] = _make_mat(
        "BusDashWheelchairLamp", "#241A0B", roughness=0.22, image=img_dash_wc
    )
    mats["BusDriverMonitor"] = _make_mat(
        "BusDriverMonitor", "#2B5B9E", roughness=0.25, image=img_drivermon, emissive_hex="#2B5B9E", emissive_strength=0.25
    )
    mats["BusSignDisplay"] = _make_mat(
        "BusSignDisplay", "#14181F", roughness=0.20, image=img_sign18, emissive_hex="#1E293B", emissive_strength=0.22
    )

    # Convenient aliases for exterior & interior modules
    aliases = {
        "BusBase": "BusCream",
        "BusSage": "BusCream",
        "BusBand": "BusGreen",
        "BusForestGreen": "BusGreen",
        "BusBlack": "BusTrim",
        "BusSash": "BusTrim",
        "BusRoof": "BusCream",
        "BusMirror": "BusChrome",
        "BusMirrorBody": "BusMirrorWhite",
        "BusSilver": "BusBumperSilver",
        "BusWall": "BusInterior",
        "BusCeiling": "BusInterior",
        "BusDash": "BusInteriorDark",
        "BusConsole": "BusInteriorDark",
        "BusSeatBlue": "BusSeat",
        "BusMoquetteBlue": "BusSeat",
        "BusMoquettePriority": "BusSeatPriority",
        "BusSeatOrange": "BusSeatPriority",
        "BusSeatCrimson": "BusSeatPriority",
        "BusStanchion": "BusPole",
        "BusOrangePole": "BusPole",
        "BusHandrail": "BusSteel",
        "BusStainless": "BusSteel",
        "BusStepYellow": "BusYellowEdge",
        "BusGrabStrap": "BusStrap",
        "BusInstrumentCluster": "BusGauges",
        "BusBinnacleScreen": "BusGauges",
        "BusFusoEmblem": "BusSteeringEmblem",
        "BusHornPad": "BusSteeringEmblem",
        "BusFareboxTop": "BusFareboxDisplay",
        "BusOverheadDisplay": "BusNextStopDisplay",
        "BusPartitionGlass": "BusGlass",
    }
    for alias, target in aliases.items():
        mats[alias] = mats[target]

    return mats


# Alias entrypoints so any caller convention works
build = build_materials
create_materials = build_materials
