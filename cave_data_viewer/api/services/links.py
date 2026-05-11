"""Neuroglancer link template loader + resolver.

Templates are declarative recipes (YAML or `LinkTemplate(...)` objects). The
client posts `{template, query: {root_id, ...}}` and the resolver here pulls
synapse rows from `dcv_synapse_cache` (warmed by an earlier `/connectivity` request),
shapes them, and composes a ViewerState via the building blocks in
`services/state`. The dataframe never crosses the wire.

To extend visual behavior — cell-type-grouped layers, supervoxel-id annotation
segments in live mode, custom shaders, annotation properties — add the
primitive in `services/state.py`, then call it from `resolve_link` based on a
new field on `LinkTemplate`. `resolve_link` itself stays small.
"""

import logging
from pathlib import Path
from typing import Literal

import pandas as pd
import yaml
from flask import current_app
from pydantic import BaseModel, Field, ValidationError

from . import state as ngl
from .neuron import NeuronQuery

logger = logging.getLogger(__name__)


# ----- schema -----------------------------------------------------------------

class AnnotationLayerSpec(BaseModel):
    name: str
    color: str | None = None  # CSS color name or hex; None → nglui default
    shader: str | bool = True  # True = nglui default; False = none; str = custom GLSL


class LinkTemplate(BaseModel):
    """A declarative recipe for a Neuroglancer state."""
    name: str
    description: str = ""
    direction: Literal["inputs", "outputs", "both"]
    inputs: AnnotationLayerSpec = Field(default_factory=lambda: AnnotationLayerSpec(name="syns_in", color="turquoise"))
    outputs: AnnotationLayerSpec = Field(default_factory=lambda: AnnotationLayerSpec(name="syns_out", color="tomato"))
    shorten: Literal["never", "if_long", "always"] = "if_long"


# ----- loader -----------------------------------------------------------------

def load_templates() -> dict[str, LinkTemplate]:
    """Load all templates fresh on every call. Templates are tiny YAML files;
    parsing them per-request is cheap and avoids stale-cache surprises when an
    operator edits a template file without restarting the process.
    """
    out: dict[str, LinkTemplate] = {}
    bundled_dir = Path(__file__).parent.parent / "templates" / "links"
    _load_dir(bundled_dir, out)
    extra_dir = current_app.config.get("LINK_TEMPLATE_DIR")
    if extra_dir:
        _load_dir(Path(extra_dir), out)
    return out


def _load_dir(path: Path, out: dict[str, LinkTemplate]) -> None:
    if not path.is_dir():
        return
    for yaml_path in sorted(path.glob("*.yaml")):
        try:
            data = yaml.safe_load(yaml_path.read_text()) or {}
        except yaml.YAMLError as exc:
            logger.warning("skipping link template %s: YAML parse error: %s", yaml_path, exc)
            continue
        if "name" not in data:
            data["name"] = yaml_path.stem
        try:
            tmpl = LinkTemplate.model_validate(data)
        except ValidationError as exc:
            logger.warning("skipping link template %s: validation error: %s", yaml_path, exc)
            continue
        out[tmpl.name] = tmpl


# ----- resolver ---------------------------------------------------------------

# When live-mode supervoxel-id annotation segments land, this becomes a function
# that returns the right pair based on `is_live(nq.mat_version)`.
_DEFAULT_SEGMENTS_COLUMNS: tuple[str, str] = ("pre_pt_root_id", "post_pt_root_id")


def resolve_link(
    *,
    template: LinkTemplate,
    nq: NeuronQuery,
    client,
    selected_partner_ids: list[str] | list[int] | None,
    spelunker_url: str,
) -> dict:
    """Compose a Neuroglancer state for `template` and render it to a URL."""
    selected_int_ids = (
        [int(x) for x in selected_partner_ids] if selected_partner_ids else None
    )

    df_in, df_out = _resolve_dataframes(nq, template, selected_int_ids)

    # Pin segments. The focal (queried) neuron is always pinned and colored
    # white so it's visually distinct from any partner segments — useful even
    # when no partner is co-pinned, since point-annotation clicks in the
    # synapse layers add other segments and the focal cell otherwise becomes
    # indistinguishable. When exactly one partner is selected, pin it
    # alongside the focal cell so the link opens to a clean pair view; for
    # 2+ selections we leave them unpinned (the synapse annotations link
    # them anyway, and pinning many partners drags in too many meshes).
    viewer = ngl.new_viewer_state(client)
    pin_ids: list[int] = [nq.root_id]
    if selected_int_ids and len(selected_int_ids) == 1:
        partner_id = selected_int_ids[0]
        if partner_id != nq.root_id:
            pin_ids.append(partner_id)
    ngl.pin_segments(viewer, pin_ids, colors={nq.root_id: "white"})

    if df_in is not None:
        viewer.add_layer(ngl.synapse_layer(
            df_in,
            layer_name=template.inputs.name,
            color=template.inputs.color or "turquoise",
            shader_template=template.inputs.shader,
            position_prefix=nq.synapse_position_prefix,
            segments_columns=_DEFAULT_SEGMENTS_COLUMNS,
            data_resolution=list(nq.desired_resolution),
        ))
    if df_out is not None:
        viewer.add_layer(ngl.synapse_layer(
            df_out,
            layer_name=template.outputs.name,
            color=template.outputs.color or "tomato",
            shader_template=template.outputs.shader,
            position_prefix=nq.synapse_position_prefix,
            segments_columns=_DEFAULT_SEGMENTS_COLUMNS,
            data_resolution=list(nq.desired_resolution),
        ))

    url, shortened = ngl.render_url(
        viewer,
        target_url=spelunker_url,
        shorten=template.shorten,
        client=client,
    )
    return {"url": url, "shortened": shortened}


def _resolve_dataframes(
    nq: NeuronQuery,
    template: LinkTemplate,
    selected_int_ids: list[int] | None,
) -> tuple[pd.DataFrame | None, pd.DataFrame | None]:
    """Pull synapse dfs for the requested directions, filter to the selection,
    and order rows so a partner's synapses are contiguous in the SPA's
    partners-table order (num_syn desc).
    """
    df_in = df_out = None
    if template.direction in ("inputs", "both"):
        df_in = nq._synapse_df("post").copy()  # cached if same key already fetched
        if selected_int_ids is not None:
            df_in = df_in[df_in["pre_pt_root_id"].isin(selected_int_ids)]
        df_in = ngl.sort_to_partner_order(
            df_in,
            partner_col="pre_pt_root_id",
            partner_order=nq.partners_in()["root_id"].tolist(),
        )
    if template.direction in ("outputs", "both"):
        df_out = nq._synapse_df("pre").copy()
        if selected_int_ids is not None:
            df_out = df_out[df_out["post_pt_root_id"].isin(selected_int_ids)]
        df_out = ngl.sort_to_partner_order(
            df_out,
            partner_col="post_pt_root_id",
            partner_order=nq.partners_out()["root_id"].tolist(),
        )
    return df_in, df_out
