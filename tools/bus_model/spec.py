"""Kyoto City Bus PDG-AA273KAN (Nishinippon Shatai 96MC B-I) — shared geometry spec.

Fleet #1771 (京都200か17-71), Yokooji depot / Route 18, Thermo King domed roof HVAC.
Source: real photographs (media_1795459256215_6051fd0f.jpg, #1771, #1777, #1778, #1785).

COORDINATE SYSTEM:
  All module builders (`exterior.py`, `interior.py`, `wheels.py`) specify coordinates in
  logical Body / Three.js space:
    origin (0,0,0) = ground under REAR AXLE CENTER
    +X = left (curb / door side), -X = right (driver side)
    +Y = up (ground Y=0, roof crown Y=2.65, Thermo King HVAC top Y=2.99)
    +Z = forward (rear axle Z=0, front axle Z=+4.80, front bumper Z=+7.01, rear bumper Z=-3.48)

  `geom.py` (`MeshBuilder.build` and `new_empty`) automatically transforms logical
  `(x, y_up, z_fwd)` into Blender-native Z-up `(x_bl, y_bl, z_bl) = (x, -z_fwd, y_up)`
  so the bus sits upright on Z=0 in `.blend` (front facing -Y, Numpad 1 Front View).
  Exporting `public/models/bus.glb` with `export_yup=True` maps Blender `(x, -z_fwd, y_up)`
  back to glTF/Three.js `(x, y_up, z_fwd)` 1:1.

Pure-python module (no bpy) so both exterior.py and interior.py can import it.
"""
import math

# ---------------------------------------------------------------- fleet
FLEET_NO = "1771"
PLATE_TOP = "京都 200"
PLATE_KANA = "か"
PLATE_NUM = "17-71"

# ---------------------------------------------------------------- main dimensions
LENGTH = 10.49
WIDTH = 2.49
HALF_W = WIDTH / 2.0  # 1.245 outer body wall
WHEELBASE = 4.80
FOH = 2.21
ROH = 3.48
TOTAL_HEIGHT = 2.86  # top of two-section Thermo King HVAC dome (rises ~0.21m above ROOF_CROWN_Y=2.65)

Z_FRONT_BUMPER = WHEELBASE + FOH  # +7.01 (bumper tip)
Z_REAR_BUMPER = -ROH  # -3.48 (bumper tip)
Z_FRONT = 6.95  # front body panel (at Y <= RAKE_Y0)
Z_REAR = -3.42  # rear body panel

# Body shell (matched to real 96MC B-I side & rear photos) ----------------
WALL_T = 0.04  # shell thickness (outer skin -> inner trim)
INNER_HALF_W = HALF_W - WALL_T  # 1.205 inner wall surface
SKIRT_Y = 0.28  # bottom edge of body side panels
WALL_TOP_Y = 2.48  # vertical side wall ends, cant-rail radius starts
CANT_R = 0.12  # roof edge (cant rail) radius, all round
ROOF_EDGE_Y = WALL_TOP_Y + CANT_R  # 2.60 roof at cant rail
ROOF_CAMBER = 0.05  # extra height at centre line -> crown 2.65
ROOF_CROWN_Y = ROOF_EDGE_Y + ROOF_CAMBER  # 2.65
CORNER_R_FRONT = 0.15  # tighter 96MC B-I front corner radius matching media_1795480605239_ac27a741.jpg
CORNER_R_REAR = 0.14  # plan-view radius of rear vertical corners

# True 96MC B-I front profile parameters:
#   - Y <= 1.14: vertical lower nose at Z_FRONT = 6.95
#   - Y = 1.14..2.14: windshield raked rearward ~7.5° (-0.130 m -> Z = 6.820 at Y=2.14)
#   - Y = 2.14..2.16: subtle horizontal drip-lip overhang above windshield (+0.015 m -> Z = 6.835)
#   - Y = 2.16..2.52: near-vertical destination sign brow (~1.5° -> Z = 6.826 at Y=2.52),
#     then rounding smoothly into the roof via cant_inset(y).
RAKE_Y0 = 1.14
WINDSHIELD_TOP_Y = 2.14
WINDSHIELD_RAKE_DZ = 0.130  # 13 cm rearward lean across 1.00 m windshield height (~7.41 deg)
BROW_LIP_Y = 2.16
BROW_LIP_DZ = 0.115  # Z = 6.835 at Y=2.16 (1.5 cm drip-lip overhang over windshield top)
BROW_TOP_DZ = 0.125  # Z = 6.825 at Y=2.52 (~1.5 deg near-vertical front brow)
RAKE_K = 0.130  # nominal windshield rake rate for legacy callers

# ---------------------------------------------------------------- livery bands (outer skin, Y ranges)
# Kyoto City Bus: pale sage-cream #C8D5BB base & roof, dark forest green #3B4F43 S-curve bands,
# metallic silver #A8AEB5 front/rear bumpers, #181B1E black window sashes.
BAND_SKIRT = (0.42, 0.66)  # dark green lower rocker band + thin lower pinstripe (aft of S-curve)
BAND_BELT = (1.06, 1.10)  # thin dark green beltline pinstripe under window sill (WIN_SILL_Y=1.15)
BAND_WINDOW = (1.15, 2.18)  # black window sash band
BAND_REAR_BLACK = (1.66, 2.38)  # rear window glass & black rubber gasket range

# ---------------------------------------------------------------- wheels / tyres (275/70R22.5)
TIRE_RADIUS = 0.46  # loaded radius used by game wheel spin
TIRE_RADIUS_FREE = 0.4795
TIRE_WIDTH = 0.275
RIM_RADIUS = 0.2858  # 22.5 inch bead seat
TRACK_FRONT = 2.05
TRACK_REAR = 1.836  # dual centre
DUAL_SPACING = 0.32  # centre-to-centre of rear twin tyres
WHEEL_CENTERS = {
    "FL": (TRACK_FRONT / 2, TIRE_RADIUS, WHEELBASE),
    "FR": (-TRACK_FRONT / 2, TIRE_RADIUS, WHEELBASE),
    "RL": (TRACK_REAR / 2, TIRE_RADIUS, 0.0),
    "RR": (-TRACK_REAR / 2, TIRE_RADIUS, 0.0),
}
ARCH_R = 0.56  # wheel-arch cut radius about wheel centre -> arch top Y=1.02
ARCH_TOP_Y = TIRE_RADIUS + ARCH_R  # 1.02
ARCH_Z = {"F": (WHEELBASE - ARCH_R, WHEELBASE + ARCH_R), "R": (-ARCH_R, ARCH_R)}
# inner extent of the wheel wells (wheelhouse boxes inside must cover these)
WHEELWELL_INNER_X = {"F": 0.84, "R": 0.62}  # |x| of wheel-well inner wall
WHEELWELL_TOP_Y = {"F": 1.04, "R": 1.04}

# ---------------------------------------------------------------- floor (interior reference)
FLOOR_Y_LOW = 0.33  # non-step front / middle floor top
FLOOR_Y_STEP = 0.56  # intermediate step behind middle door
FLOOR_Y_REAR = 0.79  # rear raised floor (over rear axle / engine)
FLOOR_LOW_Z_REAR = 1.95  # low floor ends here (riser 1 at this Z)
FLOOR_STEP_Z_REAR = 1.60  # step tread ends here (riser 2 at this Z)
CEILING_Y = 2.34  # lower realistic ceiling liner height under ROOF_CROWN_Y = 2.65
DRIVER_PLATFORM_Y = 0.53
DASH_TOP_Y = 1.12

# ---------------------------------------------------------------- doors & openings (left = +X)
DOOR_SILL_Y = 0.32
DOOR_TOP_Y = 2.18
FRONT_DOOR_Z = (5.58, 6.56)  # 2-leaf folding / twin-pane front door with pale-sage lower panels
MID_DOOR_Z = (2.05, 3.25)  # wide single-leaf sliding door with pale-sage lower panel
MID_DOOR_POCKET_Z = (0.88, 1.92)
EMERGENCY_EXIT_Z = (-2.50, -1.82)  # right side (-X), hinged emergency door with pale-sage skin
EMERGENCY_EXIT_Y = (1.00, 2.18)

# ---------------------------------------------------------------- windows
WIN_SILL_Y = 1.15
WIN_HEADER_Y = 2.18
WIN_TRANSOM_Y = (1.88, 1.91)  # reverse-T horizontal transom bar

# (z0, z1, sill_y, header_y, kind)
WINDOWS_LEFT = [
    (4.18, 5.42, 1.15, 2.18, "revT"),  # L-F1 reverse-T window above front wheel
    (3.42, 4.18, 1.15, 2.18, "fixed_dark"),  # L-F2 flush dark panel with entrance/priority stickers
    (0.88, 1.92, 1.15, 2.18, "sign_bay"),  # L-R1 immediately behind middle door (houses full-window SignSideL!)
    (-1.35, 0.85, 1.15, 2.18, "revT"),  # L-R2 wide reverse-T window over rear axle
    (-3.24, -1.39, 1.15, 2.18, "revT"),  # L-R3 rearmost reverse-T + fixed quarter window
]
WINDOWS_RIGHT = [
    (5.45, 6.65, 1.10, 2.16, "driver"),  # driver sliding cab window (pale-sage pillar at 5.25..5.45)
    (4.68, 5.25, 1.15, 2.18, "fixed"),  # narrow fixed window behind driver cab pillar
    (3.12, 4.64, 1.15, 2.18, "revT"),  # R-1 reverse-T window
    (1.56, 3.08, 1.15, 2.18, "revT"),  # R-2 reverse-T window
    (0.00, 1.52, 1.15, 2.18, "revT"),  # R-3 reverse-T window over rear axle
    (-1.62, -0.04, 1.15, 2.18, "revT"),  # R-4 reverse-T window (pale-sage pillar at -1.82..-1.62)
    (-2.43, -1.89, 1.32, 2.08, "exit"),  # emergency exit upper black-framed glass
    (-3.26, -2.65, 1.15, 2.14, "fixed"),  # R-5 rearmost dark-tinted quarter window
]
SAFETY_WINDOW = {"x": (0.56, 1.24), "z": (6.64, 6.95), "y": (0.68, 1.10)}  # left front safety window wrapping to Z=6.64
WINDSHIELD = {"x": 1.24, "y": (1.15, 2.14), "z_wrap_l": 6.64, "z_wrap_r": 6.69}  # wraparound windshield + slim A-pillars!
REAR_WINDOW = {"x": 1.00, "y": (1.66, 2.38)}  # top sits only ~0.22-0.27m below roof edge/crown!

# ---------------------------------------------------------------- destination signs (Body space)
# Meshes have loc/rot = 0; vertices baked so geometry.boundingBox is exact in Three.js.
# Front and Rear signs share the exact same dimensions (1.48 m x 0.30 m).
SIGN_FRONT = {"x": (-0.80, 0.68), "y": (2.235, 2.535)}  # 1.48 x 0.30 m inside recessed rounded dark window (-1.09..+1.09)
SIGN_REAR = {"x": (-0.74, 0.74), "y": (2.06, 2.36)}  # 1.48 x 0.30 m (exact match to SIGN_FRONT!) inside rear window
SIGN_SIDE_L = {"x": (1.228, 1.242), "y": (1.58, 2.16), "z": (0.90, 1.90)}  # upper half of window bay behind middle door!

# ---------------------------------------------------------------- roof equipment
HVAC = {"x": 0.90, "y_base": 2.63, "y_top": TOTAL_HEIGHT, "y_front_top": 2.79, "z": (1.95, 5.00), "z_split": 4.20}
ROOF_VENT_F = {"x": 0.28, "z": (5.25, 5.81), "z_center": 5.53, "r": 0.28, "h": 0.055}
ROOF_VENT_R = {"x": 0.28, "z": (-1.04, -0.48), "z_center": -0.76, "r": 0.28, "h": 0.055}

# ---------------------------------------------------------------- driver / cockpit (right side, -X)
COCKPIT_ANCHOR = (-0.78, 1.93, 5.55)  # driver eye position (well below 2.14m windshield top & 2.34m ceiling)
COCKPIT_ANCHOR_ROT = (-0.06, math.pi, 0.0)  # three.js Euler (x pitch, y yaw, z); looks +Z, slightly down
STEERING_CENTER = (-0.78, 1.38, 6.12)  # steering-wheel hub centre aligned with COCKPIT_ANCHOR=1.93
STEERING_TILT = math.radians(52)  # wheel plane tilt from vertical (bus wheels lie flat-ish)


# ---------------------------------------------------------------- shape functions
def smoothstep(e0, e1, x):
    t = min(1.0, max(0.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)


def roof_y(x):
    """Outer roof skin height at lateral position x (cambered)."""
    t = min(1.0, abs(x) / HALF_W)
    return ROOF_EDGE_Y + ROOF_CAMBER * (1.0 - t * t)


def camber_dy(x, y):
    """Roof camber displacement applied to the shell (and roof-hugging parts)."""
    t = min(1.0, abs(x) / HALF_W)
    return ROOF_CAMBER * (1.0 - t * t) * smoothstep(WALL_TOP_Y, ROOF_EDGE_Y, y)


def front_profile_dz(y):
    """True 96MC B-I centerline front Z offset (<= 0, rearward from Z_FRONT=6.95) at height y.
    - Y <= 1.14: 0.0 (vertical lower nose at Z=6.95)
    - Y = 1.14..2.14: linear ~7.5° rearward windshield rake (-0.130 m at Y=2.14 -> Z=6.820)
    - Y = 2.14..2.16: horizontal drip-lip overhang stepping out to -0.115 m (Z=6.835)
    - Y = 2.16..2.60: near-vertical destination sign brow (~1.5° slight tilt, -0.115 -> -0.127 m)
    """
    if y <= RAKE_Y0:
        return 0.0
    if y <= WINDSHIELD_TOP_Y:
        t = (y - RAKE_Y0) / (WINDSHIELD_TOP_Y - RAKE_Y0)
        return -WINDSHIELD_RAKE_DZ * t
    if y <= BROW_LIP_Y:
        t = smoothstep(WINDSHIELD_TOP_Y, BROW_LIP_Y, y)
        return -(WINDSHIELD_RAKE_DZ * (1.0 - t) + BROW_LIP_DZ * t)
    t = min(1.0, max(0.0, (y - BROW_LIP_Y) / (ROOF_EDGE_Y - BROW_LIP_Y)))
    return -(BROW_LIP_DZ + (BROW_TOP_DZ - BROW_LIP_DZ) * t)


def rake_dz(x, y, z):
    """Front-face rake displacement (negative = rearward)."""
    w = smoothstep(Z_FRONT - 0.31, Z_FRONT - 0.02, z)
    return front_profile_dz(y) * w


def deform(co):
    """Apply the body-shell deformations (rake + camber) to an (x, y, z) point."""
    x, y, z = co
    return (x, y + camber_dy(x, y), z + rake_dz(x, y, z))


def front_z(y):
    """Outer front skin Z on the centre line at height y (flat-front part)."""
    return Z_FRONT + front_profile_dz(y)


def front_inner_z(y):
    """Inner face of the front wall at height y: interior parts must stay behind this."""
    return front_z(y) - WALL_T


# ---------------------------------------------------------------- plan outline
class PlanOutline:
    """Rounded-rectangle plan outline of the body (XZ), optionally inset by d.

    Parameter s runs from 0 at the front centre line toward +X (left), round the
    front-left corner, down the left side, across the rear, up the right side and
    back to the front centre at s = length.
    """

    def __init__(self, d=0.0):
        self.d = d
        w = HALF_W - d
        zf = Z_FRONT - d
        zr = Z_REAR + d
        rf = max(CORNER_R_FRONT - d, 0.004)
        rr = max(CORNER_R_REAR - d, 0.004)
        self.w, self.zf, self.zr, self.rf, self.rr = w, zf, zr, rf, rr
        # segments: (kind, data, length)
        segs = []
        segs.append(("line", ((0.0, zf), (w - rf, zf)), w - rf))
        segs.append(("arc", ((w - rf, zf - rf), rf, 90.0, 0.0), rf * math.pi / 2))
        segs.append(("line", ((w, zf - rf), (w, zr + rr)), (zf - rf) - (zr + rr)))
        segs.append(("arc", ((w - rr, zr + rr), rr, 0.0, -90.0), rr * math.pi / 2))
        segs.append(("line", ((w - rr, zr), (-(w - rr), zr)), 2 * (w - rr)))
        segs.append(("arc", ((-(w - rr), zr + rr), rr, -90.0, -180.0), rr * math.pi / 2))
        segs.append(("line", ((-w, zr + rr), (-w, zf - rf)), (zf - rf) - (zr + rr)))
        segs.append(("arc", ((-(w - rf), zf - rf), rf, 180.0, 90.0), rf * math.pi / 2))
        segs.append(("line", ((-(w - rf), zf), (0.0, zf)), w - rf))
        self.segs = segs
        self.starts = []
        acc = 0.0
        for s in segs:
            self.starts.append(acc)
            acc += s[2]
        self.length = acc

    # angle convention for arcs: angle measured in XZ with 0 = +X, 90 = +Z
    def _seg_point(self, i, t):
        kind, data, ln = self.segs[i]
        if kind == "line":
            (x0, z0), (x1, z1) = data
            x = x0 + (x1 - x0) * t
            z = z0 + (z1 - z0) * t
            dx, dz = x1 - x0, z1 - z0
            l = math.hypot(dx, dz) or 1.0
            # outward normal = (-dz, dx) for this traversal direction
            nx, nz = -dz / l, dx / l
            return x, z, nx, nz
        (cx, cz), r, a0, a1 = data
        a = math.radians(a0 + (a1 - a0) * t)
        nx, nz = math.cos(a), math.sin(a)
        return cx + r * nx, cz + r * nz, nx, nz

    def point(self, s):
        """(x, z, nx, nz) at arc length s (wrapped)."""
        s = s % self.length
        for i in range(len(self.segs) - 1, -1, -1):
            if s >= self.starts[i] - 1e-12:
                ln = self.segs[i][2]
                t = 0.0 if ln <= 0 else min(1.0, (s - self.starts[i]) / ln)
                return self._seg_point(i, t)
        return self._seg_point(0, 0.0)

    def samples(self, arc_steps=8, line_breaks=None):
        """List of s values: every segment end + arc subdivisions + optional extra
        breakpoints (s values) on straight segments."""
        out = []
        for i, (kind, data, ln) in enumerate(self.segs):
            s0 = self.starts[i]
            if kind == "arc":
                for k in range(arc_steps):
                    out.append(s0 + ln * k / arc_steps)
            else:
                out.append(s0)
        if line_breaks:
            out.extend(line_breaks)
        out = sorted(set(round(v, 6) for v in out if 0 <= v < self.length - 1e-6))
        return out

    # helpers to find s for a feature position --------------------------------
    def s_front_x(self, x):
        """s on the front edge / front corners where the outline reaches lateral x
        (x>0 -> left half, x<0 -> right half)."""
        ax = abs(x)
        if ax <= self.w - self.rf:
            s = ax
        else:
            # on front corner arc: x = (w-rf) + rf*cos(a) ; a from 90 -> 0
            c = min(1.0, (ax - (self.w - self.rf)) / self.rf)
            a = math.degrees(math.acos(c))  # 90..0
            s = self.starts[1] + self.segs[1][2] * (90.0 - a) / 90.0
        return s if x >= 0 else self.length - s

    def s_side_z(self, z, side=1):
        """s on the side wall / front-or-rear corners at longitudinal z.
        side=+1 left (+X), -1 right (-X)."""
        zf_c = self.zf - self.rf
        zr_c = self.zr + self.rr
        if side > 0:
            if z >= zf_c:  # front-left arc: z = zf_c + rf*sin(a), a 90..0
                sa = min(1.0, (z - zf_c) / self.rf)
                a = math.degrees(math.asin(sa))
                return self.starts[1] + self.segs[1][2] * (90.0 - a) / 90.0
            if z <= zr_c:  # rear-left arc: a 0..-90
                sa = min(1.0, (zr_c - z) / self.rr)
                a = math.degrees(math.asin(sa))
                return self.starts[3] + self.segs[3][2] * a / 90.0
            return self.starts[2] + (zf_c - z)
        else:
            if z >= zf_c:  # front-right arc: a 180 -> 90
                sa = min(1.0, (z - zf_c) / self.rf)
                a = math.degrees(math.asin(sa))
                return self.starts[7] + self.segs[7][2] * a / 90.0
            if z <= zr_c:  # rear-right arc: a -90 -> -180
                sa = min(1.0, (zr_c - z) / self.rr)
                a = math.degrees(math.asin(sa))
                return self.starts[5] + self.segs[5][2] * (90.0 - a) / 90.0
            return self.starts[6] + (z - zr_c)

    def s_rear_x(self, x):
        """s on the rear edge / rear corners where outline reaches lateral x."""
        ax = abs(x)
        if ax <= self.w - self.rr:
            return self.starts[4] + (self.w - self.rr - x)
        c = min(1.0, (ax - (self.w - self.rr)) / self.rr)
        a = math.degrees(math.acos(c))  # 0 at side, 90 at rear
        if x > 0:
            return self.starts[3] + self.segs[3][2] * a / 90.0
        return self.starts[5] + self.segs[5][2] * (90.0 - a) / 90.0


def cant_inset(y):
    """Horizontal inset of the outer skin at height y due to the cant-rail radius."""
    if y <= WALL_TOP_Y:
        return 0.0
    dy = min(CANT_R, y - WALL_TOP_Y)
    return CANT_R - math.sqrt(max(0.0, CANT_R * CANT_R - dy * dy))
