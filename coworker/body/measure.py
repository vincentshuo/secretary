"""Tailoring measurements defined once on the reference body and read on any fitted body.

Girths are tape lengths (convex hull of a frozen section); lengths follow surface arcs or
landmark segments. Each measurement is keyed by (parameter id, side) where side is
"L", "R" or "" for midline items. Nothing here is copied from MakeHuman's AGPL ruler.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import torch

from .geometry import (
    Crossings,
    _plane_coords,
    arc_between,
    hull_order,
    loop_around,
    plane_basis,
    plane_loops,
    tape_hull,
)
from .model import BodyModel, Shape

UP = np.array([0.0, 0.0, 1.0])
BACK = np.array([0.0, 1.0, 0.0])  # Anny faces −y
SMOOTH = 0.002  # metres; softness of max/min over candidate sections
SIDES = {"L": 1.0, "R": -1.0}  # Anny's ".L" bones sit at +x
BACK_DROP = 0.0  # the back-shoulder tape crosses the upper back at acromion height
ACROMION_LEAN = 0.2


def _vertex(i: int) -> Crossings:
    return Crossings(np.array([i]), np.array([i]), np.array([0.0]))


@dataclass
class Girth:
    candidates: list[Crossings]
    combine: str = "one"  # "max" | "min" | "one": fullest / slimmest candidate section
    hull: bool = True  # tape over the convex hull rather than along every crossing

    def crossings(self) -> list[Crossings]:
        return self.candidates


@dataclass
class Path:
    """Ordered pieces: a taut tape over a surface arc ("tape"), landmark points ("chain"),
    or the centre of a section ("centroid")."""

    pieces: list[tuple[str, Crossings]]

    def crossings(self) -> list[Crossings]:
        return [c for _, c in self.pieces]


@dataclass
class Measures:
    items: dict[tuple[str, str], Girth | Path]
    index: torch.Tensor  # vertex subset the fitter evaluates
    local: dict[tuple[str, str], Girth | Path] = field(default_factory=dict)
    landmarks: dict[str, int] = field(default_factory=dict)
    reference: dict = field(default_factory=dict)


@dataclass
class Plan:
    seg0: torch.Tensor
    seg1: torch.Tensor
    seg_cand: torch.Tensor
    n_cand: int
    cand_of: torch.Tensor  # [measures, K] candidate ids, −1 padding
    sign: torch.Tensor  # +1 fullest, −1 slimmest
    orders: list[list[np.ndarray]]  # per measure, per candidate: ordered point rows
    closed: list[bool]


class Evaluator:
    """All measurements as one sparse point map plus segment sums, so fitting stays fast."""

    def __init__(self, measures: Measures, keys=None):
        self.keys = list(keys or measures.local)
        self.defs = [measures.local[k] for k in self.keys]
        rows: list[int] = []
        cols: list[int] = []
        vals: list[float] = []
        count = 0

        def add(c: Crossings, centroid=False):
            nonlocal count
            n = len(c.a)
            if centroid:
                rows.extend([count] * 2 * n)
                cols.extend(c.a.tolist() + c.b.tolist())
                vals.extend(((1 - c.t) / n).tolist() + (c.t / n).tolist())
                count += 1
                return np.array([count - 1])
            ids = np.arange(count, count + n)
            rows.extend(ids.tolist() * 2)
            cols.extend(c.a.tolist() + c.b.tolist())
            vals.extend((1 - c.t).tolist() + c.t.tolist())
            count += n
            return ids

        self.parts: list[list[tuple[str, np.ndarray]]] = []
        for d in self.defs:
            if isinstance(d, Girth):
                self.parts.append([("girth" if d.hull else "loop", add(c)) for c in d.candidates])
            else:
                self.parts.append([(mode, add(c, mode == "centroid")) for mode, c in d.pieces])
        self.W = torch.sparse_coo_tensor(
            torch.tensor([rows, cols]), torch.tensor(vals, dtype=torch.float32), (count, len(measures.index)),
            check_invariants=False,
        ).coalesce()

    def points(self, v_sub: torch.Tensor) -> torch.Tensor:
        return torch.sparse.mm(self.W, v_sub)

    def plan(self, v_sub: torch.Tensor) -> Plan:
        P = self.points(v_sub).detach().numpy()
        seg0, seg1, segc, orders, closed, cand_rows, signs = [], [], [], [], [], [], []
        n_cand = 0

        def segments(order, ring):
            nonlocal n_cand
            a = order if ring else order[:-1]
            b = np.roll(order, -1) if ring else order[1:]
            seg0.extend(a.tolist())
            seg1.extend(b.tolist())
            segc.extend([n_cand] * len(a))
            n_cand += 1
            return n_cand - 1

        for d, parts in zip(self.defs, self.parts):
            if isinstance(d, Girth):
                ords = []
                ids = []
                for mode, rows in parts:
                    order = rows[hull_order(_plane_coords(P[rows]))] if mode == "girth" else rows
                    ords.append(order)
                    ids.append(segments(order, True))
                orders.append(ords)
                closed.append(True)
                cand_rows.append(ids)
                signs.append(-1.0 if d.combine == "min" else 1.0)
            else:
                seq = []
                for mode, rows in parts:
                    seq.append(rows[tape_hull(torch.from_numpy(P[rows]))] if mode == "tape" else rows)
                order = np.concatenate(seq)
                orders.append([order])
                closed.append(False)
                cand_rows.append([segments(order, False)])
                signs.append(1.0)
        k = max(len(r) for r in cand_rows)
        cand_of = torch.tensor([r + [-1] * (k - len(r)) for r in cand_rows])
        return Plan(
            torch.tensor(seg0), torch.tensor(seg1), torch.tensor(segc), n_cand, cand_of,
            torch.tensor(signs), orders, closed,
        )

    def values(self, v_sub: torch.Tensor, plan: Plan) -> torch.Tensor:
        P = self.points(v_sub)
        lengths = torch.linalg.norm(P[plan.seg1] - P[plan.seg0], dim=1)
        cand = torch.zeros(plan.n_cand, dtype=P.dtype).index_add(0, plan.seg_cand, lengths)
        C = cand[plan.cand_of.clamp(min=0)]
        s = plan.sign[:, None]
        scaled = torch.where(plan.cand_of >= 0, s * C / SMOOTH, torch.tensor(-torch.inf))
        return plan.sign * SMOOTH * torch.logsumexp(scaled, 1)

    def display(self, v_sub: torch.Tensor, plan: Plan, points_from: torch.Tensor | None = None):
        """Per key: the chosen section/path as 3-D points (optionally on posed vertices)."""
        P = self.points(v_sub).detach()
        Q = P if points_from is None else self.points(points_from).detach()
        out = {}
        for key, ords, closed, sign in zip(self.keys, plan.orders, plan.closed, plan.sign.tolist()):
            lengths = [
                float(torch.linalg.norm(P[np.roll(o, -1)] - P[o], dim=1)[: None if closed else -1].sum())
                for o in ords
            ]
            k = int(np.argmax(lengths) if sign > 0 else np.argmin(lengths))
            out[key] = (Q[ords[k]].numpy(), closed)
        return out


class _Builder:
    def __init__(self, model: BodyModel):
        self.model = model
        shape = Shape.neutral()
        with torch.no_grad():
            self.v = model.vertices(shape).numpy().astype(np.float64)
        self.f = model.faces
        self.h = {k: v.astype(np.float64) for k, v in model.bone_heads(shape).items()}
        self.dom = model.dominant_bone()
        self.labels = model.bone_labels

    def bones(self, *prefixes: str) -> np.ndarray:
        ids = [i for i, name in enumerate(self.labels) if name.startswith(prefixes)]
        return np.isin(self.dom, ids)

    def face_mask(self, vertex_mask: np.ndarray) -> np.ndarray:
        return vertex_mask[self.f].all(1)

    def ring(self, point, normal, axis_point=None, mask=None) -> Crossings:
        c = loop_around(self.v, self.f, point, normal, point if axis_point is None else axis_point, mask)
        if c is None:
            raise ValueError(f"no closed section at {np.round(point, 3)}")
        return c

    def nearest(self, p, mask=None) -> int:
        d = np.linalg.norm(self.v - p, axis=1)
        if mask is not None:
            d = np.where(mask, d, np.inf)
        return int(np.argmin(d))

    def extreme(self, centre, direction, radius, mask=None) -> int:
        """Surface vertex furthest along `direction` from `centre` within `radius`."""
        direction = direction / np.linalg.norm(direction)
        rel = self.v - centre
        score = rel @ direction - 0.6 * np.linalg.norm(rel - np.outer(rel @ direction, direction), axis=1)
        ok = np.linalg.norm(rel, axis=1) < radius
        if mask is not None:
            ok &= mask
        return int(np.argmax(np.where(ok, score, -np.inf)))

    def surface_path(self, a: int, b: int, via: np.ndarray, mask=None) -> Crossings:
        """Planar surface arc from vertex a to vertex b passing nearest `via`."""
        pa, pb = self.v[a], self.v[b]
        normal = np.cross(pb - pa, via - pa)
        best = None
        for c, closed in plane_loops(self.v, self.f, pa, normal, mask):
            pts = c.points(self.v)
            da = np.linalg.norm(pts - pa, axis=1)
            db = np.linalg.norm(pts - pb, axis=1)
            score = da.min() + db.min()
            if best is None or score < best[0]:
                best = (score, c, closed, int(da.argmin()), int(db.argmin()))
        _, c, closed, i, j = best
        pts = c.points(self.v)
        if closed:
            arc = arc_between(pts, i, j, via)
        else:
            arc = np.arange(min(i, j), max(i, j) + 1)
            if i > j:
                arc = arc[::-1]
        chain = c.subset(arc)
        return Crossings(
            np.concatenate([[a], chain.a, [b]]),
            np.concatenate([[a], chain.b, [b]]),
            np.concatenate([[0.0], chain.t, [0.0]]),
        )

    def along(self, a, b, fractions, normal=None):
        a, b = self.h[a], self.h[b]
        return [(a + f * (b - a), (b - a) if normal is None else normal) for f in fractions]


def compile_measures(model: BodyModel) -> Measures:
    B = _Builder(model)
    h = B.h
    items: dict[tuple[str, str], Girth | Path] = {}
    marks: dict[str, int] = {}
    torso_axis = lambda z: np.array([0.0, h["spine03"][1], z])  # noqa: E731

    # Head: hat line above brows and ears, take the fullest of a few heights.
    eye_z = h["eye.L"][2]
    head_c = (h["head"] + np.array([0, -0.04, 0]))
    head_mask = B.face_mask(~B.bones("eye"))
    items[("B01", "")] = Girth(
        [B.ring(np.array([0, head_c[1], eye_z + dz]), UP, None, head_mask) for dz in (0.04, 0.05, 0.06)],
        "max",
    )

    # Collar line below the larynx, sloping down to the front like a shirt collar band.
    neck_p = h["neck01"] + 0.35 * (h["head"] - h["neck01"])
    tilt = np.radians(14)
    items[("B07", "")] = Girth([B.ring(neck_p, np.array([0, -np.sin(tilt), np.cos(tilt)]))])

    base = B.ring(h["neck01"] - np.array([0, 0, 0.012]), UP)
    base_pts = base.points(B.v)
    midline = np.abs(B.v[:, 0]) < 0.004
    marks["C7"] = B.nearest(base_pts[np.argmax(base_pts[:, 1])] * np.array([0, 1, 1]), midline)
    for s, sx in SIDES.items():
        marks[f"SNP.{s}"] = B.nearest(base_pts[np.argmax(sx * base_pts[:, 0])])
        joint = h[f"upperarm01.{s}"]
        marks[f"AC.{s}"] = B.extreme(joint, np.array([ACROMION_LEAN * sx, 0, 1]), 0.10)
        elbow = h[f"lowerarm01.{s}"]
        marks[f"EL.{s}"] = B.extreme(elbow, np.array([0.5 * sx, 1.0, 0]), 0.07)
        marks[f"WR.{s}"] = B.extreme(h[f"wrist.{s}"], np.array([0.5 * sx, 1.0, 0]), 0.045, B.bones("lowerarm", "wrist"))

    ac_l, ac_r = B.v[marks["AC.L"]], B.v[marks["AC.R"]]
    back_via = np.array([0, B.v[marks["C7"]][1] + 0.01, (ac_l[2] + ac_r[2]) / 2 - BACK_DROP])
    back_via = B.v[B.extreme(back_via - BACK * 0.05, BACK, 0.12)]
    items[("C03", "")] = Path([("tape", B.surface_path(marks["AC.R"], marks["AC.L"], back_via))])

    for s in SIDES:
        snp, ac = B.v[marks[f"SNP.{s}"]], B.v[marks[f"AC.{s}"]]
        items[("C04", s)] = Path([("tape", B.surface_path(marks[f"SNP.{s}"], marks[f"AC.{s}"], (snp + ac) / 2 + UP * 0.04))])

    # Chest: fullest level between the nipple line and just under the armpit.
    s_lo, s_hi = h["spine02"][2], h["upperarm01.L"][2]
    items[("C08", "")] = Girth(
        [B.ring(torso_axis(s_lo + f * (s_hi - s_lo)), UP) for f in (0.30, 0.38, 0.46, 0.54)], "max"
    )

    # Natural waist: Anny's own anthropometric waist loop (upstream vertex ring).
    from anny.anthropometry import BASE_MESH_WAIST_VERTICES

    base_index = model.anny.base_mesh_vertex_indices.cpu().numpy().tolist()
    waist = np.array([base_index.index(i) for i in BASE_MESH_WAIST_VERTICES])
    items[("E01", "")] = Girth([Crossings(waist, waist, np.zeros(len(waist)))], hull=False)
    waist_z = float(B.v[waist, 2].mean())

    hip_joint_z = h["upperleg01.L"][2]
    rise_z = waist_z - 0.5 * (waist_z - hip_joint_z)
    band_tilt = np.radians(8)
    items[("E05", "")] = Girth(
        [B.ring(torso_axis(rise_z), np.array([0, -np.sin(band_tilt), np.cos(band_tilt)]))]
    )
    items[("E06", "")] = Girth(
        [B.ring(torso_axis(z), UP) for z in np.linspace(rise_z, waist_z + 0.03, 5)], "max"
    )
    crotch_mask = (np.abs(B.v[:, 0]) < 0.012) & (B.v[:, 2] < hip_joint_z + 0.05)
    crotch_z = float(B.v[crotch_mask, 2].min())
    marks["CROTCH"] = int(np.where(crotch_mask)[0][np.argmin(B.v[crotch_mask, 2])])
    items[("E08", "")] = Girth(
        [B.ring(torso_axis(z), UP) for z in np.linspace(crotch_z + 0.05, rise_z - 0.02, 6)], "max"
    )

    for s in SIDES:
        ac, el, wr = marks[f"AC.{s}"], marks[f"EL.{s}"], marks[f"WR.{s}"]
        items[("F03", s)] = Path([("chain", _vertex(ac)), ("chain", _vertex(el)), ("chain", _vertex(wr))])
        c7, acp = B.v[marks["C7"]], B.v[ac]
        over = B.surface_path(marks["C7"], ac, (c7 + acp) / 2 + UP * 0.05)
        items[("F05", s)] = Path([("tape", over), ("chain", _vertex(el)), ("chain", _vertex(wr))])
        arm = B.face_mask(B.bones(f"upperarm0", f"shoulder01.{s}", f"lowerarm01.{s}") & (np.sign(B.v[:, 0]) == SIDES[s]))
        items[("F07", s)] = Girth(
            [B.ring(p, n, None, arm) for p, n in B.along(f"upperarm01.{s}", f"lowerarm01.{s}", (0.35, 0.45, 0.55, 0.65))],
            "max",
        )
        fore = B.face_mask(B.bones(f"lowerarm", f"wrist.{s}") & (np.sign(B.v[:, 0]) == SIDES[s]))
        items[("F12", s)] = Girth(
            [B.ring(p, n, None, fore) for p, n in B.along(f"lowerarm01.{s}", f"wrist.{s}", (0.86, 0.9, 0.94))],
            "min",
        )
        items[("H09", s)] = Girth(
            [B.ring(p, n) for p, n in B.along(f"upperleg01.{s}", f"lowerleg01.{s}", (0.24, 0.3, 0.36, 0.42))],
            "max",
        )
        items[("H13", s)] = Girth(
            [B.ring(p, n) for p, n in B.along(f"lowerleg01.{s}", f"foot.{s}", (0.18, 0.26, 0.34, 0.42))],
            "max",
        )
        # Hand: wrist-crease centre to the middle fingertip; palm girth across the knuckles.
        hand_side = np.sign(B.v[:, 0]) == SIDES[s]
        wrist_ring = B.ring(h[f"wrist.{s}"], h[f"finger3-1.{s}"] - h[f"wrist.{s}"], None, B.face_mask(hand_side))
        tip_ids = np.where(B.bones(f"finger3-3.{s}"))[0]
        tip = int(tip_ids[np.argmax(np.linalg.norm(B.v[tip_ids] - h[f"wrist.{s}"], axis=1))])
        marks[f"TIP.{s}"] = tip
        items[("G01", s)] = Path([("centroid", wrist_ring), ("chain", _vertex(tip))])
        knuckles = (h[f"finger2-1.{s}"] + h[f"finger5-1.{s}"]) / 2
        palm_p = h[f"wrist.{s}"] + 0.95 * (knuckles - h[f"wrist.{s}"])
        # At the knuckles the thumb is its own section, so the enclosing loop excludes it.
        items[("G04", s)] = Girth([B.ring(palm_p, knuckles - h[f"wrist.{s}"])])

    needed = sorted(set().union(*(c.vertices() for m in items.values() for c in m.crossings())))
    remap = {g: i for i, g in enumerate(needed)}
    local = {k: _remap(m, remap) for k, m in items.items()}
    ref = {
        "waist_z": waist_z,
        "rise_z": rise_z,
        "crotch_z": crotch_z,
        "floor_z": float(B.v[:, 2].min()),
    }
    return Measures(items, torch.tensor(needed), local, marks, ref)


def _remap(m, remap):
    if isinstance(m, Girth):
        return Girth([c.remap(remap) for c in m.candidates], m.combine, m.hull)
    return Path([(mode, c.remap(remap)) for mode, c in m.pieces])


def section_ring(verts: np.ndarray, faces: np.ndarray, point, normal, axis_point=None, mask=None):
    """Runtime section for reference layers (hem lines, boot top); no gradients needed."""
    return loop_around(verts, faces, point, normal, point if axis_point is None else axis_point, mask)


__all__ = ["Measures", "compile_measures", "section_ring", "plane_basis", "SIDES"]
