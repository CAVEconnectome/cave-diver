import os

from flask import Flask
from werkzeug.middleware.proxy_fix import ProxyFix


_DEFAULTS = {
    "GLOBAL_SERVER_ADDRESS": "https://global.daf-apis.com",
    "DEFAULT_DATASTACK": None,
    # Allowlist of datastacks the SPA's picker offers. The list is also the
    # only thing the listing endpoint returns — endpoints themselves don't
    # gate on it (CAVE auth is the security boundary). Override per-deployment
    # via `CDV_DATASTACKS_ALLOWED` (comma-separated). Default ships the three
    # development datastacks: minnie65_public + minnie65_phase3_v1 (cortex,
    # shared aligned_volume `minnie65_phase3`) and brain_and_nerve_cord
    # (different aligned_volume, no spatial config — exercises the
    # "no transform" branches of the bundle assembler and SPA).
    "DATASTACKS_ALLOWED": [
        "minnie65_public",
        "minnie65_phase3_v1",
        "brain_and_nerve_cord",
    ],
    "CORS_ORIGINS": ["http://localhost:5173"],
    "SPELUNKER_URL": "https://spelunker.cave-explorer.org",
    "CACHE_QUERY_TTL_SECONDS": 15 * 60,
    "CACHE_TABLE_META_TTL_SECONDS": 60 * 60,
    # Frozen materializations are immutable, so this is effectively forever.
    # The 7-day ceiling exists only because cachetools.TTLCache requires a
    # finite TTL; it also bounds memory if a config or proxy quirk makes us
    # accumulate keys across many datastacks.
    "CACHE_UNIQUE_VALUES_TTL_SECONDS": 7 * 24 * 60 * 60,
    "CACHE_INFO_TTL_SECONDS": 24 * 60 * 60,
    # Spatial-features payload (per-partner soma_depth, soma_x/z,
    # radial_dist, median_dist, median_syn_depth) is invariant for a
    # frozen materialization. 30 minutes covers a typical exploration
    # session; live mode short-circuits the cache by including
    # mat_version="live" in the key (always fresh).
    "CACHE_SPATIAL_FEATURES_TTL_SECONDS": 30 * 60,
    "CACHE_DECORATION_SOFT_TTL_SECONDS": 4 * 60 * 60,
    "CACHE_DECORATION_HARD_TTL_SECONDS": 24 * 60 * 60,
    "CACHE_DECORATION_LIVE_SOFT_TTL_SECONDS": 5 * 60,
    "CACHE_DECORATION_LIVE_HARD_TTL_SECONDS": 30 * 60,
    "DECORATION_REVALIDATION_WORKERS": 4,
    "LINK_TEMPLATE_DIR": None,
    "PLOT_TEMPLATE_DIR": None,
    "DATASTACK_CONFIG_DIR": None,
    "ALIGNED_VOLUME_CONFIG_DIR": None,
    # GCS-backed L2 cache. Unset (None) → L2 disabled, every cache is
    # in-process only (today's behavior). When set, decoration mat caches
    # and the synapse-df cache also persist to GCS so cross-pod reads
    # warm a cold L1 in ~30ms instead of paying a multi-second CAVE
    # refetch. Only the bucket name is required; ADC supplies auth.
    "GCS_CACHE_BUCKET": None,
    # Object-name prefix inside the bucket. Defaults to `cache/`; multiple
    # deployments can share a single bucket by setting different prefixes
    # (e.g. `cdv-prod/cache/`, `cdv-staging/cache/`).
    "GCS_CACHE_PREFIX": "cache/",
    # GCP project used as the billing/quota project for GCS calls. Required
    # when the runtime auth identity (e.g. end-user ADC from
    # `gcloud auth application-default login`) does not embed a project.
    # Service accounts and Workload Identity bindings carry a project
    # natively, so production deployments often don't need to set this —
    # it's primarily a local-dev / CI nicety.
    "GCS_CACHE_PROJECT": None,
    # TTL for the longlived-versions marker-file cache (per-pod). 5 minutes
    # is fast enough that an operator marking a new public release sees
    # service-wide effect quickly, and slow enough that the GCS read load
    # from polling stays trivial (one read per pod per datastack per
    # 5 min). The value is the staleness window after a `cdv-warm-cache`
    # mark — values served are always correct; only the choice of L2
    # partition lags.
    "LONGLIVED_VERSIONS_TTL_SECONDS": 300,
}


def configure_app(app: Flask, overrides: dict | None = None) -> None:
    app.config.update(_DEFAULTS)
    for key in _DEFAULTS:
        env_value = os.environ.get(f"CDV_{key}")
        if env_value is not None:
            app.config[key] = _coerce(_DEFAULTS[key], env_value)
    # middle-auth-client and CAVEclient ship with their own `GLOBAL_SERVER`
    # env var (host only, e.g. `global.daf-apis.com`) used for the initial
    # global / datastack-discovery API. Our config historically called the
    # same value `GLOBAL_SERVER_ADDRESS` (with scheme). When operators set
    # `GLOBAL_SERVER` for middle-auth and don't separately set
    # `CDV_GLOBAL_SERVER_ADDRESS`, derive ours from it so the deployment
    # has a single source of truth.
    if (
        os.environ.get("CDV_GLOBAL_SERVER_ADDRESS") is None
        and os.environ.get("GLOBAL_SERVER")
    ):
        bare = os.environ["GLOBAL_SERVER"].strip()
        # Allow operators to set either `host` or `https://host`; normalize
        # to a full URL.
        if not bare.startswith(("http://", "https://")):
            bare = f"https://{bare}"
        app.config["GLOBAL_SERVER_ADDRESS"] = bare.rstrip("/")
    if overrides:
        app.config.update(overrides)
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_prefix=1)


def _coerce(default, raw: str):
    if isinstance(default, bool):
        return raw.lower() in {"1", "true", "yes", "on"}
    if isinstance(default, int):
        return int(raw)
    if isinstance(default, list):
        return [item.strip() for item in raw.split(",") if item.strip()]
    return raw
