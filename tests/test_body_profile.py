import base64
import os
import stat
from pathlib import Path

import pytest
import torch
from fastapi.testclient import TestClient

os.environ.setdefault("EDISON_ANNY_CACHE", str(Path.home() / ".cache" / "edison-anny-test"))

from coworker.body import catalog as cat  # noqa: E402
from coworker.body.store import BodyArchive  # noqa: E402

DRIVE = {p["id"] for p in cat.PARAMETERS if p["kind"] == cat.DRIVE}
# Synthetic values for an average adult man; never a real person's measurements.
SAMPLE = {
    "B07": {"value": 39}, "C03": {"value": 47}, "C08": {"value": 98}, "E01": {"value": 82},
    "E05": {"value": 86}, "E08": {"value": 97}, "F03": {"left": 61, "right": 60},
    "F07": {"left": 30}, "F12": {"left": 17}, "H09": {"left": 56, "right": 55}, "H13": {"left": 37},
    "D11": {"value": 70}, "D12": {"value": 74}, "H18": {"outseam": 104, "inseam": 80},
    "H15": {"girth": 36, "height": 30}, "F13": {"girth": 19, "side": "L"},
}


def test_catalog_keeps_the_guides_22_items_and_classes():
    ids = [p["id"] for p in cat.PARAMETERS]
    assert len(ids) == 22 == len(set(ids))
    kinds = {k: sorted(p["id"] for p in cat.PARAMETERS if p["kind"] == k) for k in (cat.DRIVE, cat.INDIRECT, cat.REFERENCE)}
    assert kinds[cat.DRIVE] == sorted(["B07", "C03", "C08", "E01", "E08", "F03", "F07", "F12", "H09", "H13"])
    assert kinds[cat.REFERENCE] == sorted(["D11", "D12", "H18", "H15", "F13"])
    assert all(p["how"] and p["use"] for p in cat.PARAMETERS)


def test_targets_mirror_a_single_side_and_skip_reference_layers():
    t = cat.targets({"F07": {"left": 30}, "B07": {"value": 39}, "D11": {"value": 70}})
    assert t == {("F07", "L"): 0.30, ("F07", "R"): 0.30, ("B07", ""): 0.39}


def test_clean_rejects_out_of_range_and_drops_unknown_fields():
    assert cat.clean({"C08": {"value": "98.04", "bogus": 1, "note": " 呼气末 "}, "ZZ": {"value": 1}}) == {
        "C08": {"value": 98.0, "note": "呼气末"}
    }
    with pytest.raises(ValueError):
        cat.clean({"C08": {"value": 12}})


def test_archive_snapshots_keep_revisions_and_delete_for_real(tmp_path):
    store = BodyArchive(tmp_path / "body")
    assert stat.S_IMODE(os.stat(store.db).st_mode) == 0o600
    assert store.draft() == {"values": {}, "updated_at": None}
    store.save_draft({"C08": {"value": 98}})
    assert store.draft()["values"] == {"C08": {"value": 98.0}}
    snap = store.create("2026-11-20", {"C08": {"value": 98}})
    with pytest.raises(ValueError):
        store.create("2026-11-20", {})
    revised = store.revise(snap["id"], "2026-11-21", {"C08": {"value": 99}})
    assert revised["values"] == {"C08": {"value": 99.0}} and revised["revisions"] == 1
    assert store.revisions(snap["id"])[0]["values"] == {"C08": {"value": 98.0}}
    store.cache_shape(snap["id"], "v1", {"x": 1})
    exported = store.export()
    assert exported["snapshots"][0]["history"][0]["measured_on"] == "2026-11-20"
    store.delete(snap["id"])
    assert store.snapshots() == [] and store.cached_shape(snap["id"], "v1") is None
    with pytest.raises(KeyError):
        store.delete(snap["id"])


@pytest.fixture(scope="module")
def service():
    from coworker.body.service import BodyService

    s = BodyService()
    s._load()
    assert s.error is None, s.error
    return s


def test_fast_coefficients_equal_upstream_anny(service):
    from coworker.body.model import LOCAL_CHANGES, Shape

    g = torch.Generator().manual_seed(3)
    shape = Shape(torch.rand(4, generator=g), torch.rand(len(LOCAL_CHANGES), generator=g) * 2 - 1)
    m = service.model
    assert torch.allclose(m.coefficients(shape), m.fast_coefficients(shape))


def test_round_trip_recovers_measurements_within_one_centimetre(service):
    from coworker.body.model import LOCAL_CHANGES, Shape

    g = torch.Generator().manual_seed(11)
    for _ in range(3):
        truth = Shape(torch.rand(4, generator=g) * 0.7 + 0.15, (torch.rand(len(LOCAL_CHANGES), generator=g) * 2 - 1) * 0.5)
        values = service.fitter.measure(truth)
        fitted = service.fitter.fit(values).values
        errors = {k: abs(fitted[k] - v) for k, v in values.items() if k[0] in DRIVE}
        assert max(errors.values()) < 0.01, errors


def test_render_fits_recorded_values_and_draws_reference_layers(service):
    out = service.render(SAMPLE, warm=False)
    for pid, sides in out["residual"].items():
        if pid in DRIVE:
            assert all(abs(r) <= 1.0 for r in sides.values()), (pid, sides)
    assert {"D11", "D12", "H18", "H15", "F13"} <= set(out["geometry"])
    assert set(out["measured"]) >= DRIVE
    assert len(out["vertices"]) > 0
    assert len(out["geometry"]["F05"]) == 2
    for route in out["geometry"]["F05"]:
        assert len(route["landmarks"]) == 4
        assert route["landmarks"][0] == route["points"][0]
        assert route["landmarks"][-1] == route["points"][-1]


def test_body_routes_round_trip_through_the_archive(tmp_path, service):
    from coworker.server import SessionManager, create_app

    os.environ["EDISON_BODY_ROOT"] = str(tmp_path / "body")
    try:
        app = create_app(SessionManager(data_dir=tmp_path / "state"))
    finally:
        del os.environ["EDISON_BODY_ROOT"]
    app.state.body_service._service = service
    with TestClient(app) as client:
        assert len(client.get("/v1/body/catalog").json()["parameters"]) == 22
        assert client.get("/v1/body/status").json()["state"] == "ready"
        topology = client.get("/v1/body/topology").json()
        assert topology["vertex_count"] > 10000
        base_vertices = base64.b64decode(topology["base_vertices"])
        assert len(base_vertices) == topology["vertex_count"] * 4
        assert client.put("/v1/body/draft", json={"values": SAMPLE}).status_code == 200
        snap = client.post("/v1/body/snapshots", json={"measured_on": "2026-11-20", "values": SAMPLE}).json()
        ghost = client.get(f"/v1/body/snapshots/{snap['id']}/body").json()
        assert ghost["geometry"]["C08"]
        assert client.get(f"/v1/body/snapshots/{snap['id']}/body").json()["vertices"] == ghost["vertices"]
        assert client.post("/v1/body/fit", json={"values": {"C08": {"value": 5}}}).status_code == 422
        export = client.get("/v1/body/export")
        assert export.headers["cache-control"] == "private, no-store"
        assert client.delete(f"/v1/body/snapshots/{snap['id']}").status_code == 200
