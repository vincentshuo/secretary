"""Verify a frozen release starts empty beside a populated legacy state directory.

Usage: uv run python tests/smoke_desktop_privacy.py [path/to/openworker-server]
Only synthetic records are created; no real user state or credentials are read.
"""
from __future__ import annotations

import hashlib
import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import httpx

# Anny's SMPL/SMPL-X bridge data is licensed non-commercially and must never ship.
FORBIDDEN_DIRS = {"noncommercial"}


def snapshot(root: Path) -> dict[str, str]:
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(root.rglob("*")) if p.is_file()}


def check_release(binary: Path) -> None:
    forbidden = {"workspace.sqlite3", "secrets.json", "prefs.json", "desktop.json", ".env"}
    for path in binary.parent.rglob("*"):
        rel = path.relative_to(binary.parent)
        assert path.name not in forbidden and path.suffix not in {".sqlite", ".sqlite3", ".db"}, (
            f"User-state file in release: {rel}"
        )
        assert not (path.is_dir() and path.name in FORBIDDEN_DIRS), f"Forbidden assets in release: {rel}"

    probe = subprocess.run([str(binary.resolve()), "--probe-body"], capture_output=True, text=True,
                           timeout=300, env={**os.environ, "HOME": tempfile.gettempdir()})
    assert probe.returncode == 0, f"Body runtime probe failed:\n{probe.stdout}\n{probe.stderr}"
    print(probe.stdout.strip())

    with tempfile.TemporaryDirectory(prefix="edison-privacy-") as directory:
        root = Path(directory)
        # Seed the state directory used by the old coworker host.
        legacy = root / ".config/coworker"
        legacy.mkdir(parents=True)
        (legacy / "config.toml").write_text('model = "private-fixture"\n')
        (legacy / "prefs.json").write_text('{"default_model":"private-fixture"}')
        before = snapshot(legacy)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        env = {k: v for k, v in os.environ.items()
               if not k.startswith(("COWORKER_", "YOUTUBE_WORKBENCH_", "ANNY_"))}
        env.update(HOME=str(root), COWORKER_STATE_DIR=str(root / ".config/edison"),
                   COWORKER_API_TOKEN="fixture")
        with (root / "server.log").open("w") as log:
            proc = subprocess.Popen([str(binary.resolve()), "--host", "127.0.0.1", "--port", str(port)],
                                    env=env, cwd=root, stdout=log, stderr=log)
            try:
                with httpx.Client(base_url=f"http://127.0.0.1:{port}",
                                  headers={"X-OpenWorker-Token": "fixture"}, timeout=2) as client:
                    for _ in range(300):
                        assert proc.poll() is None, (
                            "Release exited before becoming ready:\n" + (root / "server.log").read_text())
                        try:
                            health = client.get("/v1/health")
                            health.raise_for_status()
                            break
                        except httpx.HTTPError:
                            time.sleep(.2)
                    else:
                        raise AssertionError("Release did not become ready")
                    health = health.json()
                    count = len(client.get("/v1/sessions").raise_for_status().json()["sessions"])
                    print(f"Release: model={health['model']!r}, {count} sessions")
                    assert health["status"] == "ok"
                    assert health["model"] != "private-fixture", "Fresh release reads legacy config"
                    assert count == 0, "Fresh release reads legacy sessions"
                    assert client.get("/v1/health", headers={"X-OpenWorker-Token": ""}).json() == {
                        "status": "ok"}, "Unauthenticated health leaks state"
                    assert client.get("/v1/sessions", headers={"X-OpenWorker-Token": ""}).status_code == 401
                    assert snapshot(legacy) == before, "Release modified the legacy state directory"
            finally:
                proc.terminate()
                proc.wait(timeout=15)
    print("Release privacy smoke passed; legacy data unchanged")


if __name__ == "__main__":
    check_release(Path(sys.argv[1] if len(sys.argv) > 1 else "dist/openworker-server/openworker-server"))
