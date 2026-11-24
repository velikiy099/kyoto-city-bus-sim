"""Kyoto City Bus PDG-AA273KAN (96MC B-I / Aero Star-S) photo-accurate interior & cockpit builder.

Exposes `build(body_empty, mats)` operating in logical Body / Three.js coordinates
(Y-up, +Z forward, +X left). `geom.py` transforms all meshes and empties into
Blender-native Z-up `(x, -z_fwd, y_up)` for `.blend` and `export_yup=True` `.glb`.
"""
import math

from mathutils import Euler, Vector

from . import spec
from .geom import MeshBuilder, new_empty


# ---------------------------------------------------------------- helpers
def _add_chamfered_slab(mb, x0, x1, y0, y1, z0, z1, c_front, c_rear, mat, uv_scale=None):
    """Horizontal floor slab from z0..z1 with optional corner chamfers at front/rear."""
    pts_xz = []
    if c_rear > 0:
        pts_xz.extend([(x0 + c_rear, z0), (x1 - c_rear, z0), (x1, z0 + c_rear)])
    else:
        pts_xz.extend([(x0, z0), (x1, z0)])
    if c_front > 0:
        pts_xz.extend([(x1, z1 - c_front), (x1 - c_front, z1), (x0 + c_front, z1), (x0, z1 - c_front)])
    else:
        pts_xz.extend([(x1, z1), (x0, z1)])
    if c_rear > 0:
        pts_xz.append((x0, z0 + c_rear))

    n = len(pts_xz)
    bot = [mb.add_vert((x, y0, z)) for (x, z) in pts_xz]
    top = [mb.add_vert((x, y1, z)) for (x, z) in pts_xz]

    s = uv_scale or 1.0
    top_uv = [(x * s, z * s) for (x, z) in pts_xz]
    mb.add_face(list(reversed(top)), mat, list(reversed(top_uv)))
    mb.add_face(bot, mat, top_uv)
    for i in range(n):
        j = (i + 1) % n
        x_a, z_a = pts_xz[i]
        x_b, z_b = pts_xz[j]
        seg_len = math.hypot(x_b - x_a, z_b - z_a)
        mb.add_face(
            [bot[j], bot[i], top[i], top[j]],
            mat,
            ((0, y0 * s), (seg_len * s, y0 * s), (seg_len * s, y1 * s), (0, y1 * s)),
        )


def _add_curved_black_grab_handle(mb, x_center, y_center, z_back, half_w, mats):
    """Curved black grab handle mounted on the upper light-grey plastic seatback (step_60_shot_1.png)."""
    mat_blk = mats["BusTrim"]
    # Left & right mounting blocks bolted to the light-grey seatback shell
    for sx in (-1, 1):
        mx = x_center + sx * half_w
        mb.box(
            (mx - 0.016, y_center - 0.014, z_back - 0.022),
            (mx + 0.016, y_center + 0.014, z_back + 0.005),
            mat_blk,
        )
    # Smooth downward-arching black grab handle bar standing proud of the seatback (-Z)
    pts = [
        (x_center - half_w, y_center, z_back - 0.012),
        (x_center - half_w * 0.75, y_center - 0.014, z_back - 0.036),
        (x_center - half_w * 0.35, y_center - 0.026, z_back - 0.044),
        (x_center, y_center - 0.030, z_back - 0.046),
        (x_center + half_w * 0.35, y_center - 0.026, z_back - 0.044),
        (x_center + half_w * 0.75, y_center - 0.014, z_back - 0.036),
        (x_center + half_w, y_center, z_back - 0.012),
    ]
    mb.tube(pts, 0.011, 8, mat_blk, caps=True)


def _add_seat(
    mb,
    x_center,
    y_support,
    z_center,
    width,
    mats,
    seat_mat,
    aisle_side=-1,
    y_aisle_floor=None,
    on_wheelhouse=False,
):
    """Photo-accurate Kyoto City Bus 96MC forward-facing seat (step_60_shot_1.png & step_32_shot_1.png).

    Features:
    - ZERO floating gap: solid enclosed under-seat riser/pedestal down to `y_support` (floor or wheelhouse)
      AND solid inner aisle support + twin vertical steel legs all the way down to `y_aisle_floor`.
    - Light-grey molded plastic rear seatback panel (`BusSeatShell`) framed by a thick rounded moquette
      outer border (`seat_mat`).
    - Two curved black grab handles (`BusTrim`) on paired seats (one on single seats) + black aisle armrest.
    """
    hw = width * 0.5
    x0, x1 = x_center - hw, x_center + hw
    y_floor_in = y_aisle_floor if y_aisle_floor is not None else y_support

    if on_wheelhouse:
        # Wheelhouse top is Y=1.06; keep cushion bottom at Y=1.18 (just slightly above regular rear seats)
        c_y0 = y_support + 0.12
        c_y1 = c_y0 + 0.09
    else:
        c_y0 = y_support + 0.34
        c_y1 = y_support + 0.43

    # 1. SOLID UNDER-SEAT BASE / PEDESTAL / LEGS (ZERO FLOATING SEATS!)
    # Under-cushion dark steel pan spanning full seat footprint
    mb.box(
        (x0 + 0.01, c_y0 - 0.035, z_center - 0.18),
        (x1 - 0.01, c_y0, z_center + 0.22),
        mats["BusInteriorDark"],
    )

    if on_wheelhouse:
        # Full-width solid riser box connecting wheelhouse top (y_support=1.06) flush to cushion bottom (c_y0)
        mb.box(
            (x0 + 0.015, y_support - 0.02, z_center - 0.17),
            (x1 - 0.015, c_y0 - 0.03, z_center + 0.20),
            mats["BusInteriorDark"],
        )
        # If paired seat overhangs the inner edge of the wheelhouse (|X| < 0.62), extend a solid pedestal
        # and twin steel legs all the way down to the rear aisle floor (y_floor_in = 0.79)!
        if x_center > 0:
            x_well_in = spec.WHEELWELL_INNER_X["R"]  # 0.62
            if x0 < x_well_in:
                mb.box(
                    (x0 + 0.02, y_floor_in, z_center - 0.15),
                    (min(x1 - 0.02, x_well_in + 0.04), c_y0 - 0.03, z_center + 0.18),
                    mats["BusInteriorDark"],
                )
        else:
            x_well_in = -spec.WHEELWELL_INNER_X["R"]  # -0.62
            if x1 > x_well_in:
                mb.box(
                    (max(x0 + 0.02, x_well_in - 0.04), y_floor_in, z_center - 0.15),
                    (x1 - 0.02, c_y0 - 0.03, z_center + 0.18),
                    mats["BusInteriorDark"],
                )
    else:
        # Solid enclosed under-seat pedestal box from floor/platform (y_support) right up to cushion pan
        mb.box(
            (x0 + 0.035, y_support, z_center - 0.15),
            (x1 - 0.035, c_y0 - 0.03, z_center + 0.17),
            mats["BusInteriorDark"],
            skip=("-y",),
        )
        # Wall-side structural side skirt bracket connecting seat pan flush to side wall
        if x_center > 0:
            mb.box(
                (x_center, y_support, z_center - 0.16),
                (min(spec.INNER_HALF_W, x1 + 0.02), c_y0 - 0.02, z_center + 0.18),
                mats["BusSeatShell"],
                skip=("-y",),
            )
        else:
            mb.box(
                (max(-spec.INNER_HALF_W, x0 - 0.02), y_support, z_center - 0.16),
                (x_center, c_y0 - 0.02, z_center + 0.18),
                mats["BusSeatShell"],
                skip=("-y",),
            )

    # Twin aisle-side vertical tubular steel support legs down to floor/platform + foot plates
    x_leg = x_center + aisle_side * (hw - 0.045)
    for lz in (z_center - 0.12, z_center + 0.15):
        mb.cylinder((x_leg, y_floor_in, lz), (x_leg, c_y0 - 0.01, lz), 0.016, 8, mats["BusSteel"])
        mb.box(
            (x_leg - 0.028, y_floor_in, lz - 0.028),
            (x_leg + 0.028, y_floor_in + 0.012, lz + 0.028),
            mats["BusSteel"],
        )

    # 2. SEAT CUSHION (plush checked moquette, divided into 2 cushions on paired seats)
    if width >= 0.65:
        sub_w = (width - 0.012) * 0.5
        for idx, sx in enumerate((-1, 1)):
            cx_sub = x_center + sx * (sub_w * 0.5 + 0.003)
            mb.box(
                (cx_sub - sub_w * 0.5, c_y0, z_center - 0.18),
                (cx_sub + sub_w * 0.5, c_y1, z_center + 0.24),
                seat_mat,
                uv_scale=2.6,
                skip=("-y",),
            )
    else:
        mb.box(
            (x0, c_y0, z_center - 0.18),
            (x1, c_y1, z_center + 0.24),
            seat_mat,
            uv_scale=2.6,
            skip=("-y",),
        )

    # 3. SEAT BACKREST: Moquette outer border framing the light-grey molded plastic back panel!
    back_tilt = Euler((-0.13, 0.0, 0.0), "XYZ")
    back_h = 0.54
    back_cy = c_y1 + back_h * 0.5 - 0.02
    back_cz = z_center - 0.16

    # Main moquette backrest body (forms front cushion + thick rounded left/right/top moquette border)
    mb.obox(
        (x_center, back_cy, back_cz),
        (width, back_h, 0.056),
        seat_mat,
        rot=back_tilt,
        uv_scale=2.6,
    )
    # Rounded top moquette crest cylinder across the top of the seatback
    top_y = c_y1 + back_h - 0.025
    top_z = back_cz - 0.5 * back_h * math.sin(0.13)
    mb.cylinder(
        (x0 + 0.01, top_y, top_z),
        (x1 - 0.01, top_y, top_z),
        0.028,
        10,
        seat_mat,
    )

    # Inset light-grey molded plastic back shell (`BusSeatShell` #C8CED4) on rear (-Z) face
    # Leaving 4.5cm moquette border on left & right and 5.0cm moquette border at top!
    shell_w = max(0.24, width - 0.09)
    shell_h = back_h - 0.055
    shell_cy = back_cy - 0.022
    shell_cz = back_cz - 0.018
    mb.obox(
        (x_center, shell_cy, shell_cz),
        (shell_w, shell_h, 0.032),
        mats["BusSeatShell"],
        rot=back_tilt,
    )

    # Small white/red notice sticker on upper center of light-grey plastic seatback (step_60_shot_1.png)
    sticker_y = c_y1 + back_h - 0.095
    sticker_z = back_cz - 0.036 - (sticker_y - back_cy) * math.sin(0.13)
    mb.box(
        (x_center - 0.055, sticker_y - 0.014, sticker_z - 0.004),
        (x_center + 0.055, sticker_y + 0.014, sticker_z + 0.002),
        mats["BusPureWhite"],
    )
    mb.box(
        (x_center - 0.050, sticker_y + 0.004, sticker_z - 0.005),
        (x_center + 0.050, sticker_y + 0.011, sticker_z - 0.003),
        mats["BusRed"],
    )

    # 4. CURVED BLACK GRAB HANDLES on upper light-grey plastic panel (2 on paired seats, 1 on single)
    handle_y = c_y1 + back_h - 0.135
    handle_z = back_cz - 0.032 - (handle_y - back_cy) * math.sin(0.13)
    if width >= 0.65:
        for sx in (-1, 1):
            _add_curved_black_grab_handle(
                mb,
                x_center + sx * (width * 0.22),
                handle_y,
                handle_z,
                half_w=min(0.115, width * 0.15),
                mats=mats,
            )
    else:
        _add_curved_black_grab_handle(
            mb,
            x_center,
            handle_y,
            handle_z,
            half_w=min(0.125, width * 0.28),
            mats=mats,
        )

    # 5. AISLE-SIDE BLACK CURVED ARMREST (`BusTrim`)
    x_arm = x_center + aisle_side * (hw - 0.012)
    mb.tube(
        [
            (x_arm, c_y1 - 0.01, z_center + 0.16),
            (x_arm, c_y1 + 0.14, z_center + 0.14),
            (x_arm, c_y1 + 0.16, z_center + 0.02),
            (x_arm, c_y1 + 0.15, z_center - 0.14),
        ],
        0.014,
        8,
        mats["BusTrim"],
        caps=True,
    )


def _add_longitudinal_priority_bench(mb, y_floor, z0, z1, mats):
    """Left-side (+X) crimson/burgundy longitudinal priority bench with central padded armrest divider
    and solid enclosed base down to low floor (step_32_shot_1.png)."""
    iw = spec.INNER_HALF_W  # 1.205
    seat_mat = mats["BusSeatPriority"]
    x_aisle = 0.74
    x_wall = iw - 0.015
    c_y0 = y_floor + 0.34
    c_y1 = y_floor + 0.43

    # Solid enclosed base cabinet from low floor (0.33) up to cushion bottom (0.67) — ZERO floating!
    mb.box(
        (x_aisle + 0.03, y_floor, z0 + 0.02),
        (x_wall, c_y0, z1 - 0.02),
        mats["BusInterior"],
        skip=("-y",),
    )
    # Dark recessed toe-kick strip at floor level
    mb.box(
        (x_aisle + 0.025, y_floor, z0 + 0.015),
        (x_wall, y_floor + 0.06, z1 - 0.015),
        mats["BusInteriorDark"],
        skip=("-y",),
    )
    # Front/mid/rear tubular steel support legs along the aisle edge (step_32_shot_1.png)
    z_mid = 0.5 * (z0 + z1)
    for lz in (z0 + 0.06, z_mid, z1 - 0.06):
        mb.cylinder((x_aisle + 0.03, y_floor, lz), (x_aisle + 0.03, c_y0, lz), 0.015, 8, mats["BusSteel"])

    # Crimson/burgundy priority bench cushion
    mb.box(
        (x_aisle, c_y0, z0 + 0.01),
        (x_wall, c_y1, z1 - 0.01),
        seat_mat,
        uv_scale=2.6,
        skip=("-y",),
    )
    # Crimson/burgundy backrest along the left wall
    mb.box(
        (x_wall - 0.11, c_y1, z0 + 0.01),
        (x_wall, c_y1 + 0.48, z1 - 0.01),
        seat_mat,
        uv_scale=2.6,
    )
    # Padded crimson central armrest divider block + end armrest blocks (step_32_shot_1.png)
    for az, half_t in ((z_mid, 0.042), (z0 + 0.035, 0.028), (z1 - 0.035, 0.028)):
        mb.box(
            (x_aisle + 0.02, c_y1, az - half_t),
            (x_wall - 0.08, c_y1 + 0.16, az + half_t),
            seat_mat,
            uv_scale=2.6,
        )


def _add_wheelhouse_luggage_rack(mb, side_sign, y_top, z0, z1, mats):
    """Brushed stainless steel tubular luggage rack ('荷物置き場') over front wheelhouse (step_32_shot_1.png)."""
    iw = spec.INNER_HALF_W
    x_in = side_sign * (spec.WHEELWELL_INNER_X["F"] - 0.02)
    x_out = side_sign * (iw - 0.02)
    xa, xb = min(x_in, x_out), max(x_in, x_out)

    # Raised header/backstop panel at rear & front of wheelhouse deck
    mb.box((xa + 0.01, y_top, z0 + 0.01), (xb - 0.01, y_top + 0.24, z0 + 0.05), mats["BusInterior"])
    mb.box((xa + 0.01, y_top + 0.24, z0 + 0.01), (xb - 0.01, y_top + 0.28, z0 + 0.05), mats["BusSeatPriority"])

    # Stainless tubular perimeter guardrail with corner posts above wheelhouse deck
    ry1 = y_top + 0.14
    ry2 = y_top + 0.22
    for ry in (ry1, ry2):
        mb.tube(
            [
                (x_out, ry, z0 + 0.05),
                (x_in, ry, z0 + 0.05),
                (x_in, ry, z1 - 0.04),
                (x_out, ry, z1 - 0.04),
            ],
            0.012,
            8,
            mats["BusSteel"],
            caps=True,
        )
    for pz in (z0 + 0.05, 0.5 * (z0 + z1), z1 - 0.04):
        mb.cylinder((x_in, y_top, pz), (x_in, ry2 + 0.01, pz), 0.013, 8, mats["BusSteel"])


def _add_rear_bench(mb, y_floor, z_back, mats):
    """5-across rear bench against the rear bulkhead with solid full-width base down to y_floor."""
    seat_mat = mats["BusSeat"]
    total_w = 2.28
    c_y0 = y_floor + 0.35
    c_y1 = y_floor + 0.44
    # Continuous solid base box under bench (ZERO floating gap!)
    mb.box(
        (-total_w * 0.5, y_floor, z_back - 0.02),
        (total_w * 0.5, c_y0, z_back + 0.44),
        mats["BusInteriorDark"],
        skip=("-y",),
    )
    slot_w = total_w / 5.0
    for i in range(5):
        cx = -total_w * 0.5 + slot_w * (i + 0.5)
        mb.box(
            (cx - slot_w * 0.48, c_y0, z_back + 0.03),
            (cx + slot_w * 0.48, c_y1, z_back + 0.46),
            seat_mat,
            uv_scale=2.6,
            skip=("-y",),
        )
        mb.obox(
            (cx, c_y1 + 0.28, z_back + 0.06),
            (slot_w * 0.95, 0.54, 0.055),
            seat_mat,
            rot=Euler((-0.12, 0.0, 0.0), "XYZ"),
            uv_scale=2.6,
        )


def _add_stanchion(mb, x, z, y0, y1, mats, orange=True):
    """Vertical stanchion pole in matte safety orange with silver clamp collars (step_60_shot_1.png)."""
    r = 0.018
    if not orange or (y1 - y0) < 0.55:
        mb.cylinder((x, y0, z), (x, y1, z), r, 10, mats["BusSteel"])
        return
    # Bottom silver mounting base & collar
    mb.cylinder((x, y0, z), (x, y0 + 0.07, z), r + 0.004, 10, mats["BusSteel"])
    # Main matte orange pole up to near ceiling/handrail
    y_top_orange = max(y0 + 0.20, y1 - 0.08)
    mb.cylinder((x, y0 + 0.07, z), (x, y_top_orange, z), r, 10, mats["BusPole"])
    # Silver intermediate joint ring & top ceiling flange
    y_mid_ring = min(y0 + 0.62, y_top_orange - 0.12)
    if y_mid_ring > y0 + 0.15:
        mb.cylinder((x, y_mid_ring - 0.025, z), (x, y_mid_ring + 0.025, z), r + 0.004, 10, mats["BusSteel"])
    mb.cylinder((x, y_top_orange, z), (x, y1, z), r + 0.003, 10, mats["BusSteel"])


def _add_stop_button(mb, x, y, z, facing_axis, mats):
    """Yellow oval stop-button housing with red illuminated push button ('降車ボタン', step_60_shot_1.png)."""
    u = Vector(facing_axis).normalized()
    pos = Vector((x, y, z)) + u * 0.018
    # Silver pole mounting band behind button
    mb.cylinder((x, y - 0.055, z), (x, y + 0.055, z), 0.022, 10, mats["BusSteel"])
    # Yellow capsule/oval housing
    mb.obox(pos, (0.046, 0.096, 0.044), mats["BusYellowEdge"])
    # Red upper lamp & lower push button face
    btn_pos = pos + u * 0.020
    mb.obox(btn_pos + Vector((0.0, 0.016, 0.0)), (0.032, 0.026, 0.014), mats["BusStopButton"])
    mb.obox(btn_pos + Vector((0.0, -0.018, 0.0)), (0.030, 0.028, 0.016), mats["BusStopButton"])


def _add_grab_strap(mb, x, y_rail, z, mats):
    """White hanging grab strap ('つり革') with triangular plastic handgrip (step_60_shot_1 & step_32_shot_1)."""
    mat_strap = mats["BusStrap"]
    # Silver clamp on overhead rail
    mb.cylinder((x, y_rail - 0.01, z - 0.016), (x, y_rail - 0.01, z + 0.016), 0.018, 8, mats["BusSteel"])
    # White upper strap band
    mb.box((x - 0.006, y_rail - 0.16, z - 0.013), (x + 0.006, y_rail - 0.01, z + 0.013), mat_strap)
    # White triangular handgrip in Y-Z plane (open triangle clearly recognizable from front/rear!)
    ty_top = y_rail - 0.155
    ty_bot = y_rail - 0.265
    tz_hw = 0.058
    pts = [
        (x, ty_top, z),
        (x, ty_bot, z - tz_hw),
        (x, ty_bot, z + tz_hw),
        (x, ty_top, z),
    ]
    mb.tube(pts, 0.0095, 8, mat_strap, caps=False)


def _add_ceiling_circular_vent(mb, cx, cy, cz, radius, mats):
    """Circular slatted exhaust vent grille on ceiling centerline (step_60_shot_1.png top center!)."""
    # Recessed dark plenum disc behind grille slats
    mb.cylinder((cx, cy - 0.008, cz), (cx, cy + 0.005, cz), radius * 0.92, 28, mats["BusInteriorDark"])
    # Outer molded light-grey bezel ring
    mb.torus((cx, cy - 0.012, cz), (0.0, -1.0, 0.0), radius, 0.024, 28, 10, mats["BusInterior"])
    # 5 concentric circular louver rings
    for frac in (0.80, 0.64, 0.48, 0.32, 0.16):
        mb.torus((cx, cy - 0.014, cz), (0.0, -1.0, 0.0), radius * frac, 0.008, 24, 6, mats["BusInterior"])
    # Center hub cap & 8 radial support ribs
    mb.cylinder((cx, cy - 0.018, cz), (cx, cy - 0.006, cz), radius * 0.11, 16, mats["BusInterior"])
    for k in range(8):
        ang = math.radians(k * 45.0)
        rx = cx + math.cos(ang) * radius * 0.90
        rz = cz + math.sin(ang) * radius * 0.90
        mb.beam((cx, cy - 0.013, cz), (rx, cy - 0.013, rz), 0.012, 0.008, mats["BusInterior"])


# ---------------------------------------------------------------- builders
def _build_floor_and_trim(body_empty, mats):
    mb = MeshBuilder()
    iw = spec.INNER_HALF_W  # 1.205
    y_low = spec.FLOOR_Y_LOW  # 0.33
    y_step = spec.FLOOR_Y_STEP  # 0.56
    y_rear = spec.FLOOR_Y_REAR  # 0.79
    z_low_r = spec.FLOOR_LOW_Z_REAR  # 1.95
    z_step_r = spec.FLOOR_STEP_Z_REAR  # 1.60
    z_front_in = spec.front_inner_z(y_low) - 0.03  # 6.88
    z_rear_in = spec.Z_REAR + spec.WALL_T + 0.02  # -3.36

    # 1. Non-step front/mid floor (notched around front wheel arches Z=4.22..5.38, |X|>0.83)
    mb.box((-iw, y_low - 0.04, z_low_r), (iw, y_low, 4.22), mats["BusFloor"], uv_scale=1.2, skip=("-y",))
    mb.box((-0.83, y_low - 0.04, 4.22), (0.83, y_low, 5.38), mats["BusFloor"], uv_scale=1.2, skip=("-y",))
    _add_chamfered_slab(mb, -iw, iw, y_low - 0.04, y_low, 5.38, z_front_in, 0.22, 0.0, mats["BusFloor"], uv_scale=1.2)

    # Raised right-side (-X) priority seating platform (Y=0.33..0.46, Z=1.95..4.22, step_32_shot_1.png!)
    y_prio_plat = 0.46
    mb.box((-iw, y_low, z_low_r), (-0.45, y_prio_plat, 4.22), mats["BusFloor"], uv_scale=1.2, skip=("-y",))
    # Brushed stainless steel platform nosing strip along the right aisle edge (step_32_shot_1.png)
    mb.box((-0.465, y_low, z_low_r), (-0.442, y_prio_plat + 0.008, 4.22), mats["BusSteel"])

    # Door threshold yellow tactile step plates (+X left side)
    mb.box((0.92, y_low, spec.FRONT_DOOR_Z[0] + 0.02), (iw, y_low + 0.012, spec.FRONT_DOOR_Z[1] - 0.02), mats["BusYellowEdge"])
    mb.box((1.05, y_low, spec.MID_DOOR_Z[0] + 0.02), (iw, y_low + 0.012, spec.MID_DOOR_Z[1] - 0.02), mats["BusYellowEdge"])

    # 2. Two yellow-edged steps aft of middle door & rear raised floor (Y=0.79)
    mb.box((-iw, y_low, z_low_r - 0.03), (iw, y_step, z_low_r + 0.01), mats["BusInteriorDark"])
    mb.box((-0.66, y_step - 0.005, z_low_r - 0.045), (0.66, y_step + 0.014, z_low_r + 0.015), mats["BusYellowEdge"])
    mb.box((-iw, y_step - 0.04, z_step_r), (iw, y_step, z_low_r), mats["BusFloor"], uv_scale=1.2, skip=("-y",))

    mb.box((-iw, y_step, z_step_r - 0.03), (iw, y_rear, z_step_r + 0.01), mats["BusInteriorDark"])
    mb.box((-0.66, y_rear - 0.005, z_step_r - 0.045), (0.66, y_rear + 0.014, z_step_r + 0.015), mats["BusYellowEdge"])
    _add_chamfered_slab(mb, -iw, iw, y_rear - 0.04, y_rear, z_rear_in, -0.56, 0.0, 0.14, mats["BusFloor"], uv_scale=1.2)
    mb.box((-0.61, y_rear - 0.04, -0.56), (0.61, y_rear, 0.56), mats["BusFloor"], uv_scale=1.2, skip=("-y",))
    mb.box((-iw, y_rear - 0.04, 0.56), (iw, y_rear, z_step_r), mats["BusFloor"], uv_scale=1.2, skip=("-y",))

    # 3. Driver floor platform (-X front, ahead of front wheelhouse Z>=5.38)
    _add_chamfered_slab(mb, -iw, -0.38, y_low, spec.DRIVER_PLATFORM_Y, 5.20, 6.86, 0.22, 0.0, mats["BusInteriorDark"], uv_scale=1.0)

    # 4. Wheelhouse boxes (light-grey molded interior covers over front wheelhouses matching step_32_shot_1.png,
    #    dark heavy-duty wheelhouse bases in rear so exterior wheel arches stay 100% open)
    fz0, fz1 = spec.ARCH_Z["F"]  # 4.24, 5.36
    fx_in = spec.WHEELWELL_INNER_X["F"] - 0.03  # 0.81
    fx_wall = spec.WHEELWELL_INNER_X["F"]  # 0.84
    fy_top = spec.WHEELWELL_TOP_Y["F"] + 0.02  # 1.06
    for sx in (-1, 1):
        xa, xb = (fx_in, fx_wall) if sx > 0 else (-fx_wall, -fx_in)
        mb.box((xa, y_low, fz0 - 0.04), (xb, fy_top, fz1 + 0.04), mats["BusInterior"], skip=("-y",))
        mb.box((xa - 0.003 * sx, y_low, fz0 - 0.042), (xb + 0.003 * sx, y_low + 0.10, fz1 + 0.042), mats["BusInteriorDark"], skip=("-y",))
        ta, tb = (fx_in, iw) if sx > 0 else (-iw, -fx_in)
        mb.box((ta, spec.ARCH_TOP_Y + 0.005, fz0 - 0.04), (tb, fy_top, fz1 + 0.04), mats["BusInterior"])
        _add_wheelhouse_luggage_rack(mb, sx, fy_top, fz0 - 0.02, fz1 - 0.12, mats)

    rz0, rz1 = spec.ARCH_Z["R"]  # -0.56, 0.56
    rx_in = spec.WHEELWELL_INNER_X["R"] - 0.03  # 0.59
    rx_wall = spec.WHEELWELL_INNER_X["R"]  # 0.62
    ry_top = spec.WHEELWELL_TOP_Y["R"] + 0.02  # 1.06
    for sx in (-1, 1):
        xa, xb = (rx_in, rx_wall) if sx > 0 else (-rx_wall, -rx_in)
        mb.box((xa, y_rear, rz0 - 0.04), (xb, ry_top, rz1 + 0.04), mats["BusInteriorDark"], skip=("-y",))
        ta, tb = (rx_in, iw) if sx > 0 else (-iw, -rx_in)
        mb.box((ta, spec.ARCH_TOP_Y + 0.005, rz0 - 0.04), (tb, ry_top, rz1 + 0.04), mats["BusInteriorDark"])

    # 5. Lower interior side trim walls + window sill rails with stop-button strip (step_60_shot_1.png)
    # Adapted to WIN_SILL_Y = 1.15, WIN_HEADER_Y = 2.18, CEILING_Y = 2.34
    sill_y = spec.WIN_SILL_Y  # 1.15
    hdr_y = spec.WIN_HEADER_Y  # 2.18
    # Left (+X) segments:
    mb.box((iw - 0.02, y_low, 3.26), (iw, sill_y, 4.22), mats["BusInterior"], skip=("+x",))
    mb.box((iw - 0.02, 1.06, 4.22), (iw, sill_y, 5.38), mats["BusInterior"], skip=("+x",))
    mb.box((iw - 0.02, y_low, 5.38), (iw, sill_y, 5.56), mats["BusInterior"], skip=("+x",))
    mb.box((iw - 0.09, y_low, 0.88), (iw, sill_y, 2.04), mats["BusInterior"], skip=("+x",))
    # Left side destination sign (upper-half SignSideL bay Z=0.88..1.92, Y=1.56..2.18) interior casing (step_60_shot_1.png left!)
    # Lower half (Y=1.15..1.55) remains clear transparent window glass!
    mb.box((iw - 0.11, 1.56, 0.88), (iw, hdr_y, 1.92), mats["BusInterior"], skip=("+x",))
    mb.box((iw - 0.115, 1.72, 1.18), (iw - 0.105, 1.92, 1.46), mats["BusIcReader"])  # blue translucent inspection window
    mb.box((iw - 0.115, 1.74, 1.54), (iw - 0.105, 1.90, 1.72), mats["BusPureWhite"])
    mb.box((iw - 0.116, 1.78, 1.58), (iw - 0.104, 1.86, 1.68), mats["BusRed"])
    mb.box((iw - 0.02, y_rear, 0.56), (iw, sill_y, 0.88), mats["BusInterior"], skip=("+x",))
    mb.box((iw - 0.02, 1.06, -0.56), (iw, sill_y, 0.56), mats["BusInterior"], skip=("+x",))
    mb.box((iw - 0.02, y_rear, z_rear_in + 0.14), (iw, sill_y, -0.56), mats["BusInterior"], skip=("+x",))

    # Right (-X) segments:
    mb.box((-iw, y_prio_plat, 1.95), (-iw + 0.02, sill_y, 4.22), mats["BusInterior"], skip=("-x",))
    mb.box((-iw, 1.06, 4.22), (-iw + 0.02, sill_y, 5.22), mats["BusInterior"], skip=("-x",))
    mb.box((-iw, y_rear, 0.56), (-iw + 0.02, sill_y, 1.95), mats["BusInterior"], skip=("-x",))
    mb.box((-iw, 1.06, -0.56), (-iw + 0.02, sill_y, 0.56), mats["BusInterior"], skip=("-x",))
    mb.box((-iw, y_rear, -1.82), (-iw + 0.02, sill_y, -0.56), mats["BusInterior"], skip=("-x",))
    mb.box((-iw, y_rear, -2.50), (-iw + 0.02, 1.30, -1.82), mats["BusInterior"], skip=("-x",))  # emergency door lower trim
    mb.box((-iw, y_rear, z_rear_in + 0.14), (-iw + 0.02, sill_y, -2.50), mats["BusInterior"], skip=("-x",))

    # Window sill horizontal trim rails with red/yellow wall stop-buttons (step_60_shot_1.png right window sill)
    mb.box((-iw + 0.015, sill_y - 0.065, -3.10), (-iw + 0.042, sill_y, 4.60), mats["BusInterior"])
    mb.box((iw - 0.042, sill_y - 0.065, -3.10), (iw - 0.015, sill_y, 0.85), mats["BusInterior"])
    for wz in (-2.65, -1.55, -0.75, 0.10, 0.95, 2.30, 3.45):
        mb.box((-iw + 0.038, sill_y - 0.050, wz - 0.04), (-iw + 0.052, sill_y - 0.012, wz + 0.04), mats["BusYellowEdge"])
        mb.box((-iw + 0.042, sill_y - 0.043, wz - 0.022), (-iw + 0.056, sill_y - 0.018, wz + 0.022), mats["BusStopButton"])

    # Rear bulkhead lower inner trim (below REAR_WINDOW sill Y=1.66)
    mb.box((-iw + 0.14, y_rear, z_rear_in), (iw - 0.14, 1.65, z_rear_in + 0.03), mats["BusInterior"], skip=("-z",))

    # 6. Behind-driver partition panel with dark padded top rail & clear upper guard (step_60_shot_2.png)
    mb.box((-iw, spec.DRIVER_PLATFORM_Y, 5.18), (-0.42, sill_y + 0.01, 5.23), mats["BusInterior"])
    # Thick dark charcoal padded tubular top rail on behind-driver partition
    mb.cylinder((-iw + 0.03, sill_y + 0.035, 5.205), (-0.42, sill_y + 0.035, 5.205), 0.032, 12, mats["BusInteriorDark"])
    # Clear upper guard behind driver (kept cleanly below CEILING_Y = 2.34 & WIN_HEADER_Y = 2.18)
    mb.box((-1.18, sill_y + 0.05, 5.195), (-0.58, 2.05, 5.215), mats["BusGlass"])
    mb.box((-1.19, 2.04, 5.185), (-0.57, 2.07, 5.225), mats["BusSteel"])

    # Partition behind front door (+X, Z=5.44..5.49) & ahead of middle door (+X, Z=3.28..3.33)
    mb.box((0.76, y_low, 5.44), (iw, sill_y + 0.02, 5.49), mats["BusInterior"])
    mb.cylinder((0.76, sill_y + 0.04, 5.465), (iw - 0.03, sill_y + 0.04, 5.465), 0.026, 10, mats["BusInteriorDark"])
    mb.box((0.78, sill_y + 0.06, 5.455), (iw - 0.02, 1.86, 5.475), mats["BusGlass"])

    mb.box((0.72, y_low, 3.27), (iw, sill_y + 0.02, 3.32), mats["BusInterior"])
    mb.cylinder((0.72, sill_y + 0.04, 3.295), (iw - 0.03, sill_y + 0.04, 3.295), 0.025, 10, mats["BusInteriorDark"])

    # 96MC moquette-trimmed step-up divider walls at Z=1.95 (step_60_shot_1.png)
    for sx0, sx1 in ((0.66, iw), (-iw, -0.66)):
        mb.box((sx0, y_low, 1.93), (sx1, 1.21, 1.98), mats["BusInterior"])
        mb.box((sx0 + 0.02, 0.82, 1.98), (sx1 - 0.02, 1.17, 1.996), mats["BusSeat"], uv_scale=2.4)
        mb.cylinder((sx0 + 0.02, 1.22, 1.955), (sx1 - 0.02, 1.22, 1.955), 0.024, 10, mats["BusInteriorDark"])

    # 7. Ceiling liner, curved cantrail ad coves, circular exhaust vent grilles & fluorescent lights
    # Adapted cleanly to CEILING_Y = 2.34 and WIN_HEADER_Y = 2.18 (zero clipping with roof or rear window!)
    cy = spec.CEILING_Y  # 2.34
    mb.box((-0.84, cy, -3.05), (0.84, cy + 0.028, 6.48), mats["BusInterior"], skip=("+y",))
    # Longitudinal ceiling panel seam ribs & center circular slatted exhaust vent grilles (step_60_shot_1.png)!
    for sz in (-2.10, -0.10, 1.85, 3.80, 5.65):
        mb.box((-0.84, cy - 0.010, sz - 0.02), (0.84, cy, sz + 0.02), mats["BusInterior"])
    _add_ceiling_circular_vent(mb, 0.0, cy, -0.82, 0.28, mats)
    _add_ceiling_circular_vent(mb, 0.0, cy, 5.15, 0.26, mats)

    # Curved cantrail ad coves & framed ad poster cards along left/right ceiling edges (Y = 2.21..2.33, strictly between 2.18 and 2.34)
    mb.obox((1.01, cy - 0.065, 1.65), (0.38, 0.022, 9.40), mats["BusInterior"], rot=Euler((0.0, 0.0, -0.28), "XYZ"))
    mb.obox((-1.01, cy - 0.065, 1.65), (0.38, 0.022, 9.40), mats["BusInterior"], rot=Euler((0.0, 0.0, 0.28), "XYZ"))
    # Black-framed safety slogan plaques & colorful curved ad posters along upper cantrail (step_60_shot_1.png)
    for sx in (-1, 1):
        rot_c = Euler((0.0, 0.0, -sx * 0.28), "XYZ")
        for az, ad_mat in ((-1.65, mats["BusPureWhite"]), (-0.35, mats["BusDecalEntrance"]), (1.10, mats["BusPureWhite"]), (2.75, mats["BusDecalExit"]), (4.25, mats["BusPureWhite"])):
            mb.obox((sx * 0.99, cy - 0.078, az), (0.26, 0.012, 1.05), ad_mat, rot=rot_c)
            mb.obox((sx * 0.85, cy - 0.036, az), (0.04, 0.016, 0.85), mats["BusTrim"], rot=rot_c)
        # Black AC return air louver slots along upper cove
        for vz in (-2.55, 0.45, 3.55):
            mb.obox((sx * 0.85, cy - 0.036, vz), (0.045, 0.020, 0.34), mats["BusInteriorDark"], rot=rot_c)

    # Small twin-dome black security camera pods above right window header (step_60_shot_3.png upper right!)
    for cz_cam in (1.75, 2.55, 3.45):
        mb.box((-1.15, hdr_y + 0.015, cz_cam - 0.06), (-1.04, hdr_y + 0.032, cz_cam + 0.06), mats["BusTrim"])
        for dz_c in (-0.026, 0.026):
            mb.sphere((-1.095, hdr_y + 0.015, cz_cam + dz_c), 0.020, 10, 6, mats["BusTrim"])

    # Flush rectangular fluorescent ceiling light fixtures (step_60_shot_1.png & step_60_shot_3.png)
    for lx in (-0.48, 0.48):
        for lz0, lz1 in ((-2.75, -1.35), (0.05, 1.45), (2.25, 3.65), (4.15, 5.05)):
            mb.box((lx - 0.11, cy - 0.024, lz0), (lx + 0.11, cy, lz1), mats["BusCeilingLight"], skip=("+y",))
            mb.box((lx - 0.12, cy - 0.026, lz0 - 0.025), (lx + 0.12, cy, lz0), mats["BusSteel"])
            mb.box((lx - 0.12, cy - 0.026, lz1), (lx + 0.12, cy, lz1 + 0.025), mats["BusSteel"])

    # 8. Mid-Cabin Hanging Flat-Panel LCD Monitor (`step_60_shot_3.png` & `step_60_shot_1.png`)
    # Slim ~0.46m wide x 0.28m tall x 0.038m thick dark bezel with rounded corners, twin ceiling bracket tubes,
    # and BLANK unlit dark screen (`mats["BusMonitorBlank"]`) positioned at X=-0.42, Y=1.94..2.22, Z=1.95.
    mx_c, my_c, mz_c = -0.42, 2.08, 1.95
    mw, mh, mt = 0.46, 0.28, 0.038
    mx0, mx1 = mx_c - mw * 0.5, mx_c + mw * 0.5  # -0.65 .. -0.19
    my0, my1 = my_c - mh * 0.5, my_c + mh * 0.5  # 1.94 .. 2.22
    mz0, mz1 = mz_c - mt * 0.5, mz_c + mt * 0.5  # 1.931 .. 1.969
    cr_m = 0.016  # corner radius of slim LCD bezel
    # Rounded-corner outer matte black LCD bezel body
    mb.box((mx0 + cr_m, my0, mz0), (mx1 - cr_m, my1, mz1), mats["BusTrim"])
    mb.box((mx0, my0 + cr_m, mz0), (mx1, my1 - cr_m, mz1), mats["BusTrim"])
    for cx_m in (mx0 + cr_m, mx1 - cr_m):
        for cy_m in (my0 + cr_m, my1 - cr_m):
            mb.cylinder((cx_m, cy_m, mz0), (cx_m, cy_m, mz1), cr_m, 10, mats["BusTrim"])
    # Raised outer front bezel frame around recessed blank LCD screen (2.2cm border on all 4 sides)
    bz_w = 0.022
    mb.box((mx0 + cr_m, my1 - bz_w, mz0 - 0.003), (mx1 - cr_m, my1, mz0), mats["BusTrim"])
    mb.box((mx0 + cr_m, my0, mz0 - 0.003), (mx1 - cr_m, my0 + bz_w, mz0), mats["BusTrim"])
    mb.box((mx0, my0 + cr_m, mz0 - 0.003), (mx0 + bz_w, my1 - cr_m, mz0), mats["BusTrim"])
    mb.box((mx1 - bz_w, my0 + cr_m, mz0 - 0.003), (mx1, my1 - cr_m, mz0), mats["BusTrim"])
    # BLANK DARK LCD SCREEN (`mats["BusMonitorBlank"]`) inset inside the slim black bezel
    mb.rect((mx_c, my_c, mz0 - 0.0012), (-1, 0, 0), (0, 1, 0), mw - 2 * bz_w, mh - 2 * bz_w, mats["BusMonitorBlank"])
    # Slim rear electronics cover & VESA ceiling mount bracket on +Z back face
    mb.box((mx_c - 0.18, my_c - 0.10, mz1), (mx_c + 0.18, my_c + 0.10, mz1 + 0.010), mats["BusInteriorDark"])
    mb.box((mx_c - 0.12, my_c + 0.02, mz1 + 0.010), (mx_c + 0.12, my_c + 0.11, mz1 + 0.018), mats["BusTrim"])
    # Twin vertical ceiling suspension bracket tubes up to CEILING_Y = 2.34 (step_60_shot_3.png)
    for bx_m in (mx_c - 0.10, mx_c + 0.10):
        mb.cylinder((bx_m, my_c + 0.08, mz1 + 0.014), (bx_m, cy, mz1 + 0.014), 0.011, 8, mats["BusSteel"])
        mb.box((bx_m - 0.022, cy - 0.010, mz1 - 0.010), (bx_m + 0.022, cy, mz1 + 0.036), mats["BusInterior"])

    # 9. Front Overhead Widescreen LCD Monitor, Auxiliary Status Box & Overhead Mirrors (`step_60_shot_2.png`)
    # Front interior header bulkhead above WINDSHIELD_TOP_Y = 2.14 up to CEILING_Y = 2.34
    mb.box((-1.14, 2.14, 6.50), (1.14, cy, 6.72), mats["BusInterior"])
    mb.box((-1.14, 2.13, 6.49), (1.14, 2.15, 6.54), mats["BusInteriorDark"])

    # Slim LECIP/OJI widescreen front overhead LCD monitor housing (~0.66m x 0.28m x 0.052m)
    # Mounted at X=+0.05m, Y=2.02..2.30m (center Y=2.16m), Z=6.38m, tilted ~8.6 deg downward toward passengers
    f_center = Vector((0.05, 2.16, 6.38))
    f_tilt = Euler((-0.15, 0.0, 0.0), "XYZ")
    f_R = f_tilt.to_matrix()
    f_u = f_R @ Vector((-1.0, 0.0, 0.0))
    f_v = f_R @ Vector((0.0, 1.0, 0.0))
    f_n = f_u.cross(f_v).normalized()  # points rearward (-Z) and slightly downward (-Y)
    fw, fh, ft = 0.66, 0.28, 0.044
    fbz = 0.025
    # Main slim dark metal monitor housing + tapered rear backing shell
    mb.obox(f_center, (fw, fh, ft), mats["BusTrim"], rot=f_tilt)
    mb.obox(f_center - f_n * 0.026, (fw - 0.08, fh - 0.06, 0.014), mats["BusInteriorDark"], rot=f_tilt)
    # Raised outer bezel frame around the recessed blank screen
    mb.obox(f_center + f_n * 0.023 + f_v * ((fh - fbz) * 0.5), (fw, fbz, 0.004), mats["BusTrim"], rot=f_tilt)
    mb.obox(f_center + f_n * 0.023 - f_v * ((fh - fbz) * 0.5), (fw, fbz, 0.004), mats["BusTrim"], rot=f_tilt)
    mb.obox(f_center + f_n * 0.023 + f_u * ((fw - fbz) * 0.5), (fbz, fh - 2 * fbz, 0.004), mats["BusTrim"], rot=f_tilt)
    mb.obox(f_center + f_n * 0.023 - f_u * ((fw - fbz) * 0.5), (fbz, fh - 2 * fbz, 0.004), mats["BusTrim"], rot=f_tilt)
    # BLANK DARK LCD SCREEN (`mats["BusMonitorBlank"]`) inset inside the front overhead bezel
    mb.rect(f_center + f_n * 0.0232, f_u, f_v, fw - 2 * fbz, fh - 2 * fbz, mats["BusMonitorBlank"])
    # Twin steel mounting brackets connecting front overhead monitor to ceiling & front header bulkhead
    for bx_f in (-0.15, 0.25):
        mb.box((bx_f - 0.018, 2.27, 6.37), (bx_f + 0.018, cy, 6.51), mats["BusSteel"])
        mb.cylinder((bx_f, 2.26, 6.40), (bx_f, cy, 6.40), 0.012, 8, mats["BusTrim"])

    # Right-side slim auxiliary status box on front header bulkhead (front rollsign/destination inspection window)
    mb.box((-0.68, 2.13, 6.44), (-0.23, 2.29, 6.51), mats["BusInterior"])
    mb.box((-0.68, 2.125, 6.438), (-0.23, 2.14, 6.51), mats["BusInteriorDark"])
    # Recessed blank dark destination inspection window + small beige indicator plaque on left
    mb.box((-0.56, 2.155, 6.436), (-0.35, 2.225, 6.445), mats["BusTrim"])
    mb.rect((-0.455, 2.19, 6.435), (-1, 0, 0), (0, 1, 0), 0.19, 0.056, mats["BusMonitorBlank"])
    mb.box((-0.32, 2.16, 6.437), (-0.25, 2.225, 6.444), mats["BusSwitchPanelWhite"])

    # Vertical rectangular door-monitoring mirror to the left (+X) of front overhead monitor (step_60_shot_2.png)
    m_left_rot = Euler((-0.10, 0.28, 0.0), "XYZ")
    mb.obox((0.48, 2.17, 6.37), (0.135, 0.205, 0.018), mats["BusSteel"], rot=m_left_rot)
    mb.obox((0.478, 2.17, 6.360), (0.115, 0.185, 0.006), mats["BusChrome"], rot=m_left_rot)
    mb.cylinder((0.48, 2.26, 6.38), (0.48, cy, 6.42), 0.010, 8, mats["BusSteel"])

    # Compact oval/rounded cabin mirror & small black sensor pod below front overhead monitor (step_60_shot_2.png)
    m_sub_rot = Euler((0.12, -0.18, 0.0), "XYZ")
    mb.obox((0.11, 1.965, 6.39), (0.115, 0.072, 0.016), mats["BusSteel"], rot=m_sub_rot)
    mb.obox((0.11, 1.965, 6.381), (0.098, 0.058, 0.006), mats["BusChrome"], rot=m_sub_rot)
    mb.cylinder((0.11, 1.995, 6.395), (0.11, 2.04, 6.41), 0.008, 6, mats["BusTrim"])
    mb.cylinder((0.01, 1.975, 6.385), (0.01, 1.975, 6.425), 0.018, 10, mats["BusTrim"])

    # 10. Priority seat & emergency exit interior decals
    mb.rect((iw - 0.022, 1.42, 3.78), (0, 0, 1), (0, 1, 0), 0.26, 0.26, mats["BusDecalWheelchair"])
    mb.rect((-iw + 0.015, 2.13, -2.16), (0, 0, -1), (0, 1, 0), 0.28, 0.08, mats["BusDecalEmergency"])

    return mb.build("InteriorTrim", parent=body_empty, smooth_angle=math.radians(40))


def _build_seats(body_empty, mats):
    mb = MeshBuilder()
    y_low = spec.FLOOR_Y_LOW  # 0.33
    y_prio_plat = 0.46  # raised right-side priority seating platform
    y_rear = spec.FLOOR_Y_REAR  # 0.79
    y_well = spec.WHEELWELL_TOP_Y["R"] + 0.02  # 1.06

    # --- 1. Front Non-Step Priority Zone (Match step_32_shot_1.png!) ---
    # Left (+X) between front wheelhouse (Z=4.22) and middle door (Z=3.32):
    # Crimson/burgundy longitudinal priority bench with central padded armrest divider & solid base
    _add_longitudinal_priority_bench(mb, y_low, 3.33, 4.20, mats)

    # Right (-X) on raised priority platform (Z=1.95..4.22):
    # Two rows of forward-facing crimson/burgundy priority seats with light-grey backs & twin steel legs
    _add_seat(
        mb,
        x_center=-0.84,
        y_support=y_prio_plat,
        z_center=3.58,
        width=0.50,
        mats=mats,
        seat_mat=mats["BusSeatPriority"],
        aisle_side=1,
        y_aisle_floor=y_prio_plat,
        on_wheelhouse=False,
    )
    _add_seat(
        mb,
        x_center=-0.84,
        y_support=y_prio_plat,
        z_center=2.58,
        width=0.50,
        mats=mats,
        seat_mat=mats["BusSeatPriority"],
        aisle_side=1,
        y_aisle_floor=y_prio_plat,
        on_wheelhouse=False,
    )

    # --- 2. Rear Raised-Floor Zone (Y = 0.79, Match step_60_shot_1.png, ZERO FLOATING SEATS!) ---
    # Left (+X) paired forward-facing royal-blue checked moquette seats
    # Row 1 (Z=1.18, beside left side-sign cabinet X=1.07..1.20)
    _add_seat(
        mb,
        x_center=0.73,
        y_support=y_rear,
        z_center=1.18,
        width=0.68,
        mats=mats,
        seat_mat=mats["BusSeat"],
        aisle_side=-1,
        y_aisle_floor=y_rear,
        on_wheelhouse=False,
    )
    # Row 2 (Z=0.36, over front of rear wheelhouse — solid wheelhouse riser + inner floor legs!)
    _add_seat(
        mb,
        x_center=0.77,
        y_support=y_well,
        z_center=0.36,
        width=0.78,
        mats=mats,
        seat_mat=mats["BusSeat"],
        aisle_side=-1,
        y_aisle_floor=y_rear,
        on_wheelhouse=True,
    )
    # Row 3 (Z=-0.44, over rear of rear wheelhouse — solid wheelhouse riser + inner floor legs!)
    _add_seat(
        mb,
        x_center=0.77,
        y_support=y_well,
        z_center=-0.44,
        width=0.78,
        mats=mats,
        seat_mat=mats["BusSeat"],
        aisle_side=-1,
        y_aisle_floor=y_rear,
        on_wheelhouse=True,
    )
    # Row 4 (Z=-1.24, on rear raised floor)
    _add_seat(
        mb,
        x_center=0.77,
        y_support=y_rear,
        z_center=-1.24,
        width=0.78,
        mats=mats,
        seat_mat=mats["BusSeat"],
        aisle_side=-1,
        y_aisle_floor=y_rear,
        on_wheelhouse=False,
    )
    # Row 5 (Z=-2.06, on rear raised floor)
    _add_seat(
        mb,
        x_center=0.77,
        y_support=y_rear,
        z_center=-2.06,
        width=0.78,
        mats=mats,
        seat_mat=mats["BusSeat"],
        aisle_side=-1,
        y_aisle_floor=y_rear,
        on_wheelhouse=False,
    )

    # Right (-X) paired forward-facing royal-blue checked moquette seats
    # Row 1 (Z=1.18, on rear raised floor)
    _add_seat(
        mb,
        x_center=-0.77,
        y_support=y_rear,
        z_center=1.18,
        width=0.78,
        mats=mats,
        seat_mat=mats["BusSeat"],
        aisle_side=1,
        y_aisle_floor=y_rear,
        on_wheelhouse=False,
    )
    # Row 2 (Z=0.36, over front of rear wheelhouse — solid wheelhouse riser + inner floor legs!)
    _add_seat(
        mb,
        x_center=-0.77,
        y_support=y_well,
        z_center=0.36,
        width=0.78,
        mats=mats,
        seat_mat=mats["BusSeat"],
        aisle_side=1,
        y_aisle_floor=y_rear,
        on_wheelhouse=True,
    )
    # Row 3 (Z=-0.44, over rear of rear wheelhouse — solid wheelhouse riser + inner floor legs!)
    _add_seat(
        mb,
        x_center=-0.77,
        y_support=y_well,
        z_center=-0.44,
        width=0.78,
        mats=mats,
        seat_mat=mats["BusSeat"],
        aisle_side=1,
        y_aisle_floor=y_rear,
        on_wheelhouse=True,
    )
    # Row 4 (Z=-1.24, on rear raised floor ahead of emergency exit door Z=-2.50..-1.82)
    _add_seat(
        mb,
        x_center=-0.77,
        y_support=y_rear,
        z_center=-1.24,
        width=0.78,
        mats=mats,
        seat_mat=mats["BusSeat"],
        aisle_side=1,
        y_aisle_floor=y_rear,
        on_wheelhouse=False,
    )

    # Rear 5-across bench (Z=-3.26, with solid full-width base box down to y_rear)
    _add_rear_bench(mb, y_rear, -3.26, mats)

    return mb.build("InteriorSeats", parent=body_empty, smooth_angle=math.radians(45))


def _build_poles_and_straps(body_empty, mats):
    mb = MeshBuilder()
    y_low = spec.FLOOR_Y_LOW  # 0.33
    y_prio_plat = 0.46
    y_rear = spec.FLOOR_Y_REAR  # 0.79
    cy = spec.CEILING_Y  # 2.34

    # 1. Matte orange vertical stanchion poles (step_60_shot_1, step_60_shot_2, step_60_shot_3)
    low_poles = [
        (0.76, 5.45, y_low),
        (0.74, 4.18, y_low),
        (0.72, 3.31, y_low),
        (0.65, 1.96, y_low),
        (-0.42, 5.20, spec.DRIVER_PLATFORM_Y),  # behind-driver main orange stanchion (step_60_shot_2)
        (-0.56, 3.38, y_prio_plat),
        (-0.70, 1.96, y_prio_plat),  # outside mid-cabin monitor (-0.65..-0.19)
    ]
    for px, pz, py0 in low_poles:
        _add_stanchion(mb, px, pz, py0, cy, mats, orange=True)

    rear_poles = [
        (0.36, 0.96),
        (-0.36, 0.96),
        (0.36, 0.14),
        (-0.36, 0.14),
        (0.36, -1.44),
        (-0.36, -1.44),
        (0.36, -2.26),
    ]
    for px, pz in rear_poles:
        _add_stanchion(mb, px, pz, y_rear, cy, mats, orange=True)

    # 2. Behind-driver & cockpit-zone orange U-shaped tubular safety guard bars (step_60_shot_2.png!)
    # U-bar on top of behind-driver partition (adapted to WIN_SILL_Y = 1.15)
    mb.tube(
        [
            (-0.84, 1.19, 5.205),
            (-0.84, 1.48, 5.205),
            (-0.52, 1.48, 5.205),
            (-0.42, 1.38, 5.205),
        ],
        0.015,
        8,
        mats["BusPole"],
        caps=True,
    )
    # Orange U-bar along driver's left console / behind farebox (step_60_shot_2.png)
    mb.tube(
        [
            (-0.42, 1.26, 5.22),
            (-0.35, 1.26, 5.52),
            (-0.35, 1.14, 5.88),
            (-0.35, 0.88, 5.88),
        ],
        0.015,
        8,
        mats["BusPole"],
        caps=True,
    )

    # 3. Overhead longitudinal brushed stainless steel handrails & ceiling brackets (step_60_shot_1 & step_60_shot_3)
    y_rail = 2.02
    # Left (+X) continuous overhead handrail
    rx_l = 0.45
    mb.cylinder((rx_l, y_rail, -2.35), (rx_l, y_rail, 5.25), 0.014, 10, mats["BusSteel"])
    for bz in (-2.26, -1.44, 0.14, 0.96, 1.96, 3.35, 4.20, 5.20):
        mb.cylinder((rx_l, y_rail, bz), (rx_l, cy, bz), 0.011, 8, mats["BusSteel"], caps=False)
    mb.tube([(rx_l, y_rail, 5.25), (rx_l, y_rail + 0.14, 5.38), (rx_l, cy, 5.45)], 0.014, 8, mats["BusSteel"])

    # Right (-X) overhead handrail split cleanly before/after mid-cabin LCD monitor at Z=1.95 (step_60_shot_1 & step_60_shot_3)
    rx_r = -0.42
    mb.cylinder((rx_r, y_rail, -2.35), (rx_r, y_rail, 1.70), 0.014, 10, mats["BusSteel"])
    mb.tube([(rx_r, y_rail, 1.70), (rx_r, y_rail + 0.14, 1.76), (rx_r, cy, 1.80)], 0.014, 8, mats["BusSteel"])
    mb.tube([(rx_r, cy, 2.10), (rx_r, y_rail + 0.14, 2.14), (rx_r, y_rail, 2.20)], 0.014, 8, mats["BusSteel"])
    mb.cylinder((rx_r, y_rail, 2.20), (rx_r, y_rail, 5.25), 0.014, 10, mats["BusSteel"])
    for bz in (-2.26, -1.44, 0.14, 0.96, 2.30, 3.35, 4.20, 5.20):
        mb.cylinder((rx_r, y_rail, bz), (rx_r, cy, bz), 0.011, 8, mats["BusSteel"], caps=False)
    mb.tube([(rx_r, y_rail, 5.25), (rx_r, y_rail + 0.14, 5.38), (rx_r, cy, 5.45)], 0.014, 8, mats["BusSteel"])

    # Cross stainless grab bar behind driver partition (step_60_shot_2.png upper left)
    mb.cylinder((-1.15, 2.055, 5.205), (-0.42, 2.055, 5.205), 0.015, 10, mats["BusSteel"])

    # 4. White triangular hanging grab straps ('つり革', step_60_shot_1 & step_60_shot_3)
    for gz in (-1.85, -1.05, -0.25, 0.55, 1.35, 2.25, 2.85, 3.45, 4.05, 4.65):
        _add_grab_strap(mb, rx_l, y_rail, gz, mats)
    for gz in (-1.85, -1.05, -0.25, 0.55, 1.35, 2.38, 2.92, 3.45, 4.05, 4.65):
        _add_grab_strap(mb, rx_r, y_rail, gz, mats)

    # 5. Yellow oval housings with red stop buttons ('降車ボタン') on orange poles (step_60_shot_1 & step_60_shot_2)
    stop_buttons = [
        (0.76, 1.32, 5.45, (0, 0, -1)),
        (0.74, 1.32, 4.18, (-1, 0, 0)),
        (0.72, 1.32, 3.31, (-1, 0, 0)),
        (-0.42, 1.40, 5.20, (0, 0, -1)),  # behind-driver pole stop button in step_60_shot_2!
        (-0.56, 1.32, 3.38, (1, 0, 0)),
        (0.65, 1.32, 1.96, (-1, 0, 0)),
        (-0.70, 1.32, 1.96, (1, 0, 0)),
        (0.36, 1.44, 0.96, (0, 0, -1)),
        (-0.36, 1.44, 0.96, (0, 0, -1)),
        (0.36, 1.44, 0.14, (0, 0, -1)),
        (-0.36, 1.44, 0.14, (0, 0, -1)),
        (0.36, 1.44, -1.44, (0, 0, -1)),
        (-0.36, 1.44, -1.44, (0, 0, -1)),
    ]
    for bx, by, bz, face in stop_buttons:
        _add_stop_button(mb, bx, by, bz, face, mats)

    return mb.build("InteriorPoles", parent=body_empty, smooth_angle=math.radians(45))


def _build_cockpit(body_empty, mats):
    """Photo-accurate Aero Star-S PDG-AA273KAN cockpit & Kyoto City Bus farebox
    (matching step_76_shot_1.png, step_34_shot_2.png, and step_60_shot_2.png)."""
    mb = MeshBuilder()
    y_plat = spec.DRIVER_PLATFORM_Y  # 0.53

    # 1. Air-suspended driver seat (cushion visible at bottom-right of step_76_shot_1;
    #    backrest & headrest kept strictly behind COCKPIT_ANCHOR Z=5.55 so camera never clips)
    sx, sz = -0.78, 5.56
    mb.box((sx - 0.16, y_plat, sz - 0.16), (sx + 0.16, y_plat + 0.23, sz + 0.14), mats["BusInteriorDark"])
    # Blue patterned moquette driver seat cushion (step_76_shot_1.png bottom right)
    mb.box((sx - 0.24, y_plat + 0.23, sz - 0.18), (sx + 0.24, y_plat + 0.35, sz + 0.30), mats["BusSeat"], uv_scale=2.8)
    mb.obox((sx, y_plat + 0.66, 5.34), (0.46, 0.62, 0.10), mats["BusDriverSeat"], rot=Euler((-0.12, 0.0, 0.0), "XYZ"))
    mb.obox((sx, y_plat + 1.08, 5.32), (0.26, 0.20, 0.09), mats["BusDriverSeat"], rot=Euler((-0.10, 0.0, 0.0), "XYZ"))

    # 2. Main Aero Star-S dashboard structure & left switch wing (-X front, Z=6.43..6.84)
    mb.box((-1.19, y_plat, 6.43), (-0.33, 1.16, 6.84), mats["BusInteriorDark"], skip=("-y",))
    # Wide sculpted upper binnacle housing behind gauges & left switch panel (back wall at Z=6.435 so front elements at Z=6.36..6.42 are 100% visible!)
    mb.box((-1.08, 1.12, 6.435), (-0.34, 1.455, 6.68), mats["BusInteriorDark"])
    # Upper visor brow & outer side cheeks framing the recessed instrument binnacle (step_76_shot_1.png)
    mb.box((-1.08, 1.44, 6.37), (-0.34, 1.47, 6.44), mats["BusInteriorDark"])
    mb.box((-1.08, 1.12, 6.37), (-1.05, 1.455, 6.44), mats["BusInteriorDark"])
    mb.box((-0.36, 1.12, 6.37), (-0.34, 1.455, 6.44), mats["BusInteriorDark"])
    mb.box((-0.56, 1.12, 6.385), (-0.535, 1.445, 6.44), mats["BusInteriorDark"])  # divider pillar between gauges & left switch panel
    # Recessed grey instrument cluster surround bezel directly behind steering wheel
    mb.box((-0.985, 1.185, 6.418), (-0.555, 1.44, 6.44), mats["BusGray"])
    # 3-Dial Analog Instrument Cluster (`BusGauges`: left Speedometer, center Tachometer, right Fuel/Air)
    # Positioned at Y=1.315, Z=6.395 so from COCKPIT_ANCHOR (-0.78, 1.93, 5.55)
    # it sits cleanly inside the open upper arch of the 2-spoke steering wheel at (-0.78, 1.38, 6.12)!
    tilt_g = 0.14
    mb.rect(
        (-0.77, 1.315, 6.395),
        (-1, 0, 0),
        (0, math.cos(tilt_g), math.sin(tilt_g)),
        0.41,
        0.21,
        mats["BusGauges"],
    )

    # Right binnacle wing (X = -1.05..-0.985): small round sub-gauge, green vertical LED bar & rocker switch
    mb.cylinder((-1.02, 1.385, 6.395), (-1.02, 1.385, 6.435), 0.022, 12, mats["BusPureWhite"])
    mb.torus((-1.02, 1.385, 6.395), (0.0, 0.0, -1.0), 0.022, 0.004, 12, 6, mats["BusTrim"])
    mb.box((-1.028, 1.295, 6.395), (-1.012, 1.345, 6.435), mats["BusGreenLamp"])
    mb.box((-1.030, 1.225, 6.395), (-1.010, 1.265, 6.435), mats["BusTrim"])

    # 3. Left Dash Switch Panel, Top Stop-Request Indicator Pods, Shift Lever with Boot & Parking Brake Knob
    # Two stalk-mounted hooded stop-request pods on top-left of dashboard cowling (left = '停車', right = wheelchair)
    pod_rot = Euler((0.34, 0.32, 0.0), "XYZ")
    pod_R = pod_rot.to_matrix()
    u_pod = pod_R @ Vector((-1.0, 0.0, 0.0))
    v_pod = pod_R @ Vector((0.0, 1.0, 0.0))
    n_pod = u_pod.cross(v_pod).normalized()
    pw, ph, pt = 0.084, 0.056, 0.044
    hood_t, hood_d = 0.006, 0.010
    for px, mat_key in ((-0.50, "BusDashStopLamp"), (-0.40, "BusDashWheelchairLamp")):
        mb.cylinder((px, 1.465, 6.41), (px, 1.473, 6.41), 0.022, 10, mats["BusTrim"])
        mb.cylinder((px, 1.470, 6.41), (px, 1.502, 6.40), 0.0085, 8, mats["BusTrim"])
        pod_c = Vector((px, 1.526, 6.40))
        mb.obox(pod_c, (pw, ph, pt), mats["BusTrim"], rot=pod_rot)
        rim_c = pod_c + n_pod * (pt * 0.5 + hood_d * 0.5)
        mb.obox(rim_c + v_pod * ((ph - hood_t) * 0.5), (pw, hood_t, hood_d), mats["BusTrim"], rot=pod_rot)
        mb.obox(rim_c - v_pod * ((ph - hood_t) * 0.5), (pw, hood_t, hood_d), mats["BusTrim"], rot=pod_rot)
        mb.obox(rim_c + u_pod * ((pw - hood_t) * 0.5), (hood_t, ph - 2 * hood_t, hood_d), mats["BusTrim"], rot=pod_rot)
        mb.obox(rim_c - u_pod * ((pw - hood_t) * 0.5), (hood_t, ph - 2 * hood_t, hood_d), mats["BusTrim"], rot=pod_rot)
        mb.rect(pod_c + n_pod * 0.023, u_pod, v_pod, 0.072, 0.044, mats[mat_key])
    # Upper-left white route/safety instruction card plaque & green/amber LEDs (proud of Z=6.435 back wall)
    mb.box((-0.50, 1.32, 6.395), (-0.40, 1.435, 6.435), mats["BusPureWhite"])
    mb.box((-0.49, 1.37, 6.390), (-0.41, 1.41, 6.398), mats["BusRed"])
    mb.box((-0.49, 1.30, 6.392), (-0.41, 1.317, 6.435), mats["BusGreenLamp"])
    # Silver-bordered rectangular switch matrix on lower-left dash face
    mb.box((-0.525, 1.165, 6.405), (-0.365, 1.285, 6.435), mats["BusSteel"])
    mb.box((-0.517, 1.173, 6.398), (-0.373, 1.277, 6.410), mats["BusTrim"])
    # Orange/yellow square indicator switches + two white/grey rectangular reset buttons ('リセット') below
    for bx, col in ((-0.495, mats["BusPureWhite"]), (-0.395, mats["BusAmber"])):
        mb.box((bx - 0.015, 1.195, 6.390), (bx + 0.015, 1.23, 6.402), col)
    for rx in (-0.48, -0.41):
        mb.box((rx - 0.024, 1.133, 6.395), (rx + 0.024, 1.159, 6.435), mats["BusSwitchPanelWhite"])

    # Manual/automated gear shift lever with square ribbed rubber boot & round black knob (step_76_shot_1 bottom-left)
    mb.box((-0.52, y_plat, 6.08), (-0.36, 0.91, 6.36), mats["BusInteriorDark"])
    # Ribbed rubber accordion boot (`BusRubber`)
    for k in range(4):
        s_pad = 0.075 - k * 0.012
        y_b0 = 0.91 + k * 0.022
        mb.box((-0.44 - s_pad, y_b0, 6.18 - s_pad), (-0.44 + s_pad, y_b0 + 0.020, 6.18 + s_pad), mats["BusRubber"])
    # Shift rod & round black shift knob
    mb.cylinder((-0.44, 0.99, 6.18), (-0.44, 1.09, 6.15), 0.011, 8, mats["BusTrim"])
    mb.sphere((-0.44, 1.105, 6.145), 0.028, 12, 8, mats["BusTrim"])

    # Parking brake valve lever & black pull knob with white 'OFF / PARK' plate (step_76_shot_1 between wheel & shifter)
    mb.box((-0.58, 1.08, 6.29), (-0.54, 1.11, 6.32), mats["BusPureWhite"])
    mb.box((-0.585, 1.00, 6.26), (-0.535, 1.07, 6.31), mats["BusTrim"])
    mb.cylinder((-0.56, 1.03, 6.27), (-0.55, 0.98, 6.20), 0.010, 8, mats["BusTrim"])
    mb.sphere((-0.55, 0.975, 6.195), 0.020, 10, 8, mats["BusRubber"])

    # 4. Right-Side Driver Console, Angled Blue LCD Monitor & White Door-Switch Plate (step_76_shot_1.png right!)
    mb.box((-1.195, y_plat, 5.58), (-0.98, 1.09, 6.42), mats["BusInteriorDark"])
    # Brushed aluminium edge rail along inner edge of right console
    mb.box((-1.00, 1.08, 5.62), (-0.975, 1.105, 6.34), mats["BusSteel"])
    # Distinctive WHITE rectangular door-switch plate on top of right console (`BusSwitchPanelWhite`)
    mb.box((-1.16, 1.09, 5.88), (-1.01, 1.112, 6.18), mats["BusSwitchPanelWhite"])
    # Door control toggle lever, rotary knobs, and red/black buttons on the white switch plate
    for kz, kmat in ((5.93, mats["BusTrim"]), (6.01, mats["BusSteel"]), (6.09, mats["BusTrim"]), (6.14, mats["BusRed"])):
        mb.cylinder((-1.06, 1.112, kz), (-1.06, 1.138, kz), 0.014, 10, kmat)
        mb.cylinder((-1.12, 1.112, kz), (-1.12, 1.135, kz), 0.011, 8, mats["BusTrim"])
    mb.cylinder((-1.08, 1.112, 5.98), (-1.08, 1.175, 5.96), 0.007, 8, mats["BusSteel"])  # toggle lever stalk

    # Row of silver toggle switches & yellow labels along inner vertical wall of right console
    for sz_sw in (5.92, 6.00, 6.08, 6.16, 6.24):
        mb.cylinder((-0.98, 1.01, sz_sw), (-0.95, 1.02, sz_sw), 0.006, 6, mats["BusSteel"])
        mb.box((-0.982, 0.96, sz_sw - 0.015), (-0.975, 0.98, sz_sw + 0.015), mats["BusYellowEdge"])

    # Angled dark-grey LCD route/timetable monitor mounted behind farebox (windshield side), facing driver
    mon_pos = Vector((-0.08, 1.38, 6.66))
    mon_rot = Euler((0.24, 0.50, 0.0), "XYZ")
    mb.box((-0.14, 1.11, 6.76), (-0.02, 1.15, 6.89), mats["BusTrim"])
    mb.tube([(-0.08, 1.14, 6.83), (-0.08, 1.25, 6.74), (-0.08, 1.34, 6.68)], 0.016, 8, mats["BusTrim"], caps=True)
    mb.obox(mon_pos, (0.22, 0.16, 0.045), mats["BusTrim"], rot=mon_rot)
    # Blank dark unlit LCD screen facing driver
    u_mon = mon_rot.to_matrix() @ Vector((-1.0, 0.0, 0.0))
    v_mon = mon_rot.to_matrix() @ Vector((0.0, 1.0, 0.0))
    n_mon = u_mon.cross(v_mon).normalized()
    c_mon = mon_pos + n_mon * 0.024
    mb.rect(c_mon, u_mon, v_mon, 0.185, 0.125, mats["BusMonitorBlank"])

    # 5. Kyoto City Bus Upright Grey Farebox ('運賃箱') & Curved Stainless U-Guardrail (step_34_shot_2.png!)
    fx, fz = -0.18, 6.18
    # Lower grey metal pedestal & main cabinet (`BusFareboxBody` #90948C)
    mb.box((fx - 0.13, spec.FLOOR_Y_LOW, fz - 0.15), (fx + 0.13, 0.96, fz + 0.15), mats["BusFareboxBody"])
    # Dark coin collection box housing on rear face of lower cabinet
    mb.box((fx - 0.09, 0.62, fz - 0.185), (fx + 0.05, 0.88, fz - 0.15), mats["BusTrim"])
    # Upper main farebox body (Y=0.96..1.22)
    mb.box((fx - 0.135, 0.96, fz - 0.15), (fx + 0.135, 1.22, fz + 0.15), mats["BusFareboxBody"])

    # Rear-left (+X, aisle half): Light-grey square IC card touch pad on top + dark front with green card slot!
    mb.box((fx + 0.005, 1.21, fz - 0.145), (fx + 0.13, 1.26, fz - 0.01), mats["BusPureWhite"])
    mb.box((fx + 0.035, 1.261, fz - 0.115), (fx + 0.10, 1.265, fz - 0.04), mats["BusIcReader"])
    mb.box((fx + 0.005, 0.96, fz - 0.175), (fx + 0.13, 1.21, fz - 0.14), mats["BusTrim"])
    # White/red '[↓カード]' label & protruding green magnetic card slot (`BusCardSlotGreen`)
    mb.box((fx + 0.025, 1.13, fz - 0.178), (fx + 0.11, 1.18, fz - 0.172), mats["BusPureWhite"])
    mb.box((fx + 0.030, 1.03, fz - 0.184), (fx + 0.105, 1.08, fz - 0.168), mats["BusCardSlotGreen"])

    # Rear-right (-X, driver half): Blue-purple coin/bill changer module ('両替', `BusFareboxChanger` #434A78)
    mb.box((fx - 0.13, 0.96, fz - 0.175), (fx - 0.005, 1.23, fz - 0.01), mats["BusFareboxChanger"])
    mb.box((fx - 0.12, 1.231, fz - 0.16), (fx - 0.015, 1.242, fz - 0.03), mats["BusSteel"])

    # Top-center red-rimmed clear acrylic coin/ticket hopper ('運賃')
    mb.box((fx - 0.075, 1.22, fz + 0.00), (fx + 0.075, 1.30, fz + 0.11), mats["BusRed"])
    mb.box((fx - 0.062, 1.23, fz + 0.01), (fx + 0.062, 1.32, fz + 0.10), mats["BusGlass"])

    # Angled textured top deck (`BusFareboxDisplay`)
    mb.rect(
        (fx, 1.268, fz - 0.02),
        (-1, 0, 0),
        (0, math.sin(0.18), math.cos(0.18)),
        0.25,
        0.27,
        mats["BusFareboxDisplay"],
    )

    # Top angled black LCD screen hood at front of farebox facing rearward/driver (step_34_shot_2.png top!)
    mb.obox((fx, 1.36, fz + 0.11), (0.23, 0.12, 0.035), mats["BusTrim"], rot=Euler((0.16, 0.0, 0.0), "XYZ"))
    mb.box((fx - 0.03, 1.39, fz + 0.091), (fx - 0.01, 1.408, fz + 0.096), mats["BusYellowEdge"])

    # Driver-side angled white/orange keypad wing protruding from right (-X) side of farebox
    mb.obox((fx - 0.155, 1.02, fz - 0.02), (0.06, 0.16, 0.22), mats["BusPureWhite"], rot=Euler((0.0, 0.0, 0.35), "XYZ"))

    # Curved polished stainless steel U-guardrail wrapping around aisle side (+X) of farebox (step_34_shot_2.png left!)
    gx = fx + 0.165
    mb.tube(
        [
            (gx, spec.FLOOR_Y_LOW, fz - 0.18),
            (gx, 0.72, fz - 0.20),
            (gx, 1.18, fz - 0.18),
            (gx, 1.42, fz - 0.06),
            (gx, 1.44, fz + 0.10),
            (gx - 0.08, 1.36, fz + 0.16),
            (fx - 0.10, 1.30, fz + 0.16),
        ],
        0.016,
        10,
        mats["BusChrome"],
        caps=True,
    )
    # Dark padded grip sleeve over the top arch of the stainless farebox guardrail (step_34_shot_2.png)
    mb.tube(
        [
            (gx, 1.24, fz - 0.15),
            (gx, 1.42, fz - 0.06),
            (gx, 1.44, fz + 0.10),
        ],
        0.021,
        10,
        mats["BusInteriorDark"],
        caps=True,
    )

    # 6. Overhead Sunvisor & Driver Rearview Mirror (step_60_shot_2.png, adapted to WINDSHIELD_TOP_Y=2.14 & CEILING_Y=2.34)
    mb.obox((-0.76, 2.085, 6.56), (0.58, 0.095, 0.010), mats["BusGlassDark"], rot=Euler((0.22, 0.0, 0.0), "XYZ"))
    mb.box((-1.05, 2.13, 6.54), (-0.47, 2.155, 6.57), mats["BusTrim"])
    m_rot = Euler((0.15, -0.32, 0.0), "XYZ")
    mb.obox((-0.20, 2.00, 6.43), (0.24, 0.085, 0.018), mats["BusTrim"], rot=m_rot)
    mb.obox((-0.20, 2.00, 6.420), (0.22, 0.070, 0.006), mats["BusChrome"], rot=m_rot)
    mb.cylinder((-0.20, 2.04, 6.44), (-0.20, 2.14, 6.47), 0.009, 6, mats["BusTrim"])

    # Fixed steering column lower shroud connecting floor/dash up to SteeringColumn pivot
    sc = spec.STEERING_CENTER  # (-0.78, 1.38, 6.12)
    mb.cylinder(sc, (sc[0], 0.94, 6.46), 0.045, 12, mats["BusTrim"])
    # Turn signal / wiper right stalk & exhaust brake left stalk on steering column shroud
    mb.cylinder((sc[0] - 0.04, sc[1] - 0.04, sc[2] + 0.04), (sc[0] - 0.18, sc[1] + 0.01, sc[2] + 0.01), 0.010, 8, mats["BusTrim"])
    mb.cylinder((sc[0] + 0.04, sc[1] - 0.04, sc[2] + 0.04), (sc[0] + 0.18, sc[1] + 0.02, sc[2] + 0.01), 0.012, 8, mats["BusTrim"])

    cockpit_obj = mb.build("InteriorCockpit", parent=body_empty, smooth_angle=math.radians(40))

    # 7. SteeringColumn Empty -> 2-Spoke Aero Star-S SteeringWheel Mesh (step_76_shot_1.png!)
    # Centered at local (0,0,0) in local X-Y plane so `steering.rotation.z = -bus.delta * 9`
    # spins cleanly in-plane in Three.js, leaving the entire upper half open to view the 3-dial gauges!
    col_empty = new_empty(
        "SteeringColumn",
        location=sc,
        parent=body_empty,
        rotation=(spec.STEERING_TILT, 0.0, 0.0),
        size=0.15,
    )
    wmb = MeshBuilder()
    wheel_r = 0.235
    # Dark-grey steering wheel rim torus in local X-Y plane (normal = local -Z toward driver)
    wmb.torus((0.0, 0.0, 0.0), (0.0, 0.0, -1.0), wheel_r, 0.020, 32, 12, mats["BusInteriorDark"])

    # Wide sculpted horizontal 2-spoke center horn pad (leaves upper half 100% open!)
    wmb.obox((0.0, -0.008, -0.006), (0.175, 0.078, 0.042), mats["BusInteriorDark"])
    wmb.obox((0.0, 0.018, -0.008), (0.145, 0.036, 0.038), mats["BusInteriorDark"])

    # Two thick angled side/lower spokes + lower thumb-rest Transition flanges (step_76_shot_1.png)
    # Note: In SteeringWheel local coords, +X is left (curb), -X is right (driver), +Y is up toward gauges, -Y is down.
    for sx in (-1, 1):
        # Main upper-side spoke sweeping slightly downward from horn pad to rim at ~ -22 deg
        wmb.beam(
            (sx * 0.070, 0.002, -0.005),
            (sx * (wheel_r - 0.012) * math.cos(math.radians(20)), -(wheel_r - 0.012) * math.sin(math.radians(20)), 0.0),
            0.044,
            0.026,
            mats["BusInteriorDark"],
            up=(0, 0, -1),
        )
        # Lower angled spoke arm framing the single lower central opening (~ -52 deg)
        wmb.beam(
            (sx * 0.058, -0.032, -0.004),
            (sx * (wheel_r - 0.012) * math.cos(math.radians(48)), -(wheel_r - 0.012) * math.sin(math.radians(48)), 0.0),
            0.038,
            0.024,
            mats["BusInteriorDark"],
            up=(0, 0, -1),
        )

    # Small recessed horizontal black Mitsubishi 3-Diamond emblem in center of horn pad (step_76_shot_1.png!)
    wmb.box((-0.036, -0.014, -0.029), (0.036, 0.008, -0.025), mats["BusTrim"])
    wmb.rect(
        (0.0, -0.003, -0.0295),
        (-1.0, 0.0, 0.0),
        (0.0, 1.0, 0.0),
        0.064,
        0.018,
        mats["BusSteeringEmblem"],
    )

    # Rear hub boss connecting to steering column shaft
    wmb.cylinder((0.0, 0.0, 0.015), (0.0, 0.0, 0.13), 0.036, 12, mats["BusTrim"])
    wmb.build("SteeringWheel", parent=col_empty, smooth_angle=math.radians(45))

    return cockpit_obj


def build(body_empty, mats):
    """Build complete PDG-AA273KAN interior & cockpit under `body_empty`."""
    objs = [
        _build_floor_and_trim(body_empty, mats),
        _build_seats(body_empty, mats),
        _build_poles_and_straps(body_empty, mats),
        _build_cockpit(body_empty, mats),
    ]
    return objs
