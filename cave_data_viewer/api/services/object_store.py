"""GCS-backed bytes store for the L2 cache layer.

Used by `LayeredSwrCache` for L2 reads/writes. Pickles the body to
bytes — the L1 layer holds live Python objects, so the pickle round-
trip is L2-only.

Body format: a pickled `(value, fetched_at)` tuple. Storing the timestamp
inside the body keeps the read path to one round-trip and matches the
in-memory shape `SwrCache` uses for entries.

Failures never propagate. `get` returns None; `set` swallows. A
configured-but-unreachable bucket degrades to "L1-only" rather than 5xx-ing
every request, and the WARNING logs surface the issue to ops without
poisoning the user-facing path.

The GCS client is lazy-constructed on first use to avoid auth at import
time — local tests and CI builds without ADC don't need network or
credentials when the bucket isn't configured.
"""

from __future__ import annotations

import json
import logging
import pickle
import time
from typing import Any
from urllib.parse import quote

import yaml

logger = logging.getLogger("cdv.cache.gcs")
# Bump to INFO so the per-call breadcrumbs (`gcs_*_attempt` / `_ok` / `_miss`)
# are visible in gunicorn logs. Critical for diagnosing SIGILL / SIGKILL
# events where Python `except` can't catch the signal — the last logged
# `_attempt` line names the call that died. Tune down to WARNING once
# the L2 path is stable in production.
logger.setLevel(logging.INFO)


class GcsObjectStore:
    """Single-bucket pickle-bytes store keyed by tuple OR string.

    Decoration callers pass tuple keys like `(ds, mat_version, table)`;
    synapse callers pass the SHA1 hex string from `canonical_query_hash`.
    `_object_name` URL-encodes each tuple element so a partner table named
    e.g. `proofreading/status_v1` doesn't blow up the GCS path.
    """

    def __init__(self, bucket_name: str, prefix: str = "cache/", project: str | None = None):
        self._bucket_name = bucket_name
        self._prefix = prefix
        self._project = project
        self._client = None  # lazy

    def _lazy_client(self):
        if self._client is None:
            # Local import keeps `google.cloud.storage` off the import-time
            # graph for unconfigured deployments and tests.
            logger.info("gcs_client_init bucket=%s prefix=%s — importing google.cloud.storage", self._bucket_name, self._prefix)
            from google.cloud import storage
            logger.info("gcs_client_init bucket=%s — instantiating Client (project=%s)", self._bucket_name, self._project)
            # `project=None` falls back to ADC's embedded project; explicit
            # project (from `CDV_GCS_CACHE_PROJECT`) wins. Required when
            # ADC is end-user creds (no project) — service accounts always
            # carry one and don't need this override.
            self._client = storage.Client(project=self._project)
            logger.info("gcs_client_init bucket=%s — Client ready (project=%s)", self._bucket_name, self._client.project)
        return self._client

    def _object_name(self, key: Any) -> str:
        if isinstance(key, (tuple, list)):
            parts = [quote(str(p), safe="") for p in key]
        else:
            parts = [quote(str(key), safe="")]
        return self._prefix + "/".join(parts) + ".pkl"

    def get(self, key: Any) -> tuple[Any, float] | None:
        """Return `(value, fetched_at)` or None. Never raises.

        Routine cold-cache misses (404 / NotFound) are NOT logged as
        warnings — every cold pod start would otherwise spam the log.
        Other errors (auth, network, bucket missing) DO log so ops can
        spot misconfiguration.

        INFO-level logs bracket each call so a SIGKILL / SIGILL / OOM
        leaves a breadcrumb in the gunicorn log naming the last GCS
        call attempted — Python `except` can't catch process signals.
        """
        obj_name = self._object_name(key)
        logger.info("gcs_get_attempt bucket=%s obj=%s", self._bucket_name, obj_name)
        try:
            blob = self._lazy_client().bucket(self._bucket_name).blob(obj_name)
            data = blob.download_as_bytes()
        except Exception as exc:
            exc_name = type(exc).__name__
            if "NotFound" not in exc_name and "404" not in str(exc):
                logger.warning("gcs_get_failed obj=%s: %s: %s", obj_name, exc_name, exc)
            else:
                logger.info("gcs_get_miss obj=%s", obj_name)
            return None
        try:
            value, fetched_at = pickle.loads(data)
        except Exception as exc:
            logger.warning("gcs_get_unpickle_failed obj=%s: %s: %s", obj_name, type(exc).__name__, exc)
            return None
        logger.info("gcs_get_ok obj=%s bytes=%d age_s=%.1f", obj_name, len(data), time.time() - fetched_at)
        return value, fetched_at

    def set(self, key: Any, value: Any, fetched_at: float) -> None:
        """Write `(value, fetched_at)` as pickle. Swallows all errors."""
        obj_name = self._object_name(key)
        try:
            data = pickle.dumps((value, fetched_at), protocol=5)
        except Exception as exc:
            logger.warning("gcs_set_pickle_failed obj=%s: %s: %s", obj_name, type(exc).__name__, exc)
            return
        logger.info("gcs_set_attempt bucket=%s obj=%s bytes=%d", self._bucket_name, obj_name, len(data))
        try:
            blob = self._lazy_client().bucket(self._bucket_name).blob(obj_name)
            blob.upload_from_string(data, content_type="application/octet-stream")
        except Exception as exc:
            logger.warning("gcs_set_failed obj=%s: %s: %s", obj_name, type(exc).__name__, exc)
            return
        logger.info("gcs_set_ok obj=%s bytes=%d", obj_name, len(data))

    # ----- JSON helpers ------------------------------------------------------
    # Used for marker files (e.g. the longlived-versions registry) which
    # benefit from being inspectable with `gsutil cat | jq` rather than
    # opaque pickled bytes. Same swallow-errors discipline as the pickle
    # path: get returns None on any failure, set logs and returns. The
    # object name uses a literal filename (NOT key-tuple URL-encoding)
    # because callers pass full filenames like
    # `minnie65_public-longlived-versions.json`.

    def _json_object_name(self, filename: str) -> str:
        return self._prefix + filename

    def get_json(self, filename: str) -> dict | list | None:
        """Read a JSON object. Returns parsed value or None on missing/error.
        404/NotFound is silent (routine cold path); other errors warn."""
        obj_name = self._json_object_name(filename)
        logger.info("gcs_get_json_attempt bucket=%s obj=%s", self._bucket_name, obj_name)
        try:
            blob = self._lazy_client().bucket(self._bucket_name).blob(obj_name)
            data = blob.download_as_bytes()
        except Exception as exc:
            exc_name = type(exc).__name__
            if "NotFound" not in exc_name and "404" not in str(exc):
                logger.warning("gcs_get_json_failed obj=%s: %s: %s", obj_name, exc_name, exc)
            else:
                logger.info("gcs_get_json_miss obj=%s", obj_name)
            return None
        try:
            return json.loads(data.decode("utf-8"))
        except Exception as exc:
            logger.warning("gcs_get_json_parse_failed obj=%s: %s: %s", obj_name, type(exc).__name__, exc)
            return None

    def set_json(self, filename: str, value: dict | list) -> None:
        """Write `value` as JSON. Swallows all errors."""
        obj_name = self._json_object_name(filename)
        try:
            data = json.dumps(value, indent=2, sort_keys=True).encode("utf-8")
        except Exception as exc:
            logger.warning("gcs_set_json_serialize_failed obj=%s: %s: %s", obj_name, type(exc).__name__, exc)
            return
        logger.info("gcs_set_json_attempt bucket=%s obj=%s bytes=%d", self._bucket_name, obj_name, len(data))
        try:
            blob = self._lazy_client().bucket(self._bucket_name).blob(obj_name)
            blob.upload_from_string(data, content_type="application/json")
        except Exception as exc:
            logger.warning("gcs_set_json_failed obj=%s: %s: %s", obj_name, type(exc).__name__, exc)
            return
        logger.info("gcs_set_json_ok obj=%s bytes=%d", obj_name, len(data))

    # ----- YAML helpers ------------------------------------------------------
    # Mirror of the JSON helpers for YAML-shaped data (user recipes — see
    # services/recipes.py). YAML is the on-disk + on-wire representation for
    # personal recipes so the schema matches operator config in
    # `config/datastacks/<ds>.yaml` exactly. `safe_load` is the only line that
    # matters for security; `sort_keys=False` preserves the field order the
    # caller writes (recipes lead with version/id/title for human inspection).
    # `_json_object_name` is reused as-is — it just prepends the prefix and is
    # format-agnostic despite the historical name.

    def get_yaml(self, filename: str) -> dict | list | None:
        """Read a YAML object. Returns parsed value or None on missing/error.
        404/NotFound is silent (routine cold path); other errors warn."""
        obj_name = self._json_object_name(filename)
        logger.info("gcs_get_yaml_attempt bucket=%s obj=%s", self._bucket_name, obj_name)
        try:
            blob = self._lazy_client().bucket(self._bucket_name).blob(obj_name)
            data = blob.download_as_bytes()
        except Exception as exc:
            exc_name = type(exc).__name__
            if "NotFound" not in exc_name and "404" not in str(exc):
                logger.warning("gcs_get_yaml_failed obj=%s: %s: %s", obj_name, exc_name, exc)
            else:
                logger.info("gcs_get_yaml_miss obj=%s", obj_name)
            return None
        try:
            return yaml.safe_load(data.decode("utf-8"))
        except Exception as exc:
            logger.warning("gcs_get_yaml_parse_failed obj=%s: %s: %s", obj_name, type(exc).__name__, exc)
            return None

    def set_yaml(self, filename: str, value: dict | list) -> None:
        """Write `value` as YAML. Swallows all errors."""
        obj_name = self._json_object_name(filename)
        try:
            data = yaml.safe_dump(
                value, sort_keys=False, default_flow_style=False
            ).encode("utf-8")
        except Exception as exc:
            logger.warning("gcs_set_yaml_serialize_failed obj=%s: %s: %s", obj_name, type(exc).__name__, exc)
            return
        logger.info("gcs_set_yaml_attempt bucket=%s obj=%s bytes=%d", self._bucket_name, obj_name, len(data))
        try:
            blob = self._lazy_client().bucket(self._bucket_name).blob(obj_name)
            blob.upload_from_string(data, content_type="application/yaml")
        except Exception as exc:
            logger.warning("gcs_set_yaml_failed obj=%s: %s: %s", obj_name, type(exc).__name__, exc)
            return
        logger.info("gcs_set_yaml_ok obj=%s bytes=%d", obj_name, len(data))

    def list_yaml(self, prefix_within_store: str) -> list[dict | list]:
        """List all `.yaml` objects under `<self._prefix><prefix_within_store>`.
        Returns parsed values; silently drops objects that fail to parse.
        Returns [] on any list-API failure."""
        full_prefix = self._prefix + prefix_within_store
        logger.info("gcs_list_yaml_attempt bucket=%s prefix=%s", self._bucket_name, full_prefix)
        try:
            blobs = list(
                self._lazy_client()
                .bucket(self._bucket_name)
                .list_blobs(prefix=full_prefix)
            )
        except Exception as exc:
            logger.warning("gcs_list_yaml_failed prefix=%s: %s: %s", full_prefix, type(exc).__name__, exc)
            return []
        out: list[dict | list] = []
        for blob in blobs:
            if not blob.name.endswith(".yaml"):
                continue
            try:
                parsed = yaml.safe_load(blob.download_as_bytes().decode("utf-8"))
            except Exception as exc:
                logger.warning("gcs_list_yaml_item_failed obj=%s: %s: %s", blob.name, type(exc).__name__, exc)
                continue
            if parsed is not None:
                out.append(parsed)
        logger.info("gcs_list_yaml_ok prefix=%s n=%d", full_prefix, len(out))
        return out

    def delete(self, filename: str) -> None:
        """Delete a single object by filename. Silent on NotFound; warns on
        other errors. Always returns None — callers that want idempotent
        DELETE semantics get them for free."""
        obj_name = self._json_object_name(filename)
        logger.info("gcs_delete_attempt bucket=%s obj=%s", self._bucket_name, obj_name)
        try:
            self._lazy_client().bucket(self._bucket_name).blob(obj_name).delete()
        except Exception as exc:
            exc_name = type(exc).__name__
            if "NotFound" not in exc_name and "404" not in str(exc):
                logger.warning("gcs_delete_failed obj=%s: %s: %s", obj_name, exc_name, exc)
            else:
                logger.info("gcs_delete_miss obj=%s", obj_name)
            return
        logger.info("gcs_delete_ok obj=%s", obj_name)


_KINDS: tuple[str, ...] = (
    "num_soma",
    "table",
    "synapse",
    "spatial_features",
    "unique_values",
    # NOTE: embedding frames are intentionally NOT here. Their source is
    # already a static, in-region GCS parquet, so the per-pod L1 cache
    # (`dcv_embedding_frame_cache`, a plain SwrCache) is enough — an L2
    # mirror would be a redundant second bucket copy. See the cache's
    # construction in api/__init__.py.
    # Full materialized cell_id ↔ root_id universe for one
    # (datastack, mat_version). Pickled `CellUniverse` dataclass —
    # two dense dicts of ~low-six-digits of int→int pairs, single-
    # digit MB total. Immutable per (ds, mv) by construction:
    # materializations are frozen, so this cache effectively never
    # expires while the mat_version is current. First-pod-on-a-new-
    # mat_version pays the CAVE round-trip; all subsequent pods +
    # users hit warm.
    "cell_id_universe",
    # Tiny histogram summary of one feature column (bin counts +
    # min/max for numeric; per-value counts for categorical). A
    # hundred-ish bytes per entry; immutable per (ds, ft, column,
    # dec, mv, bins) since the parquet content is pinned by URI and
    # decoration snapshots are pinned by mat_version. Heavily shared:
    # every user opening the Selection Builder on the same column
    # hits the same entry, so the first user warms the cache and the
    # rest read for the cost of a single small GCS object fetch.
    "column_histograms",
)
_RETENTION_CLASSES: tuple[str, ...] = ("default", "longlived")


def build_l2_stores(app) -> dict[str, dict[str, GcsObjectStore]]:
    """Return a 2-level dict of named GCS stores per (retention_class, kind),
    or ``{}`` if ``GCS_CACHE_BUCKET`` is unset.

    Layout:
    ::

        {
            "default":   {"cell_type": Store, "num_soma": Store, ...},
            "longlived": {"cell_type": Store, "num_soma": Store, ...},
        }

    Each store's prefix is ``<GCS_CACHE_PREFIX><retention_class>/<kind>/``,
    e.g. ``cache/default/cell_type/`` or ``cache/longlived/synapse/``.
    Retention class as the **outermost** path component lets the bucket's
    lifecycle rules scope to one prefix per class
    (``matchesPrefix: ["cache/default/"]`` etc.).

    `GCS_CACHE_PROJECT` (when set) flows into every store's `Client`
    constructor as the billing/quota project. Necessary for end-user
    ADC; ignored when not set (the client falls back to whatever the
    auth identity carries).
    """
    bucket = app.config.get("GCS_CACHE_BUCKET")
    if not bucket:
        return {}
    prefix = app.config.get("GCS_CACHE_PREFIX") or "cache/"
    if not prefix.endswith("/"):
        prefix = prefix + "/"
    project = app.config.get("GCS_CACHE_PROJECT")
    return {
        retention: {
            kind: GcsObjectStore(
                bucket,
                prefix=f"{prefix}{retention}/{kind}/",
                project=project,
            )
            for kind in _KINDS
        }
        for retention in _RETENTION_CLASSES
    }


def build_info_store(app) -> GcsObjectStore | None:
    """Build a store rooted at `<prefix>info/` for marker files (longlived-
    versions registry, etc.). Lives outside both retention-class subtrees
    so the lifecycle rules don't sweep it. Returns None when GCS is not
    configured."""
    bucket = app.config.get("GCS_CACHE_BUCKET")
    if not bucket:
        return None
    prefix = app.config.get("GCS_CACHE_PREFIX") or "cache/"
    if not prefix.endswith("/"):
        prefix = prefix + "/"
    project = app.config.get("GCS_CACHE_PROJECT")
    return GcsObjectStore(bucket, prefix=f"{prefix}info/", project=project)


def build_userdata_store(app) -> GcsObjectStore | None:
    """Build a store rooted at `<prefix>userdata/` for per-user JSON/YAML
    state (currently: personal recipes — see services/recipes.py).

    Sibling of `info/` and the `cache/<retention>/` trees; explicitly OUTSIDE
    the lifecycle-rule scope. The bucket setup script's lifecycle rules use
    exact `matchesPrefix` for `cache/default/` and `cache/longlived/`, so
    `userdata/` is exempt — but a future operator widening those prefixes
    would silently delete user recipes. See scripts/setup_local_cache_bucket.sh
    for the warning. Returns None when GCS is not configured."""
    bucket = app.config.get("GCS_CACHE_BUCKET")
    if not bucket:
        return None
    prefix = app.config.get("GCS_CACHE_PREFIX") or "cache/"
    if not prefix.endswith("/"):
        prefix = prefix + "/"
    project = app.config.get("GCS_CACHE_PROJECT")
    return GcsObjectStore(bucket, prefix=f"{prefix}userdata/", project=project)
