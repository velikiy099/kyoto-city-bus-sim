"""275/70R22.5 tires, front single steel wheels, and rear dual wheels for PDG-AA273KAN.

Node hierarchy contract (required by src/bus/busModel.js):
  WheelPivotFL (Empty at (+1.025, 0.460, +4.800)) -> child mesh WheelFL at local (0,0,0)
  WheelPivotFR (Empty at (-1.025, 0.460, +4.800)) -> child mesh WheelFR at local (0,0,0)
  WheelPivotRL (Empty at (+0.918, 0.460,  0.000)) -> child mesh WheelRL at local (0,0,0)
  WheelPivotRR (Empty at (-0.918, 0.460,  0.000)) -> child mesh WheelRR at local (0,0,0)

Each wheel spins around its local X axis (`w.tire.rotation.x = wheelSpin`).
Steel wheel rims are painted body-color pale sage-green (`#BAC8AC`, `BusWheelRim`)
with dark center hub, dark lug nuts, and hand-hole recesses (`step_54_shot_1.png`, `step_56_shot_1.png`).
"""
import math

from . import spec
from .geom import MeshBuilder, new_empty


def _add_revolved_profile(mb, profile, seg, mat, smooth=True):
    """Revolve an (x, r) profile around the local X axis.

    Consecutive profile points `(x0, r0) -> (x1, r1)` are wound so the outward normal
    points away from the tire/rim interior.
    """
    rings = []
    for x, r in profile:
        ring = []
        for i in range(seg):
            a = 2.0 * math.pi * i / seg
            ring.append(mb.add_vert((x, r * math.cos(a), r * math.sin(a))))
        rings.append(ring)
    for k in range(len(rings) - 1):
        r0, r1 = rings[k], rings[k + 1]
        for i in range(seg):
            j = (i + 1) % seg
            mb.add_face([r0[i], r0[j], r1[j], r1[i]], mat, None, smooth)


def _add_tire(mb, x_center, mats, seg=28):
    """Build one 275/70R22.5 heavy-duty radial bus tire centered at local x = x_center."""
    r_out = spec.TIRE_RADIUS  # 0.460 m loaded radius
    r_sh = r_out - 0.018  # shoulder radius
    r_mid = 0.385  # sidewall maximum bulge radius
    r_bead = spec.RIM_RADIUS + 0.012  # 0.298 m rim flange contact
    hw = spec.TIRE_WIDTH * 0.5  # 0.1375 m
    ht = hw * 0.78  # tread half-width 0.107 m
    hm = hw * 1.00  # sidewall bulge half-width
    hb = hw * 0.80  # bead half-width

    profile = [
        (x_center - hb, r_bead),
        (x_center - hm, r_mid),
        (x_center - ht, r_sh),
        (x_center - ht * 0.72, r_out),
        (x_center - ht * 0.36, r_out),
        (x_center - ht * 0.32, r_out - 0.007),
        (x_center - ht * 0.28, r_out),
        (x_center + ht * 0.28, r_out),
        (x_center + ht * 0.32, r_out - 0.007),
        (x_center + ht * 0.36, r_out),
        (x_center + ht * 0.72, r_out),
        (x_center + ht, r_sh),
        (x_center + hm, r_mid),
        (x_center + hb, r_bead),
    ]
    _add_revolved_profile(mb, profile, seg, mats["BusTire"], smooth=True)


def _add_front_wheel_hardware(mb, side, mats, seg=28):
    """Outward-dished 22.5-inch pale sage-green steel wheel rim, dark hub cap, and 10 JIS lug nuts.

    side = +1 for left (+X curb side), -1 for right (-X driver side).
    """
    r_flange = spec.RIM_RADIUS + 0.014  # 0.300 m
    r_drop = spec.RIM_RADIUS - 0.010  # 0.276 m
    r_dish = 0.220
    r_bolt_face = 0.135
    r_hub = 0.095
    rim_mat = mats["BusWheelRim"]

    if side > 0:
        rim_prof = [
            (-0.105, r_flange),
            (-0.085, r_drop),
            (0.065, r_drop),
            (0.108, r_flange),
            (0.095, r_flange - 0.015),
            (0.072, r_dish),
            (0.098, r_bolt_face),
            (0.098, r_hub),
        ]
    else:
        rim_prof = [
            (-0.098, r_hub),
            (-0.098, r_bolt_face),
            (-0.072, r_dish),
            (-0.095, r_flange - 0.015),
            (-0.108, r_flange),
            (-0.065, r_drop),
            (0.085, r_drop),
            (0.105, r_flange),
        ]
    _add_revolved_profile(mb, rim_prof, seg, rim_mat, smooth=True)

    # Dark center front axle hub & pale-sage hub ring
    x_hub0 = side * 0.05
    x_hub1 = side * 0.126
    p0, p1 = ((x_hub0, 0, 0), (x_hub1, 0, 0)) if side > 0 else ((x_hub1, 0, 0), (x_hub0, 0, 0))
    mb.cylinder(p0, p1, r_hub, 16, mats["BusAxleDark"])
    mb.cylinder(
        (side * 0.120, 0, 0) if side > 0 else (side * 0.134, 0, 0),
        (side * 0.134, 0, 0) if side > 0 else (side * 0.120, 0, 0),
        r_hub * 0.62, 12, mats["BusAxleDark"],
    )

    # 10 dark lug nuts + 8 dark hand-hole cutouts around the pale-sage wheel disc
    r_lug = 0.156
    r_vent = 0.232
    for k in range(10):
        ang = 2.0 * math.pi * k / 10.0
        ly, lz = r_lug * math.cos(ang), r_lug * math.sin(ang)
        x_a, x_b = (0.092, 0.114) if side > 0 else (-0.114, -0.092)
        mb.cylinder((x_a, ly, lz), (x_b, ly, lz), 0.014, 6, mats["BusAxleDark"])
    for k in range(8):
        vang = 2.0 * math.pi * (k + 0.5) / 8.0
        vy, vz = r_vent * math.cos(vang), r_vent * math.sin(vang)
        vx_a, vx_b = (0.072, 0.090) if side > 0 else (-0.090, -0.072)
        mb.cylinder((vx_a, vy, vz), (vx_b, vy, vz), 0.025, 8, mats["BusAxleDark"])


def _add_rear_dual_wheel_hardware(mb, side, mats, seg=28):
    """Deep-dish dual rear pale sage-green steel wheel rim, dark planetary axle hub, and 10 lug nuts."""
    dx = spec.DUAL_SPACING * 0.5  # 0.160 m
    r_flange = spec.RIM_RADIUS + 0.014  # 0.300 m
    r_drop = spec.RIM_RADIUS - 0.010
    r_dish = 0.215
    r_hub = 0.116
    rim_mat = mats["BusWheelRim"]

    x_out = side * dx
    if side > 0:
        rim_prof = [
            (-dx - 0.10, r_flange),
            (-dx + 0.08, r_drop),
            (x_out - 0.08, r_drop),
            (x_out + 0.105, r_flange),
            (x_out + 0.085, r_flange - 0.018),
            (x_out - 0.035, r_dish),
            (x_out - 0.045, r_hub),
        ]
    else:
        rim_prof = [
            (x_out + 0.045, r_hub),
            (x_out + 0.035, r_dish),
            (x_out - 0.085, r_flange - 0.018),
            (x_out - 0.105, r_flange),
            (x_out + 0.08, r_drop),
            (dx - 0.08, r_drop),
            (dx + 0.10, r_flange),
        ]
    _add_revolved_profile(mb, rim_prof, seg, rim_mat, smooth=True)

    # Prominent dark planetary reduction rear axle hub
    xh0, xh1 = (-0.05, x_out + 0.082) if side > 0 else (x_out - 0.082, 0.05)
    mb.cylinder((xh0, 0, 0), (xh1, 0, 0), r_hub, 16, mats["BusAxleDark"])
    xh2, xh3 = (x_out + 0.072, x_out + 0.092) if side > 0 else (x_out - 0.092, x_out - 0.072)
    mb.cylinder((xh2, 0, 0), (xh3, 0, 0), r_hub * 0.72, 12, mats["BusAxleDark"])

    # 10 rear lug nuts + 8 deep-dish ventilation slots
    r_lug = 0.154
    r_vent = 0.232
    for k in range(10):
        ang = 2.0 * math.pi * k / 10.0
        ly, lz = r_lug * math.cos(ang), r_lug * math.sin(ang)
        la, lb = (x_out - 0.042, x_out - 0.015) if side > 0 else (x_out + 0.015, x_out + 0.042)
        mb.cylinder((la, ly, lz), (lb, ly, lz), 0.015, 6, mats["BusAxleDark"])
    for k in range(8):
        vang = 2.0 * math.pi * (k + 0.5) / 8.0
        vy, vz = r_vent * math.cos(vang), r_vent * math.sin(vang)
        va, vb = (x_out - 0.016, x_out + 0.008) if side > 0 else (x_out - 0.008, x_out + 0.016)
        mb.cylinder((va, vy, vz), (vb, vy, vz), 0.025, 8, mats["BusAxleDark"])


def build(mats):
    """Build WheelPivotFL/FR/RL/RR Empties and child WheelFL/FR/RL/RR Meshes."""
    pivots = {}
    configs = [
        ("FL", +1, False),
        ("FR", -1, False),
        ("RL", +1, True),
        ("RR", -1, True),
    ]
    for code, side, is_dual in configs:
        center = spec.WHEEL_CENTERS[code]
        pivot = new_empty(f"WheelPivot{code}", location=center, parent=None, size=0.25)
        mb = MeshBuilder()
        if not is_dual:
            _add_tire(mb, 0.0, mats)
            _add_front_wheel_hardware(mb, side, mats)
        else:
            dx = spec.DUAL_SPACING * 0.5
            _add_tire(mb, -dx, mats)
            _add_tire(mb, +dx, mats)
            _add_rear_dual_wheel_hardware(mb, side, mats)
        wheel_obj = mb.build(f"Wheel{code}", parent=pivot)
        wheel_obj.location = (0.0, 0.0, 0.0)
        wheel_obj.rotation_euler = (0.0, 0.0, 0.0)
        pivots[code] = pivot
    return pivots


build_wheels = build
