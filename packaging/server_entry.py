"""PyInstaller entry point for the bundled desktop sidecar server.

Thin wrapper so PyInstaller has a concrete script to analyze (the console_script
`openworker-server` is generated metadata, not a file). Runs the same `main()`.

`--probe-body` is a build-time self-check: it imports the frozen body stack (Anny + torch)
and exits, so the release smoke test can prove the bundle is complete without a server.
"""

import sys


def probe_body() -> None:
    import anny
    import torch
    from anny.paths import get_anny_root_dir

    data = get_anny_root_dir() / "data"
    assert (data / "cached" / "anny.pth").is_file(), f"Anny package data missing under {data}"
    assert "warp" not in sys.modules, "warp must not be imported (skinning_method='lbs')"
    total = float(torch.ones(3).sum())
    print(f"Body probe: anny {anny.__version__}, torch {torch.__version__}, sum={total}")


if __name__ == "__main__":
    if sys.argv[1:] == ["--probe-body"]:
        probe_body()
    else:
        from coworker.server.run import main

        main()
