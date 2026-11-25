"""Authenticated read surface for the curriculum archive; never serves source files."""

from __future__ import annotations

import logging
import os
import threading
import time
from pathlib import Path

from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.responses import Response

from ..curriculum import CourseArchive, generate_notes
from ..curriculum_login import renew, signing_in, start_scan
from ..curriculum_sync import (
    archive_pass,
    export_documents,
    generate_transcript,
    publish_export,
    record_backup,
)

log = logging.getLogger(__name__)
PASS_INTERVAL = 900
FIRST_PASS_DELAY = 60


def _pass(store: CourseArchive, manager) -> None:
    try:
        status = archive_pass(store, lambda: manager)
        if status and status.get("auth_required") and renew(store):
            archive_pass(store, lambda: manager)
        publish_export(store)
    except Exception:
        log.exception("classroom archive pass failed")


def _archive_loop(store: CourseArchive, manager) -> None:
    time.sleep(FIRST_PASS_DELAY)
    while True:
        _pass(store, manager)
        time.sleep(PASS_INTERVAL)


def start_archive_loop(store: CourseArchive, manager) -> threading.Thread | None:
    """Keep an enabled archive current while the app runs; a fresh archive stays idle."""
    if os.environ.get("EDISON_CLASSROOM_SYNC") == "0":
        return None
    if not store.sync_status("automation").get("enabled"):
        return None
    thread = threading.Thread(
        target=_archive_loop, args=(store, manager), name="classroom-archive", daemon=True
    )
    thread.start()
    return thread


def attach_curriculum(app: FastAPI, manager):
    root = (
        Path(os.environ["EDISON_CURRICULUM_ROOT"]).expanduser()
        if os.environ.get("EDISON_CURRICULUM_ROOT")
        else manager._data_base / "curriculum"
    )
    store = CourseArchive(root)
    app.state.curriculum = store
    busy: set[str] = set()
    guard = threading.Lock()
    slot = threading.Semaphore(1)

    # A previous process cannot still be generating after this instance restarts.
    with store.connect() as db:
        db.execute(
            "UPDATE recordings SET state='pending', detail='上次整理中断，可重新整理' WHERE state='generating'"
        )
    start_archive_loop(store, manager)

    @app.get("/v1/curriculum/archive")
    def archive():
        result = store.listing()
        if result["automation"].get("enabled"):
            result["backup"] = record_backup(store, export_documents(store)["revision"])
        result["platform"] = {"signing_in": signing_in()}
        return result

    @app.post("/v1/curriculum/platform/sign-in")
    def platform_sign_in():
        start_scan(store, lambda: _pass(store, manager))
        return {"signing_in": True}

    @app.get("/v1/curriculum/occurrence")
    def occurrence(course: str, date: str, first: int, last: int):
        if first < 1 or last > 12 or first > last:
            raise HTTPException(422, "Invalid class periods")
        try:
            return store.occurrence(course, date, first, last)
        except ValueError:
            raise HTTPException(422, "Invalid class date") from None

    @app.get("/v1/curriculum/documents/{doc_id}")
    def document(doc_id: str):
        try:
            return store.document(doc_id)
        except KeyError:
            raise HTTPException(404, "Document not found") from None

    @app.get("/v1/curriculum/documents/{doc_id}/download")
    def download(doc_id: str):
        try:
            doc = store.document(doc_id)
        except KeyError:
            raise HTTPException(404, "Document not found") from None
        return Response(
            doc["markdown"],
            media_type="text/markdown; charset=utf-8",
            headers={
                "Content-Disposition": f'attachment; filename="classroom-{doc_id}.md"',
                "Cache-Control": "private, no-store",
            },
        )

    def prepare(rid: str):
        try:
            with slot:
                if store.sync_status("automation").get("perspective") == "transcript":
                    generate_transcript(store, rid, manager)
                else:
                    generate_notes(store, rid, manager)
        except Exception:
            store.set_state(rid, "failed", "整理未完成，可重试；原始材料已保留")
        finally:
            with guard:
                busy.discard(rid)

    @app.post("/v1/curriculum/recordings/{rid}/prepare")
    def start(rid: str, tasks: BackgroundTasks):
        try:
            record = store.recording(rid)
        except KeyError:
            raise HTTPException(404, "Recording not found") from None
        if store.listing()["coverage"].get(record["course"], {}).get("excluded"):
            raise HTTPException(409, "This course is excluded from the archive")
        if record["documents"]:
            return {"state": "ready"}
        if not store.segments(rid):
            raise HTTPException(409, "No usable transcript")
        if not manager.get_settings().get("model_ready"):
            raise HTTPException(409, "Configure a text model in Edison first")
        with guard:
            if rid not in busy:
                busy.add(rid)
                store.set_state(rid, "generating")
                tasks.add_task(prepare, rid)
        return {"state": "generating"}
