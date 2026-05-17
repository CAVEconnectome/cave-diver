"""Integration-style tests for the /examples endpoints.

Uses the standard `client` fixture (Flask test client w/ auth bypass).
Stubs the registry on app.extensions so tests don't depend on real files.
LTS gating is exercised by stubbing the longlived-registry too.
"""

from __future__ import annotations

import pytest


class FakeRegistry:
    def __init__(
        self,
        examples_by_ds: dict[str, list[dict]] | None = None,
        recipes_by_ds: dict[str, list[dict]] | None = None,
    ) -> None:
        self._examples = examples_by_ds or {}
        self._recipes = recipes_by_ds or {}

    def examples(self, ds: str) -> list[dict]:
        return list(self._examples.get(ds, []))

    def example(self, ds: str, eid: str) -> dict | None:
        for ex in self._examples.get(ds, []):
            if ex.get("id") == eid:
                return ex
        return None

    def recipes(self, ds: str) -> list[dict]:
        return list(self._recipes.get(ds, []))

    def asset_path(self, ds: str, filename: str):
        return None


class FakeLts:
    def __init__(self, sets: dict[str, set[int]]) -> None:
        self._sets = sets

    def longlived_set(self, ds: str) -> set[int]:
        return self._sets.get(ds, set())


@pytest.fixture()
def app_with_registry(app, monkeypatch):
    examples = {
        "ds_x": [
            {
                "version": 1, "kind": "explorer", "id": "in-lts",
                "title": "in lts", "summary": "x",
                "pinned": {"mv": 1078},
                "explorer": {"ft": "x", "emb": "y", "selection": ["1"]},
            },
            {
                "version": 1, "kind": "explorer", "id": "out-of-lts",
                "title": "stale", "summary": "x",
                "pinned": {"mv": 9999},
                "explorer": {"ft": "x", "emb": "y", "selection": ["1"]},
            },
        ],
    }
    app.extensions["dcv_recipe_registry"] = FakeRegistry(examples_by_ds=examples)
    app.extensions["dcv_longlived_registry"] = FakeLts({"ds_x": {1078}})
    return app


def test_lists_only_lts_examples(app_with_registry, client) -> None:
    resp = client.get("/api/v1/examples?ds=ds_x")
    assert resp.status_code == 200
    body = resp.get_json()
    assert [it["id"] for it in body["items"]] == ["in-lts"]
    assert body["hidden_count"] == 1


def test_filter_by_kind(app_with_registry, client) -> None:
    resp = client.get("/api/v1/examples?ds=ds_x&kind=connectivity")
    assert resp.status_code == 200
    assert resp.get_json()["items"] == []


def test_list_strips_selection_payload(app_with_registry, client) -> None:
    resp = client.get("/api/v1/examples?ds=ds_x")
    item = resp.get_json()["items"][0]
    assert "selection" not in item.get("explorer", {})


def test_get_full_payload_includes_selection(app_with_registry, client) -> None:
    resp = client.get("/api/v1/examples/ds_x/in-lts")
    assert resp.status_code == 200
    assert resp.get_json()["explorer"]["selection"] == ["1"]


def test_get_lts_retired_returns_410(app_with_registry, client) -> None:
    resp = client.get("/api/v1/examples/ds_x/out-of-lts")
    assert resp.status_code == 410


def test_get_unknown_returns_404(app_with_registry, client) -> None:
    resp = client.get("/api/v1/examples/ds_x/nope")
    assert resp.status_code == 404


def test_unknown_datastack_empty_list(app_with_registry, client) -> None:
    resp = client.get("/api/v1/examples?ds=unknown")
    assert resp.status_code == 200
    assert resp.get_json() == {"items": [], "hidden_count": 0}
