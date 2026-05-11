import logging
import threading
import time
from typing import Any

from cachetools import LRUCache


logger = logging.getLogger("cdv.cache")


class SwrCache:
    """Stale-while-revalidate cache.

    `get(key)` returns `(value, "fresh"|"stale")` if the entry is within hard TTL,
    `None` if absent or past hard TTL. Stale hits are the caller's signal to
    queue a background revalidation; the cached value is still served immediately.

    L1-only — values are stored as live Python objects, no serialization
    overhead. The L2 layer (when present, via `LayeredSwrCache`) does its
    own pickle round-trip in `GcsObjectStore`.
    """

    def __init__(
        self,
        *,
        soft_ttl: float,
        hard_ttl: float,
        maxsize: int = 1024,
        immutable: bool = False,
    ):
        self._cache: LRUCache = LRUCache(maxsize=maxsize)
        self._lock = threading.Lock()
        self.soft_ttl = soft_ttl
        self.hard_ttl = hard_ttl
        # Immutable mode: data is keyed by an invariant identifier (e.g.
        # mat_version) and is bit-identical across time. Skip soft/hard
        # TTL gating on read — every hit is "fresh" by construction. Used
        # for materialized synapse dataframes and per-cell soma summaries.
        # `soft_ttl` / `hard_ttl` are still required by the constructor
        # (kept for API uniformity) but never consulted in this mode;
        # callers may pass any value (e.g. 0).
        self.immutable = immutable

    def get(self, key: Any) -> tuple[Any, str] | None:
        with self._lock:
            entry = self._cache.get(key)
        if entry is None:
            return None
        value, fetched_at = entry
        if self.immutable:
            return value, "fresh"
        age = time.time() - fetched_at
        if age > self.hard_ttl:
            with self._lock:
                self._cache.pop(key, None)
            return None
        return value, ("fresh" if age <= self.soft_ttl else "stale")

    def get_with_layer(self, key: Any) -> tuple[Any, str, str] | None:
        """Like `get`, but returns `(value, freshness, layer)` so a caller
        timing the lookup can attribute the latency. `layer` is always
        `"l1"` here — the SwrCache itself has no L2; the field exists so
        consumers don't have to type-narrow between SwrCache and
        LayeredSwrCache (which overrides this and may return `"l2"`).
        """
        result = self.get(key)
        if result is None:
            return None
        value, freshness = result
        return value, freshness, "l1"

    def get_with_meta(self, key: Any) -> tuple[Any, float] | None:
        """Like `get`, but exposes the absolute `fetched_at` timestamp.

        Used by the poll endpoint to decide whether the cache entry is newer
        than a given ticket — independent of soft/hard TTL state.
        """
        with self._lock:
            entry = self._cache.get(key)
        if entry is None:
            return None
        value, fetched_at = entry
        if not self.immutable:
            age = time.time() - fetched_at
            if age > self.hard_ttl:
                with self._lock:
                    self._cache.pop(key, None)
                return None
        return value, fetched_at

    def get_full(self, key: Any) -> tuple[Any, str, float] | None:
        """Combined `get` + `get_with_meta`: returns `(value, freshness,
        fetched_at)` or None. Used by the live-mode delta path in
        `lookup_decorations`, which needs all three: freshness to decide
        whether to schedule a background refresh, and fetched_at to
        compute the get_delta_roots time window for targeted fill-in.
        Saves a second cache read.
        """
        with self._lock:
            entry = self._cache.get(key)
        if entry is None:
            return None
        value, fetched_at = entry
        if self.immutable:
            return value, "fresh", fetched_at
        age = time.time() - fetched_at
        if age > self.hard_ttl:
            with self._lock:
                self._cache.pop(key, None)
            return None
        return value, ("fresh" if age <= self.soft_ttl else "stale"), fetched_at

    def set(self, key: Any, value: Any) -> None:
        with self._lock:
            self._cache[key] = (value, time.time())

    def set_with_timestamp(self, key: Any, value: Any, fetched_at: float) -> None:
        """Set with an explicit `fetched_at`. Used by `LayeredSwrCache` to
        promote an L2 entry to L1 without resetting freshness — a 3-hour-old
        L2 snapshot must appear 3-hours-old on the new pod (potentially
        stale → schedules revalidation), not freshly minted.
        """
        with self._lock:
            self._cache[key] = (value, fetched_at)

    def __contains__(self, key: Any) -> bool:
        return self.get(key) is not None

    def clear(self) -> None:
        with self._lock:
            self._cache.clear()


class LayeredSwrCache:
    """SwrCache + optional GCS L2. Drop-in replacement for `SwrCache`.

    Read path: L1 first → L2 on miss → promote to L1 with the original
    `fetched_at` preserved (so freshness still reflects when CAVE was
    queried, not when this pod read from GCS).

    Write path: L1 synchronously, L2 via the supplied executor as a
    fire-and-forget job. Decoration mat caches use `RevalidationExecutor`
    (per-key dedup, app context); the executor's submit signature is
    `(key, fn)` so we namespace L2 writes under `("gcs_write", cache_key)`
    to avoid colliding with the executor's existing revalidation jobs.

    L2 can be:

    - ``None``: short-circuits to identical `SwrCache` semantics. Used
      when GCS isn't configured.
    - A bare `GcsObjectStore`: today's single-store path. All reads/writes
      go to that store.
    - A ``dict[str, GcsObjectStore]`` keyed by retention class
      (``"default"`` / ``"longlived"``) plus a ``retention_resolver(key)``
      callable. The resolver picks the inner store on every read/write,
      letting one cache instance route to different lifecycle partitions
      based on the key.

    The dict-with-resolver shape is the production path for decoration
    mat caches under retention classes. The bare-store shape is kept for
    backwards compatibility and for tests that don't care about
    retention dispatch.
    """

    def __init__(
        self,
        *,
        soft_ttl: float,
        hard_ttl: float,
        maxsize: int = 1024,
        l2=None,
        executor=None,
        retention_resolver=None,
        immutable: bool = False,
    ):
        self._l1 = SwrCache(
            soft_ttl=soft_ttl,
            hard_ttl=hard_ttl,
            maxsize=maxsize,
            immutable=immutable,
        )
        self._l2 = l2
        # `executor` must implement `submit(fn) -> Future` (e.g. a plain
        # `concurrent.futures.ThreadPoolExecutor`). L2 writes are
        # idempotent and need no app context — the original design's
        # use of `RevalidationExecutor` (with per-key dedup + Flask
        # context) was overhead for the L2-write path. Decoration
        # *revalidation* closures keep using `RevalidationExecutor`
        # directly via `DecorationService.executor`; only L2 writes
        # are routed through this simpler executor.
        self._executor = executor
        # When L2 is a dict-of-stores, the resolver is required to pick
        # which inner store to read from / write to. When L2 is a bare
        # store (or None), the resolver is unused.
        self._retention_resolver = retention_resolver
        self.soft_ttl = soft_ttl
        self.hard_ttl = hard_ttl
        self.immutable = immutable

    def _resolve_l2_store(self, key: Any):
        """Return the active L2 store for `key`, or None if no L2 is
        configured. Handles the three l2-shape cases (None, bare,
        dict-with-resolver)."""
        if self._l2 is None:
            return None
        if not isinstance(self._l2, dict):
            return self._l2
        # Dict-of-stores: consult the resolver. Defensive defaulting
        # to "default" if the resolver isn't set or raises — the worst
        # case is that an entry lands in the default partition, which
        # is the "today's behavior" path.
        retention_class = "default"
        if self._retention_resolver is not None:
            try:
                retention_class = self._retention_resolver(key) or "default"
            except Exception as exc:
                logger.warning(
                    "layered_retention_resolver_failed key=%r: %s: %s",
                    key, type(exc).__name__, exc,
                )
        return self._l2.get(retention_class) or self._l2.get("default")

    def _try_l2(self, key: Any) -> bool:
        """Check L2; on a within-TTL hit, promote to L1 preserving the
        original `fetched_at` and return True. Returns False when L2 is
        absent, the entry doesn't exist, or it's past hard_ttl.

        Defense in depth: `GcsObjectStore.get` already swallows internally,
        but we wrap anyway so any future L2 implementation that *does*
        raise still degrades to a miss instead of propagating an error
        through every cache reader.
        """
        store = self._resolve_l2_store(key)
        if store is None:
            return False
        try:
            result = store.get(key)
        except Exception as exc:
            logger.warning(
                "layered_l2_get_failed key=%r: %s: %s",
                key, type(exc).__name__, exc,
            )
            return False
        if result is None:
            return False
        value, fetched_at = result
        # Immutable mode: data never expires from the caller's POV — the
        # cache key already pins immutability invariants (e.g.
        # mat_version), so a hit is bit-identical to what the source
        # would return today. Skip the hard_ttl gate and let bucket
        # lifecycle be the single source of truth for L2 expiry.
        if not self.immutable and time.time() - fetched_at > self.hard_ttl:
            return False
        self._l1.set_with_timestamp(key, value, fetched_at)
        return True

    def get(self, key: Any) -> tuple[Any, str] | None:
        result = self._l1.get(key)
        if result is not None:
            return result
        if self._try_l2(key):
            return self._l1.get(key)
        return None

    def get_with_layer(self, key: Any) -> tuple[Any, str, str] | None:
        """Layer-aware variant of `get`. Returns `(value, freshness, layer)`
        where `layer` is `"l1"` for an in-memory hit and `"l2"` for a hit
        promoted from GCS this call. None on miss.

        Why callers want this: the L1 path is microseconds, the L2 path is
        a GCS round-trip (tens to hundreds of ms). Routing the same value
        through both indistinguishably hides where time went on a cold-pod
        warmup. Per-request timing instrumentation reads `layer` to pick
        between `<thing>_l1_hit` and `<thing>_l2_hit` stage labels.
        """
        result = self._l1.get(key)
        if result is not None:
            value, freshness = result
            return value, freshness, "l1"
        if self._try_l2(key):
            promoted = self._l1.get(key)
            if promoted is not None:
                value, freshness = promoted
                return value, freshness, "l2"
        return None

    def get_with_meta(self, key: Any) -> tuple[Any, float] | None:
        result = self._l1.get_with_meta(key)
        if result is not None:
            return result
        if self._try_l2(key):
            return self._l1.get_with_meta(key)
        return None

    def get_full(self, key: Any) -> tuple[Any, str, float] | None:
        result = self._l1.get_full(key)
        if result is not None:
            return result
        if self._try_l2(key):
            return self._l1.get_full(key)
        return None

    def set(self, key: Any, value: Any) -> None:
        self._l1.set(key, value)
        store = self._resolve_l2_store(key)
        if store is None:
            return
        fetched_at = time.time()
        executor = self._executor
        if executor is not None:
            # Default-arg-capture every variable — the late-binding bug
            # CLAUDE.md warns about applies here too. Plain
            # `executor.submit(fn)` signature: L2 writes are idempotent
            # and need no per-key dedup (writes for the same key produce
            # bit-identical bytes since the input value is the same).
            def _write(_store=store, _key=key, _value=value, _ts=fetched_at):
                _store.set(_key, _value, _ts)
            executor.submit(_write)
        else:
            store.set(key, value, fetched_at)

    def __contains__(self, key: Any) -> bool:
        return self._l1.__contains__(key)

    def clear(self) -> None:
        self._l1.clear()
