#!/usr/bin/env python3
"""Run one bounded archive pass by hand; the desktop sidecar runs the same pass every 15 minutes."""

import argparse
import json
from pathlib import Path

from coworker.curriculum import CourseArchive
from coworker.curriculum_sync import archive_pass, publish_export
from coworker.secrets import state_dir


def manager():
    from coworker.config import load_config
    from coworker.server.manager import SessionManager

    return SessionManager(data_dir=state_dir(), model=load_config().model)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path)
    parser.add_argument("--collect-only", action="store_true")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--max-lessons", type=int, default=4)
    parser.add_argument("--only", nargs="*", help="Limit preparation to these platform lesson IDs")
    args = parser.parse_args()
    store = CourseArchive(args.root or state_dir() / "curriculum")
    status = archive_pass(
        store,
        manager,
        max_lessons=args.max_lessons,
        force=args.force,
        only=args.only,
        collect_only=args.collect_only,
    )
    if status is None:
        print("Another archive pass is running", flush=True)
        return
    publish_export(store)
    summary = {k: status.get(k) for k in ("acquired", "errors", "pending", "generation_error")}
    print(json.dumps(summary, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
