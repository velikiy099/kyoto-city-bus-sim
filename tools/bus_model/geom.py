"""Small mesh-building toolkit shared by exterior.py / interior.py / wheels.py.

All input coordinates passed to `MeshBuilder` and `new_empty` are in logical Body / Three.js
space (Y-up, +Z forward, +X left).
When `MeshBuilder.build()` or `new_empty()` creates the Blender object, it automatically
applies the proper +90° X-rotation `C: (x, y_up, z_fwd) -> (x, -z_fwd, y_up)` into
Blender-native Z-up space (+Z up, -Y forward, +X left):
  - In Blender `.blend`, the bus sits upright on `Z = 0..2.99`, `Y = -7.01..+3.48`, `X = -1.25..+1.25`.
  - When exported to `public/models/bus.glb` with `export_yup=True`, Blender's glTF exporter
    applies `C^-1: (x_bl, y_bl, z_bl) -> (x_bl, z_bl, -y_bl) = (x, y_up, z_fwd)`, restoring
    the exact Three.js Y-up +Z-forward coordinates and node rotations 1:1.

Faces are wound counter-clockwise when seen from the side the normal points to (`det(C) = +1`
preserves winding order).
"""
import math

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector

# Transformation from logical Y-up (+X left, +Y up, +Z forward)
# to Blender native Z-up (+X left, -Y forward, +Z up):
YUP_TO_BLENDER_MAT3 = Matrix((
    (1.0, 0.0, 0.0),
    (0.0, 0.0, -1.0),
    (0.0, 1.0, 0.0),
))
BLENDER_TO_YUP_MAT3 = YUP_TO_BLENDER_MAT3.transposed()


def yup_to_blender_pos(p):
    """Convert logical Y-up point `(x, y_up, z_fwd)` to Blender Z-up `(x, -z_fwd, y_up)`."""
    return (float(p[0]), -float(p[2]), float(p[1]))


def yup_to_blender_vec(p):
    """Convert logical Y-up Vector `(x, y_up, z_fwd)` to Blender Z-up Vector `(x, -z_fwd, y_up)`."""
    return Vector((float(p[0]), -float(p[2]), float(p[1])))


def yup_to_blender_euler(rot):
    """Convert logical Y-up XYZ Euler `(rx, ry, rz)` to Blender Z-up XYZ Euler via `C @ R @ C^T`."""
    if rot is None:
        return Euler((0.0, 0.0, 0.0), "XYZ")
    e_yup = rot if isinstance(rot, Euler) else Euler((float(rot[0]), float(rot[1]), float(rot[2])), "XYZ")
    R_bl = YUP_TO_BLENDER_MAT3 @ e_yup.to_matrix() @ BLENDER_TO_YUP_MAT3
    return R_bl.to_euler("XYZ")


def link_object(obj, parent=None):
    coll = bpy.context.scene.collection
    if obj.name not in coll.objects:
        coll.objects.link(obj)
    if parent is not None:
        obj.parent = parent
        obj.matrix_parent_inverse = Matrix.Identity(4)
    return obj


def new_empty(name, location=(0, 0, 0), parent=None, rotation=(0, 0, 0), rotation_euler=None, size=0.2):
    """Create an Empty whose `location` and `rotation` are given in logical Y-up `(x, y_up, z_fwd)` space
    and stored in Blender-native Z-up `(x, -z_fwd, y_up)` space."""
    e = bpy.data.objects.new(name, None)
    e.empty_display_type = "PLAIN_AXES"
    e.empty_display_size = size
    e.location = yup_to_blender_pos(location)
    rot_in = rotation_euler if rotation_euler is not None else rotation
    e.rotation_euler = yup_to_blender_euler(rot_in)
    link_object(e, parent)
    return e


def _v(p):
    return Vector((float(p[0]), float(p[1]), float(p[2])))


def orthonormal(axis):
    """Two unit vectors perpendicular to axis."""
    a = _v(axis).normalized()
    ref = Vector((0, 1, 0)) if abs(a.y) < 0.9 else Vector((1, 0, 0))
    u = a.cross(ref).normalized()
    v = a.cross(u).normalized()
    return u, v


class MeshBuilder:
    def __init__(self):
        self.verts = []
        self.faces = []  # list of vertex index tuples
        self.face_mat = []
        self.face_uv = []  # list of per-loop uv tuples or None
        self.face_smooth = []
        self.mats = []

    @staticmethod
    def _v(x, y_up=None, z_fwd=None):
        """Convert `(x, y_up, z_fwd)` (or a 3-tuple) to Blender Z-up `(x, -z_fwd, y_up)`."""
        if y_up is None:
            return yup_to_blender_pos(x)
        return (float(x), -float(z_fwd), float(y_up))

    # ------------------------------------------------------------- basics
    def mat_index(self, mat):
        if mat is None:
            return 0
        for i, m in enumerate(self.mats):
            if m == mat:
                return i
        self.mats.append(mat)
        return len(self.mats) - 1

    def add_vert(self, co):
        self.verts.append((float(co[0]), float(co[1]), float(co[2])))
        return len(self.verts) - 1

    def add_face(self, idxs, mat, uvs=None, smooth=False):
        self.faces.append(tuple(idxs))
        self.face_mat.append(self.mat_index(mat))
        self.face_uv.append(tuple(uvs) if uvs else None)
        self.face_smooth.append(smooth)

    def poly(self, pts, mat, uvs=None, smooth=False):
        idx = [self.add_vert(p) for p in pts]
        self.add_face(idx, mat, uvs, smooth)
        return idx

    def quad(self, p0, p1, p2, p3, mat, uvs=((0, 0), (1, 0), (1, 1), (0, 1)), smooth=False):
        return self.poly([p0, p1, p2, p3], mat, uvs, smooth)

    def transform(self, matrix, start=0):
        """Transform vertices added since index `start` by a 4x4 matrix (in logical Y-up space)."""
        for i in range(start, len(self.verts)):
            self.verts[i] = tuple(matrix @ Vector(self.verts[i]))

    def map_verts(self, fn, start=0):
        for i in range(start, len(self.verts)):
            self.verts[i] = tuple(fn(self.verts[i]))

    # ------------------------------------------------------------- primitives
    def rect(self, center, u_axis, v_axis, w, h, mat, uv=(0, 0, 1, 1), flip=False):
        """Flat rectangle centred at `center`, width along u_axis, height along v_axis.
        Normal = u x v (or reversed if flip). UV (u0,v0,u1,v1) maps left->right, bottom->top."""
        c, u, v = _v(center), _v(u_axis).normalized(), _v(v_axis).normalized()
        hu, hv = u * (w / 2), v * (h / 2)
        p0, p1, p2, p3 = c - hu - hv, c + hu - hv, c + hu + hv, c - hu + hv
        u0, v0, u1, v1 = uv
        if flip:
            return self.quad(p1, p0, p3, p2, mat, ((u1, v0), (u0, v0), (u0, v1), (u1, v1)))
        return self.quad(p0, p1, p2, p3, mat, ((u0, v0), (u1, v0), (u1, v1), (u0, v1)))

    def box(self, mn, mx, mat, uv_scale=None, skip=(), mats=None):
        """Axis-aligned box. skip: subset of {'+x','-x','+y','-y','+z','-z'}.
        uv_scale: if given, world-space box-projected UVs (uv = coord * uv_scale).
        mats: optional dict face-key -> material overriding mat."""
        x0, y0, z0 = mn
        x1, y1, z1 = mx
        P = [
            (x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
            (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1),
        ]
        faces = {
            "-z": (1, 0, 3, 2), "+z": (4, 5, 6, 7),
            "-y": (0, 1, 5, 4), "+y": (3, 7, 6, 2),
            "-x": (0, 4, 7, 3), "+x": (5, 1, 2, 6),
        }
        base = len(self.verts)
        for p in P:
            self.add_vert(p)
        for key, f in faces.items():
            if key in skip:
                continue
            m = mats.get(key, mat) if mats else mat
            uvs = None
            if uv_scale:
                s = uv_scale
                ax = key[1]
                uvs = []
                for i in f:
                    x, y, z = P[i]
                    if ax == "x":
                        uvs.append((z * s, y * s))
                    elif ax == "y":
                        uvs.append((x * s, z * s))
                    else:
                        uvs.append((x * s, y * s))
            else:
                uvs = ((0, 0), (1, 0), (1, 1), (0, 1))
            self.add_face([base + i for i in f], m, uvs)

    def obox(self, center, size, mat, rot=None, uv_scale=None, skip=()):
        """Oriented box: size (sx, sy, sz) about center, rotated by mathutils Matrix/Euler/Quaternion."""
        start = len(self.verts)
        sx, sy, sz = size
        self.box((-sx / 2, -sy / 2, -sz / 2), (sx / 2, sy / 2, sz / 2), mat, uv_scale, skip)
        R = Matrix.Identity(4)
        if rot is not None:
            R = rot.to_matrix().to_4x4() if not isinstance(rot, Matrix) else rot.to_4x4()
        self.transform(Matrix.Translation(_v(center)) @ R, start)

    def beam(self, p0, p1, w, h, mat, up=(0, 1, 0)):
        """Rectangular bar from p0 to p1, cross-section w (side) x h (up)."""
        a, b = _v(p0), _v(p1)
        d = b - a
        L = d.length
        if L < 1e-9:
            return
        f = d / L
        upv = _v(up)
        s = f.cross(upv)
        if s.length < 1e-6:
            s = f.cross(Vector((1, 0, 0)))
        s.normalize()
        u = s.cross(f).normalized()
        M = Matrix((s, u, f)).transposed().to_4x4()
        M.translation = (a + b) / 2
        start = len(self.verts)
        self.box((-w / 2, -h / 2, -L / 2), (w / 2, h / 2, L / 2), mat)
        self.transform(M, start)

    def cylinder(self, p0, p1, r, seg, mat, caps=True, r1=None, smooth=True, cap_mat=None, cap_uv=False):
        """Cylinder / cone frustum from p0 (radius r) to p1 (radius r1)."""
        a, b = _v(p0), _v(p1)
        ax = b - a
        if ax.length < 1e-9:
            return
        u, v = orthonormal(ax)
        r1 = r if r1 is None else r1
        ring0, ring1 = [], []
        for i in range(seg):
            t = 2 * math.pi * i / seg
            d = u * math.cos(t) + v * math.sin(t)
            ring0.append(self.add_vert(a + d * r))
            ring1.append(self.add_vert(b + d * r1))
        for i in range(seg):
            j = (i + 1) % seg
            self.add_face(
                [ring0[i], ring0[j], ring1[j], ring1[i]], mat,
                ((i / seg, 0), ((i + 1) / seg, 0), ((i + 1) / seg, 1), (i / seg, 1)), smooth,
            )
        if caps:
            cm = cap_mat or mat

            def cuv(k, rad):
                t = 2 * math.pi * k / seg
                return (0.5 + 0.5 * math.cos(t), 0.5 + 0.5 * math.sin(t))

            # cap at p1 faces +axis, at p0 faces -axis
            self.add_face(list(ring1), cm, [cuv(k, r1) for k in range(seg)] if cap_uv else None)
            self.add_face(list(reversed(ring0)), cm,
                          [cuv(k, r) for k in reversed(range(seg))] if cap_uv else None)

    def tube(self, points, r, seg, mat, caps=True):
        """Swept circular tube through a polyline (simple parallel-transport frames)."""
        pts = [_v(p) for p in points]
        if len(pts) < 2:
            return
        rings = []
        prev_u = None
        for k, p in enumerate(pts):
            if k == 0:
                t = pts[1] - pts[0]
            elif k == len(pts) - 1:
                t = pts[-1] - pts[-2]
            else:
                t = (pts[k + 1] - pts[k]).normalized() + (pts[k] - pts[k - 1]).normalized()
            t.normalize()
            if prev_u is None:
                u, _ = orthonormal(t)
            else:
                u = (prev_u - t * prev_u.dot(t)).normalized()
            v = t.cross(u).normalized()
            prev_u = u
            ring = []
            for i in range(seg):
                a = 2 * math.pi * i / seg
                ring.append(self.add_vert(p + (u * math.cos(a) + v * math.sin(a)) * r))
            rings.append(ring)
        for k in range(len(rings) - 1):
            r0, r1 = rings[k], rings[k + 1]
            for i in range(seg):
                j = (i + 1) % seg
                self.add_face([r0[i], r0[j], r1[j], r1[i]], mat, None, True)
        if caps:
            self.add_face(list(reversed(rings[0])), mat)
            self.add_face(list(rings[-1]), mat)

    def disc(self, center, normal, r, seg, mat, uv=True, r_in=0.0, u_axis=None, v_axis=None):
        """Flat disc (or annulus if r_in>0) facing `normal`, UV 0..1 over its bounding square."""
        c = _v(center)
        if u_axis is not None and v_axis is not None:
            u = _v(u_axis).normalized()
            v = _v(v_axis).normalized()
            n = u.cross(v).normalized()
        else:
            n = _v(normal).normalized()
            u, v = orthonormal(n)
            # make u x v == n
            if u.cross(v).dot(n) < 0:
                u, v = v, u
        if r_in <= 0:
            idx, uvs = [], []
            for i in range(seg):
                t = 2 * math.pi * i / seg
                idx.append(self.add_vert(c + (u * math.cos(t) + v * math.sin(t)) * r))
                uvs.append((0.5 + 0.5 * math.cos(t), 0.5 + 0.5 * math.sin(t)))
            self.add_face(idx, mat, uvs if uv else None)
        else:
            outer, inner = [], []
            for i in range(seg):
                t = 2 * math.pi * i / seg
                d = u * math.cos(t) + v * math.sin(t)
                outer.append(self.add_vert(c + d * r))
                inner.append(self.add_vert(c + d * r_in))
            for i in range(seg):
                j = (i + 1) % seg
                self.add_face([inner[i], outer[i], outer[j], inner[j]], mat)

    def hollow_cylinder(self, p0, p1, r_out, r_in, seg, mat, smooth=True):
        """Watertight open-ended cylindrical tube from p0 to p1 (e.g., lamp glare hood)."""
        a, b = _v(p0), _v(p1)
        ax = b - a
        if ax.length < 1e-9:
            return
        u, v = orthonormal(ax)
        if u.cross(v).dot(ax) < 0:
            u, v = v, u
        o0, o1, i0, i1 = [], [], [], []
        for k in range(seg):
            t = 2 * math.pi * k / seg
            d = u * math.cos(t) + v * math.sin(t)
            o0.append(self.add_vert(a + d * r_out))
            o1.append(self.add_vert(b + d * r_out))
            i0.append(self.add_vert(a + d * r_in))
            i1.append(self.add_vert(b + d * r_in))
        for k in range(seg):
            j = (k + 1) % seg
            self.add_face([o0[k], o0[j], o1[j], o1[k]], mat, None, smooth)
            self.add_face([i0[k], i1[k], i1[j], i0[j]], mat, None, smooth)
            self.add_face([i1[k], o1[k], o1[j], i1[j]], mat)
            self.add_face([i0[k], i0[j], o0[j], o0[k]], mat)

    def torus(self, center, normal, R, r, seg, seg2, mat):
        c = _v(center)
        n = _v(normal).normalized()
        u, v = orthonormal(n)
        rings = []
        for i in range(seg):
            t = 2 * math.pi * i / seg
            d = u * math.cos(t) + v * math.sin(t)
            ring = []
            for k in range(seg2):
                p = 2 * math.pi * k / seg2
                ring.append(self.add_vert(c + d * (R + r * math.cos(p)) + n * (r * math.sin(p))))
            rings.append(ring)
        for i in range(seg):
            i2 = (i + 1) % seg
            for k in range(seg2):
                k2 = (k + 1) % seg2
                self.add_face([rings[i][k], rings[i2][k], rings[i2][k2], rings[i][k2]], mat, None, True)

    def sphere(self, center, radius, seg, rings, mat, scale=(1, 1, 1), hemi=False):
        c = _v(center)
        sx, sy, sz = scale
        top = self.add_vert((c.x, c.y + radius * sy, c.z))
        layers = []
        nr = rings if not hemi else rings // 2
        for k in range(1, nr):
            phi = math.pi * k / rings
            y = math.cos(phi) * radius
            rr = math.sin(phi) * radius
            layer = []
            for i in range(seg):
                t = 2 * math.pi * i / seg
                layer.append(self.add_vert((c.x + rr * math.cos(t) * sx, c.y + y * sy, c.z + rr * math.sin(t) * sz)))
            layers.append(layer)
        if hemi:
            layer = []
            for i in range(seg):
                t = 2 * math.pi * i / seg
                layer.append(self.add_vert((c.x + radius * math.cos(t) * sx, c.y, c.z + radius * math.sin(t) * sz)))
            layers.append(layer)
        for i in range(seg):
            j = (i + 1) % seg
            self.add_face([top, layers[0][j], layers[0][i]], mat, None, True)
        for k in range(len(layers) - 1):
            a, b = layers[k], layers[k + 1]
            for i in range(seg):
                j = (i + 1) % seg
                self.add_face([a[i], a[j], b[j], b[i]], mat, None, True)
        if not hemi:
            bot = self.add_vert((c.x, c.y - radius * sy, c.z))
            last = layers[-1]
            for i in range(seg):
                j = (i + 1) % seg
                self.add_face([bot, last[i], last[j]], mat, None, True)
        else:
            self.add_face(list(layers[-1]), mat)

    def grid_surface(self, nu, nv, fn, mat, uv=True, smooth=True, closed_u=False):
        """Parametric surface: fn(u, v) -> (x, y, z), u,v in [0,1]. (nu x nv) cells."""
        idx = []
        cols = nu if closed_u else nu + 1
        for j in range(nv + 1):
            row = []
            for i in range(cols):
                row.append(self.add_vert(fn(i / nu, j / nv)))
            idx.append(row)
        for j in range(nv):
            for i in range(nu):
                i2 = (i + 1) % cols if closed_u else i + 1
                uvs = ((i / nu, j / nv), ((i + 1) / nu, j / nv), ((i + 1) / nu, (j + 1) / nv), (i / nu, (j + 1) / nv)) if uv else None
                self.add_face([idx[j][i], idx[j][i2], idx[j + 1][i2], idx[j + 1][i]], mat, uvs, smooth)
        return idx

    # ------------------------------------------------------------- output
    def build(self, name, parent=None, smooth_angle=None, double_sided_ok=True):
        """Build Blender Mesh object in Blender-native Z-up coordinates `(x, -z_fwd, y_up)`."""
        me = bpy.data.meshes.new(name)
        bl_verts = [(x, -z, y) for (x, y, z) in self.verts]
        me.from_pydata(bl_verts, [], self.faces)
        for m in self.mats:
            me.materials.append(m)
        if self.faces:
            me.polygons.foreach_set("material_index", self.face_mat)
            me.polygons.foreach_set("use_smooth", [bool(s) for s in self.face_smooth])
            if any(self.face_uv):
                uvl = me.uv_layers.new(name="UVMap")
                data = []
                for f, uvs in zip(self.faces, self.face_uv):
                    if uvs and len(uvs) == len(f):
                        for uv in uvs:
                            data.extend((uv[0], uv[1]))
                    else:
                        data.extend([0.0, 0.0] * len(f))
                uvl.data.foreach_set("uv", data)
        me.validate(clean_customdata=False)
        me.update()
        if smooth_angle is not None:
            try:
                me.shade_smooth()
                me.set_sharp_from_angle(angle=smooth_angle)
            except Exception:
                pass
        obj = bpy.data.objects.new(name, me)
        link_object(obj, parent)
        return obj


def bake_object_transform(obj):
    """Apply obj's local transform into its mesh vertices (keeps parent)."""
    if obj.type != "MESH":
        return
    M = obj.matrix_basis.copy()
    obj.data.transform(M)
    obj.matrix_basis = Matrix.Identity(4)


def mesh_from_bmesh(name, bm, mats, parent=None):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    for m in mats:
        me.materials.append(m)
    obj = bpy.data.objects.new(name, me)
    link_object(obj, parent)
    return obj
