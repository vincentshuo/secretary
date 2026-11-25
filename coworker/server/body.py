"""Body profile routes: local archive plus the fitted Anny hologram."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from fastapi import Body, FastAPI, HTTPException
from fastapi.responses import Response

from ..body.store import BodyArchive


def attach_body(app: FastAPI, manager, service=None) -> None:
    root = (
        Path(os.environ["EDISON_BODY_ROOT"]).expanduser()
        if os.environ.get("EDISON_BODY_ROOT")
        else manager._data_base / "body"
    )
    store = BodyArchive(root)
    app.state.body = store
    if service is None:
        from ..body.service import shared_service

        service = shared_service()
    app.state.body_service = service

    def ready():
        status = service.status()
        if status["state"] == "loading":
            raise HTTPException(503, "人体模型正在加载")
        if status["state"] == "error":
            raise HTTPException(500, status["error"])

    def bad(exc: Exception):
        raise HTTPException(422, str(exc)) from None

    @app.get("/v1/body/catalog")
    def catalog():
        from ..body.catalog import catalog as build

        return build()

    @app.get("/v1/body/status")
    def status():
        return service.status()

    @app.get("/v1/body/topology")
    def topology():
        ready()
        return service.topology()

    @app.post("/v1/body/fit")
    def fit(payload: dict[str, Any] = Body(...)):
        ready()
        try:
            return service.render(payload.get("values") or {}, warm=True)
        except ValueError as exc:
            bad(exc)

    @app.get("/v1/body/profile")
    def profile():
        return {"draft": store.draft(), "snapshots": store.snapshots()}

    @app.put("/v1/body/draft")
    def draft(payload: dict[str, Any] = Body(...)):
        try:
            return store.save_draft(payload.get("values") or {})
        except ValueError as exc:
            bad(exc)

    @app.post("/v1/body/snapshots")
    def create(payload: dict[str, Any] = Body(...)):
        try:
            return store.create(payload.get("measured_on"), payload.get("values") or {})
        except (ValueError, TypeError) as exc:
            bad(exc)

    @app.put("/v1/body/snapshots/{sid}")
    def revise(sid: str, payload: dict[str, Any] = Body(...)):
        try:
            return store.revise(sid, payload.get("measured_on"), payload.get("values") or {})
        except KeyError:
            raise HTTPException(404, "Snapshot not found") from None
        except (ValueError, TypeError) as exc:
            bad(exc)

    @app.delete("/v1/body/snapshots/{sid}")
    def delete(sid: str):
        try:
            store.delete(sid)
        except KeyError:
            raise HTTPException(404, "Snapshot not found") from None
        return {"deleted": sid}

    @app.get("/v1/body/snapshots/{sid}/revisions")
    def revisions(sid: str):
        try:
            return {"revisions": store.revisions(sid)}
        except KeyError:
            raise HTTPException(404, "Snapshot not found") from None

    @app.get("/v1/body/snapshots/{sid}/body")
    def snapshot_body(sid: str):
        """The snapshot's fitted body, from the shape cache when the fitter is unchanged."""
        ready()
        from ..body.fit import VERSION
        from ..body.model import Shape

        try:
            snap = store.snapshot(sid)
        except KeyError:
            raise HTTPException(404, "Snapshot not found") from None
        cached = store.cached_shape(sid, VERSION)
        if cached:
            return service.render(snap["values"], shape=Shape.from_json(cached))
        out = service.render(snap["values"], warm=False)
        store.cache_shape(sid, VERSION, out["shape"])
        return out

    @app.get("/v1/body/export")
    def export():
        return Response(
            json.dumps(store.export(), ensure_ascii=False, indent=2),
            media_type="application/json; charset=utf-8",
            headers={
                "Content-Disposition": 'attachment; filename="edison-body-profile.json"',
                "Cache-Control": "private, no-store",
            },
        )
