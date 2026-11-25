"""Local body archive: one draft, dated snapshots with revisions, fitted-shape cache.

Recorded values are the only source of truth; fitted shapes are a cache keyed by the
fitter version and recomputed whenever the fitter changes.
"""

from __future__ import annotations

import json
import os
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import date, datetime, timezone
from pathlib import Path

from .catalog import clean

SCHEMA = 1


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _day(value) -> str:
    return date.fromisoformat(str(value)).isoformat()


class BodyArchive:
    def __init__(self, root: str | Path):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.root, 0o700)
        self.db = self.root / "body.sqlite3"
        with self.connect() as db:
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS draft(
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    values_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS snapshots(
                    id TEXT PRIMARY KEY,
                    measured_on TEXT NOT NULL,
                    values_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS revisions(
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
                    measured_on TEXT NOT NULL,
                    values_json TEXT NOT NULL,
                    replaced_at TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS shapes(
                    snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
                    fitter TEXT NOT NULL,
                    shape_json TEXT NOT NULL,
                    PRIMARY KEY (snapshot_id, fitter));
                """
            )
            db.execute("INSERT OR IGNORE INTO meta VALUES ('schema', ?)", (str(SCHEMA),))
        os.chmod(self.db, 0o600)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.db)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys = ON")
        try:
            with db:
                yield db
        finally:
            db.close()

    # ---- draft -----------------------------------------------------------------------
    def draft(self) -> dict:
        with self.connect() as db:
            row = db.execute("SELECT values_json, updated_at FROM draft WHERE id = 1").fetchone()
        if row is None:
            return {"values": {}, "updated_at": None}
        return {"values": json.loads(row["values_json"]), "updated_at": row["updated_at"]}

    def save_draft(self, values: dict) -> dict:
        values = clean(values)
        now = _now()
        with self.connect() as db:
            db.execute(
                "INSERT INTO draft VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET values_json = excluded.values_json, updated_at = excluded.updated_at",
                (json.dumps(values, ensure_ascii=False), now),
            )
        return {"values": values, "updated_at": now}

    # ---- snapshots -------------------------------------------------------------------
    def _snapshot(self, row, revisions: int) -> dict:
        return {
            "id": row["id"],
            "measured_on": row["measured_on"],
            "values": json.loads(row["values_json"]),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "revisions": revisions,
        }

    def snapshots(self) -> list[dict]:
        with self.connect() as db:
            rows = db.execute(
                """SELECT s.*, (SELECT COUNT(*) FROM revisions r WHERE r.snapshot_id = s.id) AS n
                   FROM snapshots s ORDER BY measured_on, created_at"""
            ).fetchall()
        return [self._snapshot(r, r["n"]) for r in rows]

    def snapshot(self, sid: str) -> dict:
        with self.connect() as db:
            row = db.execute("SELECT * FROM snapshots WHERE id = ?", (sid,)).fetchone()
            if row is None:
                raise KeyError(sid)
            n = db.execute("SELECT COUNT(*) FROM revisions WHERE snapshot_id = ?", (sid,)).fetchone()[0]
        return self._snapshot(row, n)

    def create(self, measured_on, values: dict) -> dict:
        values = clean(values)
        if not values:
            raise ValueError("a snapshot needs at least one recorded value")
        sid, now = uuid.uuid4().hex, _now()
        with self.connect() as db:
            db.execute(
                "INSERT INTO snapshots VALUES (?, ?, ?, ?, ?)",
                (sid, _day(measured_on), json.dumps(values, ensure_ascii=False), now, now),
            )
        return self.snapshot(sid)

    def revise(self, sid: str, measured_on, values: dict) -> dict:
        values = clean(values)
        if not values:
            raise ValueError("a snapshot needs at least one recorded value")
        now = _now()
        with self.connect() as db:
            row = db.execute("SELECT * FROM snapshots WHERE id = ?", (sid,)).fetchone()
            if row is None:
                raise KeyError(sid)
            db.execute(
                "INSERT INTO revisions(snapshot_id, measured_on, values_json, replaced_at) VALUES (?, ?, ?, ?)",
                (sid, row["measured_on"], row["values_json"], now),
            )
            db.execute(
                "UPDATE snapshots SET measured_on = ?, values_json = ?, updated_at = ? WHERE id = ?",
                (_day(measured_on), json.dumps(values, ensure_ascii=False), now, sid),
            )
            db.execute("DELETE FROM shapes WHERE snapshot_id = ?", (sid,))
        return self.snapshot(sid)

    def revisions(self, sid: str) -> list[dict]:
        self.snapshot(sid)
        with self.connect() as db:
            rows = db.execute(
                "SELECT measured_on, values_json, replaced_at FROM revisions WHERE snapshot_id = ? ORDER BY id DESC",
                (sid,),
            ).fetchall()
        return [
            {"measured_on": r["measured_on"], "values": json.loads(r["values_json"]), "replaced_at": r["replaced_at"]}
            for r in rows
        ]

    def delete(self, sid: str) -> None:
        with self.connect() as db:
            if db.execute("DELETE FROM snapshots WHERE id = ?", (sid,)).rowcount == 0:
                raise KeyError(sid)
        with sqlite3.connect(self.db) as db:
            db.execute("VACUUM")

    # ---- fitted-shape cache ----------------------------------------------------------
    def cached_shape(self, sid: str, fitter: str) -> dict | None:
        with self.connect() as db:
            row = db.execute(
                "SELECT shape_json FROM shapes WHERE snapshot_id = ? AND fitter = ?", (sid, fitter)
            ).fetchone()
        return json.loads(row["shape_json"]) if row else None

    def cache_shape(self, sid: str, fitter: str, shape: dict) -> None:
        with self.connect() as db:
            db.execute("DELETE FROM shapes WHERE snapshot_id = ? AND fitter != ?", (sid, fitter))
            db.execute(
                "INSERT OR REPLACE INTO shapes VALUES (?, ?, ?)", (sid, fitter, json.dumps(shape))
            )

    # ---- export ----------------------------------------------------------------------
    def export(self) -> dict:
        return {
            "format": "edison.body-profile",
            "version": SCHEMA,
            "exported_at": _now(),
            "unit": "cm",
            "draft": self.draft(),
            "snapshots": [dict(s, history=self.revisions(s["id"])) for s in self.snapshots()],
        }
