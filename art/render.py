"""
SessionBrain's art, rendered in Blender (Cycles): each activity's node, and the plate under the map.

    blender -b --factory-startup --python art/render.py -- [--only shell,web] [--samples 128] [--out web/art]

For each node two images come out, both with a transparent ground:
  <id>.webp       the object: dark satin, lit like a product shot, with its soft contact shadow
  <id>-glow.webp  white, its alpha how strongly that spot glows: the lit details and the light they
                  spill onto the body, with a little bloom. The page tints it with the activity's
                  colour, so skins and the desktop theme keep working without a re-render.
And the plate:
  plate.webp      grey; 50% is the theme's ground exactly, lighter and darker shade it. The page
                  multiplies the ground colour by it, so it follows the theme too.
"""

import math
import os
import sys

import bpy
import numpy as np

ARGS = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []


def arg(name, default):
    return ARGS[ARGS.index(name) + 1] if name in ARGS else default


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.abspath(os.path.join(ROOT, arg("--out", "web/art")))
SAMPLES = int(arg("--samples", "128"))
ONLY = [s for s in arg("--only", "").split(",") if s]
NODE_PX = 256
os.makedirs(OUT, exist_ok=True)

# ---------------------------------------------------------------------------------------------
# Scene


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    for kind in ("OPTIX", "CUDA"):
        try:
            prefs.compute_device_type = kind
            prefs.get_devices()
            if any(d.type == kind for d in prefs.devices):
                for d in prefs.devices:
                    d.use = d.type == kind
                scene.cycles.device = "GPU"
                break
        except TypeError:
            continue
    scene.cycles.samples = SAMPLES
    scene.cycles.use_denoising = True
    scene.cycles.use_adaptive_sampling = True
    scene.render.film_transparent = True
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.color_depth = "16"
    world = bpy.data.worlds.new("world")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.012, 0.013, 0.016, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 1.0
    scene.world = world
    return scene


def material(name, base, rough=0.4, metal=0.0, coat=0.0, emit=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*base, 1)
    p.inputs["Roughness"].default_value = rough
    p.inputs["Metallic"].default_value = metal
    p.inputs["Coat Weight"].default_value = coat
    p.inputs["Coat Roughness"].default_value = 0.12
    p.inputs["Emission Color"].default_value = (1, 1, 1, 1)
    p.inputs["Emission Strength"].default_value = emit
    m["glow"] = emit
    return m


def mats():
    return {
        # The body: a deep charcoal satin with a thin clear coat, like a premium device.
        "satin": material("satin", (0.048, 0.051, 0.058), rough=0.4, coat=0.4),
        "metal": material("metal", (0.20, 0.205, 0.215), rough=0.32, metal=1.0),
        # Unlit glass where the light will be: near black, a little glossy.
        "glass": material("glass", (0.008, 0.009, 0.011), rough=0.18, coat=0.6),
        # The parts that glow, and how strongly (bright details, dim screens).
        "led": material("led", (0.02, 0.02, 0.02), rough=0.3, emit=3.2),
        "dim": material("dim", (0.02, 0.02, 0.02), rough=0.3, emit=1.1),
        "screen": material("screen", (0.01, 0.011, 0.013), rough=0.15, coat=0.6, emit=0.06),
    }


M = {}


def finish(o, mat, bevel=0.0, seg=5):
    if bevel > 0:
        b = o.modifiers.new("bevel", "BEVEL")
        b.width = bevel
        b.segments = seg
        b.limit_method = "ANGLE"
        b.harden_normals = True
    o.data.materials.append(M[mat])
    for poly in o.data.polygons:
        poly.use_smooth = True
    return o


def box(size, loc, mat="satin", bevel=0.06, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = bpy.context.object
    o.scale = size
    bpy.ops.object.transform_apply(scale=True)
    return finish(o, mat, bevel)


def cyl(r, depth, loc, mat="satin", rot=(0, 0, 0), bevel=0.0, verts=64):
    bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=depth, location=loc, rotation=rot, vertices=verts)
    return finish(bpy.context.object, mat, bevel)


def sphere(r, loc, mat="satin", scale=(1, 1, 1)):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=r, location=loc, segments=96, ring_count=48)
    o = bpy.context.object
    o.scale = scale
    bpy.ops.object.transform_apply(scale=True)
    return finish(o, mat)


def torus(R, r, loc, mat="led", rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_torus_add(major_radius=R, minor_radius=r, location=loc, rotation=rot, major_segments=128, minor_segments=16)
    return finish(bpy.context.object, mat)


def rod(a, b, r, mat="led"):
    """A cylinder from point a to point b."""
    a, b = np.array(a, float), np.array(b, float)
    d = b - a
    length = float(np.linalg.norm(d))
    o = cyl(r, length, tuple((a + b) / 2), mat, verts=32)
    z = np.array([0, 0, 1.0])
    axis = np.cross(z, d / length)
    angle = math.acos(max(-1, min(1, float(np.dot(z, d / length)))))
    if np.linalg.norm(axis) > 1e-6:
        o.rotation_mode = "AXIS_ANGLE"
        o.rotation_axis_angle = (angle, *(axis / np.linalg.norm(axis)))
    return o


def slab(points, depth, y, mat="satin", bevel=0.04):
    """A flat shape in the x/z plane (facing the camera), `depth` thick, its front at y."""
    mesh = bpy.data.meshes.new("slab")
    n = len(points)
    verts = [(x, y, z) for x, z in points] + [(x, y + depth, z) for x, z in points]
    faces = [list(range(n))[::-1], list(range(n, 2 * n))] + [[i, (i + 1) % n, n + (i + 1) % n, n + i] for i in range(n)]
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    o = bpy.data.objects.new("slab", mesh)
    bpy.context.collection.objects.link(o)
    return finish(o, mat, bevel)


# ---------------------------------------------------------------------------------------------
# The nodes, each its topic, about two units across, standing on the floor and facing the camera
# (which looks along +y from in front and a little above).

FRONT = -0.2  # where the face of a standing panel is


def panel(w=2.0, h=1.4, z=0.78):
    box((w, 0.34, h), (0, 0, z), bevel=0.09)
    box((w - 0.22, 0.04, h - 0.42), (0, FRONT + 0.02, z - 0.1), "screen", bevel=0.02)


def you():
    # Head and shoulders: a domed bust, its lower half under the floor.
    sphere(0.88, (0, 0.05, 0), scale=(1, 0.62, 0.76))
    sphere(0.38, (0, 0, 1.13))
    torus(0.2, 0.026, (0, 0, 0.7))
    sphere(0.05, (0, -0.46, 0.34), "led")


def model():
    z = 1.05
    box((1.3, 0.26, 1.3), (0, 0, z), bevel=0.07)
    box((0.62, 0.05, 0.62), (0, -0.14, z), "glass", bevel=0.02)
    box((0.46, 0.03, 0.46), (0, -0.165, z), "led", bevel=0.015)
    for k in (-0.38, 0, 0.38):
        for sx, sz, size in ((0, 1, (0.1, 0.12, 0.26)), (0, -1, (0.1, 0.12, 0.26)), (1, 0, (0.26, 0.12, 0.1)), (-1, 0, (0.26, 0.12, 0.1))):
            x = sx * 0.78 if sx else k
            zz = z + (sz * 0.78 if sz else k)
            box(size, (x, 0, zz), "metal", bevel=0.02)


def memory():
    for i, z in enumerate((0.16, 0.5, 0.84)):
        box((1.9, 1.25, 0.2), (0, 0.1, z), bevel=0.07)
        if i < 2:
            box((1.72, 1.08, 0.05), (0, 0.1, z + 0.17), "dim", bevel=0.02)
    box((1.4, 0.03, 0.05), (0, -0.53, 0.84), "led", bevel=0.01)


def files():
    pts = [(-0.66, 0.05), (0.66, 0.05), (0.66, 1.38), (0.3, 1.74), (-0.66, 1.74)]
    slab(pts, 0.16, -0.08)
    slab([(0.3, 1.74), (0.3, 1.38), (0.66, 1.38)], 0.05, -0.12, "metal", bevel=0.01)
    for z, w in ((1.2, 0.8), (0.95, 0.8), (0.7, 0.8), (0.45, 0.52)):
        box((w, 0.03, 0.065), (-0.08 + (w - 0.8) / 2, -0.1, z), "led" if z > 1 else "dim", bevel=0.012)


def shell():
    panel()
    for i in range(3):
        cyl(0.045, 0.04, (-0.82 + i * 0.14, FRONT - 0.005, 1.33), "dim", rot=(math.pi / 2, 0, 0), verts=24)
    box((1.9, 0.02, 0.02), (0, FRONT - 0.01, 1.22), "metal", bevel=0.0)
    # The prompt: a chevron and a cursor.
    for s in (1, -1):
        box((0.3, 0.03, 0.07), (-0.5, FRONT - 0.02, 0.72 + s * 0.09), "led", bevel=0.012, rot=(0, s * math.radians(36), 0))
    box((0.36, 0.03, 0.07), (0.02, FRONT - 0.02, 0.5), "led", bevel=0.012)


def browser():
    panel()
    for i in range(2):
        cyl(0.045, 0.04, (-0.82 + i * 0.14, FRONT - 0.005, 1.33), "dim", rot=(math.pi / 2, 0, 0), verts=24)
    box((1.05, 0.03, 0.09), (0.25, FRONT - 0.02, 1.33), "led", bevel=0.02)
    for z, w in ((0.92, 1.2), (0.68, 0.9), (0.46, 1.05)):
        box((w, 0.03, 0.07), (-0.6 + w / 2, FRONT - 0.02, z), "dim", bevel=0.012)


def web():
    c = (0, 0, 1.0)
    sphere(0.86, c, "satin")
    for a in (0, 60, 120):
        torus(0.87, 0.011, c, rot=(math.pi / 2, 0, math.radians(a)))
    torus(0.87, 0.012, c)
    for s in (1, -1):
        lat = math.radians(38)
        torus(0.87 * math.cos(lat), 0.01, (0, 0, 1.0 + s * 0.87 * math.sin(lat)), "dim")


def agents():
    top, left, right = (0, 0, 1.42), (-0.68, 0, 0.42), (0.68, 0, 0.42)
    for p in (top, left, right):
        sphere(0.34, p)
        torus(0.35, 0.02, p, "led")
    hub = (0, 0, 0.86)
    rod(top, hub, 0.05)
    rod(hub, left, 0.045, "dim")
    rod(hub, right, 0.045, "dim")
    sphere(0.09, hub, "led")


def skills():
    raw = [(4, -23), (-14, 3), (-2, 3), (-6, 23), (14, -5), (2, -5)]
    pts = [(x / 46 * 2.0, (23 - y) / 46 * 1.9 + 0.04) for x, y in raw]
    slab(pts, 0.3, -0.15, bevel=0.05)
    cx = sum(p[0] for p in pts) / len(pts)
    cz = sum(p[1] for p in pts) / len(pts)
    inner = [(cx + (x - cx) * 0.62, cz + (z - cz) * 0.62) for x, z in pts]
    slab(inner, 0.04, -0.18, "led", bevel=0.012)


def hooks():
    box((1.15, 0.62, 0.55), (0, 0, 1.14), bevel=0.08)
    cyl(0.57, 0.62, (0, 0, 0.92), rot=(math.pi / 2, 0, 0), bevel=0.08, verts=96)
    for x in (-0.27, 0.27):
        cyl(0.065, 0.5, (x, 0, 1.62), "metal")
        cyl(0.067, 0.1, (x, 0, 1.84), "led")
    box((0.86, 0.03, 0.06), (0, -0.325, 1.08), "led", bevel=0.012)
    cyl(0.1, 0.46, (0, 0, 0.3), "satin")
    cyl(0.12, 0.08, (0, 0, 0.42), "dim")


NODES = {"you": you, "model": model, "memory": memory, "files": files, "shell": shell, "browser": browser, "web": web, "agents": agents, "skills": skills, "hooks": hooks}

# ---------------------------------------------------------------------------------------------
# Lights, camera, floor


def light(name, kind, loc, energy, size, target=(0, 0, 0.9)):
    data = bpy.data.lights.new(name, kind)
    data.energy = energy
    if kind == "AREA":
        data.shape = "DISK"
        data.size = size
    o = bpy.data.objects.new(name, data)
    o.location = loc
    bpy.context.collection.objects.link(o)
    d = np.array(target) - np.array(loc)
    o.rotation_euler = (math.atan2(math.hypot(d[0], d[1]), -d[2]), 0, math.atan2(d[1], d[0]) + math.pi / 2)
    return o


def stage(px):
    scene = bpy.context.scene
    scene.render.resolution_x = scene.render.resolution_y = px
    cam = bpy.data.cameras.new("cam")
    cam.type = "ORTHO"
    cam.ortho_scale = 2.9
    o = bpy.data.objects.new("cam", cam)
    bpy.context.collection.objects.link(o)
    elev = math.radians(18)
    dist = 12
    o.location = (0, -dist * math.cos(elev), 0.9 + dist * math.sin(elev))
    o.rotation_euler = (math.pi / 2 - elev, 0, 0)
    scene.camera = o
    lights = [
        light("key", "AREA", (-3.2, -3.6, 5.2), 1150, 4.0),
        light("fill", "AREA", (4.0, -3.0, 1.6), 140, 3.0),
        light("rim", "AREA", (1.8, 4.2, 3.6), 1100, 2.5),
        light("top", "AREA", (0, 0.5, 6), 160, 5.0),
    ]
    bpy.ops.mesh.primitive_plane_add(size=30, location=(0, 0, 0))
    floor = bpy.context.object
    floor.is_shadow_catcher = True
    return lights, floor


# ---------------------------------------------------------------------------------------------
# Images


def load(path):
    img = bpy.data.images.load(path)
    w, h = img.size
    a = np.empty(w * h * 4, np.float32)
    img.pixels.foreach_get(a)
    bpy.data.images.remove(img)
    return a.reshape(h, w, 4)


def save_webp(arr, path, quality=92):
    h, w, _ = arr.shape
    img = bpy.data.images.new("out", w, h, alpha=True, float_buffer=False)
    img.alpha_mode = "STRAIGHT"
    img.pixels.foreach_set(np.ascontiguousarray(arr, np.float32).ravel())
    img.filepath_raw = path
    img.file_format = "WEBP"
    scene = bpy.context.scene
    scene.render.image_settings.quality = quality
    img.save()
    bpy.data.images.remove(img)


def blur(a, r):
    """A soft blur: three box blurs, each way, about a gaussian of radius r."""
    out = a.astype(np.float64)
    k = max(1, int(r))
    for axis in (0, 1):
        for _ in range(3):
            pad = [(0, 0)] * out.ndim
            pad[axis] = (k + 1, k)
            c = np.cumsum(np.pad(out, pad, mode="constant"), axis=axis)
            hi = np.take(c, np.arange(2 * k + 1, c.shape[axis]), axis=axis)
            lo = np.take(c, np.arange(0, c.shape[axis] - 2 * k - 1), axis=axis)
            out = (hi - lo) / (2 * k + 1)
    return out


def render(path):
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


def node(name):
    global M
    scene = reset()
    M = mats()
    NODES[name]()
    lights, floor = stage(NODE_PX)
    tmp = os.path.join(OUT, f".{name}")

    # The object, lit, with its shadow; the glowing parts dark, as if switched off.
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"
    for m in M.values():
        m.node_tree.nodes["Principled BSDF"].inputs["Emission Strength"].default_value = 0
    render(tmp + "-body.png")
    save_webp(load(tmp + "-body.png"), os.path.join(OUT, f"{name}.webp"))

    # The glow: only the lit parts give light, onto the body around them.
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.render.film_transparent = False
    scene.world.node_tree.nodes["Background"].inputs["Color"].default_value = (0, 0, 0, 1)
    for o in lights:
        o.hide_render = True
    floor.hide_render = True
    for m in M.values():
        m.node_tree.nodes["Principled BSDF"].inputs["Emission Strength"].default_value = m.get("glow", 0.0)
    render(tmp + "-glow.png")
    g = load(tmp + "-glow.png")
    lum = np.clip(0.2126 * g[..., 0] + 0.7152 * g[..., 1] + 0.0722 * g[..., 2], 0, 1)
    bloom = 0.3 * blur(lum, NODE_PX / 80) + 0.14 * blur(lum, NODE_PX / 24)
    alpha = np.clip(lum + bloom, 0, 1)
    out = np.ones((*alpha.shape, 4), np.float32)
    out[..., 3] = alpha
    save_webp(out, os.path.join(OUT, f"{name}-glow.webp"))
    for f in (tmp + "-body.png", tmp + "-glow.png"):
        os.remove(f)
    print(f"ART {name}: done", flush=True)


# ---------------------------------------------------------------------------------------------
# The plate: a matte surface seen from straight above, a soft pool of light around the middle, a
# shallow dais under Claude and a fine grain, fading to the plain ground at its edges.

PLATE_W, PLATE_H = 2400, 1600


def plate():
    global M
    scene = reset()
    M = mats()
    scene.render.film_transparent = False
    scene.render.resolution_x, scene.render.resolution_y = PLATE_W, PLATE_H
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.world.node_tree.nodes["Background"].inputs["Color"].default_value = (0, 0, 0, 1)

    grey = bpy.data.materials.new("surface")
    grey.use_nodes = True
    nt = grey.node_tree
    p = nt.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (0.5, 0.5, 0.5, 1)
    p.inputs["Roughness"].default_value = 0.62
    # A fine, even grain, as on bead-blasted metal or a matte coating.
    noise = nt.nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 900.0
    noise.inputs["Detail"].default_value = 2.0
    bump = nt.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.08
    nt.links.new(noise.outputs["Fac"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], p.inputs["Normal"])

    bpy.ops.mesh.primitive_plane_add(size=40, location=(0, 0, 0))
    bpy.context.object.data.materials.append(grey)
    # The dais: a low disc with a soft edge where Claude sits.
    bpy.ops.mesh.primitive_cylinder_add(radius=1.25, depth=0.06, location=(0, 0, 0.03), vertices=256)
    dais = bpy.context.object
    b = dais.modifiers.new("bevel", "BEVEL")
    b.width = 0.025
    b.segments = 6
    dais.data.materials.append(grey)
    for poly in dais.data.polygons:
        poly.use_smooth = True

    cam = bpy.data.cameras.new("cam")
    cam.type = "ORTHO"
    cam.ortho_scale = 12.0
    o = bpy.data.objects.new("cam", cam)
    o.location = (0, 0, 20)
    bpy.context.collection.objects.link(o)
    scene.camera = o
    light("pool", "AREA", (0, 0, 7.5), 1500, 6.0, target=(0, 0, 0))
    light("grazing", "AREA", (-7, 5, 1.6), 260, 3.0, target=(0, 0, 0))

    tmp = os.path.join(OUT, ".plate.png")
    render(tmp)
    a = load(tmp)
    lum = 0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]
    # Centred on 50% (the theme's ground), its range kept gentle, and faded to 50% at the edges so the
    # page's plain ground meets it without a seam.
    edge = np.median(np.concatenate([lum[0], lum[-1], lum[:, 0], lum[:, -1]]))
    centre = lum[PLATE_H // 2, PLATE_W // 2]
    v = 0.5 + 0.5 * (lum - edge) / max(1e-4, centre - edge)
    h, w = lum.shape
    yy, xx = np.mgrid[0:h, 0:w]
    r = np.hypot((xx - w / 2) / (w / 2), (yy - h / 2) / (h / 2))
    fade = np.clip((1.0 - r) / 0.35, 0, 1) ** 1.5
    v = 0.5 + (v - 0.5) * fade
    out = np.ones((h, w, 4), np.float32)
    out[..., 0] = out[..., 1] = out[..., 2] = np.clip(v, 0, 1)
    save_webp(out, os.path.join(OUT, "plate.webp"), quality=90)
    os.remove(tmp)
    print("ART plate: done", flush=True)


for name in ONLY or [*NODES, "plate"]:
    plate() if name == "plate" else node(name)
