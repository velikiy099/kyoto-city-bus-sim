"""Build script for Kyoto City Bus PDG-AA273KAN (96MC B-I, fleet #1771, Yokooji / Route 18).

Run via:
    /opt/homebrew/bin/blender --background --python tools/build-bus-model.py

Workflow:
1. Loads `tools/bus-model.blend`.
2. Preserves the 5 non-bus objects (`Passenger`, `Sedan`, `TreeA`, `TreeB`, `Truck`) and their materials.
3. Removes all old bus objects and rebuilds in Blender-native Z-up (`+Z` up, `-Y` forward, `+X` left):
   - `materials.build_materials()`
   - `Body` Empty at `(0,0,0)`
   - `exterior.build(body_empty, mats)`
   - `interior.build(body_empty, mats)`
   - `wheels.build(mats)` (`WheelPivotFL/FR/RL/RR` -> `WheelFL/FR/RL/RR`)
4. Saves `tools/bus-model.blend` and `tools/bus-pdg-aa273kan.blend` (upright on `Z=0` in Blender).
5. Exports `public/models/bus.glb` (`export_yup=True`, `use_selection=True` on ONLY bus nodes,
   restoring exact Three.js Y-up `+Z`-forward coordinates 1:1).
6. Renders all 10 Cycles CPU verification PNGs (orthographic front/rear/left/right/top, 3/4 front-left,
   3/4 rear-right, interior front/rear, cockpit driver POV at `spec.COCKPIT_ANCHOR`).
"""
import math
import shutil
import sys
from pathlib import Path

import bpy
from mathutils import Matrix

ROOT_DIR = Path(__file__).resolve().parent.parent
TOOLS_DIR = ROOT_DIR / "tools"
if str(TOOLS_DIR) not in sys.path:
    sys.path.insert(0, str(TOOLS_DIR))

from bus_model import exterior, interior, materials, spec, wheels
from bus_model.geom import new_empty, yup_to_blender_pos, yup_to_blender_vec

BLEND_MAIN_PATH = TOOLS_DIR / "bus-model.blend"
BLEND_PDG_PATH = TOOLS_DIR / "bus-pdg-aa273kan.blend"
GLB_OUT_PATH = ROOT_DIR / "public" / "models" / "bus.glb"

RENDER_DIR_COORD = Path("/Users/basalt/.gemini/antigravity/brain/ad98b72e-bdcc-4235-9623-488df8879754/renders")
RENDER_DIR_LOCAL = Path("/Users/basalt/.gemini/antigravity/brain/50baac00-8e8a-4c75-bf64-db17083cd0e7/renders")
RENDER_DIR_V2 = Path("/Users/basalt/.gemini/antigravity/brain/ba31878e-4580-4240-925a-63a27b1aff5d/renders")

KEEP_OBJECTS = frozenset({"Passenger", "Sedan", "TreeA", "TreeB", "Truck"})


def _clean_old_bus_objects():
    """Remove all objects except the 5 preserved non-bus assets."""
    to_remove = [o for o in bpy.data.objects if o.name not in KEEP_OBJECTS]
    for o in to_remove:
        bpy.data.objects.remove(o, do_unlink=True)

    for me in list(bpy.data.meshes):
        if me.users == 0:
            bpy.data.meshes.remove(me)
    for cu in list(bpy.data.curves):
        if cu.users == 0:
            bpy.data.curves.remove(cu)
    for cam in list(bpy.data.cameras):
        if cam.users == 0:
            bpy.data.cameras.remove(cam)
    for lt in list(bpy.data.lights):
        if lt.users == 0:
            bpy.data.lights.remove(lt)
    for mat in list(bpy.data.materials):
        if mat.users == 0 and mat.name not in materials.KEEP_MATERIALS:
            bpy.data.materials.remove(mat)


def _select_bus_hierarchy():
    """Select ONLY Body, WheelPivotFL/FR/RL/RR and all their descendants."""
    bpy.ops.object.select_all(action="DESELECT")
    root_names = ("Body", "WheelPivotFL", "WheelPivotFR", "WheelPivotRL", "WheelPivotRR")
    roots = [bpy.data.objects[n] for n in root_names if n in bpy.data.objects]

    def _sel(obj):
        obj.select_set(True)
        for ch in obj.children:
            _sel(ch)

    for r in roots:
        _sel(r)
    if roots:
        bpy.context.view_layer.objects.active = roots[0]
    return roots


def _print_audit_summary():
    """Print Blender Z-up and Three.js Y-up bounding box and triangle statistics."""
    bus_meshes = [o for o in bpy.data.objects if o.name not in KEEP_OBJECTS and o.type == "MESH"]

    all_x, all_y, all_z = [], [], []
    body_x, body_y, body_z = [], [], []
    total_tris = 0
    for o in bus_meshes:
        M = o.matrix_world
        o.data.calc_loop_triangles()
        total_tris += len(o.data.loop_triangles)
        xs = [(M @ v.co).x for v in o.data.vertices]
        ys = [(M @ v.co).y for v in o.data.vertices]
        zs = [(M @ v.co).z for v in o.data.vertices]
        all_x.extend(xs)
        all_y.extend(ys)
        all_z.extend(zs)
        if not o.name.startswith("Mirror"):
            body_x.extend(xs)
            body_y.extend(ys)
            body_z.extend(zs)

    print("=== PDG-AA273KAN BUILD AUDIT (BLENDER Z-UP & THREE.JS Y-UP) ===")
    print(f"Preserved non-bus objects: {sorted(o.name for o in bpy.data.objects if o.name in KEEP_OBJECTS)}")
    print(f"Bus mesh count: {len(bus_meshes)} | Total triangles: {total_tris}")
    print(
        f"Blender Z-up BBox (excl. Mirror*): "
        f"X=[{min(body_x):.3f}, {max(body_x):.3f}] (W={max(body_x)-min(body_x):.3f}m), "
        f"Y_bl=[{min(body_y):.3f}, {max(body_y):.3f}] (L={max(body_y)-min(body_y):.3f}m), "
        f"Z_bl=[{min(body_z):.3f}, {max(body_z):.3f}] (H={max(body_z)-min(body_z):.3f}m)"
    )
    print(
        f"Three.js Y-up BBox (export_yup=True, excl. Mirror*): "
        f"X=[{min(body_x):.3f}, {max(body_x):.3f}], "
        f"Y_up=[{min(body_z):.3f}, {max(body_z):.3f}], "
        f"Z_fwd=[{-max(body_y):.3f}, {-min(body_y):.3f}]"
    )
    print(
        f"Full Blender Z-up BBox (incl. Mirror*): "
        f"X=[{min(all_x):.3f}, {max(all_x):.3f}], "
        f"Y_bl=[{min(all_y):.3f}, {max(all_y):.3f}], "
        f"Z_bl=[{min(all_z):.3f}, {max(all_z):.3f}]"
    )
    for sname in ("BodyShell", "RoofEquipment", "SignFront", "SignRear", "SignSideL", "SteeringWheel"):
        so = bpy.data.objects.get(sname)
        if so and so.type == "MESH":
            vx = [v.co.x for v in so.data.vertices]
            vy_up = [v.co.z for v in so.data.vertices]
            vz_fwd = [-v.co.y for v in so.data.vertices]
            print(
                f"  {sname}: bl_loc={tuple(round(x,3) for x in so.location)} "
                f"bl_rot={tuple(round(x,3) for x in so.rotation_euler)} "
                f"threejs_local_bbox=X[{min(vx):.3f}..{max(vx):.3f}] Y_up[{min(vy_up):.3f}..{max(vy_up):.3f}] Z_fwd[{min(vz_fwd):.3f}..{max(vz_fwd):.3f}]"
            )


def _aim_camera_from_yup(cam_obj, eye_yup, target_yup, up_yup=(0.0, 1.0, 0.0)):
    """Place and orient a Blender camera in Blender Z-up space from logical Y-up `(x, y_up, z_fwd)` coordinates."""
    eye_v = yup_to_blender_vec(eye_yup)
    tgt_v = yup_to_blender_vec(target_yup)
    up_v = yup_to_blender_vec(up_yup).normalized()
    forward = (tgt_v - eye_v).normalized()
    if abs(forward.dot(up_v)) > 0.999:
        up_v = yup_to_blender_vec((1.0, 0.0, 0.0))
    right = forward.cross(up_v).normalized()
    cam_up = right.cross(forward).normalized()
    rot = Matrix((right, cam_up, -forward)).transposed()
    M = rot.to_4x4()
    M.translation = eye_v
    cam_obj.matrix_world = M


def _render_verification_views():
    """Render all 10 Cycles CPU verification PNGs into the writable render folder(s)."""
    writable_dirs = []
    for cand in (RENDER_DIR_COORD, RENDER_DIR_LOCAL, RENDER_DIR_V2):
        try:
            cand.mkdir(parents=True, exist_ok=True)
            probe = cand / ".write_test"
            probe.write_text("ok")
            probe.unlink()
            writable_dirs.append(cand)
        except OSError:
            pass
    if not writable_dirs:
        raise RuntimeError("No writable render output directory available")
    primary_dir = writable_dirs[0]
    extra_dirs = writable_dirs[1:]

    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.cycles.samples = 24
    if hasattr(sc.cycles, "use_denoising"):
        sc.cycles.use_denoising = False
    sc.render.film_transparent = False
    sc.view_settings.view_transform = "Standard"
    sc.view_settings.look = "None"

    # Hide preserved non-bus objects during rendering so they don't photobomb bus views
    for name in KEEP_OBJECTS:
        o = bpy.data.objects.get(name)
        if o:
            o.hide_render = True

    # Setup bright neutral sky world
    world = bpy.data.worlds.get("VerifyWorld") or bpy.data.worlds.new("VerifyWorld")
    world.use_nodes = True
    bg = next((n for n in world.node_tree.nodes if n.type == "BACKGROUND"), None)
    if bg:
        bg.inputs[0].default_value = (0.56, 0.64, 0.74, 1.0)
        bg.inputs[1].default_value = 1.05
    sc.world = world

    # Ground plane for soft contact shadow in exterior views (MeshBuilder auto-converts to Z-up z = -0.002)
    mb_gnd = exterior.MeshBuilder()
    gnd_mat = bpy.data.materials.new("_VerifyGround")
    gnd_mat.use_nodes = True
    g_bsdf = materials.get_principled_bsdf(gnd_mat)
    g_bsdf.inputs["Base Color"].default_value = (0.24, 0.26, 0.28, 1.0)
    g_bsdf.inputs["Roughness"].default_value = 0.85
    mb_gnd.quad((-12, -0.002, -12), (-12, -0.002, 16), (12, -0.002, 16), (12, -0.002, -12), gnd_mat)
    gnd_obj = mb_gnd.build("_VerifyGroundObj", parent=None)

    # Three-point sun + interior point lights (specified in logical Y-up, converted to Z-up)
    temp_objs = [gnd_obj]
    temp_lights = []
    sun_specs = [
        ("_SunKey", (12.0, 18.0, 14.0), (0.0, 1.4, 1.8), 3.2),
        ("_SunFill", (-14.0, 12.0, -10.0), (0.0, 1.4, 1.8), 1.7),
    ]
    for lname, lpos, ltgt, energy in sun_specs:
        ld = bpy.data.lights.new(lname, "SUN")
        ld.energy = energy
        ld.angle = math.radians(8.0)
        lo = bpy.data.objects.new(lname, ld)
        sc.collection.objects.link(lo)
        _aim_camera_from_yup(lo, lpos, ltgt)
        temp_objs.append(lo)
        temp_lights.append(ld)

    # Interior fill point lights along the bus cabin & cockpit
    for iz, p_energy in ((5.85, 38.0), (4.20, 30.0), (2.20, 30.0), (0.20, 30.0), (-1.80, 30.0)):
        ld = bpy.data.lights.new(f"_IntPt_{iz}", "POINT")
        ld.energy = p_energy
        ld.shadow_soft_size = 0.45
        lo = bpy.data.objects.new(f"_IntPt_{iz}", ld)
        lo.location = yup_to_blender_pos((-0.25 if iz > 5.4 else 0.0, spec.CEILING_Y - 0.12, iz))
        sc.collection.objects.link(lo)
        temp_objs.append(lo)
        temp_lights.append(ld)

    cam_data = bpy.data.cameras.new("_VerifyCam")
    cam_obj = bpy.data.objects.new("_VerifyCam", cam_data)
    sc.collection.objects.link(cam_obj)
    sc.camera = cam_obj
    temp_objs.append(cam_obj)

    z_mid = 0.5 * (spec.Z_FRONT_BUMPER + spec.Z_REAR_BUMPER)  # +1.765 m
    y_mid = 1.50

    # (filename, kind, res_x, res_y, scale_or_fov_mm, eye_yup, target_yup, up_yup)
    views = [
        ("ortho_front.png", "ORTHO", 900, 900, 3.6, (0.0, y_mid, 14.0), (0.0, y_mid, z_mid), (0, 1, 0)),
        ("ortho_rear.png", "ORTHO", 900, 900, 3.6, (0.0, y_mid, -12.0), (0.0, y_mid, z_mid), (0, 1, 0)),
        ("ortho_left.png", "ORTHO", 1400, 560, 11.4, (14.0, y_mid, z_mid), (0.0, y_mid, z_mid), (0, 1, 0)),
        ("ortho_right.png", "ORTHO", 1400, 560, 11.4, (-14.0, y_mid, z_mid), (0.0, y_mid, z_mid), (0, 1, 0)),
        ("ortho_top.png", "ORTHO", 1400, 560, 11.4, (0.0, 15.0, z_mid), (0.0, y_mid, z_mid), (1, 0, 0)),
        ("persp_34_front_left.png", "PERSP", 1200, 800, 35.0, (6.2, 2.55, 11.8), (0.0, 1.38, 2.10), (0, 1, 0)),
        ("persp_34_rear_right.png", "PERSP", 1200, 800, 35.0, (-6.2, 2.55, -8.5), (0.0, 1.38, 1.40), (0, 1, 0)),
        ("interior_front_to_rear.png", "PERSP", 1000, 750, 20.0, (0.0, 1.65, 5.20), (0.0, 1.35, -2.50), (0, 1, 0)),
        ("interior_rear_to_front.png", "PERSP", 1000, 750, 20.0, (0.0, 1.85, -2.40), (-0.15, 1.35, 6.20), (0, 1, 0)),
        (
            "cockpit_driver_pov.png",
            "PERSP",
            1200,
            800,
            14.5,
            spec.COCKPIT_ANCHOR,
            (
                spec.COCKPIT_ANCHOR[0] + 0.12,
                spec.COCKPIT_ANCHOR[1] - 0.25,
                spec.COCKPIT_ANCHOR[2] + 1.00,
            ),
            (0, 1, 0),
        ),
    ]

    for fname, kind, rx, ry, param, eye, tgt, up in views:
        sc.render.resolution_x = rx
        sc.render.resolution_y = ry
        cam_data.type = kind
        cam_data.clip_start = 0.05
        cam_data.clip_end = 100.0
        if kind == "ORTHO":
            cam_data.ortho_scale = param
        else:
            cam_data.lens = param
            cam_data.sensor_width = 36.0
        _aim_camera_from_yup(cam_obj, eye, tgt, up)
        out_primary = primary_dir / fname
        sc.render.filepath = str(out_primary)
        bpy.ops.render.render(write_still=True)
        for extra_dir in extra_dirs:
            try:
                shutil.copy2(out_primary, extra_dir / fname)
            except OSError:
                pass
        print(f"Rendered {out_primary}")

    # Clean up temporary render objects
    gnd_mesh = gnd_obj.data
    for o in temp_objs:
        bpy.data.objects.remove(o, do_unlink=True)
    for ld in temp_lights:
        bpy.data.lights.remove(ld)
    bpy.data.cameras.remove(cam_data)
    bpy.data.meshes.remove(gnd_mesh)
    bpy.data.materials.remove(gnd_mat)
    for name in KEEP_OBJECTS:
        o = bpy.data.objects.get(name)
        if o:
            o.hide_render = False


def main():
    print(f"Loading {BLEND_MAIN_PATH} ...")
    bpy.ops.wm.open_mainfile(filepath=str(BLEND_MAIN_PATH))

    _clean_old_bus_objects()

    mats = materials.build_materials()
    body_empty = new_empty("Body", location=(0.0, 0.0, 0.0), parent=None, size=0.4)
    exterior.build(body_empty, mats)
    interior.build(body_empty, mats)
    wheels.build(mats)
    bpy.context.view_layer.update()

    _print_audit_summary()

    # Save clean .blend files in Blender-native Z-up (before any temporary render lights/cameras)
    bpy.ops.wm.save_as_mainfile(filepath=str(BLEND_MAIN_PATH))
    bpy.ops.wm.save_as_mainfile(filepath=str(BLEND_PDG_PATH))
    print(f"Saved {BLEND_MAIN_PATH} and {BLEND_PDG_PATH}")

    # Export public/models/bus.glb with export_yup=True (converts Blender Z-up -> Three.js Y-up 1:1)
    GLB_OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    _select_bus_hierarchy()
    bpy.ops.export_scene.gltf(
        filepath=str(GLB_OUT_PATH),
        export_format="GLB",
        use_selection=True,
        export_yup=True,
    )
    print(f"Exported {GLB_OUT_PATH} ({GLB_OUT_PATH.stat().st_size / 1024:.1f} KB)")

    # Render verification suite
    _render_verification_views()
    print("All builds, exports, and verification renders complete.")


if __name__ == "__main__":
    main()
