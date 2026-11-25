"""Prebuild Anny's model cache for packaging: `python -m coworker.body.cache OUTDIR`.

Only the compact model data the runtime loads is kept; Anny's intermediate build files
(over 800 MB) are discarded.
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path


def build(out: Path) -> Path:
    from .model import BodyModel

    out.mkdir(parents=True, exist_ok=True)
    BodyModel(out)
    kept = list(out.glob("v*/build_compact_model_data_*.safetensors"))
    if len(kept) != 1:
        raise SystemExit(f"expected one compact model file in {out}, found {len(kept)}")
    for f in out.rglob("*"):
        if f.is_file() and f not in kept:
            f.unlink()
    for d in sorted((p for p in out.rglob("*") if p.is_dir()), reverse=True):
        if not any(d.iterdir()):
            d.rmdir()
    if any(p.name == "noncommercial" for p in out.rglob("*")):
        shutil.rmtree(out)
        raise SystemExit("non-commercial Anny assets must not be bundled")
    return kept[0]


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: python -m coworker.body.cache OUTDIR")
    print(build(Path(sys.argv[1])))
