"""Mesh sections frozen as edge crossings, so later bodies are measured on the same anatomy."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import torch


@dataclass
class Crossings:
    """Points on mesh edges: point = v[a]·(1−t) + v[b]·t."""

    a: np.ndarray
    b: np.ndarray
    t: np.ndarray

    def points(self, verts):
        if isinstance(verts, torch.Tensor):
            t = torch.as_tensor(self.t, dtype=verts.dtype)[:, None]
            return verts[self.a] * (1 - t) + verts[self.b] * t
        return verts[self.a] * (1 - self.t[:, None]) + verts[self.b] * self.t[:, None]

    def remap(self, index: dict[int, int]) -> Crossings:
        return Crossings(
            np.array([index[i] for i in self.a]), np.array([index[i] for i in self.b]), self.t
        )

    def vertices(self) -> set[int]:
        return set(self.a.tolist()) | set(self.b.tolist())

    def subset(self, keep: np.ndarray) -> Crossings:
        return Crossings(self.a[keep], self.b[keep], self.t[keep])


def plane_loops(
    verts: np.ndarray, faces: np.ndarray, point: np.ndarray, normal: np.ndarray, face_mask=None
) -> list[tuple[Crossings, bool]]:
    """Chains where the plane cuts the surface, each ordered along the surface."""
    normal = normal / np.linalg.norm(normal)
    d = (verts - point) @ normal
    d = np.where(np.abs(d) < 1e-9, 1e-9, d)
    f = faces if face_mask is None else faces[face_mask]
    sd = np.sign(d[f])
    f = f[~((sd == sd[:, :1]).all(1))]
    edge_of: dict[tuple[int, int], list[int]] = {}
    face_edges: list[list[tuple[int, int]]] = []
    for fi, tri in enumerate(f):
        crossed = []
        for i, j in ((0, 1), (1, 2), (2, 0)):
            u, v = int(tri[i]), int(tri[j])
            if (d[u] > 0) != (d[v] > 0):
                key = (min(u, v), max(u, v))
                crossed.append(key)
                edge_of.setdefault(key, []).append(fi)
        face_edges.append(crossed)
    seen: set[tuple[int, int]] = set()
    loops = []
    for start in edge_of:
        if start in seen:
            continue
        # Walk both directions from the start edge through faces sharing crossed edges.
        def walk(edge, face):
            path = []
            while face is not None:
                nxt = [e for e in face_edges[face] if e != edge]
                if not nxt or nxt[0] in seen:
                    return path, bool(nxt) and nxt[0] == start
                edge = nxt[0]
                seen.add(edge)
                path.append(edge)
                faces_ = [g for g in edge_of[edge] if g != face]
                face = faces_[0] if faces_ else None
            return path, False

        seen.add(start)
        owners = edge_of[start]
        forward, closed = walk(start, owners[0])
        backward = []
        if not closed and len(owners) > 1:
            backward, _ = walk(start, owners[1])
        chain = backward[::-1] + [start] + forward
        a = np.array([e[0] for e in chain])
        b = np.array([e[1] for e in chain])
        t = d[a] / (d[a] - d[b])
        loops.append((Crossings(a, b, t), closed))
    return loops


def plane_basis(normal: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    normal = normal / np.linalg.norm(normal)
    helper = np.array([0.0, 0.0, 1.0]) if abs(normal[2]) < 0.9 else np.array([1.0, 0.0, 0.0])
    u = np.cross(normal, helper)
    u /= np.linalg.norm(u)
    return u, np.cross(normal, u)


def _inside(poly: np.ndarray, p: np.ndarray) -> bool:
    x, y = p
    inside = False
    for (x1, y1), (x2, y2) in zip(poly, np.roll(poly, -1, axis=0)):
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1 + 1e-12) + x1:
            inside = not inside
    return inside


def loop_around(
    verts, faces, point, normal, axis_point, face_mask=None
) -> Crossings | None:
    """The closed section that encloses `axis_point` (smallest if nested)."""
    u, w = plane_basis(normal)
    target = np.array([(axis_point - point) @ u, (axis_point - point) @ w])
    best, best_area = None, np.inf
    for crossings, closed in plane_loops(verts, faces, point, normal, face_mask):
        if not closed or len(crossings.a) < 6:
            continue
        pts = crossings.points(verts) - point
        poly = np.stack([pts @ u, pts @ w], 1)
        area = abs(np.sum(poly[:, 0] * np.roll(poly[:, 1], -1) - np.roll(poly[:, 0], -1) * poly[:, 1])) / 2
        if _inside(poly, target) and area < best_area:
            best, best_area = crossings, area
    return best


def hull_order(points2d: np.ndarray) -> np.ndarray:
    """Indices of the 2-D convex hull, counter-clockwise (monotone chain)."""
    order = np.lexsort((points2d[:, 1], points2d[:, 0]))

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower: list[int] = []
    for i in order:
        while len(lower) >= 2 and cross(points2d[lower[-2]], points2d[lower[-1]], points2d[i]) <= 0:
            lower.pop()
        lower.append(int(i))
    upper: list[int] = []
    for i in order[::-1]:
        while len(upper) >= 2 and cross(points2d[upper[-2]], points2d[upper[-1]], points2d[i]) <= 0:
            upper.pop()
        upper.append(int(i))
    return np.array(lower[:-1] + upper[:-1])


def _plane_coords(points: np.ndarray) -> np.ndarray:
    centred = points - points.mean(0)
    normal = np.linalg.svd(centred, full_matrices=False)[2][2]
    u, w = plane_basis(normal)
    return np.stack([centred @ u, centred @ w], 1)


def girth_hull(points: torch.Tensor) -> np.ndarray:
    return hull_order(_plane_coords(points.detach().numpy()))


def tape_hull(points: torch.Tensor) -> np.ndarray:
    """Outer chain a taut tape follows over an open surface arc, first point to last."""
    p = points.detach().numpy()
    n = len(p)
    if n < 3:
        return np.arange(n)
    hull = list(hull_order(_plane_coords(p)))
    if 0 not in hull or n - 1 not in hull:
        return np.arange(n)
    k = hull.index(0)
    hull = hull[k:] + hull[:k]
    j = hull.index(n - 1)
    # The chord between the endpoints is the inner side; keep the longer way round.
    first, second = hull[: j + 1], [0] + hull[j:][::-1]
    def span(chain):
        return np.linalg.norm(np.diff(p[chain], axis=0), axis=1).sum()
    return np.array(first if span(first) >= span(second) else second)


def closed_length(ring: torch.Tensor) -> torch.Tensor:
    return torch.linalg.norm(ring - torch.roll(ring, 1, 0), dim=1).sum()


def polyline_length(points: torch.Tensor) -> torch.Tensor:
    return torch.linalg.norm(points[1:] - points[:-1], dim=1).sum()


def arc_between(points: np.ndarray, i: int, j: int, via: np.ndarray) -> np.ndarray:
    """Indices of the closed-loop arc from i to j that passes nearest to `via`."""
    n = len(points)
    first = [(i + k) % n for k in range(((j - i) % n) + 1)]
    second = [(i - k) % n for k in range(((i - j) % n) + 1)]

    def miss(arc):
        return np.min(np.linalg.norm(points[arc] - via, axis=1))

    return np.array(first if miss(first) <= miss(second) else second)


def walk_length(points: np.ndarray, length: float) -> np.ndarray:
    """Point reached after `length` along a polyline (clamped to its end)."""
    seg = np.linalg.norm(np.diff(points, axis=0), axis=1)
    run = np.concatenate([[0], np.cumsum(seg)])
    if length >= run[-1]:
        return points[-1]
    k = int(np.searchsorted(run, length) - 1)
    k = max(k, 0)
    f = (length - run[k]) / max(seg[k], 1e-9)
    return points[k] * (1 - f) + points[k + 1] * f
