# Feature-Table Discovery by Convention — Design

**Status:** draft for review
**Date:** 2026-05-18
**Scope:** Replace the per-datastack `feature_explorer.manifest_uri` field with a convention-based discovery rule rooted in a single env var. Make `source.uri` optional in the per-FT YAML so a co-located parquet doesn't need to be named. Drop the unused multi-datastack participation block. Make the Docker image work end-to-end without host-absolute paths in any committed YAML.

---

## Background

The Feature Explorer's per-file YAML catalog was migrated in commits `9fd9683` / `11a4f43` to schema v1 (one `FeatureTableSpec` per `.yaml`, directory-loaded). The migration left a tangled config surface:

- The datastack YAML carries an explicit `feature_explorer.manifest_uri` that operators must keep in sync with deployment storage. Two committed YAMLs currently have host-machine `file://` paths (`minnie65_phase3_v1.yaml` points at a developer's home directory) or stale references (`minnie65_public.yaml` points at `file:///tmp/cdv-embeddings/manifest.yaml`, a path no current script produces — the sample writer outputs `feature_tables/`, not a flat `manifest.yaml`).
- The `Dockerfile` bundles `config/` into `/app/config/` but the bundled datastack YAMLs reference host paths, so a `docker build && docker run` cannot serve a Feature Explorer page without YAML edits.
- The codebase still carries forward-looking multi-datastack participation machinery (`FeatureTableSpec.datastacks: list[DatastackEntry]`, the `effective_datastacks()` helper) that no committed YAML uses.
- Two scaffolders disagree on the on-disk shape: `make_sample_embedding.py` writes a per-file directory under `/tmp/cdv-embeddings/`; `scaffold_feature_explorer.py` writes a single file to `/tmp/manifest.yaml` (which also violates the basename-equals-id rule).
- Operators want to drop a (parquet, yaml) pair into GCS and have a running pod pick it up without a redeploy or a datastack-YAML edit.

This spec removes the per-datastack URI, fixes the host-path leakage, deletes unused schema fields, and writes a coherent doc story around one convention.

## Goals

- New feature tables are added by uploading a (parquet, yaml) pair into a per-datastack subdir of a deploy-time-fixed base URI. No datastack-YAML edits. No service redeploy.
- Local `docker build && docker run` serves the Feature Explorer against the bundled catalog without any committed YAML naming a host path.
- One env var configures the base URI for the whole deployment. Datastack YAMLs are deploy-portable.
- Schema is strictly smaller after the change.
- **Every committed YAML is reproducible from a scaffolder.** No more hand-authored config files. The scaffolders are the operator-facing authoring tools; they must produce output that matches what we'd hand-write.
- **Scaffolders pick filenames and paths.** The operator answers content questions (datastack name, parquet path, etc.); the scaffolder computes the output path from the convention. `--out` / `--outdir` become overrides for unusual cases (e.g. previewing into `/tmp`), not part of the common-case invocation. The script prints the computed path so the operator knows where it landed.

## Non-goals

- Changing the per-FT schema beyond making `source.uri` optional and removing the `datastacks:` block.
- Replacing the parquet loader, the SWR cache, or any cache lifecycle behavior.
- Changing the wire shape exposed to the frontend.
- A multi-datastack participation mechanism. Confirmed-out: drop the field. If real demand surfaces later, two cheap restorations exist (re-add the block, or extend `cache_alias` to also alias feature_tables); both are additive.
- Replacing `scaffold_feature_explorer.py` with `make_sample_embedding.py` or vice versa. Both stay; their output paths are aligned to the new convention.

## Architecture

### Configuration surface

One env var: **`CDV_FEATURE_TABLES_BASE_URI`**.

| Deployment | Value |
|---|---|
| Local source install | unset → defaults to repo's `config/` resolved as `file://<repo>/config/` |
| Local Docker (bundled-only) | unset → defaults to image's `/app/config/` as `file:///app/config/` |
| Local Docker (bind-mounted catalog) | `file:///etc/cdv/` |
| K8s production | `gs://cdv-cache/` |

**Convention:** the loader reads from `<base>/feature_tables/<datastack>/` for any datastack with `feature_explorer.enabled: true`.

**Datastack YAML's `feature_explorer` block shrinks to two fields:**

```yaml
feature_explorer:
  enabled: true
  cell_id_source_table: nucleus_detection_v0   # optional fallback
```

`manifest_uri` is removed from `FeatureExplorerConfig`. Adding a new datastack with feature data = creating the subdir; no datastack YAML edit.

### Per-FT YAML schema changes

Two changes to `FeatureTableSpec` (`cave_data_viewer/api/services/embeddings/manifest.py`):

1. **`source.uri` becomes optional.** When omitted, the loader fills it in from the YAML's URI prefix: for a `file://` base, this is the filesystem directory the YAML was loaded from; for `gs://` it's the URI prefix up to the last `/`. Either way, the default is `<yaml-prefix>/<id>.parquet`. When set explicitly, that wins. This is the multi-datastack-shared-parquet escape hatch — both datastacks' tiny YAMLs point `source.uri:` at one canonical parquet URL with zero data duplication.
2. **`datastacks:` block removed entirely.** Removes `DatastackEntry` model, `FeatureTableSpec.datastacks` field, `effective_datastacks()` helper, `_coerce_datastacks()`, and the related test surface. Each YAML belongs to exactly one datastack — the one whose subdir it lives in.

Everything else stays: filename basename equals `id`, `schema_version: 1`, embeddings, categories, scaling, clip, audit.

### Loader changes

`cave_data_viewer/api/services/embeddings/manifest.py`:

- Add `resolve_manifest_uri(base, datastack) -> str` joining `<base>/feature_tables/<datastack>/`.
- Update `fetch_and_parse_manifest()` so when `source.uri` is missing on a parsed FT, it's filled with the join of the YAML's resolved directory and `<id>.parquet`.
- Cache key in `dcv_embedding_manifest_cache` changes from `(datastack, manifest_uri)` to `(datastack,)` — the URI is now a deterministic function of the datastack name + the env var. `CDV_FEATURE_TABLES_BASE_URI` is read once at app boot into `app.config["FEATURE_TABLES_BASE_URI"]`; the cache assumes it is immutable for the lifetime of the process. (Restarting the pod is the way to change the base URI, which matches how the other config-dir env vars already work.)

`cave_data_viewer/api/services/datastack_config.py`:

- Remove `FeatureExplorerConfig.manifest_uri` field.
- Add app-config wiring in `create_app()` for `CDV_FEATURE_TABLES_BASE_URI` → `app.config["FEATURE_TABLES_BASE_URI"]`, with the default derived from `_REPO_ROOT_CONFIG` (source install) or `_PACKAGED_CONFIG` (wheel install), whichever exists, expressed as a `file://` URI.

### Docker

- Image continues to bundle `config/feature_tables/<ds>/` directories alongside `config/datastacks/` via hatchling `force-include`.
- `Dockerfile` adds:

  ```dockerfile
  RUN mkdir -p /etc/cdv/feature_tables
  # CDV_FEATURE_TABLES_BASE_URI intentionally unset — defaults to /app/config/.
  # Override at runtime: -e CDV_FEATURE_TABLES_BASE_URI=file:///etc/cdv/  or  gs://...
  ```

- No bind-mount or env override is required for the default "bundled catalog" run. The mount point exists for operators who want it.
- K8s helm sets `CDV_FEATURE_TABLES_BASE_URI=gs://<bucket>/`. The bundled catalog in the image is ignored at runtime.

### Migration

Backwards compatibility is not preserved (this is a pre-deployment refactor).

1. **Schema:**
   - Remove `FeatureExplorerConfig.manifest_uri`.
   - Remove `FeatureTableSpec.datastacks`, `DatastackEntry`, `effective_datastacks`, `_coerce_datastacks`.
   - Make `FeatureTableSourceRef.uri` optional; `FeatureTableSourceRef.kind` stays required.

2. **Committed YAMLs:**
   - `config/datastacks/minnie65_public.yaml`: drop `manifest_uri` from `feature_explorer`.
   - `config/datastacks/minnie65_phase3_v1.yaml`: drop `manifest_uri` from `feature_explorer`.
   - `config/feature_tables/minnie65_phase3_v1/microns_somadata_allcells_v661.yaml`: keep `source.uri` explicit. The 16MB Perisomatic parquet is gitignored at the repo root for local-dev use; it is NOT bundled into the Docker image. This YAML serves real-data flows on a developer laptop, not the Docker proving-ground run.

3. **Docker proving-ground catalog:**
   - `make_sample_embedding.py` is re-pointed at `<repo>/config/feature_tables/<datastack>/` and produces a tiny synthetic pair (`<id>.yaml` + `<id>.parquet`, ~1000 rows × a handful of columns). The synthetic parquet is small enough to commit (sub-100KB) and is removed from the `*.parquet` ignore rule for that subdirectory.
   - This synthetic catalog is what the Docker image bundles. `docker build && docker run` against either `minnie65_public` or `minnie65_phase3_v1` serves the synthetic feature table from the bundled `/app/config/feature_tables/`.
   - The dev-laptop Perisomatic catalog and the Docker proving-ground catalog co-exist without conflict: they live in the same directory but have different `id` values.

4. **Scaffolders.** Common invocation principle: the operator passes content args (datastack name, parquet path, feature-table id); the scaffolder computes the output path from the convention and writes there. `--out` exists only as an override for unusual destinations. Each script prints the resolved output path on success.
   - `scripts/scaffold_datastack.py`: already writes to `config/datastacks/<datastack>.yaml` from `--datastack`. Update the template to emit the new `cell_id_lookup: {kind, name}` block and the trimmed `feature_explorer: {enabled, cell_id_source_table}` block. `--public` and `--internal` toggle `live_mode` as today.
   - `scripts/make_sample_embedding.py`: takes `--datastack` (default `minnie65_public`), writes `config/feature_tables/<ds>/<sample-id>.yaml` and `config/feature_tables/<ds>/<sample-id>.parquet` (both committed; the sample is small). Drops the `--outdir` default and the `feature_explorer:` printout (no `manifest_uri` to print).
   - `scripts/scaffold_feature_explorer.py`: takes `--parquet` and `--datastack`; the interactive id-naming step computes the output path as `config/feature_tables/<ds>/<id>.yaml`. The filename-equals-id rule is enforced structurally — there is no `--out` flag in the common case, so the basename can't drift from `id`.
   - **New: `scripts/scaffold_aligned_volume.py`.** Takes `--name`; writes `config/aligned_volumes/<name>.yaml` as a heavily-commented skeleton. Operator fills in the spatial transform parameters (no useful introspection — coordinate transforms are domain knowledge, not detectable from a parquet). Pattern mirrors `scaffold_datastack.py`: every common knob shown, commented; defaults match the cortex-volume shape since that's the only registered provider today.

### Validation gate — rebuild-from-scratch

The implementation is not complete until **every committed YAML in `config/datastacks/`, `config/aligned_volumes/`, and `config/feature_tables/` can be regenerated by running the scaffolders.** This is the operator-workflow proving ground; it surfaces gaps in defaults, missing prompts, and documentation drift that a code-only diff won't catch.

The rebuild proceeds in this order, each step's output compared to the committed YAML before moving on:

1. **Aligned volumes** — `scripts/scaffold_aligned_volume.py --name minnie65_phase3` → manual fill of transform/layer/synapse fields → diff against `config/aligned_volumes/minnie65_phase3.yaml`. Differences land in either the scaffolder's skeleton or the committed YAML.
2. **Datastacks** — `scripts/scaffold_datastack.py --datastack minnie65_public --aligned-volume minnie65_phase3 --public` and `--datastack minnie65_phase3_v1 --internal`. Diff against committed YAMLs. The `cell_id_lookup` block (new shape from commit `91ce836`), `feature_explorer.enabled`, and `cache_alias` for `minnie65_public` all need scaffolder support.
3. **Synthetic feature table for Docker** — `scripts/make_sample_embedding.py --datastack minnie65_public` against an in-script generator → produces `<id>.yaml + <id>.parquet` in the convention path. Both files committed.
4. **Real-data feature table** — `scripts/scaffold_feature_explorer.py --parquet <path-to-perisomatic-parquet> --datastack minnie65_phase3_v1` → diff against the already-committed `microns_somadata_allcells_v661.yaml`. The depth-axis narrowing (`soma_depth_y` only, not all three) and category groupings are the interesting checks. The Perisomatic parquet is large (~16MB) and gitignored; developers obtain it out-of-band.
5. **End-to-end Docker run** — `docker build -t cdv . && docker run -p 8000:8000 -e CDV_DEV_AUTH_BYPASS=1 cdv`. Browse `/explore` for both datastacks; the synthetic feature table is served from the bundled catalog. Verify the explorer surfaces no host-path errors.

Each diff that surfaces a missing scaffolder feature gets fixed in the scaffolder before the migration is considered done.

5. **Docs:**
   - `docs/setting-up-a-datastack.md` §2 — rewrite around the convention; remove single-file shorthand from the primary path (still works, document briefly).
   - `docs/datastack-config.md` — update the `feature_explorer` row in the top-level structure table; update the `feature_explorer` field reference; remove `manifest_uri` row.
   - `docs/feature-explorer-plan.md` — light prose update to align with the new model.

6. **Loader + tests:**
   - Replace tests asserting `manifest_uri`-based discovery with tests asserting the convention join.
   - Add a test exercising `source.uri` default-fill.
   - Add a test asserting the loader works against a `file://` base in a `tmpdir`.

### Out of scope

- Replacing the per-FT YAML schema (still v1).
- Changing how parquets are loaded (`loader.py` untouched).
- Cache lifecycle, GCS L2 of decorations.
- Frontend changes — `manifest_uri` was never on the wire.
- The Helm chart. The chart bumps env var defaults but the chart change is downstream of this work.

## Open questions

None. All design decisions confirmed in brainstorming.
