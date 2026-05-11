"""Per-request timing instrumentation.

Why this exists: most of the latency in this service is spent in CAVE
round-trips (synapse / soma / decoration-table fetches), and the cost of
each varies wildly across datastacks, materialization versions, and
neuron sizes. Without per-stage breakdowns it's impossible to tell
whether a slow `/connectivity` request is bottlenecked on synapse fetch,
decoration enrichment, or in-process aggregation. This module emits one
structured log line per request with a stage-name → ms map.

Usage:

    from .services.timing import timer

    with timer("synapse_query[post]"):
        df = client.materialize.tables.synapses_pni_2(...)

Stages with the same name within one request accumulate into a list, so
two `synapse_query[post]` calls produce `[12.3, 11.8]` rather than
overwriting. Easier to spot duplicate work that way.

The Flask `before_request` hook initializes a per-request stages dict on
`flask.g`; the `after_request` hook emits a JSON payload tagged
`request_timing`. Outside a request context (e.g. unit tests calling
services directly) the timer is a no-op — it doesn't error, just doesn't
record. That keeps tests free of Flask scaffolding.

Logger name: `cdv.timing`. Configured at INFO with its own StreamHandler
so the timing line is greppable independently of Flask's request log.
Production deployments can override with their own `dictConfig`.
"""

import json
import logging
import time
from contextlib import contextmanager

from flask import g, request


logger = logging.getLogger("cdv.timing")


# Stage-name prefixes that count as "CAVE round-trips" for the rollup.
# Stage labels with `_hit` in them (e.g. `synapse_l1_hit[post]`,
# `synapse_l2_hit[post]`, `soma_l2_hit`) are cache-lookup latency, not
# CAVE work, even though they share a prefix word — the suffix-skip
# below filters them out. Decoration queries are CAVE-bound but the SWR
# cache means warm-hit short-circuits before any timer wraps them, so
# anything that does emit a `decoration_query[*]` is a real round-trip.
_CAVE_STAGE_PREFIXES = (
    "synapse_query",
    "soma_query",
    "decoration_query",
    "datastack_info_query",
)


def _is_cache_lookup_stage(name: str) -> bool:
    """`<thing>_l1_hit` / `<thing>_l2_hit` / legacy `<thing>_cache_hit` —
    every cache-lookup stage. Centralised so `_classify_cave_ms` and
    `_classify_l2_ms` use the same definition."""
    return "_l1_hit" in name or "_l2_hit" in name or "cache_hit" in name


def _stage_total(value) -> float:
    """Stage values are either a scalar (single call) or a list (repeated
    calls of the same name accumulated). Reduce to a single sum either
    way so the rollup is uniform."""
    if isinstance(value, list):
        return sum(value)
    return float(value)


def _classify_cave_ms(stages: dict) -> float:
    """Sum every stage value matching a CAVE-query prefix into a single
    rollup. Cache-lookup stages share the prefix word but aren't CAVE
    work; they're skipped via `_is_cache_lookup_stage`."""
    total = 0.0
    for name, value in stages.items():
        if not name.startswith(_CAVE_STAGE_PREFIXES):
            continue
        if _is_cache_lookup_stage(name):
            continue
        total += _stage_total(value)
    return round(total, 2)


def _classify_cache_l2_ms(stages: dict) -> float:
    """Sum every stage value tagged `*_l2_hit*` — wall-time spent on
    GCS L2 cache reads (including the unpickle / promote-to-L1 path).
    Surfaced as its own rollup so a slow request that's actually waiting
    on cold-pod L2 promotion doesn't get misread as CAVE-bound.

    Under parallelism this can exceed `total_ms` (sum of two parallel
    GCS reads > wall time) — same caveat that already applies to the
    per-direction CAVE timers under parallel synapse fetches.
    """
    total = 0.0
    for name, value in stages.items():
        if "_l2_hit" not in name:
            continue
        total += _stage_total(value)
    return round(total, 2)


def record_stage(label: str, elapsed_ms: float, *, stages: dict | None = None) -> None:
    """Record a pre-measured timing under `label`. Same accumulation
    rules as `timer` (repeated labels stack into a list).

    Use this when the work to time is a single function call whose
    return value drives the label choice — e.g. `cache.get_with_layer`
    where the resulting `layer` decides between `synapse_l1_hit` and
    `synapse_l2_hit`. With a `with timer(...)` block, the label is
    fixed before the work runs, so a layer-aware label can't be
    expressed cleanly that way.
    """
    target = stages
    if target is None:
        try:
            target = g.setdefault("timing_stages", {})
        except RuntimeError:
            return
    rounded = round(elapsed_ms, 2)
    existing = target.get(label)
    if existing is None:
        target[label] = rounded
    elif isinstance(existing, list):
        existing.append(rounded)
    else:
        target[label] = [existing, rounded]


@contextmanager
def timer(stage: str, *, stages: dict | None = None):
    """Time a code block and accumulate the result into a stages dict.

    Default behavior reads/writes `flask.g.timing_stages` — fine for code
    that runs in the request's main thread. Outside a request context,
    silently no-ops.

    `stages` parameter for cross-thread use: when work runs inside a
    `ThreadPoolExecutor`, `flask.g` isn't propagated to worker threads,
    so the default path silently drops the timing. Capture
    `flask.g.timing_stages` at the orchestrator (in the request thread)
    and pass it explicitly into worker code paths so their timings still
    flow back into the request log line.

    Repeated calls with the same `stage` name accumulate as a list —
    useful for spotting per-direction duplication or repeated fetches
    of the same decoration table. CPython's GIL makes single-key dict
    writes safe without an explicit lock; the read-modify-write for the
    list-accumulation case has a theoretical race that's vanishingly
    unlikely at our volumes (< few-dozen worker writes per request).
    """
    start = time.perf_counter()
    try:
        yield
    finally:
        elapsed_ms = round((time.perf_counter() - start) * 1000, 2)
        target = stages
        if target is None:
            try:
                target = g.setdefault("timing_stages", {})
            except RuntimeError:
                target = None  # no request context — drop the recording
        # NB: do NOT `return` from inside this finally block. A bare
        # `return` here would silently suppress any in-flight exception
        # raised inside the `yield` — see Python's "exception suppression
        # by return-in-finally" gotcha. Gate the recording on `target`
        # being available instead.
        if target is not None:
            existing = target.get(stage)
            if existing is None:
                target[stage] = elapsed_ms
            elif isinstance(existing, list):
                existing.append(elapsed_ms)
            else:
                target[stage] = [existing, elapsed_ms]


def current_stages() -> dict | None:
    """Return the current request's stages dict, or None when outside a
    request context. Helper for orchestrator code that needs to capture
    the dict reference once and pass it to worker threads (where
    `flask.g` access would raise).
    """
    try:
        return g.setdefault("timing_stages", {})
    except RuntimeError:
        return None


def _configure_logger() -> None:
    """Idempotent logger setup. Always sets level + propagation (so a host
    that attaches its own handler before `init_timing` still gets INFO
    lines through). Only the default StreamHandler is conditional —
    skipped when the host has already attached one to avoid double output.
    """
    logger.setLevel(logging.INFO)
    logger.propagate = False
    if logger.handlers:
        return
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter(
        "%(asctime)s %(name)s %(message)s",
        datefmt="%H:%M:%S",
    ))
    logger.addHandler(handler)


def init_timing(app) -> None:
    """Wire the request-lifecycle hooks. Called from the app factory."""
    _configure_logger()

    @app.before_request
    def _start_timer():  # noqa: ANN202
        # Skip CORS preflight — the request lifecycle for OPTIONS is
        # very short and not interesting to log.
        if request.method == "OPTIONS":
            return
        g.timing_started = time.perf_counter()
        g.timing_stages = {}

    @app.after_request
    def _emit_timing(response):
        started = g.pop("timing_started", None)
        if started is None:
            return response
        total_ms = round((time.perf_counter() - started) * 1000, 2)
        stages = g.pop("timing_stages", {})
        # Latency rollup splits total_ms into three buckets so the top of
        # the log line answers "where did this request spend its time?"
        # without grepping through stages:
        #   - `cave_ms`     : real CAVE round-trips (synapse / soma /
        #                     decoration_query), excluding cache lookups.
        #   - `cache_l2_ms` : wall-time on GCS L2 reads (cold-pod warmup,
        #                     mostly). Distinct from CAVE; visible
        #                     separately so a slow request from a cold
        #                     pod doesn't get misread as CAVE-bound.
        #   - `processing_ms`: residual — in-process aggregation, plot
        #                     building, JSON serialization, framework.
        # Under parallelism (e.g. parallel pre+post synapse fetches) the
        # per-direction sums can exceed wall time of that block, so the
        # buckets aren't strictly additive — `processing_ms` floors at 0.
        cave_ms = _classify_cave_ms(stages)
        cache_l2_ms = _classify_cache_l2_ms(stages)
        processing_ms = round(max(total_ms - cave_ms - cache_l2_ms, 0), 2)
        # Single JSON payload — easy to grep, easy to parse for charting
        # later. Path includes the query string-less URL; methods + status
        # round out the surface.
        payload = {
            "endpoint": request.path,
            "method": request.method,
            "status": response.status_code,
            "total_ms": total_ms,
            "cave_ms": cave_ms,
            "cache_l2_ms": cache_l2_ms,
            "processing_ms": processing_ms,
            "stages": stages,
        }
        logger.info("request_timing %s", json.dumps(payload, default=str))
        return response
