"""Exterior 3D geometry for Kyoto City Bus PDG-AA273KAN (Nishinippon Shatai 96MC B-I).

Fleet #1771 (京都200か17-71), Yokooji Depot / Route 18 specification with Thermo King
domed roof HVAC pod (total height 2.990 m, roof crown 2.650 m, length 10.490 m, width 2.490 m, WB 4.800 m).

All meshes are parented to `body_empty` (`Body`) at location=(0,0,0), rotation=(0,0,0).
Input coordinates are in logical Body space (+X left/curb, -X right/driver, +Y up, +Z front),
which `MeshBuilder.build()` automatically converts to Blender-native Z-up `(x, -z, y)`.
"""
import math

from . import spec
from .geom import MeshBuilder


# ---------------------------------------------------------------- S-curve side livery helper
def _skirt_bot_y(z):
    """Bottom edge of side body panels (tapers up slightly behind rear wheel arch)."""
    if z >= -1.40:
        return spec.SKIRT_Y  # 0.28
    t = spec.smoothstep(-1.40, spec.Z_REAR, z)
    return spec.SKIRT_Y + 0.06 * t


def _side_livery_slices(z, side):
    """Return vertical `(y0, y1, mat_key)` slices from bottom skirt up to window sill (1.15 m)
    at longitudinal coordinate `z` on `side` (+1 left/curb, -1 right/driver).

    Implements the Kyoto City Bus non-step S-curve livery (`step_35_shot_2.png`, `step_60_shot_1.png`,
    `step_54_shot_1.png`, `step_20_shot_2.png`):
      - Thin dark-green beltline pinstripe at Y = 1.06..1.10 m below the 1.15 m window sill.
      - Ahead of front wheel arch (z >= 4.45): thick dark-green band + thin lower pinstripe sit at
        mid-waist height (left: thick 0.71..0.87, pin 0.63..0.67; right: thick 0.76..0.92, pin 0.68..0.72).
      - Behind front wheel arch (z = 4.45 -> 3.52): both sweep smoothly DOWNWARD in an S-curve
        to lower rocker level (thick 0.50..0.66, gap 0.46..0.50, thin pinstripe 0.42..0.46),
        leaving a pale sage-cream (`BusCream`) bottom skirt strip (0.28..0.42) all along the bottom.
    """
    y_bot = _skirt_bot_y(z)

    # S-curve vertical offset from low rocker level (z <= 3.52) to front waist level (z >= 4.45)
    t_s = spec.smoothstep(3.52, 4.45, z)
    if side > 0:
        dy_front = 0.210  # left front: pin 0.630..0.670, thick 0.710..0.870
    else:
        dy_front = 0.260  # right front: pin 0.680..0.720, thick 0.760..0.920 (leaves room for 1771 below 1.10 sill)
    dy = dy_front * t_s

    pin0 = 0.420 + dy
    pin1 = 0.460 + dy
    gap1 = 0.500 + dy
    thk1 = 0.660 + dy

    slices = [
        (y_bot, pin0, "BusCream"),
        (pin0, pin1, "BusGreen"),
        (pin1, gap1, "BusCream"),
        (gap1, thk1, "BusGreen"),
    ]
    # Thin beltline pinstripe (Y = 1.06..1.10) runs from rear forward to front door (left) or driver window (right)
    has_belt_pin = (z <= 5.58) if side > 0 else (z <= 5.45)
    if has_belt_pin:
        slices.extend([
            (thk1, 1.060, "BusCream"),
            (1.060, 1.100, "BusGreen"),
            (1.100, 1.135, "BusCream"),
            (1.135, 1.150, "BusTrim"),
        ])
    else:
        slices.extend([
            (thk1, 1.150, "BusCream"),
        ])
    return slices


def _add_side_wall_strip(mb, mats, side, z0, z1, y_min=None, y_max=spec.WIN_SILL_Y, steps=1, inner_wall=True):
    """Subdivided lower waist/skirt wall strip on left (side=+1) or right (side=-1) following S-curve livery."""
    x_out = side * spec.HALF_W
    x_in = side * spec.INNER_HALF_W
    if steps == 1 and z1 > 3.45 and z0 < 4.55:
        steps = max(2, int(round((z1 - z0) / 0.05)))
    zs = [z0 + (z1 - z0) * i / steps for i in range(steps + 1)]

    for i in range(steps):
        za, zb = zs[i], zs[i + 1]
        y_bot_a = _skirt_bot_y(za) if y_min is None else max(y_min, _skirt_bot_y(za))
        y_bot_b = _skirt_bot_y(zb) if y_min is None else max(y_min, _skirt_bot_y(zb))
        sa = _side_livery_slices(za, side)
        sb = _side_livery_slices(zb, side)
        n_bands = min(len(sa), len(sb))
        for k in range(n_bands):
            ya0, ya1, mkey = sa[k]
            yb0, yb1, _ = sb[k]
            ya0_c = max(y_bot_a, min(y_max, ya0))
            ya1_c = max(ya0_c, min(y_max, ya1))
            yb0_c = max(y_bot_b, min(y_max, yb0))
            yb1_c = max(yb0_c, min(y_max, yb1))
            if (ya1_c - ya0_c) < 1e-4 and (yb1_c - yb0_c) < 1e-4:
                continue
            mat = mats[mkey]
            if side > 0:
                mb.quad((x_out, yb0_c, zb), (x_out, ya0_c, za), (x_out, ya1_c, za), (x_out, yb1_c, zb), mat)
            else:
                mb.quad((x_out, ya0_c, za), (x_out, yb0_c, zb), (x_out, yb1_c, zb), (x_out, ya1_c, za), mat)

    if inner_wall:
        ym0 = _skirt_bot_y(0.5 * (z0 + z1)) if y_min is None else y_min
        if y_max > ym0 + 1e-4:
            if side > 0:
                mb.quad((x_in, ym0, z0), (x_in, ym0, z1), (x_in, y_max, z1), (x_in, y_max, z0), mats["BusInterior"])
            else:
                mb.quad((x_in, ym0, z1), (x_in, ym0, z0), (x_in, y_max, z0), (x_in, y_max, z1), mats["BusInterior"])


def _add_arch_wall_section(mb, mats, side, z_center, y_top=spec.WIN_SILL_Y, steps=20):
    """Side wall section spanning [z_center - ARCH_R, z_center + ARCH_R] with circular wheel-arch cutout."""
    r = spec.ARCH_R
    yc = spec.TIRE_RADIUS
    x_out = side * spec.HALF_W
    zs = [z_center - r + (2.0 * r * i / steps) for i in range(steps + 1)]

    def arch_y(z):
        dz = abs(z - z_center)
        if dz >= r:
            return yc
        return yc + math.sqrt(max(0.0, r * r - dz * dz))

    for i in range(steps):
        za, zb = zs[i], zs[i + 1]
        ya_arch = arch_y(za)
        yb_arch = arch_y(zb)
        yta = 1.10 if (side < 0 and za >= 5.45) else y_top
        ytb = 1.10 if (side < 0 and zb >= 5.45) else y_top
        sa = _side_livery_slices(za, side)
        sb = _side_livery_slices(zb, side)
        n_bands = min(len(sa), len(sb))
        for k in range(n_bands):
            ya0, ya1, mkey = sa[k]
            yb0, yb1, _ = sb[k]
            ya0_c = max(ya_arch, min(yta, ya0))
            ya1_c = max(ya0_c, min(yta, ya1))
            yb0_c = max(yb_arch, min(ytb, yb0))
            yb1_c = max(yb0_c, min(ytb, yb1))
            if (ya1_c - ya0_c) < 1e-4 and (yb1_c - yb0_c) < 1e-4:
                continue
            mat = mats[mkey]
            if side > 0:
                mb.quad((x_out, yb0_c, zb), (x_out, ya0_c, za), (x_out, ya1_c, za), (x_out, yb1_c, zb), mat, smooth=True)
            else:
                mb.quad((x_out, ya0_c, za), (x_out, yb0_c, zb), (x_out, yb1_c, zb), (x_out, ya1_c, za), mat, smooth=True)

    # Molded dark rubber wheel-arch flare along the cutout edge
    r_in = r
    r_out = r + 0.032
    x_lip = side * (spec.HALF_W + 0.005)
    x_well = side * (spec.HALF_W - 0.045)
    angles = [-0.24] + [math.pi * i / steps for i in range(steps + 1)] + [math.pi + 0.24]
    for i in range(len(angles) - 1):
        a0, a1 = angles[i], angles[i + 1]
        z0_in, y0_in = z_center + r_in * math.cos(a0), max(spec.SKIRT_Y, yc + r_in * math.sin(a0))
        z1_in, y1_in = z_center + r_in * math.cos(a1), max(spec.SKIRT_Y, yc + r_in * math.sin(a1))
        z0_out, y0_out = z_center + r_out * math.cos(a0), max(spec.SKIRT_Y, yc + r_out * math.sin(a0))
        z1_out, y1_out = z_center + r_out * math.cos(a1), max(spec.SKIRT_Y, yc + r_out * math.sin(a1))
        if side > 0:
            mb.quad((x_lip, y0_out, z0_out), (x_lip, y0_in, z0_in), (x_lip, y1_in, z1_in), (x_lip, y1_out, z1_out), mats["BusRubber"], smooth=True)
            mb.quad((x_lip, y0_in, z0_in), (x_well, y0_in, z0_in), (x_well, y1_in, z1_in), (x_lip, y1_in, z1_in), mats["BusRubber"], smooth=True)
        else:
            mb.quad((x_lip, y0_in, z0_in), (x_lip, y0_out, z0_out), (x_lip, y1_out, z1_out), (x_lip, y1_in, z1_in), mats["BusRubber"], smooth=True)
            mb.quad((x_well, y0_in, z0_in), (x_lip, y0_in, z0_in), (x_lip, y1_in, z1_in), (x_well, y1_in, z1_in), mats["BusRubber"], smooth=True)


def _add_side_pillar(mb, mats, side, z0, z1, y0=spec.WIN_SILL_Y, y1=spec.WIN_HEADER_Y, outer_mat_key="BusCream"):
    """Structural body pillar (`BusCream`) or black window mullion (`BusTrim`) with inner trim skin."""
    x_out = side * spec.HALF_W
    x_in = side * spec.INNER_HALF_W
    omat = mats[outer_mat_key]
    if side > 0:
        mb.box((x_in, y0, z0), (x_out, y1, z1), omat, mats={"-x": mats["BusInterior"]})
    else:
        mb.box((x_out, y0, z0), (x_in, y1, z1), omat, mats={"+x": mats["BusInterior"]})


# ---------------------------------------------------------------- 1. Destination Sign Housings
def _build_signs(body_empty, mats):
    """Create SignFront, SignRear, SignSideL with exact Body-space bounding boxes.

    Note: SignSideL fills the ENTIRE dedicated side-sign window opening behind the middle door
    (Z = 0.90..1.90, Y = 1.17..2.16) and is completely BLANK (`BusSignBlank`).
    """
    # SignFront: inside recessed rounded-rectangle black front header window (X=[-0.80, +0.68], Y=[2.235, 2.535], 1.48x0.30m)
    z_sf = spec.front_z(2.385) - 0.024
    mbf = MeshBuilder()
    mbf.box(
        (spec.SIGN_FRONT["x"][0], spec.SIGN_FRONT["y"][0], z_sf - 0.025),
        (spec.SIGN_FRONT["x"][1], spec.SIGN_FRONT["y"][1], z_sf),
        mats["BusSign"],
        mats={"+z": mats["BusSignDisplay"]},
    )
    mbf.build("SignFront", parent=body_empty)

    # SignRear: mounted snugly inside top-center of rear window glass (X=[-0.74, +0.74], Y=[2.06, 2.36], 1.48x0.30m = same as SignFront!)
    mbr = MeshBuilder()
    mbr.box(
        (spec.SIGN_REAR["x"][0], spec.SIGN_REAR["y"][0], -3.428),
        (spec.SIGN_REAR["x"][1], spec.SIGN_REAR["y"][1], -3.392),
        mats["BusSign"],
        mats={"-z": mats["BusSignDisplay"]},
    )
    mbr.build("SignRear", parent=body_empty)

    # SignSideL: UPPER HALF OF DEDICATED WINDOW BAY BEHIND MIDDLE DOOR (Z=[+0.90, +1.90], Y=[1.58, 2.16], X=[+1.228, +1.242])
    # Completely blank dark matte/glass display (`BusSignBlank`) with NO text rendered!
    mbs = MeshBuilder()
    mbs.box(
        (spec.SIGN_SIDE_L["x"][0], spec.SIGN_SIDE_L["y"][0], spec.SIGN_SIDE_L["z"][0]),
        (spec.SIGN_SIDE_L["x"][1], spec.SIGN_SIDE_L["y"][1], spec.SIGN_SIDE_L["z"][1]),
        mats["BusSignBlank"],
    )
    mbs.build("SignSideL", parent=body_empty)


# ---------------------------------------------------------------- 2. BodyShell (Cant Rail, Roof, Corners, Sides, Front V-Chevron & Brow, Rear)
def _build_body_shell(body_empty, mats):
    mb = MeshBuilder()
    plan = spec.PlanOutline(0.0)
    # Add line breakpoints across front and rear so sign/window openings AND roof camber curve align cleanly
    extra_breaks = [
        plan.s_front_x(1.095),
        plan.s_front_x(-1.095),
        plan.s_rear_x(1.00),
        plan.s_rear_x(-1.00),
        plan.s_side_z(spec.WINDSHIELD["z_wrap_l"], +1),
        plan.s_side_z(spec.WINDSHIELD["z_wrap_r"], -1),
    ]
    for x_sub in (-0.80, -0.60, -0.40, -0.20, 0.0, 0.20, 0.40, 0.60, 0.80):
        extra_breaks.append(plan.s_front_x(x_sub))
        extra_breaks.append(plan.s_rear_x(x_sub))
    s_vals = plan.samples(arc_steps=8, line_breaks=extra_breaks)
    n_s = len(s_vals)

    # --- A. Upper Header + Cant Rail Ring (Y = 2.18 .. 2.60) ---
    y_levels = [
        (2.18, 2.38),
        (2.38, 2.48),
        (2.48, 2.555),
        (2.555, 2.60),
    ]
    xf_flat = spec.HALF_W - spec.CORNER_R_FRONT  # 1.095
    for y0, y1 in y_levels:
        d0 = spec.cant_inset(y0)
        d1 = spec.cant_inset(y1)
        for i in range(n_s):
            s_a = s_vals[i]
            s_b = s_vals[(i + 1) % n_s]
            xa, za, nxa, nza = plan.point(s_a)
            xb, zb, nxb, nzb = plan.point(s_b)
            xm = 0.5 * (xa + xb)
            zm = 0.5 * (za + zb)

            # Skip front flat brow center (built in A2 with rounded recessed sign window & drip-lip)
            if zm > spec.Z_FRONT - 0.02 and abs(xm) < xf_flat and y1 <= 2.556:
                continue
            # Skip rear window upper opening (|X| < 1.00, Y = 2.18..2.38)
            if zm < spec.Z_REAR + 0.02 and abs(xm) < 1.00 and y1 <= 2.381:
                continue

            p0 = spec.deform((xa - nxa * d0, y0, za - nza * d0))
            p1 = spec.deform((xb - nxb * d0, y0, zb - nzb * d0))
            p2 = spec.deform((xb - nxb * d1, y1, zb - nzb * d1))
            p3 = spec.deform((xa - nxa * d1, y1, za - nza * d1))
            mb.quad(p0, p1, p2, p3, mats["BusCream"], smooth=True)
            if y1 <= 2.481:
                di0 = d0 + spec.WALL_T
                di1 = d1 + spec.WALL_T
                pi0 = spec.deform((xa - nxa * di0, y0, za - nza * di0))
                pi1 = spec.deform((xb - nxb * di0, y0, zb - nzb * di0))
                pi2 = spec.deform((xb - nxb * di1, y1, zb - nzb * di1))
                pi3 = spec.deform((xa - nxa * di1, y1, za - nza * di1))
                mb.quad(pi1, pi0, pi3, pi2, mats["BusInterior"], smooth=True)

    # --- A2. Front Destination Sign Brow (`Y = 2.14 .. 2.555`, `X = -1.095 .. +1.095`) ---
    # Matches media_1795480605239_ac27a741.jpg: wide rounded-rectangle dark glass window (`-1.08..+1.08, 2.215..2.555`)
    # framed cleanly by slim pale-sage brow/cheeks/bottom-bar and subtle black rubber gasket.
    def _brow_pt(x, y, z_off=0.0):
        d = spec.cant_inset(y)
        return spec.deform((x, y, spec.Z_FRONT - d + z_off))

    nx_brow = 16
    b_xs = [-xf_flat + 2.0 * xf_flat * i / nx_brow for i in range(nx_brow + 1)]
    for y0, y1 in ((2.14, 2.155), (2.155, 2.215)):
        for i in range(nx_brow):
            xa, xb = b_xs[i], b_xs[i + 1]
            p0 = _brow_pt(xa, y0)
            p1 = _brow_pt(xb, y0)
            p2 = _brow_pt(xb, y1)
            p3 = _brow_pt(xa, y1)
            mb.quad(p0, p1, p2, p3, mats["BusCream"], smooth=True)
    for i in range(nx_brow):
        xa, xb = b_xs[i], b_xs[i + 1]
        p0 = _brow_pt(xa, 2.14, -0.004)
        p1 = _brow_pt(xb, 2.14, -0.004)
        p2 = _brow_pt(xb, 2.155, 0.0)
        p3 = _brow_pt(xa, 2.155, 0.0)
        mb.quad(p0, p1, p2, p3, mats["BusCream"], smooth=True)

    # Fill the wraparound front header transition (Y = 2.14 .. 2.18) along BOTH front corners AND wrap sides
    # back to Z_wrap_l = 6.64 (+X) and Z_wrap_r = 6.69 (-X) so the wraparound windshield seals cleanly!
    wrap_ranges = [
        (plan.s_front_x(xf_flat), plan.s_side_z(spec.WINDSHIELD["z_wrap_l"], +1), 10),
        (plan.s_side_z(spec.WINDSHIELD["z_wrap_r"], -1), plan.s_front_x(-xf_flat), 10),
    ]
    for s0_w, s1_w, n_w in wrap_ranges:
        for k in range(n_w):
            sa = s0_w + (s1_w - s0_w) * k / n_w
            sb = s0_w + (s1_w - s0_w) * (k + 1) / n_w
            xa, za, _, _ = plan.point(sa)
            xb, zb, _, _ = plan.point(sb)
            mb.quad(
                spec.deform((xa, 2.14, za)),
                spec.deform((xb, 2.14, zb)),
                spec.deform((xb, 2.18, zb)),
                spec.deform((xa, 2.18, za)),
                mats["BusCream"],
                smooth=True,
            )

    # Wide rounded-rectangle destination display opening: X = [-1.08, +1.08], Y = [2.215, 2.555], r_c = 0.045 m
    sw_x = 1.080
    sw_y0, sw_y1 = 2.215, 2.555
    r_c = 0.045
    n_arc = 6

    for sx in (-1, +1):
        x_in = sx * sw_x
        x_out = sx * xf_flat
        if sx > 0:
            mb.quad(_brow_pt(x_in, sw_y0), _brow_pt(x_out, sw_y0), _brow_pt(x_out, sw_y1), _brow_pt(x_in, sw_y1), mats["BusCream"], smooth=True)
        else:
            mb.quad(_brow_pt(x_out, sw_y0), _brow_pt(x_in, sw_y0), _brow_pt(x_in, sw_y1), _brow_pt(x_out, sw_y1), mats["BusCream"], smooth=True)

    # 4 rounded pale-sage corner fans + inward-recessed bevel lip (`recess = -0.028 m`)
    corners = [
        (+sw_x - r_c, sw_y1 - r_c, 0.0, 90.0, (+sw_x, sw_y1)),
        (-sw_x + r_c, sw_y1 - r_c, 90.0, 180.0, (-sw_x, sw_y1)),
        (-sw_x + r_c, sw_y0 + r_c, 180.0, 270.0, (-sw_x, sw_y0)),
        (+sw_x - r_c, sw_y0 + r_c, 270.0, 360.0, (+sw_x, sw_y0)),
    ]
    loop_outer = []
    loop_mid = []
    loop_inner = []
    for cx, cy, a0, a1, corner_xy in corners:
        ck = _brow_pt(corner_xy[0], corner_xy[1])
        arc_pts = []
        for k in range(n_arc + 1):
            ang = math.radians(a0 + (a1 - a0) * k / n_arc)
            px = cx + r_c * math.cos(ang)
            py = cy + r_c * math.sin(ang)
            arc_pts.append((px, py))
            if k < n_arc or a1 < 360.0:
                loop_outer.append(_brow_pt(px, py, 0.0))
                pm_x = cx + (r_c - 0.008) * math.cos(ang)
                pm_y = cy + (r_c - 0.008) * math.sin(ang)
                loop_mid.append(_brow_pt(pm_x, pm_y, -0.010))
                pi_x = cx + (r_c - 0.016) * math.cos(ang)
                pi_y = cy + (r_c - 0.016) * math.sin(ang)
                loop_inner.append(_brow_pt(pi_x, pi_y, -0.028))
        # Pale-sage spandrel triangles filling between the square corner `ck` and the rounded arc
        for k in range(n_arc):
            p_a = _brow_pt(arc_pts[k][0], arc_pts[k][1])
            p_b = _brow_pt(arc_pts[k + 1][0], arc_pts[k + 1][1])
            mb.poly([ck, p_b, p_a], mats["BusCream"], smooth=True)

    # Connect the rounded-rectangle bevel lip (`loop_outer` -> `loop_mid` in BusCream, `loop_mid` -> `loop_inner` in BusTrim)
    n_lp = len(loop_outer)
    for i in range(n_lp):
        j = (i + 1) % n_lp
        mb.quad(loop_outer[i], loop_outer[j], loop_mid[j], loop_mid[i], mats["BusCream"], smooth=True)
        mb.quad(loop_mid[i], loop_mid[j], loop_inner[j], loop_inner[i], mats["BusTrim"], smooth=True)

    # Recessed dark backplate inside the destination sign cavity (`Z_off = -0.028 m`)
    mb.poly(loop_inner, mats["BusSign"])

    # --- B. Watertight Cambered Pale Sage-Cream Roof Deck (`Y = 2.60 .. 2.65`) ---
    # Connect the exact inner perimeter of the cant-rail ring (`d_roof = cant_inset(ROOF_EDGE_Y) = CANT_R`)
    # smoothly across the roof width so there are ZERO dark corner gaps in `ortho_top.png`!
    d_roof = spec.cant_inset(spec.ROOF_EDGE_Y)
    plan_roof = spec.PlanOutline(d_roof)
    nz_r = 36
    nx_r = 12
    z_min_r = plan_roof.zr
    z_max_r = plan_roof.zf
    rf_r = plan_roof.rf
    rr_r = plan_roof.rr
    w_r = plan_roof.w

    def _roof_half_width(z):
        if z > z_max_r - rf_r:
            dz = min(rf_r, z - (z_max_r - rf_r))
            return (w_r - rf_r) + math.sqrt(max(0.0, rf_r * rf_r - dz * dz))
        if z < z_min_r + rr_r:
            dz = min(rr_r, (z_min_r + rr_r) - z)
            return (w_r - rr_r) + math.sqrt(max(0.0, rr_r * rr_r - dz * dz))
        return w_r

    # Include exact corner arc z values so the roof perimeter matches the cant-rail arc vertices!
    z_samples = set()
    for iz in range(nz_r + 1):
        z_samples.add(round(z_min_r + (z_max_r - z_min_r) * iz / nz_r, 6))
    for k in range(9):
        ang = math.pi * 0.5 * k / 8.0
        z_samples.add(round((z_max_r - rf_r) + rf_r * math.sin(ang), 6))
        z_samples.add(round((z_min_r + rr_r) - rr_r * math.sin(ang), 6))
    z_list = sorted(z_samples)

    for iz in range(len(z_list) - 1):
        z0, z1 = z_list[iz], z_list[iz + 1]
        w0, w1 = _roof_half_width(z0), _roof_half_width(z1)
        for ix in range(nx_r):
            u0 = -1.0 + 2.0 * ix / nx_r
            u1 = -1.0 + 2.0 * (ix + 1) / nx_r
            p00 = spec.deform((w0 * u0, spec.ROOF_EDGE_Y, z0))
            p10 = spec.deform((w0 * u1, spec.ROOF_EDGE_Y, z0))
            p11 = spec.deform((w1 * u1, spec.ROOF_EDGE_Y, z1))
            p01 = spec.deform((w1 * u0, spec.ROOF_EDGE_Y, z1))
            mb.quad(p00, p01, p11, p10, mats["BusCream"], smooth=True)

    # --- C. Four Rounded Vertical Corners (Y = 0.44 .. 2.18) ---
    # Seg 1: front-left (+X, +Z), Seg 3: rear-left (+X, -Z), Seg 5: rear-right (-X, -Z), Seg 7: front-right (-X, +Z)
    for seg_idx in (1, 3, 5, 7):
        s_start = plan.starts[seg_idx]
        s_len = plan.segs[seg_idx][2]
        c_steps = 8
        is_front = seg_idx in (1, 7)
        if is_front:
            c_bands = [
                (0.64, 0.67, "BusGreen"),
                (0.67, 0.74, "BusCream"),
                (0.74, 0.80, "BusGreen"),
                (0.80, 0.86, "BusCream"),
                (0.86, 1.07, "BusGreen"),
                (1.07, 1.14, "BusCream"),
                # Y = 1.14 .. 2.14 is completely OPEN for the wraparound panoramic windshield!
            ]
        else:
            c_bands = [
                (0.44, 0.465, "BusGreen"),
                (0.465, 0.50, "BusCream"),
                (0.50, 0.66, "BusGreen"),
                (0.66, 1.06, "BusCream"),
                (1.06, 1.10, "BusGreen"),
                (1.10, 2.18, "BusCream"),
            ]
        for k in range(c_steps):
            sa = s_start + s_len * k / c_steps
            sb = s_start + s_len * (k + 1) / c_steps
            xa, za, nxa, nza = plan.point(sa)
            xb, zb, nxb, nzb = plan.point(sb)
            for y0, y1, mkey in c_bands:
                # Cut out curb-side safety window around entire front-left corner (seg 1, Y = 0.67 .. 1.10)
                if seg_idx == 1 and y0 >= 0.665 and y1 <= 1.105:
                    continue
                p0 = spec.deform((xa, y0, za))
                p1 = spec.deform((xb, y0, zb))
                p2 = spec.deform((xb, y1, zb))
                p3 = spec.deform((xa, y1, za))
                mb.quad(p0, p1, p2, p3, mats[mkey], smooth=True)
                pi0 = spec.deform((xa - nxa * spec.WALL_T, y0, za - nza * spec.WALL_T))
                pi1 = spec.deform((xb - nxb * spec.WALL_T, y0, zb - nzb * spec.WALL_T))
                pi2 = spec.deform((xb - nxb * spec.WALL_T, y1, zb - nzb * spec.WALL_T))
                pi3 = spec.deform((xa - nxa * spec.WALL_T, y1, za - nza * spec.WALL_T))
                mb.quad(pi1, pi0, pi3, pi2, mats["BusInterior"], smooth=True)

    # --- D. Left Side Wall (+X = +1.245, Z = -3.28 .. +6.80) ---
    # Front door opening: Z = 5.58 .. 6.56; Mid door opening: Z = 2.05 .. 3.25
    # Wraparound windshield & safety window extend along +X back to Z_wrap_l = 6.64!
    z_wl = spec.WINDSHIELD["z_wrap_l"]  # 6.64
    _add_side_wall_strip(mb, mats, +1, 6.56, z_wl, y_min=0.64, y_max=1.15)
    _add_side_pillar(mb, mats, +1, 6.56, z_wl, 1.15, 2.18, "BusCream")  # slim 8cm left A-pillar
    _add_side_wall_strip(mb, mats, +1, 5.36, 5.58, y_max=1.15)
    _add_arch_wall_section(mb, mats, +1, spec.WHEELBASE, y_top=1.15)
    _add_side_wall_strip(mb, mats, +1, 3.25, 4.24, y_max=1.15, steps=18)
    _add_side_wall_strip(mb, mats, +1, 0.56, 2.05, y_max=1.15, steps=4)
    _add_arch_wall_section(mb, mats, +1, 0.0, y_top=1.15)
    _add_side_wall_strip(mb, mats, +1, -3.28, -0.56, y_max=1.15, steps=8)

    # Left side structural body pillars (BusCream) and window mullions (BusTrim)
    left_pillars = [
        (5.42, 5.58, 1.15, 2.18, "BusCream"),   # pale-sage body pillar behind front door
        (4.15, 4.21, 1.15, 2.18, "BusTrim"),    # black mullion between L-F1 and L-F2 dark panel
        (3.25, 3.42, 1.15, 2.18, "BusCream"),   # wide pale-sage structural pillar ahead of middle door
        (1.92, 2.05, 1.15, 2.18, "BusCream"),   # pale-sage structural pillar behind middle door
        (0.84, 0.89, 1.15, 2.18, "BusTrim"),    # black mullion behind SignSideL bay
        (-1.39, -1.34, 1.15, 2.18, "BusTrim"),  # black mullion between L-R2 & L-R3
        (-3.28, -3.24, 1.15, 2.18, "BusCream"), # rear corner pale-sage pillar
    ]
    for z0, z1, py0, py1, pmat in left_pillars:
        _add_side_pillar(mb, mats, +1, z0, z1, py0, py1, pmat)

    # Four small dark square vent grilles behind left rear wheel arch (Z = -2.78 .. -2.22, Y = 0.44 .. 0.88)
    mb.box((spec.HALF_W - 0.002, 0.42, -2.85), (spec.HALF_W + 0.003, 0.92, -1.75), mats["BusTrim"])
    mb.box((spec.HALF_W - 0.001, 0.43, -2.84), (spec.HALF_W + 0.004, 0.91, -1.76), mats["BusCream"])
    mb.box((spec.HALF_W + 0.001, 0.50, -2.84), (spec.HALF_W + 0.005, 0.66, -1.76), mats["BusGreen"])
    mb.box((spec.HALF_W + 0.001, 0.42, -2.84), (spec.HALF_W + 0.005, 0.46, -1.76), mats["BusGreen"])
    for vz0, vz1 in ((-2.78, -2.52), (-2.48, -2.22)):
        for vy0, vy1 in ((0.44, 0.64), (0.69, 0.87)):
            mb.box((spec.HALF_W - 0.002, vy0, vz0), (spec.HALF_W + 0.007, vy1, vz1), mats["BusHvacGrille"])

    # Door threshold & header jambs on left side
    for dz0, dz1 in (spec.FRONT_DOOR_Z, spec.MID_DOOR_Z):
        mb.box((spec.INNER_HALF_W, 0.28, dz0), (spec.HALF_W, 0.32, dz1), mats["BusTrim"])
        mb.box((spec.INNER_HALF_W, 2.12, dz0), (spec.HALF_W, 2.18, dz1), mats["BusCream"])

    # --- E. Right Side Wall (-X = -1.245, Z = -3.28 .. +6.80) ---
    # Wraparound windshield reaches Z_wrap_r = 6.69, leaving a slim 4 cm A-pillar (6.65..6.69) ahead of driver window!
    z_wr = spec.WINDSHIELD["z_wrap_r"]  # 6.69
    z_fc = spec.Z_FRONT - spec.CORNER_R_FRONT  # 6.80
    _add_side_wall_strip(mb, mats, -1, 6.65, z_fc, y_min=0.64, y_max=1.10)
    _add_side_wall_strip(mb, mats, -1, 5.36, 6.65, y_max=1.10)
    _add_arch_wall_section(mb, mats, -1, spec.WHEELBASE, y_top=1.15)
    _add_side_wall_strip(mb, mats, -1, 0.56, 4.24, y_max=1.15, steps=22)
    _add_arch_wall_section(mb, mats, -1, 0.0, y_top=1.15)
    _add_side_wall_strip(mb, mats, -1, -1.82, -0.56, y_max=1.15, steps=4)
    # Below emergency exit door (Z = -2.50 .. -1.82, Y = 0.28 .. 1.00)
    _add_side_wall_strip(mb, mats, -1, -2.50, -1.82, y_max=1.00, steps=2)
    # Rearmost right quarter (Z = -3.28 .. -2.50, Y = 0.28 .. 1.15)
    _add_side_wall_strip(mb, mats, -1, -3.28, -2.50, y_max=1.15, steps=3)

    # Right side structural body pillars (BusCream) & passenger window mullions (BusTrim)
    right_pillars = [
        (6.65, z_wr, 1.10, 2.18, "BusCream"),   # slim 4cm front-right A-pillar
        (5.45, 6.65, 2.16, 2.18, "BusCream"),   # header strip above driver window
        (5.25, 5.45, 1.10, 2.18, "BusCream"),   # pale-sage cab pillar behind driver window
        (4.64, 4.68, 1.15, 2.18, "BusTrim"),    # black mullion behind narrow post-driver fixed window
        (3.08, 3.12, 1.15, 2.18, "BusTrim"),    # black mullion R-1 / R-2
        (1.52, 1.56, 1.15, 2.18, "BusTrim"),    # black mullion R-2 / R-3
        (-0.04, 0.00, 1.15, 2.18, "BusTrim"),   # black mullion R-3 / R-4
        (-1.82, -1.62, 1.15, 2.18, "BusCream"), # wide pale-sage pillar ahead of emergency exit
        (-2.65, -2.50, 1.15, 2.18, "BusCream"), # pale-sage pillar behind emergency exit
        (-3.26, -2.65, 2.14, 2.18, "BusCream"), # pale-sage header above rear fixed quarter window
        (-3.28, -3.26, 1.15, 2.18, "BusCream"), # rear-right corner pillar
    ]
    for z0, z1, y0, y1, pmat in right_pillars:
        _add_side_pillar(mb, mats, -1, z0, z1, y0, y1, pmat)

    # Right-side lower advertisement frame (広告枠) between axles (Z = 1.15 .. 3.45, Y = 0.48 .. 1.04)
    mb.box((-spec.HALF_W - 0.006, 0.48, 1.15), (-spec.HALF_W - 0.002, 0.50, 3.45), mats["BusBumperSilver"])
    mb.box((-spec.HALF_W - 0.006, 1.02, 1.15), (-spec.HALF_W - 0.002, 1.04, 3.45), mats["BusBumperSilver"])
    mb.box((-spec.HALF_W - 0.006, 0.48, 1.15), (-spec.HALF_W - 0.002, 1.04, 1.17), mats["BusBumperSilver"])
    mb.box((-spec.HALF_W - 0.006, 0.48, 3.43), (-spec.HALF_W - 0.002, 1.04, 3.45), mats["BusBumperSilver"])

    # Right-rear engine cooling louver grilles behind rear wheel arch (Z = -3.20 .. -2.56, Y = 0.44 .. 0.94)
    for gy0, gy1 in ((0.44, 0.65), (0.69, 0.94)):
        mb.box((-spec.HALF_W - 0.004, gy0, -3.20), (-spec.HALF_W + 0.01, gy1, -2.56), mats["BusHvacGrille"])
        for k in range(6):
            yk = gy0 + (gy1 - gy0) * (k + 0.5) / 6
            mb.box((-spec.HALF_W - 0.006, yk - 0.005, -3.19), (-spec.HALF_W - 0.002, yk + 0.005, -2.57), mats["BusTrim"])
        mb.box((-spec.HALF_W - 0.007, gy0, -2.89), (-spec.HALF_W - 0.001, gy1, -2.87), mats["BusCream"])

    # --- F. Front Nose Panel with V-Chevron Dark-Green Livery & Safety Window Cutout ---
    # Nose panel spans Y = 0.64 (top of silver bumper) .. 1.15 (bottom of windshield), Z = +6.95.
    xf = spec.HALF_W - spec.CORNER_R_FRONT  # 1.095
    zf = spec.Z_FRONT
    n_fx = 36
    f_xs = [-xf + 2.0 * xf * i / n_fx for i in range(n_fx + 1)]

    def _front_v_curves(x):
        """Return `(y_pin0, y_pin1, y_mid0, y_mid1, y_top0, y_top1)` on the front nose at lateral `x`.
        Matches step_60_shot_2.png & step_35_shot_2.png:
        Two dark-green bands arch gently upward into two shoulders at |x| ~ 0.27 m
        and dip sharply downward into a central V-chevron notch at x = 0 around the winged emblem."""
        ax = abs(x)
        arch = 0.034 * math.exp(-((ax - 0.27) / 0.14) ** 2)
        v_dip = -0.145 * max(0.0, 1.0 - ax / 0.27) ** 1.35
        v_dip_top = -0.118 * max(0.0, 1.0 - ax / 0.25) ** 1.45

        y_pin0, y_pin1 = 0.648, 0.672
        y_mid0 = max(y_pin1, 0.742 + arch + 0.72 * v_dip)
        y_mid1 = max(y_mid0 + 0.042, 0.800 + arch + 0.72 * v_dip)
        y_top0 = max(y_mid1 + 0.030, 0.862 + arch + v_dip)
        y_top1 = max(y_top0 + 0.135, 1.075 + 0.65 * arch + v_dip_top)
        return y_pin0, y_pin1, y_mid0, y_mid1, y_top0, y_top1

    for i in range(n_fx):
        xa, xb = f_xs[i], f_xs[i + 1]
        xm = 0.5 * (xa + xb)
        pa0, pa1, ma0, ma1, ta0, ta1 = _front_v_curves(xa)
        pb0, pb1, mb0, mb1, tb0, tb1 = _front_v_curves(xb)
        bands = [
            (0.640, 0.640, pa0, pb0, "BusCream"),
            (pa0, pb0, pa1, pb1, "BusGreen"),
            (pa1, pb1, ma0, mb0, "BusCream"),
            (ma0, mb0, ma1, mb1, "BusGreen"),
            (ma1, mb1, ta0, tb0, "BusCream"),
            (ta0, tb0, ta1, tb1, "BusGreen"),
            (ta1, tb1, 1.132, 1.132, "BusCream"),
            (1.132, 1.132, 1.150, 1.150, "BusTrim"),
        ]
        for ya0, yb0, ya1, yb1, mkey in bands:
            # Cut out front-left safety window opening (x >= 0.56, y = 0.68..1.10)
            if xm >= 0.56 and ya1 > 0.675 and ya0 < 1.105:
                continue
            mb.quad((xa, ya0, zf), (xb, yb0, zf), (xb, yb1, zf), (xa, ya1, zf), mats[mkey])

    # Inner front dash bulkhead wall (leaving safety window opening clear at x = 0.56..1.12, y = 0.68..1.10)
    mb.quad((0.55, 0.33, zf - spec.WALL_T), (-xf, 0.33, zf - spec.WALL_T), (-xf, 1.15, zf - spec.WALL_T), (0.55, 1.15, zf - spec.WALL_T), mats["BusInteriorDark"])
    mb.quad((xf, 0.33, zf - spec.WALL_T), (0.55, 0.33, zf - spec.WALL_T), (0.55, 0.68, zf - spec.WALL_T), (xf, 0.68, zf - spec.WALL_T), mats["BusInteriorDark"])

    # Small dark circular sensor dot in the pale-sage V-notch above the winged emblem (step_60_shot_2.png)
    mb.disc((0.0, 1.045, zf + 0.004), (0, 0, 1), 0.015, 12, mats["BusTrim"])

    # --- G. Rear Face (-Z = -3.42, X = -1.105 .. +1.105) ---
    # Strictly non-overlapping vertical bands from Y = 0.44 up to Y = 2.18 (above 2.18 is handled by Part A)!
    xr = spec.HALF_W - spec.CORNER_R_REAR  # 1.105
    rw_x = spec.REAR_WINDOW["x"]  # 1.00
    rw_y0, rw_y1 = spec.REAR_WINDOW["y"]  # 1.66, 2.38
    zr = spec.Z_REAR
    rear_bands = [
        (0.44, 0.465, "BusGreen"),
        (0.465, 0.50, "BusCream"),
        (0.50, 0.66, "BusGreen"),
        (0.66, 1.06, "BusCream"),
        (1.06, 1.10, "BusGreen"),  # continuous horizontal dark-green beltline pinstripe across rear face!
        (1.10, rw_y0, "BusCream"),
    ]
    for y0, y1, mkey in rear_bands:
        mb.quad((xr, y0, zr), (-xr, y0, zr), (-xr, y1, zr), (xr, y1, zr), mats[mkey])
    # Pale sage-cream pillars flanking rear window up to Y = 2.18 (Y = 2.18..2.38 is already built by Part A!)
    mb.quad((-rw_x, rw_y0, zr), (-xr, rw_y0, zr), (-xr, 2.18, zr), (-rw_x, 2.18, zr), mats["BusCream"])
    mb.quad((xr, rw_y0, zr), (rw_x, rw_y0, zr), (rw_x, 2.18, zr), (xr, 2.18, zr), mats["BusCream"])
    # Inner rear wall below rear window (Y = 0.78 .. 1.66)
    mb.quad((-xr, 0.78, zr + spec.WALL_T), (xr, 0.78, zr + spec.WALL_T), (xr, rw_y0, zr + spec.WALL_T), (-xr, rw_y0, zr + spec.WALL_T), mats["BusInterior"])

    # Central square recessed engine inspection hatch lid (X = -0.42 .. +0.42, Y = 0.69 .. 1.04)
    # Matching step_20_shot_2.png!
    mb.box((-0.42, 0.69, zr - 0.005), (0.42, 0.705, zr + 0.002), mats["BusTrim"])
    mb.box((-0.42, 1.025, zr - 0.005), (0.42, 1.04, zr + 0.002), mats["BusTrim"])
    mb.box((-0.42, 0.69, zr - 0.005), (-0.405, 1.04, zr + 0.002), mats["BusTrim"])
    mb.box((0.405, 0.69, zr - 0.005), (0.42, 1.04, zr + 0.002), mats["BusTrim"])
    mb.box((-0.08, 0.995, zr - 0.008), (0.08, 1.025, zr + 0.002), mats["BusTrim"])

    mb.build("BodyShell", parent=body_empty)


# ---------------------------------------------------------------- 3. Wheel Arch Liners & Underbody
def _build_wheel_arches_and_underbody(body_empty, mats):
    mb = MeshBuilder()
    r = spec.ARCH_R
    yc = spec.TIRE_RADIUS
    steps = 16
    for side in (+1, -1):
        for key, zc in (("F", spec.WHEELBASE), ("R", 0.0)):
            x_out = side * (spec.HALF_W - 0.01)
            x_in = side * spec.WHEELWELL_INNER_X[key]
            for i in range(steps):
                a0 = -0.22 + (math.pi + 0.44) * i / steps
                a1 = -0.22 + (math.pi + 0.44) * (i + 1) / steps
                z0, y0 = zc + r * math.cos(a0), max(spec.SKIRT_Y, yc + r * math.sin(a0))
                z1, y1 = zc + r * math.cos(a1), max(spec.SKIRT_Y, yc + r * math.sin(a1))
                if side > 0:
                    mb.quad((x_out, y1, z1), (x_out, y0, z0), (x_in, y0, z0), (x_in, y1, z1), mats["BusRubber"], smooth=True)
                    mb.quad((x_in, spec.SKIRT_Y, z1), (x_in, y1, z1), (x_in, y0, z0), (x_in, spec.SKIRT_Y, z0), mats["BusRubber"])
                else:
                    mb.quad((x_out, y0, z0), (x_out, y1, z1), (x_in, y1, z1), (x_in, y0, z0), mats["BusRubber"], smooth=True)
                    mb.quad((x_in, spec.SKIRT_Y, z0), (x_in, y0, z0), (x_in, y1, z1), (x_in, spec.SKIRT_Y, z1), mats["BusRubber"])

    # Underbody chassis floor pan
    mb.box((-0.82, 0.26, -3.38), (0.82, 0.30, 6.88), mats["BusRubber"])
    mb.box((-1.20, 0.27, 5.38), (1.20, 0.30, 6.85), mats["BusRubber"])
    mb.box((-1.20, 0.27, 0.58), (1.20, 0.30, 4.22), mats["BusRubber"])
    mb.box((-1.20, 0.27, -3.38), (1.20, 0.30, -0.58), mats["BusRubber"])
    mb.build("WheelArches", parent=body_empty)


# ---------------------------------------------------------------- 4. Metallic Silver Front & Rear Bumpers
def _build_bumpers(body_empty, mats):
    mb = MeshBuilder()
    silver = mats["BusBumperSilver"]

    # --- Front Metallic Silver Bumper (Z = +6.88 .. +7.01, Y = 0.28 .. 0.64, X = -1.245 .. +1.245) ---
    # Upper face trimmed to X = -1.175..+1.175 at Y=0.415..0.595 so extreme-corner amber turn signals sit at outermost edges!
    mb.box((-1.10, 0.28, 6.89), (1.10, 0.415, spec.Z_FRONT_BUMPER - 0.004), silver)
    mb.box((-1.175, 0.415, 6.89), (1.175, 0.595, spec.Z_FRONT_BUMPER - 0.002), silver)
    mb.box((-1.10, 0.595, 6.89), (1.10, 0.64, spec.Z_FRONT_BUMPER - 0.002), silver)
    mb.box((-1.15, 0.635, 6.89), (1.15, 0.645, spec.Z_FRONT_BUMPER - 0.005), mats["BusTrim"])

    for sx in (-1, +1):
        # Lower skirt bumper wrap & side returns below/behind the corner turn signals
        x0, x1 = sorted((sx * 1.08, sx * (spec.HALF_W + 0.003)))
        mb.box((x0, 0.28, 6.82), (x1, 0.415, spec.Z_FRONT_BUMPER - 0.018), silver)
        mb.box((x0, 0.595, 6.82), (x1, 0.64, spec.Z_FRONT_BUMPER - 0.018), silver)
        x2, x3 = sorted((sx * 1.15, sx * (spec.HALF_W + 0.004)))
        z_end = 6.58 if sx > 0 else 6.65
        mb.box((x2, 0.28, z_end), (x3, 0.64, 6.915), silver)
        x_s0, x_s1 = sorted((sx * (spec.HALF_W - 0.005), sx * (spec.HALF_W + 0.006)))
        mb.box((x_s0, 0.34, z_end + 0.04), (x_s1, 0.41, 6.78), mats["BusTrim"])

    # Lower bumper step/intake recesses flanking the central license plate (|X| = 0.35 .. 0.56)
    mb.box((0.35, 0.31, 6.96), (0.56, 0.40, spec.Z_FRONT_BUMPER - 0.001), mats["BusTrim"])
    mb.box((-0.56, 0.31, 6.96), (-0.35, 0.40, spec.Z_FRONT_BUMPER - 0.001), mats["BusTrim"])

    # Central green commercial license plate (京都 200 か 17-71)
    mb.box((-0.23, 0.35, spec.Z_FRONT_BUMPER - 0.010), (0.23, 0.57, spec.Z_FRONT_BUMPER - 0.001), mats["BusTrim"])
    mb.rect((0.0, 0.46, spec.Z_FRONT_BUMPER), (1, 0, 0), (0, 1, 0), 0.44, 0.21, mats["BusPlate"])

    # --- Rear Metallic Silver Bumper (Z = -3.48 .. -3.38, Y = 0.30 .. 0.44, X = -1.245 .. +1.245) ---
    mb.box((-1.10, 0.30, spec.Z_REAR_BUMPER + 0.002), (1.10, 0.44, -3.38), silver)
    for sx in (-1, +1):
        x0, x1 = sorted((sx * 1.06, sx * (spec.HALF_W + 0.003)))
        mb.box((x0, 0.30, spec.Z_REAR_BUMPER + 0.015), (x1, 0.44, -3.32), silver)
        x2, x3 = sorted((sx * 1.16, sx * (spec.HALF_W + 0.004)))
        mb.box((x2, 0.30, -3.34), (x3, 0.44, -3.18), silver)
        rx0, rx1 = sorted((sx * 0.68, sx * 0.80))
        mb.box((rx0, 0.33, spec.Z_REAR_BUMPER - 0.001), (rx1, 0.40, spec.Z_REAR_BUMPER + 0.010), mats["BusTrim"])
        rf0, rf1 = sorted((sx * 0.90, sx * 0.98))
        mb.box((rf0, 0.33, spec.Z_REAR_BUMPER - 0.001), (rf1, 0.40, spec.Z_REAR_BUMPER + 0.010), mats["BusReflectorRed"])

    # Rear green commercial license plate offset to the left (+X = +0.60, Y = 0.46 .. 0.66)
    px_c = 0.60
    mb.box((px_c - 0.22, 0.455, spec.Z_REAR - 0.012), (px_c + 0.22, 0.665, spec.Z_REAR + 0.002), mats["BusTrim"])
    mb.box((px_c - 0.09, 0.665, spec.Z_REAR - 0.022), (px_c + 0.09, 0.695, spec.Z_REAR + 0.002), mats["BusTrim"])
    mb.rect((px_c, 0.56, spec.Z_REAR - 0.014), (-1, 0, 0), (0, 1, 0), 0.42, 0.195, mats["BusPlate"])

    mb.build("Bumpers", parent=body_empty)


# ---------------------------------------------------------------- 5. Windshield, Destination Glass, Safety Window, Side & Rear Glass + Wipers
def _build_windows_and_wipers(body_empty, mats):
    mb_glass = MeshBuilder()
    mb_frame = MeshBuilder()

    # --- A. 96MC B-I Wraparound Panoramic Raked Windshield (Y = 1.15 .. 2.14) ---
    # Wraps seamlessly around BOTH front corners back to Z_wrap_l=6.64 (+X, matching Safety Window rear!)
    # and Z_wrap_r=6.69 (-X, leaving a slim 4 cm A-pillar ahead of driver window).
    plan_ws = spec.PlanOutline(0.004)
    s_wrap_r = plan_ws.s_side_z(spec.WINDSHIELD["z_wrap_r"], -1)
    s_wrap_l = plan_ws.s_side_z(spec.WINDSHIELD["z_wrap_l"], +1)
    y_bot, y_top = spec.WINDSHIELD["y"]  # 1.15, 2.14
    z_bot = spec.front_z(y_bot) + 0.003
    z_top = spec.front_z(y_top) + 0.003

    # Build monotonic list of perimeter samples from right wrap edge (-X) -> front (+Z) -> left wrap edge (+X)
    ws_samples = []
    # Right side + front-right arc + right front half (s from s_wrap_r -> plan_ws.length)
    n_wr = 12
    for k in range(n_wr):
        s = s_wrap_r + (plan_ws.length - s_wrap_r) * k / n_wr
        ws_samples.append(plan_ws.point(s))
    # Front center + left front half + front-left arc + left side (s from 0 -> s_wrap_l)
    n_wl = 13
    for k in range(n_wl + 1):
        s = s_wrap_l * k / n_wl
        ws_samples.append(plan_ws.point(s))

    def _ws_pt(x, y, z, out=0.0):
        px, py, pz = spec.deform((x, y, z))
        return (px, py, pz + out)

    for i in range(len(ws_samples) - 1):
        xa, za, _, _ = ws_samples[i]
        xb, zb, _, _ = ws_samples[i + 1]
        p0 = _ws_pt(xa, y_bot, za)
        p1 = _ws_pt(xb, y_bot, zb)
        p2 = _ws_pt(xb, y_top, zb)
        p3 = _ws_pt(xa, y_top, za)
        mb_glass.quad(p0, p1, p2, p3, mats["BusGlass"], smooth=True)
        # Narrow black rubber weatherstrip (~2.2 cm) along top & bottom edges
        mb_frame.beam(p0, p1, 0.022, 0.022, mats["BusTrim"])
        mb_frame.beam(p3, p2, 0.022, 0.022, mats["BusTrim"])

    # Vertical weatherstrip edges at left & right A-pillar junctions + thin 2.0 cm center divider
    xr_w, zr_w, _, _ = ws_samples[0]
    xl_w, zl_w, _, _ = ws_samples[-1]
    mb_frame.beam(_ws_pt(xr_w, y_bot, zr_w), _ws_pt(xr_w, y_top, zr_w), 0.024, 0.022, mats["BusTrim"], up=(0, 0, 1))
    mb_frame.beam(_ws_pt(xl_w, y_bot, zl_w), _ws_pt(xl_w, y_top, zl_w), 0.024, 0.022, mats["BusTrim"], up=(0, 0, 1))
    mb_frame.beam((0.0, y_bot, z_bot + 0.004), (0.0, y_top, z_top + 0.004), 0.020, 0.014, mats["BusTrim"], up=(0, 0, 1))

    # Recessed dark glass cover over the front destination display window (X = -1.08..+1.08, Y = 2.215..2.555)
    z_dg_bot = spec.front_z(2.215) - 0.012
    z_dg_top = spec.front_z(2.555) - spec.cant_inset(2.555) - 0.012
    mb_glass.quad(
        (-1.075, 2.215, z_dg_bot),
        (1.075, 2.215, z_dg_bot),
        (1.075, 2.555, z_dg_top),
        (-1.075, 2.555, z_dg_top),
        mats["BusGlass"],
    )

    # Twin bottom-mounted black pantograph wipers angled `/ \` upward toward the center (`media_1795480605239_ac27a741.jpg`)
    for sx in (-1, +1):
        piv_x = sx * 0.54
        inward = -sx
        piv = (piv_x, 1.14, z_bot + 0.014)
        arm_tip = (piv_x + inward * 0.40, 1.50, spec.front_z(1.50) + 0.018)
        mb_frame.cylinder((piv_x, 1.14, z_bot - 0.01), (piv_x, 1.14, z_bot + 0.025), 0.016, 10, mats["BusTrim"])
        mb_frame.beam(piv, arm_tip, 0.014, 0.011, mats["BusTrim"], up=(0, 0, 1))
        mb_frame.beam(
            (piv_x + inward * 0.04, 1.13, z_bot + 0.014),
            (piv_x + inward * 0.42, 1.47, spec.front_z(1.47) + 0.018),
            0.010, 0.009, mats["BusTrim"], up=(0, 0, 1),
        )
        b0 = (piv_x + inward * 0.25, 1.28, spec.front_z(1.28) + 0.021)
        b1 = (piv_x + inward * 0.48, 1.74, spec.front_z(1.74) + 0.021)
        mb_frame.beam(b0, b1, 0.017, 0.013, mats["BusTrim"], up=(0, 0, 1))

    # --- B. Curb-Side Front Safety Window (セーフティウインドウ, X = +0.56..+1.24, Z = 6.64..6.95, Y = 0.68..1.10) ---
    # Wraps cleanly around front-left corner all the way back to Z = 6.64 (aligned with windshield rear edge!)
    plan = spec.PlanOutline(0.003)
    s_sw_start = plan.s_front_x(0.56)
    s_sw_end = plan.s_side_z(spec.SAFETY_WINDOW["z"][0], +1)
    n_sw = 12
    sw_pts = [plan.point(s_sw_start + (s_sw_end - s_sw_start) * k / n_sw)[:2] for k in range(n_sw + 1)]
    for i in range(len(sw_pts) - 1):
        xa, za = sw_pts[i]
        xb, zb = sw_pts[i + 1]
        mb_glass.quad((xa, 0.695, za), (xb, 0.695, zb), (xb, 1.085, zb), (xa, 1.085, za), mats["BusGlass"], smooth=True)
        mb_frame.beam((xa, 0.682, za), (xb, 0.682, zb), 0.034, 0.034, mats["BusTrim"])
        mb_frame.beam((xa, 1.098, za), (xb, 1.098, zb), 0.034, 0.034, mats["BusTrim"])
    mb_frame.beam((sw_pts[0][0], 0.68, sw_pts[0][1]), (sw_pts[0][0], 1.10, sw_pts[0][1]), 0.036, 0.036, mats["BusTrim"])
    mb_frame.beam((sw_pts[-1][0], 0.68, sw_pts[-1][1]), (sw_pts[-1][0], 1.10, sw_pts[-1][1]), 0.036, 0.036, mats["BusTrim"])

    yellow_rail_pts = [
        (0.58, 0.79, spec.Z_FRONT - 0.045),
        (0.72, 0.75, spec.Z_FRONT - 0.048),
        (0.92, 0.74, spec.Z_FRONT - 0.055),
        (1.08, 0.77, 6.80),
        (1.13, 0.82, 6.68),
    ]
    mb_frame.tube(yellow_rail_pts, 0.015, 8, mats["BusYellowEdge"])

    # --- C. Left & Right Side Windows (Y = 1.15 .. 2.18) ---
    for side, win_list in ((+1, spec.WINDOWS_LEFT), (-1, spec.WINDOWS_RIGHT)):
        x_g = side * (spec.HALF_W - 0.004)
        x_f = side * (spec.HALF_W - 0.002)
        for z0, z1, y0, y1, kind in win_list:
            if kind == "exit":
                continue
            t = 0.022
            mb_frame.box((min(x_g, x_f) - 0.01, y0, z0), (max(x_g, x_f) + 0.002, y0 + t, z1), mats["BusTrim"])
            mb_frame.box((min(x_g, x_f) - 0.01, y1 - t, z0), (max(x_g, x_f) + 0.002, y1, z1), mats["BusTrim"])
            mb_frame.box((min(x_g, x_f) - 0.01, y0, z0), (max(x_g, x_f) + 0.002, y1, z0 + t), mats["BusTrim"])
            mb_frame.box((min(x_g, x_f) - 0.01, y0, z1 - t), (max(x_g, x_f) + 0.002, y1, z1), mats["BusTrim"])

            if kind == "revT":
                yt0, yt1 = spec.WIN_TRANSOM_Y  # (1.88, 1.91)
                mb_frame.box((min(x_g, x_f) - 0.012, yt0, z0), (max(x_g, x_f) + 0.003, yt1, z1), mats["BusTrim"])
                zm = 0.5 * (z0 + z1)
                mb_frame.box((min(x_g, x_f) - 0.01, yt1, zm - 0.014), (max(x_g, x_f) + 0.002, y1, zm + 0.014), mats["BusTrim"])
            elif kind == "driver":
                zm = 0.5 * (z0 + z1)
                mb_frame.box((min(x_g, x_f) - 0.01, y0, zm - 0.014), (max(x_g, x_f) + 0.002, y1, zm + 0.014), mats["BusTrim"])
            elif kind == "sign_bay":
                # Horizontal black transom bar separating upper blank SignSideL pane (Y=1.58..2.16) from lower glass
                mb_frame.box((min(x_g, x_f) - 0.012, 1.55, z0), (max(x_g, x_f) + 0.003, 1.58, z1), mats["BusTrim"])

            gmat = mats["BusGlassDark"] if kind in ("fixed_dark", "fixed") and z0 < 4.5 else mats["BusGlass"]
            if side > 0:
                mb_glass.quad((x_g, y0 + t, z1 - t), (x_g, y0 + t, z0 + t), (x_g, y1 - t, z0 + t), (x_g, y1 - t, z1 - t), gmat)
            else:
                mb_glass.quad((x_g, y0 + t, z0 + t), (x_g, y0 + t, z1 - t), (x_g, y1 - t, z1 - t), (x_g, y1 - t, z0 + t), gmat)

    # --- D. Rear Window (X = -1.00 .. +1.00, Y = 1.66 .. 2.38, Z = -3.42) ---
    # Top of rear window sits only ~0.22m below roof edge (2.60) and ~0.27m below roof crown (2.65),
    # matching real photo #1785 (`step_20_shot_2.png`)!
    rx = spec.REAR_WINDOW["x"]
    ry0, ry1 = spec.REAR_WINDOW["y"]
    zr = spec.Z_REAR - 0.003
    mb_glass.quad((rx, ry0, zr), (-rx, ry0, zr), (-rx, ry1, zr), (rx, ry1, zr), mats["BusGlass"])
    mb_frame.box((-rx - 0.022, ry0 - 0.022, zr - 0.005), (rx + 0.022, ry0 + 0.01, zr + 0.02), mats["BusTrim"])
    mb_frame.box((-rx - 0.022, ry1 - 0.01, zr - 0.005), (rx + 0.022, ry1 + 0.022, zr + 0.02), mats["BusTrim"])
    mb_frame.box((-rx - 0.022, ry0, zr - 0.005), (-rx + 0.01, ry1, zr + 0.02), mats["BusTrim"])
    mb_frame.box((rx - 0.01, ry0, zr - 0.005), (rx + 0.022, ry1, zr + 0.02), mats["BusTrim"])
    # Inner rear shelf visible at bottom of rear glass (`step_20_shot_2.png`)
    mb_frame.box((-rx + 0.02, ry0 + 0.01, zr + 0.005), (rx - 0.02, ry0 + 0.12, zr + 0.03), mats["BusCream"])

    mb_glass.build("ExteriorGlass", parent=body_empty)
    mb_frame.build("WindowFrames", parent=body_empty)


# ---------------------------------------------------------------- 6. Doors & Front Door Courtesy Lamp
def _build_doors(body_empty, mats):
    mb_f = MeshBuilder()
    mb_g = MeshBuilder()

    # --- A. Front 2-Leaf Door (前扉, +X, Z = 5.58 .. 6.56, Y = 0.32 .. 2.16) ---
    # Unpainted black aluminum/rubber door leaves with full-height tall glass panes (NO livery paint!)
    fz0, fz1 = spec.FRONT_DOOR_Z
    fzm = 0.5 * (fz0 + fz1)
    x_d = spec.HALF_W - 0.006
    for leaf_z0, leaf_z1 in ((fz0 + 0.015, fzm - 0.015), (fzm + 0.015, fz1 - 0.015)):
        mb_f.box((x_d - 0.022, 0.34, leaf_z0), (x_d + 0.004, 0.48, leaf_z1), mats["BusTrim"])
        mb_f.box((x_d - 0.022, 0.90, leaf_z0), (x_d + 0.004, 0.94, leaf_z1), mats["BusTrim"])
        mb_f.box((x_d - 0.022, 2.09, leaf_z0), (x_d + 0.004, 2.15, leaf_z1), mats["BusTrim"])
        mb_f.box((x_d - 0.022, 0.34, leaf_z0), (x_d + 0.004, 2.15, leaf_z0 + 0.042), mats["BusTrim"])
        mb_f.box((x_d - 0.022, 0.34, leaf_z1 - 0.042), (x_d + 0.004, 2.15, leaf_z1), mats["BusTrim"])
        mb_g.quad((x_d, 0.48, leaf_z1 - 0.042), (x_d, 0.48, leaf_z0 + 0.042), (x_d, 0.90, leaf_z0 + 0.042), (x_d, 0.90, leaf_z1 - 0.042), mats["BusGlass"])
        mb_g.quad((x_d, 0.94, leaf_z1 - 0.042), (x_d, 0.94, leaf_z0 + 0.042), (x_d, 2.09, leaf_z0 + 0.042), (x_d, 2.09, leaf_z1 - 0.042), mats["BusGlass"])
    mb_f.box((x_d - 0.024, 0.32, fzm - 0.016), (x_d + 0.005, 2.16, fzm + 0.016), mats["BusRubber"])
    mb_f.box((x_d - 0.024, 0.32, fz0), (x_d + 0.005, 0.34, fz1), mats["BusRubber"])

    # Slim horizontal white/chrome door-top courtesy lamp above front door (Y = 2.30..2.35, Z = 5.75..6.35)
    # Seen in media_1795459256215_6051fd0f.jpg and step_35_shot_2.png!
    mb_f.box((spec.HALF_W - 0.002, 2.305, 5.75), (spec.HALF_W + 0.022, 2.350, 6.35), mats["BusMirrorWhite"])
    mb_f.box((spec.HALF_W + 0.002, 2.298, 5.78), (spec.HALF_W + 0.018, 2.308, 6.32), mats["BusLightWhite"])

    # --- B. Middle Wide Single-Leaf Sliding Door (中扉, +X, Z = 2.05 .. 3.25, Y = 0.32 .. 2.16) ---
    mz0, mz1 = spec.MID_DOOR_Z
    for y0, y1, mkey in (
        (0.33, 0.420, "BusCream"),
        (0.420, 0.460, "BusGreen"),
        (0.460, 0.500, "BusCream"),
        (0.500, 0.660, "BusGreen"),
        (0.660, 1.060, "BusCream"),
        (1.060, 1.100, "BusGreen"),
        (1.100, 1.160, "BusCream"),
    ):
        mb_f.box((x_d - 0.025, y0, mz0 + 0.015), (x_d + 0.002, y1, mz1 - 0.015), mats[mkey])
    mb_f.box((x_d - 0.025, 1.16, mz0 + 0.015), (x_d + 0.002, 2.14, mz0 + 0.075), mats["BusCream"])
    mb_f.box((x_d - 0.025, 1.16, mz1 - 0.075), (x_d + 0.002, 2.14, mz1 - 0.015), mats["BusCream"])
    mb_f.box((x_d - 0.025, 2.07, mz0 + 0.015), (x_d + 0.002, 2.14, mz1 - 0.015), mats["BusCream"])
    gw_z0, gw_z1 = mz0 + 0.075, mz1 - 0.075
    gw_y0, gw_y1 = 1.16, 2.07
    mb_f.box((x_d - 0.026, gw_y0, gw_z0), (x_d + 0.004, gw_y0 + 0.032, gw_z1), mats["BusTrim"])
    mb_f.box((x_d - 0.026, gw_y1 - 0.032, gw_z0), (x_d + 0.004, gw_y1, gw_z1), mats["BusTrim"])
    mb_f.box((x_d - 0.026, gw_y0, gw_z0), (x_d + 0.004, gw_y1, gw_z0 + 0.032), mats["BusTrim"])
    mb_f.box((x_d - 0.026, gw_y0, gw_z1 - 0.032), (x_d + 0.004, gw_y1, gw_z1), mats["BusTrim"])
    mb_g.quad((x_d, gw_y0 + 0.032, gw_z1 - 0.032), (x_d, gw_y0 + 0.032, gw_z0 + 0.032), (x_d, gw_y1 - 0.032, gw_z0 + 0.032), (x_d, gw_y1 - 0.032, gw_z1 - 0.032), mats["BusGlass"])
    mb_f.box((x_d - 0.026, 0.32, mz0), (x_d + 0.003, 2.15, mz0 + 0.015), mats["BusTrim"])
    mb_f.box((x_d - 0.026, 0.32, mz1 - 0.015), (x_d + 0.003, 2.15, mz1), mats["BusTrim"])
    mb_f.box((x_d - 0.026, 2.14, mz0), (x_d + 0.003, 2.16, mz1), mats["BusTrim"])

    # --- C. Right-Side Rear Emergency Exit Door (非常口, -X, Z = -2.50 .. -1.82, Y = 1.00 .. 2.18) ---
    ez0, ez1 = spec.EMERGENCY_EXIT_Z
    xe = -spec.HALF_W
    for y0, y1, mkey in (
        (1.00, 1.06, "BusCream"),
        (1.06, 1.10, "BusGreen"),
        (1.10, 1.32, "BusCream"),
        (2.08, 2.17, "BusCream"),
    ):
        mb_f.box((xe - 0.001, y0, ez0 + 0.012), (xe + 0.035, y1, ez1 - 0.012), mats[mkey])
    mb_f.box((xe - 0.001, 1.32, ez0 + 0.012), (xe + 0.035, 2.08, ez0 + 0.07), mats["BusCream"])
    mb_f.box((xe - 0.001, 1.32, ez1 - 0.07), (xe + 0.035, 2.08, ez1 - 0.012), mats["BusCream"])
    mb_f.box((xe - 0.003, 1.00, ez0), (xe + 0.035, 2.18, ez0 + 0.012), mats["BusTrim"])
    mb_f.box((xe - 0.003, 1.00, ez1 - 0.012), (xe + 0.035, 2.18, ez1), mats["BusTrim"])
    mb_f.box((xe - 0.003, 0.99, ez0), (xe + 0.035, 1.005, ez1), mats["BusTrim"])
    mb_f.box((xe - 0.003, 2.17, ez0), (xe + 0.035, 2.185, ez1), mats["BusTrim"])
    ew_z0, ew_z1 = ez0 + 0.07, ez1 - 0.07
    ew_y0, ew_y1 = 1.32, 2.08
    mb_f.box((xe - 0.004, ew_y0, ew_z0), (xe + 0.015, ew_y0 + 0.03, ew_z1), mats["BusTrim"])
    mb_f.box((xe - 0.004, ew_y1 - 0.03, ew_z0), (xe + 0.015, ew_y1, ew_z1), mats["BusTrim"])
    mb_f.box((xe - 0.004, ew_y0, ew_z0), (xe + 0.015, ew_y1, ew_z0 + 0.03), mats["BusTrim"])
    mb_f.box((xe - 0.004, ew_y0, ew_z1 - 0.03), (xe + 0.015, ew_y1, ew_z1), mats["BusTrim"])
    mb_g.quad((xe + 0.005, ew_y0 + 0.03, ew_z0 + 0.03), (xe + 0.005, ew_y0 + 0.03, ew_z1 - 0.03), (xe + 0.005, ew_y1 - 0.03, ew_z1 - 0.03), (xe + 0.005, ew_y1 - 0.03, ew_z0 + 0.03), mats["BusGlass"])
    mb_f.cylinder((xe - 0.008, 1.21, -2.02), (xe + 0.005, 1.21, -2.02), 0.050, 16, mats["BusTrim"])
    mb_f.disc((xe - 0.009, 1.21, -2.02), (-1, 0, 0), 0.036, 16, mats["BusReflectorRed"])

    mb_f.build("Doors", parent=body_empty)
    mb_g.build("DoorGlass", parent=body_empty)


# ---------------------------------------------------------------- 7. Exterior Lamps (In-Bumper Headlamps/Fog/Blinkers, Rectangular 3-Lens Tail Units)
def _build_exterior_lamps(body_empty, mats):
    mb = MeshBuilder()
    zb_f = spec.Z_FRONT_BUMPER  # +7.01
    zr = spec.Z_REAR  # -3.42

    for sx in (-1, +1):
        turn_mat = mats["BusTurnL"] if sx > 0 else mats["BusTurnR"]

        # 1. ALL FRONT LAMPS EMBEDDED INSIDE THE METALLIC SILVER FRONT BUMPER (Y = 0.28 .. 0.64)
        # Quad rectangular headlamps shifted slightly outward (|X| = 0.64 .. 1.13, matching media_1795480605239_ac27a741.jpg)
        hx0, hx1 = sorted((sx * 0.64, sx * 1.13))
        mb.box((hx0, 0.45, zb_f - 0.025), (hx1, 0.59, zb_f + 0.001), mats["BusTrim"])
        for la, lb in ((0.68, 0.86), (0.91, 1.09)):
            lx0, lx1 = sorted((sx * la, sx * lb))
            mb.box((lx0 - 0.006, 0.468, zb_f - 0.010), (lx1 + 0.006, 0.574, zb_f + 0.004), mats["BusChrome"])
            mb.box((lx0, 0.474, zb_f - 0.005), (lx1, 0.568, zb_f + 0.008), mats["BusLightWhite"])

        # Extreme outer silver bumper wraparound corners: vertical amber turn signals (|X| = 1.175 .. 1.258, Z = 6.915 .. 7.002)
        # Matches media_1795480605239_ac27a741.jpg: turn signals sit right at the outermost edges of the bumper!
        tx0, tx1 = sorted((sx * 1.175, sx * 1.258))
        mb.box((tx0 - (0.008 if sx > 0 else 0.0), 0.415, zb_f - 0.095), (tx1 + (0.008 if sx < 0 else 0.0), 0.595, zb_f - 0.008), mats["BusTrim"])
        mb.box((tx0, 0.422, zb_f - 0.088), (tx1, 0.588, zb_f - 0.005), turn_mat)

        # Lower silver bumper below headlamps: recessed slot holding rectangular fog lamp
        mb.box((hx0, 0.31, zb_f - 0.025), (hx1, 0.41, zb_f - 0.001), mats["BusTrim"])
        fx0, fx1 = sorted((sx * 0.91, sx * 1.09))
        mb.box((fx0 - 0.005, 0.322, zb_f - 0.010), (fx1 + 0.005, 0.398, zb_f + 0.003), mats["BusChrome"])
        mb.box((fx0, 0.328, zb_f - 0.006), (fx1, 0.392, zb_f + 0.006), mats["BusFogYellow"])

        # 2. Side turn signal repeaters & markers
        xs = sx * spec.HALF_W
        mb.box((xs - 0.006, 0.50, 3.60), (xs + 0.006, 0.56, 3.70), turn_mat)
        mb.box((xs - 0.006, 0.78, 0.72), (xs + 0.006, 0.83, 0.80), mats["BusRed"])

        # 3. Rear lower corners: RECTANGULAR VERTICAL 3-LENS TAIL LAMP UNITS (Y = 0.70 .. 1.04)
        rx0, rx1 = sorted((sx * 0.82, sx * 0.99))
        mb.box((rx0 - 0.01, 0.69, zr - 0.012), (rx1 + 0.01, 1.04, zr + 0.003), mats["BusTrim"])
        mb.box((rx0, 0.93, zr - 0.016), (rx1, 1.025, zr - 0.004), turn_mat)
        mb.box((rx0, 0.82, zr - 0.016), (rx1, 0.915, zr - 0.004), mats["BusBrakeLamp"])
        mb.box((rx0, 0.762, zr - 0.016), (rx1, 0.805, zr - 0.004), mats["BusBrakeLamp"])
        mb.box((rx0, 0.710, zr - 0.017), (rx1, 0.758, zr - 0.004), mats["BusReverseLamp"])

    # Inboard vertical '乗降中' lamp beside left rear tail lamp (step_20_shot_2.png)
    mb.box((0.64, 0.69, zr - 0.012), (0.75, 1.04, zr + 0.003), mats["BusTrim"])
    mb.rect((0.695, 0.865, zr - 0.015), (-1, 0, 0), (0, 1, 0), 0.092, 0.32, mats["BusRearBoardingLamp"])

    mb.build("ExteriorLamps", parent=body_empty)


# ---------------------------------------------------------------- 8. Sculpted Pale-Sage Thermo King HVAC Pod (Recessed Vents, ZERO Floating Parts!)
def _build_roof_equipment(body_empty, mats):
    mb = MeshBuilder()

    # --- A. Authentic Two-Section Stepped Pale Sage-Cream Thermo King Roof HVAC Shroud ---
    # Matches real Kyoto City Bus #1771 (`step_60_shot_1.png`), #1777 (`step_60_shot_2.png`),
    # #1778 (`step_54_shot_1.png`), and `media_1795459256215_6051fd0f.jpg`:
    # - Smooth pale sage-cream (`BusCream`) side walls with ZERO black side boxes!
    # - NO giant exposed Denso circular fan holes!
    # - Stepped-down front intake section (`Z = 4.20 .. 5.00`, `Y_top = 2.79 m`) with TWO wide
    #   recessed horizontal louvered intake grilles across the sloped front face.
    # - Smooth pillow-rounded rear/main dome (`Z = 1.95 .. 4.20`, `Y_top = 2.86 m`) with subtle
    #   molded panel seam and two slim flush-recessed top louvered vents on the upper deck.
    hx = spec.HVAC["x"]  # 0.90
    hz0, hz1 = spec.HVAC["z"]  # 1.95, 5.00
    z_mid = 0.5 * (hz0 + hz1)  # 3.475
    z_half = 0.5 * (hz1 - hz0)  # 1.525
    y_main = spec.HVAC["y_top"]  # 2.860
    y_front = spec.HVAC["y_front_top"]  # 2.790

    su_grid = [
        -1.00, -0.92, -0.84, -0.74, -0.62, -0.46, -0.28, -0.10, -0.04,
        0.00,
        0.04, 0.10, 0.28, 0.46, 0.62, 0.74, 0.84, 0.92, 1.00,
    ]
    sv_grid = [
        -1.00, -0.92, -0.80, -0.66, -0.48, -0.28, -0.10,
        0.10, 0.26, 0.40, 0.48, 0.56, 0.68, 0.78, 0.89, 0.96, 1.00,
    ]

    def _tk_outer_pos(su, sv):
        corner = 1.0 - 0.08 * (su ** 4) * (sv ** 4)
        x = hx * su * corner
        z = z_mid + z_half * sv * corner
        y_base = spec.roof_y(x) - 0.015

        au = abs(su)
        if au <= 0.74:
            pu = 1.0 - 0.025 * (au / 0.74) ** 2
        else:
            tu = min(1.0, (au - 0.74) / 0.26)
            pu = 0.975 * max(0.0, 1.0 - tu ** 1.85) ** 0.78

        # Two-tier stepped height profile along sv:
        # Rear/main dome (`sv <= 0.40`) at `y_main = 2.86`, stepping smoothly down between `sv = 0.40..0.56`
        # to front intake cowl (`sv >= 0.56`) at `y_front = 2.79`!
        t_step = spec.smoothstep(0.40, 0.56, sv)
        y_tier = y_main * (1.0 - t_step) + y_front * t_step

        if -0.68 <= sv <= 0.70:
            pv = 1.0
        elif sv > 0.70:
            tv = min(1.0, (sv - 0.70) / 0.30)
            pv = max(0.0, 1.0 - tv ** 1.80) ** 0.78
        else:
            tv = min(1.0, (-0.68 - sv) / 0.32)
            pv = max(0.0, 1.0 - tv ** 1.80) ** 0.78

        y = y_base + (y_tier - y_base) * pu * pv
        return (x, y, z)

    def _is_front_grille_cell(su_m, sv_m):
        return (0.78 < sv_m < 0.89) and (0.04 < abs(su_m) < 0.74)

    def _is_top_vent_slot(su_m, sv_m):
        return (-0.28 < sv_m < 0.10) and (0.10 < abs(su_m) < 0.62)

    def _add_recessed_quad(p0, p1, p2, p3, dx, dy, dz, wall_mat, floor_mat):
        q0 = (p0[0] + dx, p0[1] + dy, p0[2] + dz)
        q1 = (p1[0] + dx, p1[1] + dy, p1[2] + dz)
        q2 = (p2[0] + dx, p2[1] + dy, p2[2] + dz)
        q3 = (p3[0] + dx, p3[1] + dy, p3[2] + dz)
        mb.quad(p0, p1, q1, q0, wall_mat, smooth=False)
        mb.quad(p1, p2, q2, q1, wall_mat, smooth=False)
        mb.quad(p2, p3, q3, q2, wall_mat, smooth=False)
        mb.quad(p3, p0, q0, q3, wall_mat, smooth=False)
        mb.quad(q0, q1, q2, q3, floor_mat, smooth=False)

    nu = len(su_grid) - 1
    nv = len(sv_grid) - 1
    for iv in range(nv):
        sv0, sv1 = sv_grid[iv], sv_grid[iv + 1]
        sv_m = 0.5 * (sv0 + sv1)
        for iu in range(nu):
            su0, su1 = su_grid[iu], su_grid[iu + 1]
            su_m = 0.5 * (su0 + su1)

            p00 = _tk_outer_pos(su0, sv0)
            p10 = _tk_outer_pos(su1, sv0)
            p11 = _tk_outer_pos(su1, sv1)
            p01 = _tk_outer_pos(su0, sv1)

            if _is_front_grille_cell(su_m, sv_m):
                # Depress INWARD (-Y, -Z) into the front sloped condenser nose
                _add_recessed_quad(
                    p00, p01, p11, p10,
                    dx=0.0, dy=-0.015, dz=-0.018,
                    wall_mat=mats["BusTrim"],
                    floor_mat=mats["BusHvacGrille"],
                )
            elif _is_top_vent_slot(su_m, sv_m):
                # Slim flush-recessed top condenser louver slot (strictly depressed -0.010 m into deck)
                _add_recessed_quad(
                    p00, p01, p11, p10,
                    dx=0.0, dy=-0.010, dz=0.0,
                    wall_mat=mats["BusTrim"],
                    floor_mat=mats["BusHvacGrille"],
                )
            else:
                mb.quad(p00, p01, p11, p10, mats["BusCream"], smooth=True)

    # --- B. Front & Rear Circular Domed Mushroom Roof Ventilators (ベンチレーター) ---
    # Painted pale sage-cream (#C8D5BB), rising ~5.5 cm above the 2.65 m roof crown (`step_60_shot_2.png`, `step_54_shot_1.png`)
    for vent in (spec.ROOF_VENT_F, spec.ROOF_VENT_R):
        zc = vent["z_center"]
        rv = vent["r"]
        vh = vent["h"]
        yb = spec.ROOF_CROWN_Y - 0.008
        mb.cylinder((0.0, yb, zc), (0.0, yb + vh * 0.42, zc), rv * 0.72, 20, mats["BusTrim"])
        mb.cylinder((0.0, yb + vh * 0.35, zc), (0.0, yb + vh * 0.76, zc), rv, 24, mats["BusCream"], r1=rv * 0.90)
        mb.cylinder((0.0, yb + vh * 0.76, zc), (0.0, yb + vh, zc), rv * 0.90, 24, mats["BusCream"], r1=rv * 0.45)

    mb.build("RoofEquipment", parent=body_empty)


# ---------------------------------------------------------------- 9. Compact White Mirror Arms & Mirror Backs + Under-Mirror
def _build_mirrors(body_empty, mats):
    m_white = mats["BusMirrorWhite"]

    # --- Right (Driver, -X) compact upper bracket + white-backed vertical rectangular mirror (`media_1795480605239_ac27a741.jpg`) ---
    mbr = MeshBuilder()
    mbr.box((-1.24, 2.13, 6.72), (-1.18, 2.21, 6.80), m_white)
    arm_r = [
        (-1.21, 2.17, 6.76),
        (-1.34, 2.15, 6.92),
        (-1.36, 2.02, 6.96),
        (-1.36, 1.92, 6.96),
    ]
    mbr.tube(arm_r, 0.014, 10, m_white)
    mbr.box((-1.42, 1.72, 6.92), (-1.29, 2.02, 6.98), m_white, mats={"-z": mats["BusChrome"]})
    mbr.box((-1.415, 1.725, 6.917), (-1.295, 2.015, 6.922), mats["BusTrim"])
    mbr.build("MirrorR", parent=body_empty)

    # --- Left (Curb, +X) Outer-Corner Tubular Stay + Outboard Main Mirror + Corner Auxiliary Mirrors ---
    # Anchored strictly on the outer-left cheek (`X = +1.17..+1.245`) so it NEVER overlaps the wheelchair decal!
    # Matches `media_1795480605239_ac27a741.jpg`: white tubular loop sweeping outward/upward to main mirror + dual upper/under mirrors.
    mbl = MeshBuilder()
    mbl.box((1.17, 2.33, 6.72), (1.24, 2.48, 6.80), m_white)
    arm_l_upper = [
        (1.21, 2.44, 6.77),
        (1.42, 2.55, 6.98),
        (1.48, 2.44, 7.12),
        (1.48, 2.05, 7.14),
    ]
    arm_l_lower = [
        (1.21, 2.35, 6.77),
        (1.36, 2.35, 7.04),
        (1.48, 2.32, 7.13),
    ]
    mbl.tube(arm_l_upper, 0.015, 10, m_white)
    mbl.tube(arm_l_lower, 0.013, 10, m_white)
    # Outboard white-backed main curb-side vertical rectangular mirror (+X = 1.41..1.54, Y = 1.76..2.18)
    mbl.box((1.41, 1.76, 7.10), (1.54, 2.18, 7.16), m_white, mats={"-z": mats["BusChrome"]})
    mbl.box((1.415, 1.765, 7.097), (1.535, 2.175, 7.102), mats["BusTrim"])
    # Upper wide-angle mirror tucked along the upper-inner stay (`X = 1.25..1.42, Y = 2.25..2.39`)
    mbl.box((1.24, 2.25, 7.03), (1.41, 2.38, 7.08), m_white, mats={"-z": mats["BusChrome"]})
    # Round white-backed convex under-mirror (`X = 1.15, Y = 2.27, Z = 7.08`) clear of the wheelchair decal
    mbl.tube([(1.32, 2.34, 7.02), (1.16, 2.28, 7.08)], 0.012, 8, m_white)
    mbl.cylinder((1.15, 2.29, 7.10), (1.15, 2.25, 7.06), 0.088, 18, m_white)
    mbl.disc((1.15, 2.248, 7.058), (-0.2, -0.55, -0.80), 0.080, 18, mats["BusChrome"])
    mbl.build("MirrorL", parent=body_empty)


# ---------------------------------------------------------------- 10. Kyoto City Bus Markings, 3D Winged Emblem, Fleet Numbers & Decals
def _build_decals(body_empty, mats):
    mb = MeshBuilder()
    zf = spec.Z_FRONT
    zr = spec.Z_REAR
    xl = spec.HALF_W + 0.004
    xr = -spec.HALF_W - 0.004

    # 1. Front 3-Winged Silver Kyoto City Transportation Bureau Emblem (交通局章) in the central V-chevron notch
    cx, cy, cz = 0.0, 0.885, zf + 0.005
    silver = mats["BusChrome"]
    for sx in (-1, +1):
        p0 = (sx * 0.015, cy + 0.01, cz)
        p1 = (sx * 0.145, cy + 0.095, cz)
        p2 = (sx * 0.115, cy + 0.112, cz)
        p3 = (sx * 0.010, cy + 0.042, cz)
        if sx > 0:
            mb.quad(p0, p1, p2, p3, silver)
        else:
            mb.quad(p1, p0, p3, p2, silver)
        q0 = (sx * 0.018, cy - 0.012, cz)
        q1 = (sx * 0.125, cy + 0.055, cz)
        q2 = (sx * 0.100, cy + 0.072, cz)
        q3 = (sx * 0.015, cy + 0.012, cz)
        if sx > 0:
            mb.quad(q0, q1, q2, q3, silver)
        else:
            mb.quad(q1, q0, q3, q2, silver)
    mb.quad((0.0, cy - 0.120, cz), (0.040, cy - 0.005, cz), (0.0, cy + 0.025, cz), (-0.040, cy - 0.005, cz), silver)
    mb.quad((0.0, cy + 0.025, cz), (0.023, cy + 0.072, cz), (0.0, cy + 0.115, cz), (-0.023, cy + 0.072, cz), silver)
    mb.disc((0.0, cy + 0.005, cz + 0.001), (0, 0, 1), 0.040, 16, silver, r_in=0.023)

    # 2. Front-right lower green rectangular '標準仕様ノンステップバス' sticker (X = -0.58, Y = 0.745)
    mb.rect((-0.58, 0.745, zf + 0.005), (1, 0, 0), (0, 1, 0), 0.24, 0.135, mats["BusDecalNonStep"])

    # 3. Front header blue wheelchair square sticker on the right INSIDE the recessed black sign window (X = +0.74..+1.03, Y = 2.24..2.53)
    z_wc = spec.front_z(2.385) - 0.020
    mb.rect((0.885, 2.385, z_wc), (1, 0, 0), (0, 1, 0), 0.28, 0.28, mats["BusDecalWheelchair"])

    # 4. Left (Curb, +X) Side Decals:
    # - '[⊖出口 EXIT]' + '1771' ahead of front wheel arch (Z = 5.10 .. 5.56, Y = 0.98)
    mb.rect((xl, 0.98, 5.43), (0, 0, -1), (0, 1, 0), 0.22, 0.105, mats["BusDecalExit"])
    mb.rect((xl, 0.98, 5.16), (0, 0, -1), (0, 1, 0), 0.22, 0.105, mats["BusDecalFleet"])
    # - '[↑入口 ENTRANCE]' ahead of middle door (Z = 3.56, Y = 0.97) + circular speaker grille below it (Y = 0.75)
    mb.rect((xl, 0.97, 3.56), (0, 0, -1), (0, 1, 0), 0.24, 0.115, mats["BusDecalEntrance"])
    mb.disc((xl, 0.75, 3.56), (1, 0, 0), 0.052, 16, mats["BusTrim"])
    mb.disc((xl + 0.001, 0.75, 3.56), (1, 0, 0), 0.042, 16, mats["BusCream"])
    # - Priority / non-step / wheelchair stickers on L-F2 dark window bay ahead of middle door (Z = 3.45 .. 3.82)
    mb.rect((xl, 1.38, 3.74), (0, 0, -1), (0, 1, 0), 0.16, 0.22, mats["BusStopButton"])
    mb.rect((xl, 1.34, 3.54), (0, 0, -1), (0, 1, 0), 0.15, 0.16, mats["BusDecalNonStep"])
    mb.rect((xl, 1.50, 3.45), (0, 0, -1), (0, 1, 0), 0.08, 0.08, mats["BusDecalWheelchair"])
    mb.rect((xl, 1.30, 3.45), (0, 0, -1), (0, 1, 0), 0.08, 0.08, mats["BusDecalWheelchair"])
    # - '京 都 市 交 通 局' on the pale-sage lower skirt between front and rear wheels (Z = 2.85, Y = 0.35)
    mb.rect((xl, 0.35, 2.85), (0, 0, -1), (0, 1, 0), 0.78, 0.095, mats["BusDecalKyotoText"])
    # - White advertisement/notice plaque behind middle door (Z = 1.60, Y = 0.86)
    mb.rect((xl, 0.86, 1.60), (0, 0, -1), (0, 1, 0), 0.42, 0.26, mats["BusPureWhite"])

    # 5. Right (Driver, -X) Side Decals:
    # - '1771' in white-rimmed dark box below driver window rear corner (Z = 5.48, Y = 1.00, matching step_54_shot_1.png)
    mb.rect((xr, 1.00, 5.48), (0, 0, 1), (0, 1, 0), 0.25, 0.115, mats["BusDecalFleetDark"])
    # - '京 都 市 交 通 局' on the pale-sage lower skirt between front and rear wheels (Z = 2.35, Y = 0.35)
    mb.rect((xr, 0.35, 2.35), (0, 0, 1), (0, 1, 0), 0.78, 0.095, mats["BusDecalKyotoText"])

    # 6. Rear (-Z) Decals (matching step_20_shot_2.png):
    # - Blue wheelchair square decal on rear-left above beltline pinstripe (X = +0.86, Y = 1.34)
    mb.rect((0.86, 1.34, zr - 0.005), (-1, 0, 0), (0, 1, 0), 0.19, 0.19, mats["BusDecalWheelchair"])
    # - Vertical white notice plaque between central inspection lid and right tail lamp (X = -0.58, Y = 0.88)
    mb.rect((-0.58, 0.88, zr - 0.005), (-1, 0, 0), (0, 1, 0), 0.16, 0.34, mats["BusPureWhite"])
    # - Blue 'ノンステップバス' sticker inside bottom-left of rear window glass (X = +0.74, Y = 1.74)
    mb.rect((0.74, 1.74, zr - 0.005), (-1, 0, 0), (0, 1, 0), 0.28, 0.08, mats["BusDecalWheelchair"])

    mb.build("ExteriorDecals", parent=body_empty)


# ---------------------------------------------------------------- entrypoint
def build(body_empty, mats):
    """Build all exterior meshes for Kyoto City Bus PDG-AA273KAN under `body_empty`."""
    _build_signs(body_empty, mats)
    _build_body_shell(body_empty, mats)
    _build_wheel_arches_and_underbody(body_empty, mats)
    _build_bumpers(body_empty, mats)
    _build_windows_and_wipers(body_empty, mats)
    _build_doors(body_empty, mats)
    _build_exterior_lamps(body_empty, mats)
    _build_roof_equipment(body_empty, mats)
    _build_mirrors(body_empty, mats)
    _build_decals(body_empty, mats)


build_exterior = build
