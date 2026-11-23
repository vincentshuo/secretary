"""Upstream Anny body restricted to the shape space the body profile can explain.

The fitter never skins or poses the body: every rest vertex is Anny's own linear
blendshape combination, evaluated either for the whole mesh (display) or for the
few hundred vertices a measurement reads (fitting).
"""

from __future__ import annotations

import os
import shutil
import sys
import threading
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch

# Male (gender 0) adult: between Anny's young-adult (2/3) and old (1) anchors.
GENDER = 0.0
AGE = 0.72
FREE_PHENOTYPES = ("muscle", "weight", "height", "proportions")

_SYMMETRIC = [
    *(
        f"measure-{m}-incr"
        for m in (
            "neck-circ",
            "neck-height",
            "upperarm-circ",
            "upperarm-length",
            "lowerarm-length",
            "wrist-circ",
            "bust-circ",
            "underbust-circ",
            "waist-circ",
            "napetowaist-dist",
            "waisttohip-dist",
            "shoulder-dist",
            "hips-circ",
            "upperleg-height",
            "thigh-circ",
            "knee-circ",
            "lowerleg-height",
            "calf-circ",
            "ankle-circ",
            "frontchest-dist",
        )
    ),
    "stomach-pregnant-incr",
    "torso-scale-depth-incr",
    "torso-muscle-pectoral-incr",
    "buttocks-volume-incr",
    "hip-scale-horiz-incr",
    "head-scale-horiz-incr",
    "head-scale-depth-incr",
    "head-fat-incr",
]
_PER_SIDE = (
    "upperarm-fat",
    "upperarm-muscle",
    "upperarm-scale-vert",
    "lowerarm-scale-vert",
    "lowerarm-fat",
    "hand-scale",
    "hand-fingers-length",
    "hand-fingers-distance",
    "upperleg-fat",
    "upperleg-muscle",
    "lowerleg-fat",
    "lowerleg-muscle",
)
LOCAL_CHANGES = _SYMMETRIC + [f"{s}-{part}-incr" for part in _PER_SIDE for s in "lr"]


def cache_dir() -> Path:
    if os.environ.get("EDISON_ANNY_CACHE"):
        return Path(os.environ["EDISON_ANNY_CACHE"]).expanduser()
    from ..secrets import state_dir

    return state_dir() / "body" / "anny-cache"


def _seed_cache(target: Path) -> None:
    """Copy the cache prebuilt at packaging time so the first launch skips a ~1 min build."""
    bundled = Path(getattr(sys, "_MEIPASS", "")) / "anny_cache"
    if not bundled.is_dir() or any(target.glob("v*/build_compact_model_data_*.safetensors")):
        return
    shutil.copytree(bundled, target, dirs_exist_ok=True)


@dataclass
class Shape:
    phenotypes: torch.Tensor  # [4] in [0, 1], ordered as FREE_PHENOTYPES
    local: torch.Tensor  # [len(LOCAL_CHANGES)] in [-1, 1]

    def to_json(self) -> dict:
        return {
            "phenotypes": dict(zip(FREE_PHENOTYPES, self.phenotypes.tolist())),
            "local": dict(zip(LOCAL_CHANGES, self.local.tolist())),
        }

    @classmethod
    def from_json(cls, data: dict) -> Shape:
        return cls(
            torch.tensor([float(data["phenotypes"][k]) for k in FREE_PHENOTYPES]),
            torch.tensor([float(data["local"].get(k, 0.0)) for k in LOCAL_CHANGES]),
        )

    @classmethod
    def neutral(cls) -> Shape:
        return cls(torch.full((len(FREE_PHENOTYPES),), 0.5), torch.zeros(len(LOCAL_CHANGES)))


class BodyModel:
    def __init__(self, cache: Path | None = None):
        import anny
        from anny.paths import set_anny_cache_path

        cache = cache or cache_dir()
        cache.mkdir(parents=True, exist_ok=True, mode=0o700)
        _seed_cache(cache)
        set_anny_cache_path(cache)
        torch.set_num_threads(max(1, min(4, os.cpu_count() or 1)))
        self.anny = anny.Anny(
            local_changes=list(LOCAL_CHANGES), skinning_method="lbs"
        ).to(dtype=torch.float32)
        self.anny.requires_grad_(False)
        labels = list(self.anny.phenotype_labels)
        self._free = [labels.index(k) for k in FREE_PHENOTYPES]
        self._fixed = torch.tensor([[GENDER if k == "gender" else AGE if k == "age" else 0.5 for k in labels]])
        self._local_order = torch.tensor(
            [LOCAL_CHANGES.index(k) for k in self.anny.local_change_labels]
        )
        self.faces = self.anny.faces.cpu().numpy().astype(np.int64)
        self.bone_labels = list(self.anny.bone_labels)
        self.vertex_bones = self.anny.vertex_bone_indices.cpu().numpy()
        self.vertex_weights = self.anny.vertex_bone_weights.cpu().numpy()
        self.template = self.anny.template_vertices
        self.blendshapes = self.anny.blendshapes

    def coefficients(self, shape: Shape) -> torch.Tensor:
        """Anny's blendshape coefficients (upstream `_get_phenotype_blendshape_coefficients`)."""
        phenotype = self._fixed.clone()
        phenotype[0, self._free] = shape.phenotypes
        return self.anny._get_phenotype_blendshape_coefficients(
            phenotype, shape.local[self._local_order][None], torch.zeros(1, 0)
        )

    def fast_coefficients(self, shape: Shape) -> torch.Tensor:
        """Same values as `coefficients`, with the per-label ReLU split vectorised."""
        from anny.models.phenotype import phenotype_blendshape_weights

        a = self.anny
        phenotype = self._fixed.clone()
        phenotype[0, self._free] = shape.phenotypes
        wi = phenotype_blendshape_weights(
            phenotype,
            a.phenotype_labels,
            a.anchors,
            a.stacked_phenotype_blend_shapes_mask,
            extrapolate=a.extrapolate_phenotypes,
        )
        if a.phenotype_blendshape_projection is not None:
            wi = wi @ a.phenotype_blendshape_projection
        value = shape.local[self._local_order]
        split = torch.stack(
            [value * (value >= 0).to(value.dtype), -value * (-value >= 0).to(value.dtype)], 1
        ).reshape(1, -1)
        return torch.cat([wi, split], 1)

    def subset(self, index: torch.Tensor) -> VertexSubset:
        return VertexSubset(self, index)

    def vertices(self, shape: Shape, index: torch.Tensor | None = None) -> torch.Tensor:
        """Rest vertices in metres (z up, front −y); `index` restricts to a vertex subset."""
        coeffs = self.coefficients(shape)
        if index is None:
            return self.anny.get_rest_vertices(coeffs)[0]
        return self.template[index] + torch.einsum("k,kvc->vc", coeffs[0], self.blendshapes[:, index])

    def posed_vertices(self, shape: Shape, pose: torch.Tensor) -> torch.Tensor:
        """Skinned through Anny's own rig; used only for display."""
        from anny.models.rigged_model import RiggedModelWithLinearBlendShapes

        with torch.no_grad():
            out = RiggedModelWithLinearBlendShapes.forward(self.anny, pose, self.coefficients(shape))
        return out["vertices"][0]

    def bone_heads(self, shape: Shape) -> dict[str, np.ndarray]:
        with torch.no_grad():
            heads = self.anny.get_rest_model(self.coefficients(shape))["rest_bone_heads"][0]
        return {label: heads[i].numpy() for i, label in enumerate(self.bone_labels)}

    def dominant_bone(self) -> np.ndarray:
        return self.vertex_bones[np.arange(len(self.vertex_bones)), self.vertex_weights.argmax(1)]


class VertexSubset:
    """Rest vertices for a fixed vertex subset, with that slice of the blendshapes cached."""

    def __init__(self, model: BodyModel, index: torch.Tensor):
        self.model = model
        n = len(index)
        self.template = model.template[index].reshape(-1)
        self.basis = model.blendshapes[:, index].reshape(model.blendshapes.shape[0], n * 3)
        self.n = n

    def __call__(self, shape: Shape) -> torch.Tensor:
        coeffs = self.model.fast_coefficients(shape)
        return (self.template + coeffs[0] @ self.basis).reshape(self.n, 3)


_model: BodyModel | None = None
_lock = threading.Lock()


def shared_model() -> BodyModel:
    global _model
    with _lock:
        if _model is None:
            _model = BodyModel()
        return _model
