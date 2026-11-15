# Package discovery and container identity

Read the saved notebooks on GitHub, or follow their **Open in Colab** links and Run All.
Each is independent and begins with its actual attached catalog's title and subtitle.

| Notebook | Question | Experiment |
|---|---|---|
| [01 · Python wheel inventory](01_python_wheel_inventory.ipynb) | What do exact Python/ABI filename tags and declared artifact sizes establish? | `CPYTHON_TAG="cp313"` → `"cp312"` |
| [02 · Container platform and layers](02_container_platform_and_layers.ipynb) | Which platform's ordered descriptors account for the image's compressed bytes? | `ARCHITECTURE="amd64"` → `"arm64"` |
| [03 · Discovery is not a dependency plan](03_discovery_is_not_a_dependency_plan.ipynb) | Does adapter support imply search readiness, and do release declarations identify installed dependencies? | `INCLUDE_EXTRAS=False` → `True` |
| [04 · A tag page is not an image identity](04_a_tag_page_is_not_an_image_identity.ipynb) | What can a bounded registry page tell us before resolving a mutable tag to a digest? | `TAG_LIMIT=8` → `16` |

The first two retain the original wheel and OCI byte-accounting analyses. The additional
stories separate discovery, native version/condition text and immutable identity.
All calls are anonymous **live public metadata reads**, with no recording or fallback.
An upstream failure fails the run and leaves the previous saved notebook intact.
No package artifact or layer payload is downloaded, installed or run.

## Shared setup and two entrypoints

The visible install cell pins [shared notebook tools v0.3.44](https://github.com/Query-farm/vgi-example-notebooks/tree/v0.3.44).
It installs only the base package in Colab and downloads the hash-verified
[public source helper](public_sources.py) and [provenance](fixtures/provenance.json).
Compatible preloaded libraries and kernel packages are preserved. Hosted Colab itself
has not been exercised; fresh preloaded Python 3.12 notebook-only runs check each native
launcher and the companion-download path. No Git checkout or Bun/Node build is needed.

The same repository ships two independent catalogs. SQL makes their choice explicit:

```sql
ATTACH 'packages' (TYPE vgi,
    LOCATION 'github-auto://Query-farm/vgi-software-packages@v0.2.0/vgi-packages-worker');
ATTACH 'containers' (TYPE vgi,
    LOCATION 'github-auto://Query-farm/vgi-software-packages@v0.2.0/vgi-containers-worker');
```

Books 01/03 attach only packages; 02/04 attach only containers. Native release **v0.2.0**
is selected by asset prefix, host platform and published SHA256 sidecar. Both paths run
through Haybarn **2.0.0rc11** / VGI **e75482339d** on macOS arm64. Other release platforms
were not executed here. Internet access is required for dependencies, extension, native
worker and public metadata. Revalidate after changing any release pin.

For local publication, install [uv](https://docs.astral.sh/uv/) and run from this directory:

```bash
uv sync --locked --extra runner
uv run --locked --extra runner vgi-notebooks
```

The locked environment supports Python 3.11–3.14. The optional `[runner]` dependency is
for local publication, not an in-notebook replacement of Colab's kernel. The shared runner
validates presentation and saves atomically after success. Parameters and analytical SQL
remain visible; plotting and interpretation source carry editor folding metadata.
SVG output stays native in Colab/Jupyter; default publication also links committed
content-addressed SVG assets for GitHub. Optional PNG review exports are ignored.

## Focused experiments

```bash
uv run --locked --extra runner vgi-notebooks 01_python_wheel_inventory.ipynb --parameters '{"CPYTHON_TAG":"cp312"}' --output-dir validation/cp312
uv run --locked --extra runner vgi-notebooks 02_container_platform_and_layers.ipynb --parameters '{"ARCHITECTURE":"arm64"}' --output-dir validation/arm64
uv run --locked --extra runner vgi-notebooks 03_discovery_is_not_a_dependency_plan.ipynb --parameters '{"INCLUDE_EXTRAS":true}' --output-dir validation/extras
uv run --locked --extra runner vgi-notebooks 04_a_tag_page_is_not_an_image_identity.ipynb --parameters '{"TAG_LIMIT":16}' --output-dir validation/tags16
```

Overrides require a separate destination. Unknown parameters, source-directory destinations
and invalid values fail without replacing previous successful outputs. Each experiment
keeps the acquisition and question explicit; live search/metadata may also change upstream.

## Provenance and limits

- **Wheels:** live PyPI `pandas` **2.2.3** artifact metadata. Selection requires exact Python
  and ABI fields and explicitly unyanked files. A dotted platform field counts as one file;
  the chart shows its first alias and the table retains all tags. Declared sizes and hashes
  do not establish installed footprint, compatibility, performance or payload integrity.
- **Dependencies:** npm supplies a bounded `apache-arrow` discovery page. PyPI supplies the
  current project record, native version strings, and exact 2.2.3 dependency declarations.
  The current project's Python requirement is not assigned to the older release. Marker
  text is classified, not evaluated; declarations and distinct package names have separate
  counts. This is neither a PEP 508 evaluator nor a dependency solver. Missing publication
  times/yanking fields remain NULL; no universal version ordering is invented.
- **Containers:** Quay `prometheus/prometheus:v3.2.1` resolved on **2026-11-14** to the index
  recorded in provenance. Book 02 uses that immutable digest; book 04 independently resolves
  the tag and compares it with the anchor, reporting a changed tag truthfully. The provenance
  file is a historical anchor, not a saved HTTP replay. Bounded search/tag pages are not
  complete inventories; absence from a page does not establish absence from the registry.
  The worker verifies fetched manifest/configuration SHA256, but layer sizes/hashes remain
  declarations. MiB = 2^20 bytes. Largest-first accumulation measures concentration, not
  download order, elapsed time, unpacked size or runtime behavior.

The helper supplies explicit anonymous PyPI/npm/Quay roots and an empty disposable cache.
Shared `connect(globals())` creates an empty temporary SQL-secret directory, disables
persistent secrets and default-INI autoload, and sets UTC at connection creation. Both
catalogs can resolve registry secrets at bind time, so this isolation also matters for
public reads. Every notebook drains an empty secret inventory before ATTACH and at cleanup;
none creates credentials. Cleanup closes SQL and removes temporary state, restoring the
inherited configuration/cache settings. Existing saved secrets are never read or altered.

All remote calls are materialized before local display queries. Result-derived prose and
SQL checks retain NULLs and distinguish retrieval from publication time. The original
stories contain 11 and 12 checks; the added discovery/identity stories contain 13 and 12.
This notebook-only migration reuses green source CI **43614741410**, rather than rebuilding
workers or rerunning source/container workflows. Source and root dependency locks are unchanged.

## Coverage evidence

[coverage-packages.json](coverage-packages.json) and
[coverage-containers.json](coverage-containers.json) retain complete, independent release
and current-public-main catalogs, native function/table/view exports, execution receipts
and editorial mappings. Same-named table/function aliases and overloads count once within
a catalog; identities are not merged across entrypoints.

- Packages: **8/11** logical surfaces, above the required **6/11**. The undemonstrated starter
  surfaces `greet`, `sequence_table` and `fetch_items` remain in the denominator, including
  the credential-capable API example.
- Containers: **10/10**, meeting the complete-coverage requirement for a ten-surface catalog.
- Aggregate: **18/21**, reported in addition to, never instead of, the independent thresholds.

Both released/current interfaces have the same logical names and native input signatures.
Examples execute v0.2.0; current-interface editorial compatibility does not claim current
main ran analytically. Native current-main exports are separate read-only catalog probes.
Full coverage rules and runner live in the [shared standard](https://github.com/Query-farm/vgi-example-notebooks/blob/v0.3.44/docs/standard.md).

References: [PyPI JSON API](https://docs.pypi.org/api/json/),
[wheel filename fields](https://packaging.python.org/en/latest/specifications/binary-distribution-format/#file-name-convention),
[dependency specifiers](https://packaging.python.org/en/latest/specifications/dependency-specifiers/),
and [OCI image specification](https://github.com/opencontainers/image-spec).
