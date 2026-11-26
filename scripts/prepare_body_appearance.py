"""Convert CC0 MakeHuman System Assets for Edison's offline renderer.

Pass the extracted makehuman_system_assets_cc0.zip directory. Positions come from
the fitted Anny body at runtime. OBJ contributes only the indexed faces and UVs.
"""
import argparse
import json
import random
import re
import shutil
from pathlib import Path

from PIL import Image, ImageFilter

ASSETS = {
    "hair": ("hair/short01/short01", "hair/short01/short01_diffuse.png"),
    "eyes": ("eyes/high-poly/high-poly", "eyes/materials/brown_eye.png"),
    "brows": ("eyebrows/eyebrow001/eyebrow001", "eyebrows/eyebrow001/eyebrow001.png"),
}


def read_obj(obj: Path) -> dict:
    uv, indices, vertices, surface_faces = [], [], [], []
    corners = {}
    coordinates = []
    for line in obj.read_text().splitlines():
        parts = line.split()
        if not parts:
            continue
        if parts[0] == "vt":
            coordinates.append(list(map(float, parts[1:3])))
        elif parts[0] == "f":
            polygon = []
            surface_polygon = []
            for corner in parts[1:]:
                point, texture = (int(n) - 1 for n in corner.split("/")[:2])
                if (point, texture) not in corners:
                    corners[point, texture] = len(vertices)
                    vertices.append(point)
                    uv.extend(coordinates[texture])
                polygon.append(corners[point, texture])
                surface_polygon.append(point)
            for i in range(1, len(polygon) - 1):
                indices.extend((polygon[0], polygon[i], polygon[i + 1]))
                surface_faces.extend((surface_polygon[0], surface_polygon[i], surface_polygon[i + 1]))

    return dict(vertices=vertices, indices=indices, uv=uv, surface_faces=surface_faces)


def binding(obj: Path, clothes: Path) -> dict:
    mesh = read_obj(obj)
    del mesh["surface_faces"]
    scales = {}
    anchors, weights, offsets = [], [], []
    is_binding = False
    for line in clothes.read_text().splitlines():
        fields = line.split()
        if not fields or fields[0].startswith("#"):
            continue
        if fields[0] in ("x_scale", "y_scale", "z_scale"):
            a, b, length = fields[1:]
            scales[fields[0][0]] = [int(a), int(b), float(length)]
        elif fields[0] == "verts":
            is_binding = True
        elif is_binding:
            a, b, c, w0, w1, w2, x, y, z = fields
            anchors.extend(map(int, (a, b, c)))
            weights.extend(map(float, (w0, w1, w2)))
            offsets.extend(map(float, (x, y, z)))
    assert max(mesh["vertices"]) < len(anchors) // 3
    return dict(**mesh, anchors=anchors,
                weights=weights, offsets=offsets, scales=[scales[k] for k in "xyz"])


def garment(obj: Path, clothes: Path, base: Path, cache: Path) -> dict:
    """Transfer the garment from MakeHuman's clothing helper to Anny's visible body.

    Compute surface attachments once in the shared hm08 rest mesh. Each garment vertex
    stores a point on a body triangle plus clearance along that triangle's normal.
    """
    import numpy as np
    import trimesh
    from safetensors.numpy import load_file

    data = load_file(str(cache))
    vertices = np.array([list(map(float, line.split()[1:4]))
                         for line in base.read_text().splitlines() if line.startswith("v ")])
    indices = data["base_mesh_vertex_indices"]
    triangles = indices[data["faces"]]
    # The compact template carries the small topology edits around the pelvis.
    # Its inverse transform is just the coordinate conversion and metre scale.
    surface = vertices.copy()
    surface[indices] = data["template_vertices"][:, [0, 2, 1]] * [10, 10, -10]
    body = trimesh.Trimesh(vertices=surface, faces=triangles, process=False)
    ref_positions = []
    scales = {}
    bindings, covered = clothes.read_text().split("\ndelete_verts\n", 1)
    for line in bindings.splitlines():
        fields = line.split()
        if not fields or fields[0].startswith("#"):
            continue
        if fields[0] in ("x_scale", "y_scale", "z_scale"):
            a, b, length = fields[1:]
            axis = "xyz".index(fields[0][0])
            scales[axis] = abs(vertices[int(a), axis] - vertices[int(b), axis]) / float(length)
        elif fields[0].isdigit():
            if len(fields) == 1:
                ref_positions.append(vertices[int(fields[0])])
            else:
                anchors = np.array(fields[:3], dtype=int)
                weights = np.array(fields[3:6], dtype=float)
                offsets = np.array(fields[6:9], dtype=float)
                ref_positions.append(weights @ vertices[anchors] + offsets * [scales[i] for i in range(3)])
    ref_positions = np.array(ref_positions)
    nearest, _, face = trimesh.proximity.closest_point(body, ref_positions)
    weights = trimesh.triangles.points_to_barycentric(body.triangles[face], nearest)
    normal_distance = np.einsum("ij,ij->i", ref_positions - nearest, body.face_normals[face])
    clearance = np.maximum(0.075, normal_distance) / 10
    mesh = read_obj(obj)
    assert max(mesh["vertices"]) < len(weights)
    covered_vertices = []
    for start, end in re.findall(r"(\d+)(?:\s+-\s+(\d+))?", covered):
        covered_vertices.extend(range(int(start), int(end or start) + 1))
    return dict(**mesh, covered=sorted(set(covered_vertices).intersection(map(int, indices))),
                anchors=triangles[face].flatten().tolist(),
                weights=weights.round(6).flatten().tolist(), clearance=clearance.round(5).tolist())




def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--base-mesh", type=Path, required=True, help="Anny's data/mpfb2/3dobjs/base.obj")
    parser.add_argument("--model-cache", type=Path, required=True, help="Anny's compact safetensors cache")
    args = parser.parse_args()
    source = args.source
    target = Path(__file__).resolve().parents[1] / "surfaces/gui/public/body-appearance"
    target.mkdir(parents=True, exist_ok=True)
    assets = {}
    for name, (mesh, image) in ASSETS.items():
        assets[name] = binding(source / f"{mesh}.obj", source / f"{mesh}.mhclo")
        shutil.copyfile(source / image, target / f"{name}.png")
    shutil.copyfile(source / "skins/young_asian_male/young_lightskinned_male_diffuse3.png", target / "skin.png")
    # A repeating, fine bump map adds texture without altering the body mesh.
    rng = random.Random(22)
    bump = Image.new("L", (256, 256))
    bump.putdata([116 + rng.randrange(25) for _ in range(256 ** 2)])
    pixels = bump.load()
    for _ in range(5200):
        pixels[rng.randrange(256), rng.randrange(256)] = rng.randrange(40, 100)
    bump.filter(ImageFilter.GaussianBlur(0.46)).save(target / "skin-detail.png")
    suit = source / "clothes/male_casualsuit06/male_casualsuit06"
    outfit = garment(suit.with_suffix(".obj"), suit.with_suffix(".mhclo"), args.base_mesh, args.model_cache)
    for channel in ("diffuse", "normal", "ao"):
        shutil.copyfile(suit.with_name(f"{suit.name}_{channel}.png"), target / f"outfit-{channel}.png")
    (target / "outfit.json").write_text(json.dumps(outfit, separators=(",", ":")) + "\n")
    (target / "bindings.json").write_text(json.dumps(assets, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
