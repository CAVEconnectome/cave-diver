import os
from pathlib import Path

from flask import Flask, send_from_directory
from flask_cors import CORS

from .auth import auth_required
from .config import configure_app
from .errors import register_error_handlers
from .endpoints import api_bp
from .json_provider import NumpyJSONProvider
from .services.decoration import init_decoration_service
from .services.longlived_registry import LonglivedRegistry
from .services.recipe_registry import RecipeRegistry
from .services.object_store import build_info_store, build_l2_stores, build_userdata_store
from .services.request_state import init_request_state
from .services.timing import init_timing


def create_app(config_overrides: dict | None = None) -> Flask:
    app = Flask(__name__)
    app.json = NumpyJSONProvider(app)
    configure_app(app, overrides=config_overrides)
    _wire_feature_tables_base_uri(app)
    CORS(
        app,
        resources={r"/api/*": {"origins": app.config["CORS_ORIGINS"]}},
        supports_credentials=True,
    )
    register_error_handlers(app)
    # Order matters:
    #   1. Longlived registry must be ready before any cache that uses
    #      retention-class resolution.
    #   2. The L2 writer + per-cell cache instances must be built before
    #      `init_decoration_service`, which now consumes the shared
    #      `dcv_l2_writer` for its own L2-write fan-out.
    _init_longlived_registry(app)
    app.extensions["dcv_recipe_registry"] = RecipeRegistry.from_env()
    _init_userdata_store(app)
    _init_l2_immutable_caches(app)
    init_decoration_service(app)
    init_timing(app)
    init_request_state(app)
    app.register_blueprint(api_bp, url_prefix="/api/v1")
    _register_spa(app)
    return app


def _init_longlived_registry(app: Flask) -> None:
    """TTL-cached reader of the per-datastack longlived-versions marker
    files. Single instance per app; consulted at every cache-key
    construction site that needs to know whether a mat_version should
    land in the longlived (1–2 year) or default (2 day) L2 partition.
    """
    info_store = build_info_store(app)
    ttl = float(app.config.get("LONGLIVED_VERSIONS_TTL_SECONDS", 300))
    app.extensions["dcv_longlived_registry"] = LonglivedRegistry(
        info_store=info_store, ttl_seconds=ttl,
    )


def _init_userdata_store(app: Flask) -> None:
    """Per-user JSON/YAML store (currently personal recipes). Sibling of the
    cache stores; lives at `<CDV_GCS_CACHE_PREFIX>userdata/`. None when GCS
    isn't configured — the recipes endpoints surface that as
    `{enabled: false, reason: "no_bucket"}` so the SPA falls back to a
    localStorage-only mode without UX friction."""
    app.extensions["dcv_userdata_store"] = build_userdata_store(app)


def _init_l2_immutable_caches(app: Flask) -> None:
    """Build the immutable-data `LayeredSwrCache` instances + the shared
    L2 write executor.

    Caches built here:
      - `dcv_synapse_cache`           — materialized synapse DataFrames (per-cell)
      - `dcv_spatial_features_cache`  — `CachedSpatialFeatures` per cell
      - `dcv_unique_values_cache`     — column-value dict per (ds, mv, table)

    Note: there's no `dcv_soma_summary_cache`. Soma-summary data is read
    directly from the bulk `num_soma` decoration cache — that bulk cache
    holds `{root_id: row}` for every root in the soma table and is
    already L2-backed. A separate per-cell partition would just shadow
    a subset of the bulk cache's data.

    All three are configured with `immutable=True`: the cache key pins
    `mat_version` (or otherwise frozen invariants for unique_values),
    so a hit is bit-identical to what the source would return. SWR
    semantics (soft/hard TTL gating, background revalidation) don't
    apply — bucket lifecycle handles expiry.

    All extensions are present regardless of `GCS_CACHE_BUCKET`; when
    the bucket isn't configured, the LayeredSwrCache wrappers carry
    `l2=None` and short-circuit cleanly to L1-only behavior, so call
    sites don't need a bucket-presence branch.

    The shared `dcv_l2_writer` is consumed by every `LayeredSwrCache`
    in the app (the three here, plus `DecorationService`'s four). One
    executor for all L2 writes — cleaner shutdown semantics
    (`tools/warm_cache._drain_l2_writer` waits on the single writer)
    and no executor proliferation as new cache kinds get added.
    """
    from concurrent.futures import ThreadPoolExecutor
    from .services.cache_lifecycle import retention_class_for
    from .services.swr import LayeredSwrCache

    l2 = build_l2_stores(app)
    if l2:
        app.extensions["dcv_l2_writer"] = ThreadPoolExecutor(
            max_workers=4, thread_name_prefix="cdv-l2-write"
        )
    else:
        app.extensions["dcv_l2_writer"] = None
    writer = app.extensions["dcv_l2_writer"]

    def _resolve_retention(key) -> str:
        # Cache keys are tuples whose first two elements are
        # (cache_ds, mat_version). Per-cache key shape varies after
        # those: synapse is `(ds, mv, sha)`, spatial_features is
        # `(ds, mv, root_id, soma_table, digest)`, unique_values is
        # `(ds, mv, table)`. The retention only cares about (ds, mv) —
        # uniform across all kinds.
        if not isinstance(key, tuple) or len(key) < 2:
            return "default"
        ds, mat_version = key[0], key[1]
        registry = app.extensions.get("dcv_longlived_registry")
        if registry is None:
            return "default"
        return retention_class_for(registry, ds, mat_version)

    def _l2_for_kind(kind: str):
        if not l2:
            return None
        return {retention: l2[retention][kind] for retention in l2}

    # `soft_ttl` / `hard_ttl` are not consulted in `immutable=True` mode
    # but the constructor requires them. Pass the configured values for
    # documentation value (operator can still see them in config).
    soft = app.config["CACHE_QUERY_TTL_SECONDS"]
    hard = soft

    app.extensions["dcv_synapse_cache"] = LayeredSwrCache(
        soft_ttl=soft,
        hard_ttl=hard,
        maxsize=4096,  # # of distinct (ds, mv, syn-hash) entries in memory
        l2=_l2_for_kind("synapse"),
        executor=writer,
        retention_resolver=_resolve_retention,
        immutable=True,
    )
    soft_spatial = app.config["CACHE_SPATIAL_FEATURES_TTL_SECONDS"]
    app.extensions["dcv_spatial_features_cache"] = LayeredSwrCache(
        soft_ttl=soft_spatial,
        hard_ttl=soft_spatial,
        maxsize=256,  # entries can be a few MB on heavily-connected neurons
        l2=_l2_for_kind("spatial_features"),
        executor=writer,
        retention_resolver=_resolve_retention,
        immutable=True,
    )
    soft_unique = app.config["CACHE_UNIQUE_VALUES_TTL_SECONDS"]
    app.extensions["dcv_unique_values_cache"] = LayeredSwrCache(
        soft_ttl=soft_unique,
        hard_ttl=soft_unique,
        maxsize=512,  # # of distinct (ds, mv, table) entries
        l2=_l2_for_kind("unique_values"),
        executor=writer,
        retention_resolver=_resolve_retention,
        immutable=True,
    )

    # Cell_id universe cache. One entry per (cache_ds, mat_version,
    # lookup_view) holding the full {cell_id ↔ root_id} mapping at
    # that materialization. Immutable by construction (mat_versions are
    # frozen). First user / first pod on a new mat_version pays the
    # CAVE round-trip; every subsequent user and pod hits warm via
    # the shared L2 (GCS) layer. Replaces the per-process TTLCache
    # that used to live in `services/cell_id.py:_universe_mat`.
    app.extensions["dcv_cell_id_universe_cache"] = LayeredSwrCache(
        soft_ttl=soft,
        hard_ttl=hard,
        maxsize=64,  # per-pod L1 — generous; entries are single-digit MB
        l2=_l2_for_kind("cell_id_universe"),
        executor=writer,
        retention_resolver=_resolve_retention,
        immutable=True,
    )

    # Feature-explorer embedding frames. Immutable per (cache_ds, _, embedding_id,
    # parquet_uri) — the parquet URI is the load-bearing slot and content at a
    # URI is by-definition fixed. Cache entries are full pickled DataFrames
    # (single-digit MB up to ~200MB for a 500k-row embedding), so the maxsize
    # is conservative. A different parquet URI for the same embedding id
    # (e.g. after a feature recompute that rolls out a new file) routes to a
    # fresh entry; the old one orphans and ages out via bucket lifecycle.
    app.extensions["dcv_embedding_frame_cache"] = LayeredSwrCache(
        soft_ttl=soft_unique,
        hard_ttl=soft_unique,
        maxsize=32,
        l2=_l2_for_kind("embedding_frames"),
        executor=writer,
        retention_resolver=_resolve_retention,
        immutable=True,
    )

    # Datastack-info cache: long-TTL (24h via CACHE_INFO_TTL_SECONDS).
    # Holds the dict returned by `client.info.get_datastack_info()` per
    # datastack — aligned_volume, soma_table, synapse_table, viewer
    # resolution, viewer_site. These fields are stable properties of the
    # datastack and don't shift with mat_version, so a 24h TTL is the
    # right balance: long enough to be effectively cached across an
    # exploration session, bounded enough that an operator-level change
    # (rare; e.g. a renamed aligned_volume) propagates within a day.
    #
    # Plain `SwrCache` (no L2): payload is ~1KB so the GCS infrastructure
    # overhead isn't worth it. A pod restart pays one CAVE info-service
    # round-trip per datastack — sub-200ms — to refill.
    #
    # Materialization-version-dependent metadata (the `versions` list,
    # per-mat-version table list) lives on the short-TTL `table_meta_cache`
    # in `caches.py` instead — those genuinely shift on the order of hours
    # as new materializations roll over.
    from .services.swr import SwrCache
    soft_info = app.config["CACHE_INFO_TTL_SECONDS"]
    app.extensions["dcv_datastack_info_cache"] = SwrCache(
        soft_ttl=soft_info,
        hard_ttl=soft_info,
        maxsize=64,
    )

    # Feature-explorer manifest cache. Unlike the immutable caches above,
    # this one has real TTLs: soft is the freshness window (manifest edits
    # propagate within ~5 min via background SWR refresh), hard bounds how
    # long we'll serve stale data if refresh keeps failing. L1-only — the
    # manifest is small (single-digit kB) so the GCS infrastructure overhead
    # isn't worth it. Key shape: `(datastack,)` — the URI is a
    # deterministic function of CDV_FEATURE_TABLES_BASE_URI + the
    # datastack name, so we don't need to key on it.
    soft_manifest = app.config["CACHE_EMBEDDING_MANIFEST_SOFT_TTL_SECONDS"]
    hard_manifest = app.config["CACHE_EMBEDDING_MANIFEST_HARD_TTL_SECONDS"]
    app.extensions["dcv_embedding_manifest_cache"] = SwrCache(
        soft_ttl=soft_manifest,
        hard_ttl=hard_manifest,
        maxsize=64,
    )

    # Standardized feature-matrix cache. L1-only, immutable: a
    # (cache_ds, ft_id, feature_subset_digest) triple uniquely determines
    # the z-scored matrix + row→cell_id map (the parquet at a given URI is
    # fixed, the feature subset is the digest). The matrix isn't worth
    # serializing to L2 — the parquet itself is L2-backed via
    # dcv_embedding_frame_cache, and standardizing a cached frame is
    # fast (~10-50ms for 100k cells).
    app.extensions["dcv_embedding_matrix_cache"] = SwrCache(
        soft_ttl=0, hard_ttl=0, maxsize=32, immutable=True,
    )

    # SVD cache for PCA + Mahalanobis projections. Keyed on the same
    # (cache_ds, ft_id, feature_subset_digest) triple as the matrix cache
    # — one SVD per (table, subset), reused for any k_pca slice and for
    # full-whitening Mahalanobis. L1-only: the components matrix is
    # n_features^2 floats, negligible to refit from the cached matrix
    # (~5-50ms), and the matrix itself is the larger cache entry.
    app.extensions["dcv_embedding_pca_cache"] = SwrCache(
        soft_ttl=0, hard_ttl=0, maxsize=32, immutable=True,
    )

    # Per-column histogram summaries (numeric bin counts or categorical
    # per-value counts). Keyed on (cache_ds, ft_id, column, dec_tuple,
    # mat_version, n_bins). Tiny payload — hundreds of bytes per entry —
    # and immutable by construction, so this is the highest-value L2
    # cache in the feature explorer: every user opening the Selection
    # Builder on a popular column pays one ~30ms GCS read instead of
    # re-binning 94k values.
    app.extensions["dcv_column_histogram_cache"] = LayeredSwrCache(
        soft_ttl=soft_unique,
        hard_ttl=soft_unique,
        maxsize=512,
        l2=_l2_for_kind("column_histograms"),
        executor=writer,
        retention_resolver=_resolve_retention,
        immutable=True,
    )


def _wire_feature_tables_base_uri(app: Flask) -> None:
    """Wire the CDV_FEATURE_TABLES_BASE_URI env var into app.config.

    Feature-table catalog base URI. The loader joins this with
    "feature_tables/<datastack>/" to find a datastack's per-file FT
    YAMLs. Read once at boot; the manifest cache key is just
    `(datastack,)` because the URI is a deterministic function of
    this value + the datastack name.

    Default: the repo-root or wheel-bundled `config/` dir as a
    file:// URI. In Docker images this resolves to /app/config/;
    in a source install to <repo>/config/. Override at deploy time
    for production (`gs://<bucket>/`) or for bind-mount layouts
    (`file:///etc/cdv/`).
    """
    base_uri = os.environ.get("CDV_FEATURE_TABLES_BASE_URI")
    if not base_uri:
        # Use the bundled config dir (source install first, then wheel).
        from .services.datastack_config import _REPO_ROOT_CONFIG, _PACKAGED_CONFIG
        for candidate in (_REPO_ROOT_CONFIG, _PACKAGED_CONFIG):
            if candidate.is_dir():
                base_uri = f"file://{candidate}/"
                break
        else:
            base_uri = f"file://{_REPO_ROOT_CONFIG}/"
    if not base_uri.endswith("/"):
        base_uri += "/"
    app.config["FEATURE_TABLES_BASE_URI"] = base_uri


def _register_spa(app: Flask) -> None:
    """Serve the built React SPA for non-API routes when the build output
    is on disk.

    The Vite build produces `frontend/dist/` with `index.html` + an
    `assets/` subtree. In production (Docker) we copy that into the
    image and Flask serves it directly — same-origin with the API,
    which keeps the middle-auth cookie flow simple. In dev nobody has
    `frontend/dist/`, so this is a no-op and Vite's dev server (port
    5173, proxying `/api/*` to Flask on 5001) handles the SPA.

    Path resolution order: `CDV_SPA_DIR` env var → `frontend/dist`
    relative to CWD. The latter matches the dev repo layout when a
    developer runs `npm run build` for any reason.

    Routing:
      - `/<path>` returns the file at `frontend/dist/<path>` if it
        exists (covers `assets/*`, `vite.svg`, etc.).
      - Otherwise returns `index.html` so React Router can handle the
        client-side route (`/neuron/...`, `/table/...`, etc.).
      - `/api/*` is unaffected — Flask's URL matcher prefers the more
        specific blueprint route.

    Auth model — pattern borrowed from CAVEconnectome/Tourguide
    (`flask_app/api.py`):
      - SPA shell (`index.html`) is gated behind `@auth_required`. A
        user landing on a shared URL like `/neuron/864...` first hits
        middle-auth's redirect-to-login, signs in, and is bounced back
        to the same URL with a `middle_auth_token=...` query param.
        middle-auth-client cashes that into a cookie, redirects to the
        clean URL, and the SPA loads with the cookie set. Subsequent
        XHR calls to `/api/v1/...` carry the cookie automatically
        (same-origin).
      - Static assets (JS/CSS/icons referenced from index.html) are
        NOT auth-gated. Auth providers can't redirect-back through XHR
        asset loads — the redirect-and-callback flow only makes sense
        for top-level navigations. Asset requests carry the same cookie
        the original document carried, so they're effectively gated by
        the document's auth even without a per-request decorator.
      - Dev mode: `CDV_DEV_AUTH_BYPASS=1` makes `auth_required` a
        no-op (see `auth.py`), so local testing doesn't need a CAVE
        token in cookies.
    """
    spa_dir_str = os.environ.get("CDV_SPA_DIR") or "frontend/dist"
    spa_dir = Path(spa_dir_str).resolve()
    if not (spa_dir / "index.html").is_file():
        return  # dev mode — Vite serves the SPA

    # Auth-gated shell handler. Defined separately so the decorator only
    # wraps the index.html branch — assets stay public.
    @auth_required
    def _serve_spa_index():
        resp = send_from_directory(spa_dir, "index.html")
        # `index.html` references hashed asset filenames; the browser
        # MUST re-validate it on every load so a deploy that changes
        # those hashes is picked up immediately. Without this header,
        # browsers cache index.html (sometimes for hours) and continue
        # serving stale JS even after a docker push. The hashed assets
        # themselves are immutable per build, so they get cached long
        # by their default headers.
        resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        resp.headers["Pragma"] = "no-cache"
        resp.headers["Expires"] = "0"
        return resp

    @app.route("/", defaults={"path": ""})
    @app.route("/<path:path>")
    def _serve_spa(path: str):
        # Static assets get streamed straight off disk, no auth gate.
        # SPA history routes (no matching file) flow through the
        # auth-required shell handler so the user lands logged in.
        if path and (spa_dir / path).is_file():
            resp = send_from_directory(spa_dir, path)
            # Hashed bundles (e.g. assets/index-DzLY8k3E.js) are
            # immutable per build — content-addressed by Vite. Long
            # max-age is correct here; the index.html `no-cache` above
            # ensures clients pick up new hash references on each
            # navigation, so they fetch the new bundle URL anyway.
            if path.startswith("assets/"):
                resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
            return resp
        return _serve_spa_index()
