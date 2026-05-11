from flask import Blueprint, current_app, jsonify, request

from ..auth import auth_required, current_token, is_dev_bypass
from ..cave import request_client
from ..errors import ApiError
from ..services.datastack_config import (
    aligned_volume_config_for,
    check_live_allowed,
    load_datastack_config,
    resolve_synapse_config,
)
from ..services.neuron import NeuronQuery, connectivity_bundle, suggest_current_root
from ..services.spatial import build_spatial_provider
from ..services.timing import timer

bp = Blueprint("connectivity", __name__, url_prefix="/datastacks")


def _client_for(ds: str):
    mat_version = request.args.get("mat_version") or None
    try:
        return request_client(
            datastack_name=ds,
            server_address=current_app.config["GLOBAL_SERVER_ADDRESS"],
            auth_token=current_token(),
            dev_bypass=is_dev_bypass(),
            materialize_version=mat_version,
        )
    except ValueError as exc:
        raise ApiError(401, "no_auth_token", str(exc)) from exc


@bp.route("/<ds>/neuron/<int:root_id>/connectivity", methods=["POST"])
@auth_required
def connectivity(ds: str, root_id: int):
    body = request.get_json(silent=True) or {}
    include = body.get("include")
    decoration_tables = body.get("decoration_tables") or []
    mat_version = request.args.get("mat_version") or None

    try:
        check_live_allowed(ds, mat_version)
    except ValueError as exc:
        raise ApiError(422, "live_mode_disallowed", str(exc)) from exc

    # Endpoint setup: CAVEclient instantiation, datastack/aligned-volume
    # YAML resolution, NeuronQuery construction, spatial provider build.
    # Each piece is fast individually but the CAVEclient constructor in
    # particular has historically taken 50–200ms (auth-server discovery
    # + the http session warmup). Without this timer that cost lands in
    # `processing_ms` reading like in-process compute, which is misleading.
    with timer("endpoint_setup"):
        cfg = load_datastack_config(ds)

        # Capture the user's auth token + dev_bypass flag in the request thread;
        # the background revalidator runs after the request context is gone and
        # needs both available via closure to dispatch the same hardened client
        # builder (no silent cave-secret fallback in production).
        token = current_token()
        bypass = is_dev_bypass()
        server_address = current_app.config["GLOBAL_SERVER_ADDRESS"]

        def client_factory():
            return request_client(
                datastack_name=ds,
                server_address=server_address,
                auth_token=token,
                dev_bypass=bypass,
                materialize_version=mat_version,
            )

        try:
            client = client_factory()
        except ValueError as exc:
            raise ApiError(401, "no_auth_token", str(exc)) from exc
        # Aligned-volume config carries spatial transform + synapse defaults.
        # `minnie65_public` and `minnie65_phase3_v1` share `minnie65_phase3` so
        # they pick up identical transform / depth_range / layer guides AND
        # synapse conventions without duplicate YAML. Volumes without a
        # configured aligned_volumes/*.yaml (e.g. brain_and_nerve_cord) fall
        # back to schema defaults and rely on the datastack YAML's `synapse:`
        # block for any non-default conventions.
        av_cfg = aligned_volume_config_for(ds, client)
        syn_cfg = resolve_synapse_config(av_cfg, cfg)
        # Per-request body can still override the resolved aggregation rules /
        # column projection — power-user knob for ad-hoc queries that the
        # datastack YAML doesn't anticipate.
        rules = body.get("synapse_aggregation_rules") or syn_cfg.aggregation_rules_for_neuron_query()
        synapse_columns = body.get("synapse_columns", syn_cfg.merged_columns())
        nq = NeuronQuery(
            client,
            root_id=root_id,
            datastack=ds,
            mat_version=mat_version,
            synapse_aggregation_rules=rules,
            synapse_columns=synapse_columns,
            synapse_position_prefix=syn_cfg.position_prefix,
        )
        bundle_kwargs = dict(
            include=include,
            decoration_tables=decoration_tables,
            client_factory=client_factory,
            spatial_provider=build_spatial_provider(av_cfg.spatial),
        )
    try:
        payload = connectivity_bundle(nq, **bundle_kwargs)
    except ValueError as exc:
        raise ApiError(409, "neuron_query_failed", str(exc)) from exc
    except Exception as exc:
        raise ApiError(502, "cave_upstream", str(exc)) from exc

    # Stale-root translation. When both partner directions come back
    # empty, the most likely cause is that root_id was edited away by
    # proofreading after the user obtained it. Ask the chunkedgraph for
    # the current equivalent root at the request's pinned timestamp
    # (live) or the version's snapshot time (materialized). If the
    # chunkedgraph suggests a different root, re-run the bundle with
    # the new id and surface `root_id_updated` so the SPA can update
    # the URL + show a toast.
    #
    # No proactive check: the translation only fires when the request
    # has already paid an "empty bundle" cost (synapse fetches at the
    # cold root, both empty → fast). The retry is the path that does
    # the real work.
    pin_empty = not payload.get("partners_in")
    pout_empty = not payload.get("partners_out")
    if pin_empty and pout_empty:
        suggested = suggest_current_root(client, root_id, mat_version=mat_version)
        if suggested is not None and suggested != root_id:
            nq2 = NeuronQuery(
                client,
                root_id=suggested,
                datastack=ds,
                mat_version=mat_version,
                synapse_aggregation_rules=rules,
                synapse_columns=synapse_columns,
                synapse_position_prefix=syn_cfg.position_prefix,
            )
            try:
                payload = connectivity_bundle(nq2, **bundle_kwargs)
            except Exception as exc:
                # Re-run failed; serve the original empty bundle but
                # still flag the suggestion so the SPA can surface it.
                raise ApiError(502, "cave_upstream", str(exc)) from exc
            payload["root_id_updated"] = {
                "original": str(root_id),
                "current": str(suggested),
                "reason": "empty_partners_at_pinned_timestamp",
            }

    # Wrap jsonify to surface serialization cost. The NumpyJSONProvider's
    # `pd.NA → None` rule + per-key Python iteration over a 5K-partner
    # response is potentially non-trivial.
    with timer("jsonify"):
        return jsonify(payload)
