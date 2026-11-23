"""Turns recorded values into a fitted hologram: vertices, tape paths, reference layers."""

from __future__ import annotations

import base64
import hashlib
import json
import threading
from collections import OrderedDict

import numpy as np
import torch

from . import catalog as cat
from .fit import VERSION, Fitter
from .geometry import Crossings, hull_order, plane_loops, walk_length
from .measure import SIDES, Evaluator, compile_measures, section_ring
from .model import BodyModel, Shape, shared_model

ARM_BONES = ("upperarm", "lowerarm", "wrist", "finger", "metacarpal")
REGIONS = {
    "B01": ("head",), "B07": ("neck",), "C03": ("spine01", "clavicle", "shoulder01"),
    "C04": ("clavicle", "shoulder01"), "C08": ("spine01", "spine02"), "E01": ("spine03", "spine04"),
    "E05": ("spine05", "pelvis"), "E06": ("spine04", "spine05"), "E08": ("pelvis", "root"),
    "F03": ("upperarm", "lowerarm"), "F05": ("shoulder01", "upperarm", "lowerarm"),
    "F07": ("upperarm",), "F12": ("lowerarm02", "wrist"), "F13": ("lowerarm02", "wrist"),
    "H09": ("upperleg",), "H13": ("lowerleg",), "H15": ("lowerleg02",),
    "D11": ("spine",), "D12": ("spine",), "H18": ("upperleg", "lowerleg"),
    "G01": ("wrist", "metacarpal", "finger"), "G04": ("metacarpal", "finger2-1", "finger3-1", "finger4-1", "finger5-1"),
}
FRONT_ONLY, BACK_ONLY = {"E06", "D11"}, {"C03", "D12"}
BAND = {"head": 0.012, "torso": 0.025, "arm": 0.018, "leg": 0.02, "hand": 0.01, "target": 0.02}


def three(p: np.ndarray) -> np.ndarray:
    """Anny (z up, front −y) to three.js (y up, front +z)."""
    p = np.asarray(p, dtype=np.float32)
    return np.stack([p[..., 0], p[..., 2], -p[..., 1]], -1)


def b64(a: np.ndarray) -> str:
    return base64.b64encode(np.ascontiguousarray(a).tobytes()).decode()


def _rot(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    a, b = a / np.linalg.norm(a), b / np.linalg.norm(b)
    v, c = np.cross(a, b), float(a @ b)
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx / (1 + c)


class BodyService:
    def __init__(self, model: BodyModel | None = None):
        self._model = model
        self._lock = threading.Lock()
        self._ready = threading.Event()
        self.error: str | None = None
        self._cache: OrderedDict[str, tuple[Shape, dict]] = OrderedDict()
        self._last: Shape | None = None

    # ---- lifecycle -------------------------------------------------------------------
    def start(self) -> None:
        threading.Thread(target=self._load, name="body-model", daemon=True).start()

    def _load(self) -> None:
        try:
            self.model = self._model or shared_model()
            self.measures = compile_measures(self.model)
            self.fitter = Fitter(self.model, self.measures)
            self.display_keys = Evaluator(self.measures)
            self._pose = self._display_pose()
            self._faces = self._visible_faces()
            self._masks = self._highlight_masks()
        except Exception as exc:  # surfaced through status(); the rest of Edison keeps running
            self.error = f"{type(exc).__name__}: {exc}"
        finally:
            self._ready.set()

    def status(self) -> dict:
        if not self._ready.is_set():
            return {"state": "loading"}
        if self.error:
            return {"state": "error", "error": self.error}
        return {"state": "ready", "fitter": VERSION}

    def wait(self, timeout: float | None = None) -> None:
        if not self._ready.wait(timeout):
            raise TimeoutError("body model is still loading")
        if self.error:
            raise RuntimeError(self.error)

    # ---- static data -----------------------------------------------------------------
    def _display_pose(self) -> torch.Tensor:
        """Arms hang naturally: elbows straightened, upper arms drawn 18° toward the body."""
        h = self.model.bone_heads(Shape.neutral())
        labels = self.model.bone_labels
        pose = torch.eye(4)[None, None].repeat(1, len(labels), 1, 1)
        for s, sx in SIDES.items():
            sh, el, wr = h[f"upperarm01.{s}"], h[f"lowerarm01.{s}"], h[f"wrist.{s}"]
            arm = el - sh
            target = arm / np.linalg.norm(arm) * np.cos(np.radians(18)) + np.array([0, 0, -1]) * np.sin(np.radians(18))
            pose[0, labels.index(f"upperarm01.{s}"), :3, :3] = torch.tensor(_rot(arm, target), dtype=torch.float32)
            pose[0, labels.index(f"lowerarm01.{s}"), :3, :3] = torch.tensor(_rot(wr - el, arm), dtype=torch.float32)
        return pose

    def _bones(self, *prefixes) -> np.ndarray:
        ids = [i for i, n in enumerate(self.model.bone_labels) if n.startswith(prefixes)]
        return np.isin(self.model.dominant_bone(), ids)

    def _visible_faces(self) -> np.ndarray:
        eyes = self._bones("eye")
        return self.model.faces[~eyes[self.model.faces].any(1)].astype(np.uint32)

    def _highlight_masks(self) -> dict[str, np.ndarray]:
        shape = Shape.neutral()
        with torch.no_grad():
            v = self.model.vertices(shape).numpy()
            sub = self.fitter.subset(shape)
            shown = self.display_keys.display(sub, self.display_keys.plan(sub))
        spine_y = self.model.bone_heads(shape)["spine03"][1]
        masks = {}
        for p in cat.PARAMETERS:
            pid = p["id"]
            region = self._bones(*REGIONS[pid]).astype(np.float32)
            if pid in FRONT_ONLY:
                region *= v[:, 1] < spine_y
            if pid in BACK_ONLY:
                region *= v[:, 1] > spine_y
            mask = 0.3 * region
            band = BAND[p["group"]]
            for (key, _side), (pts, closed) in shown.items():
                if key != pid:
                    continue
                dense = _densify(pts, closed, band / 3)
                d = _nearest_distance(v, dense)
                mask = np.maximum(mask, np.clip(1 - d / band, 0, 1) ** 0.7)
            masks[pid] = (np.clip(mask, 0, 1) * 255).astype(np.uint8)
        return masks

    def topology(self) -> dict:
        self.wait()
        return {
            "fitter": VERSION,
            "vertex_count": int(self.model.template.shape[0]),
            "faces": b64(self._faces),
            "masks": {k: b64(m) for k, m in self._masks.items()},
        }

    # ---- fitting ---------------------------------------------------------------------
    def shape_for(self, values: dict, warm: bool = False) -> tuple[Shape, dict]:
        self.wait()
        targets = cat.targets(values)
        key = hashlib.sha256(json.dumps(sorted((f"{k[0]}{k[1]}", round(v, 4)) for k, v in targets.items())).encode()).hexdigest()
        with self._lock:
            if key in self._cache:
                self._cache.move_to_end(key)
                shape, measured = self._cache[key]
            else:
                result = self.fitter.fit(targets, self._last if warm else None)
                shape, measured = result.shape, result.values
                self._cache[key] = (shape, measured)
                while len(self._cache) > 64:
                    self._cache.popitem(last=False)
            if warm:
                self._last = shape
        return shape, {"targets": targets, "measured": measured, "key": key}

    def render(self, values: dict, warm: bool = True, shape: Shape | None = None) -> dict:
        values = cat.clean(values)
        if shape is None:
            shape, info = self.shape_for(values, warm)
        else:
            info = {"targets": cat.targets(values), "measured": self.fitter.measure(shape), "key": None}
        with torch.no_grad():
            rest = self.model.vertices(shape)
            posed = self.model.posed_vertices(shape, self._pose)
            sub = rest[self.measures.index]
            plan = self.display_keys.plan(sub)
            shown = self.display_keys.display(sub, plan, posed[self.measures.index])
        measured, targets = info["measured"], info["targets"]
        geometry: dict[str, list] = {}
        for (pid, side), (pts, closed) in shown.items():
            geometry.setdefault(pid, []).append(
                {"side": side, "closed": closed, "points": three(pts).round(4).tolist()}
            )
        layers = self._reference_layers(values, rest.numpy(), posed.numpy(), shape)
        for pid, items in layers.items():
            geometry[pid] = items
        out_measured: dict[str, dict] = {}
        residual: dict[str, dict] = {}
        for (pid, side), v in measured.items():
            out_measured.setdefault(pid, {})[side] = round(v * 100, 1)
            if (pid, side) in targets:
                residual.setdefault(pid, {})[side] = round((v - targets[(pid, side)]) * 100, 1)
        verts = three(posed.numpy())
        return {
            "fitter": VERSION,
            "shape": shape.to_json(),
            "vertices": b64(verts.astype(np.float32)),
            "bounds": {"min": verts.min(0).tolist(), "max": verts.max(0).tolist()},
            "measured": out_measured,
            "residual": residual,
            "geometry": geometry,
        }

    # ---- reference layers ------------------------------------------------------------
    def _reference_layers(self, values, rest, posed, shape) -> dict[str, list]:
        F = self.model.faces
        keep = ~self._bones(*ARM_BONES)
        body = keep[F].all(1)
        marks = self.measures.landmarks
        floor = float(rest[:, 2].min())
        h = self.model.bone_heads(shape)
        out: dict[str, list] = {}

        def hem(z, tag, below=False):
            ring = _hull_section(rest, F, z, body)
            if ring is None:
                return None
            return {"side": tag, "closed": True, "below_floor": below, "points": three(ring.points(posed)).round(4).tolist()}

        def leg_rings(z, tag, below=False):
            rings = []
            for s in SIDES:
                axis = _leg_axis_point(h, s, z)
                ring = section_ring(rest, F, np.array([axis[0], axis[1], z]), np.array([0, 0, 1.0]), axis, body)
                if ring is None:
                    ring = _hull_section(rest, F, z, body, centre=axis, radius=0.12)
                if ring is not None:
                    rings.append({"side": f"{tag}{s}" if tag else s, "closed": True, "below_floor": below,
                                  "points": three(ring.points(posed)).round(4).tolist()})
            return rings

        d11 = values.get("D11", {}).get("value")
        if d11:
            snp = marks["SNP.L"]
            z, below = _walk(rest, F, snp, np.array([1.0, 0, 0]), np.array([0, -1.0, -1.0]), d11 / 100, body, floor)
            layer = hem(z, "")
            if layer:
                out["D11"] = [layer]
        d12 = values.get("D12", {}).get("value")
        if d12:
            z, below = _walk(rest, F, marks["C7"], np.array([1.0, 0, 0]), np.array([0, 1.0, -1.0]), d12 / 100, body, floor)
            layer = hem(z, "")
            if layer:
                out["D12"] = [layer]
        h18 = values.get("H18", {})
        if h18.get("outseam") or h18.get("inseam"):
            items = []
            if h18.get("outseam"):
                rise = self.measures.items[("E05", "")].candidates[0].points(rest)
                side_pt = rise[np.argmax(rise[:, 0])]
                start = int(np.argmin(np.linalg.norm(rest - side_pt, axis=1)))
                ankle = h["foot.L"] + np.array([0.04, 0, 0.03])
                normal = np.cross(ankle - rest[start], np.array([0, 1.0, 0]))
                z, below = _walk(rest, F, start, normal, np.array([0.0, 0, -1.0]), h18["outseam"] / 100, body, floor)
                items += leg_rings(z, "out", below)
            if h18.get("inseam"):
                start = marks["CROTCH"]
                ankle = h["foot.L"] + np.array([-0.03, 0, 0.03])
                normal = np.cross(ankle - rest[start], np.array([0, 1.0, 0]))
                z, below = _walk(rest, F, start, normal, np.array([0.02, 0, -1.0]), h18["inseam"] / 100, body, floor)
                items += leg_rings(z, "in", below)
            if items:
                out["H18"] = items
        h15 = values.get("H15", {})
        if h15.get("height"):
            out["H15"] = leg_rings(floor + h15["height"] / 100, "")
        f13 = values.get("F13", {})
        if f13:
            side = f13.get("side", "L")
            wrist = self.measures.items[("F12", side)].candidates[1]
            pts = posed[wrist.a] * (1 - wrist.t[:, None]) + posed[wrist.b] * wrist.t[:, None]
            r_pts = wrist.points(rest)
            hull = hull_order(_flat(r_pts))
            ring = pts[hull]
            length = np.linalg.norm(r_pts[hull] - np.roll(r_pts[hull], 1, 0), axis=1).sum()
            girth = f13.get("girth")
            scale = (girth / 100) / length if girth else 1.08
            centre = ring.mean(0)
            ring = centre + (ring - centre) * max(scale, 1.02)
            out["F13"] = [{"side": side, "closed": True, "points": three(ring).round(4).tolist()}]
        return out


def _flat(points: np.ndarray) -> np.ndarray:
    from .geometry import _plane_coords

    return _plane_coords(points)


def _densify(pts: np.ndarray, closed: bool, step: float) -> np.ndarray:
    seq = np.vstack([pts, pts[:1]]) if closed else pts
    out = [seq[:1]]
    for a, b in zip(seq[:-1], seq[1:]):
        n = max(1, int(np.linalg.norm(b - a) / step))
        out.append(a + (b - a) * np.linspace(0, 1, n + 1)[1:, None])
    return np.vstack(out)


def _nearest_distance(v: np.ndarray, pts: np.ndarray, chunk: int = 2048) -> np.ndarray:
    out = np.empty(len(v))
    for i in range(0, len(v), chunk):
        d = np.linalg.norm(v[i : i + chunk, None] - pts[None], axis=2)
        out[i : i + chunk] = d.min(1)
    return out


def _leg_axis_point(h, s, z):
    hip, knee, ankle = h[f"upperleg01.{s}"], h[f"lowerleg01.{s}"], h[f"foot.{s}"]
    a, b = (hip, knee) if z >= knee[2] else (knee, ankle)
    f = np.clip((z - a[2]) / (b[2] - a[2] + 1e-9), 0, 1)
    return a + f * (b - a)


def _hull_section(rest, faces, z, mask, centre=None, radius=None):
    loops = plane_loops(rest, faces, np.array([0, 0, z]), np.array([0, 0, 1.0]), mask)
    if not loops:
        return None
    parts = [c for c, _ in loops]
    allc = Crossings(np.concatenate([c.a for c in parts]), np.concatenate([c.b for c in parts]), np.concatenate([c.t for c in parts]))
    pts = allc.points(rest)
    if centre is not None:
        keep = np.linalg.norm(pts[:, :2] - centre[:2], axis=1) < radius
        if keep.sum() < 3:
            return None
        allc, pts = allc.subset(np.where(keep)[0]), pts[keep]
    return allc.subset(hull_order(pts[:, :2]))


def _walk(rest, faces, start, normal, prefer, length, mask, floor) -> tuple[float, bool]:
    """Height reached after following the surface `length` metres from vertex `start`."""
    p0 = rest[start]
    best = None
    for c, closed in plane_loops(rest, faces, p0, normal, mask):
        pts = c.points(rest)
        d = np.linalg.norm(pts - p0, axis=1)
        if best is None or d.min() < best[0]:
            best = (d.min(), pts, closed, int(d.argmin()))
    if best is None:
        return p0[2] - length, False
    _, pts, closed, i = best
    n = len(pts)
    fwd = [pts[(i + k) % n] for k in range(n)] if closed else list(pts[i:])
    bwd = [pts[(i - k) % n] for k in range(n)] if closed else list(pts[: i + 1][::-1])
    prefer = prefer / np.linalg.norm(prefer)

    def heading(seq):
        if len(seq) < 4:
            return -np.inf
        return float((seq[3] - seq[0]) @ prefer)

    seq = np.array(fwd if heading(fwd) >= heading(bwd) else bwd)
    if closed:
        seq = seq[: n // 2 + n // 4]
    path = np.vstack([p0, seq])
    end = walk_length(path, length)
    run = np.linalg.norm(np.diff(path, axis=0), axis=1).sum()
    z = float(end[2])
    below = bool(length > run or z < floor)
    if length > run:
        z = float(path[-1][2]) - (length - run)
    return max(z, floor + 0.01), below


_service: LazyService | None = None


class LazyService:
    """Starts loading Anny on the first body request, so Edison itself starts instantly."""

    def __init__(self):
        self._service: LazyService | None = None
        self._lock = threading.Lock()

    def __getattr__(self, name):
        with self._lock:
            if self._service is None:
                self._service = BodyService()
                self._service.start()
        return getattr(self._service, name)


def shared_service() -> LazyService:
    global _service
    if _service is None:
        _service = LazyService()
    return _service
