"""Endpoints for operator-curated examples.

Examples are returned via three endpoints:
- GET /examples?ds=...&kind=...   — list, lightweight (selection stripped)
- GET /examples/<ds>/<id>         — full payload, LTS-gated
- GET /examples/<ds>/_assets/<f>  — thumbnail asset, basename-only

All three consult the RecipeRegistry (in-memory, built at boot) and the
LonglivedRegistry (TTL-cached GCS reader) on every request. LTS gating
is request-time so a marker-file update propagates to all pods on the
next request (no restart needed).
"""

from __future__ import annotations

import copy
import logging
from typing import Any

from flask import Blueprint, current_app, jsonify, request, send_file

from ..auth import auth_required

logger = logging.getLogger("cdv.endpoints.examples")

examples_bp = Blueprint("examples", __name__, url_prefix="/examples")


def _lts_set(ds: str) -> set[int]:
    reg = current_app.extensions.get("dcv_longlived_registry")
    if reg is None:
        return set()
    try:
        return reg.longlived_set(ds)
    except Exception:
        logger.exception("LTS lookup failed for ds=%s", ds)
        return set()


def _strip_for_list(ex: dict) -> dict:
    """Deep-copy and remove the bulky `selection` field for the list response."""
    out = copy.deepcopy(ex)
    if isinstance(out.get("explorer"), dict):
        out["explorer"].pop("selection", None)
    return out


@examples_bp.route("/", methods=["GET"])
@examples_bp.route("", methods=["GET"])
@auth_required
def list_examples() -> Any:
    ds = request.args.get("ds")
    kind_filter = request.args.get("kind")
    if not ds:
        return jsonify({"items": [], "hidden_count": 0})

    registry = current_app.extensions.get("dcv_recipe_registry")
    if registry is None:
        return jsonify({"items": [], "hidden_count": 0})

    all_examples = registry.examples(ds)
    lts = _lts_set(ds)

    items: list[dict] = []
    hidden = 0
    for ex in all_examples:
        if kind_filter and ex.get("kind") != kind_filter:
            continue
        mv = ex.get("pinned", {}).get("mv")
        if not isinstance(mv, int) or mv not in lts:
            hidden += 1
            continue
        items.append(_strip_for_list(ex))

    return jsonify({"items": items, "hidden_count": hidden})


@examples_bp.route("/<ds>/<eid>", methods=["GET"])
@auth_required
def get_example(ds: str, eid: str) -> Any:
    registry = current_app.extensions.get("dcv_recipe_registry")
    if registry is None:
        return jsonify({"error": "registry not configured"}), 500

    ex = registry.example(ds, eid)
    if ex is None:
        return jsonify({"error": "not found"}), 404

    mv = ex.get("pinned", {}).get("mv")
    if not isinstance(mv, int) or mv not in _lts_set(ds):
        return jsonify({
            "error": "example is pinned to a retired materialization version",
            "mv": mv,
        }), 410

    return jsonify(ex)


@examples_bp.route("/<ds>/_assets/<filename>", methods=["GET"])
@auth_required
def get_asset(ds: str, filename: str) -> Any:
    registry = current_app.extensions.get("dcv_recipe_registry")
    if registry is None:
        return jsonify({"error": "registry not configured"}), 500

    path = registry.asset_path(ds, filename)
    if path is None:
        return jsonify({"error": "not found"}), 404

    # send_file infers content type from the extension via the
    # _THUMBNAIL_PATTERN allowlist (png/jpg/webp), so no MIME spoofing.
    return send_file(str(path), max_age=86400)
