# Package registry and container metadata notebooks

1. [Python wheel inventory](01_python_wheel_inventory.ipynb) reads live pandas 2.2.3 artifact metadata from PyPI, separates filename tags in SQL and compares file counts and declared sizes for a selected CPython Python/ABI pair.
2. [Container platform and layers](02_container_platform_and_layers.ipynb) resolves an immutable Prometheus image index from Quay, selects a platform and examines ordered layer sizes and byte concentration. This uses the separate container worker shipped by the same repository.

## Run from this directory

Install [uv](https://docs.astral.sh/uv/). The notebook environment supports Python 3.13 or 3.14. Network access is required for dependencies, the published Haybarn/VGI extension, pinned native worker releases and public registry metadata. No local Bun/Node build, worker checkout, package install or container runtime is needed. A copy of this directory runs independently.

```bash
uv sync --frozen
uv run --frozen python execute.py
```

The literal SQL locations select the `vgi-packages-worker` and `vgi-containers-worker` prefixes of native release **v0.2.0** via `github-auto`. VGI chooses the host platform archive and verifies its published SHA256 sidecar. Both native launches were executed through published Haybarn **2.0.0rc11** on macOS arm64. The release also supplies Linux amd64/arm64 and Windows amd64 assets; those platforms were not executed here. Rerun both defaults and experiments after changing worker or engine pins.

For interactive use, register this environment and select it in Jupyter:

```bash
uv run --frozen python -m ipykernel install --user --name vgi-software-notebooks --display-name 'Python (software registry notebooks)'
```

Restart and run all after editing a parameter. Parameters, ATTACH and analytical SQL remain visible; Python configuration, plots, interpretation source and cleanup are folded. `execute.py` creates a temporary kernel with this directory as cwd, saves only after success and rejects overrides without a separate output directory, unknown parameter names and source-directory output destinations.

## Focused experiments

Run each notebook separately when supplying its own parameter:

```bash
uv run --frozen python execute.py 01_python_wheel_inventory.ipynb --parameters '{"CPYTHON_TAG":"cp312"}' --output-dir validation/cp312
uv run --frozen python execute.py 02_container_platform_and_layers.ipynb --parameters '{"ARCHITECTURE":"arm64"}' --output-dir validation/arm64
```

The package default is cp313. Selection requires an exact match in both Python and ABI filename fields and explicitly unyanked files. The chart counts each wheel file once even if its platform field contains several dotted aliases. The second chart displays the first alias; full filenames/tags and declared SHA256 metadata remain in the table. This is an artifact inventory, not an installer or dependency/compatibility solver. File sizes do not establish installed footprint, memory requirements or performance. Files and their hashes are not downloaded or verified.

The image default is linux/amd64; the experiment selects linux/arm64 from the same pinned index. The index digest was obtained from `prometheus/prometheus:v3.2.1` on 2026-11-14 and is recorded in [provenance.json](fixtures/provenance.json). SQL uses the immutable index digest, so subsequent movement of the tag does not redirect it. It displays the selected child digest before fetching its layer descriptors and verified configuration. The worker requires literal arguments; a small Python bridge copies the SQL-selected digest to the visible next query. No hidden Python retrieval or image inspection is performed.

The index descriptor size describes manifest JSON, not image payloads. Layer `size` is the declared compressed byte count. The worker verifies fetched manifests/configuration against SHA256 but does not fetch or verify layer payloads. The cumulative largest-first curve is an analytical concentration view, not a proposed download sequence or timing model. Cache reuse, parallelism, overhead and unpacked size are outside its scope. No package artifact or container image is installed or run.

## Live sources and checks

[PublicSources](notebook_support.py) uses the worker's supported JSON settings to isolate anonymous PyPI/Quay endpoints and an empty disposable cache. It restores inherited configuration and cache paths after closing the SQL connection. No private endpoints or credentials enter outputs. These notebooks perform real public reads and have no replay/fallback path. A required upstream failure fails execution and preserves the prior saved notebook. Rows carry observed UTC times, which describe retrieval rather than release upload time; the image figures also show the run start in UTC. Registry retention, metadata and yanking can change.

Worker calls are materialized before separate local display queries. Result limits are 1,000 rows, and checks fail if the bound is reached. Eleven package checks cover identity, exact tags, yanking, sizes, hashes and observation timestamps. Twelve image checks cover parent/child ownership, unique contiguous layer positions, configuration identity/rootfs count, bytes/MiB conversion and cumulative endpoints. Missing values are not replaced with zero. MiB means 2^20 bytes.

Official references: [PyPI JSON API](https://docs.pypi.org/api/json/), [wheel filename fields](https://packaging.python.org/en/latest/specifications/binary-distribution-format/#file-name-convention), [platform compatibility tags](https://packaging.python.org/en/latest/specifications/platform-compatibility-tags/), and [OCI image specification](https://github.com/opencontainers/image-spec). Source endpoints and exact provenance are bundled; no upstream response fixture is substituted for live execution.

The saved defaults embed outputs. Generated logs, images and separate experiments are ignored under `validation/`. Experiment copies include fixtures/provenance, branding, helper, runner and environment files. [STANDARD.md](STANDARD.md) records presentation conventions.

Source `make check` passed: 55 Bun tests; starter/recipe SQL assertions 80 stdio, 80 Unix-launch and 43 HTTP; 54 production SQL checks per transport across both workers; Biome and TypeScript gates. Both metadata catalogs score 100/100 L2 with zero errors/warnings and one existing informational source-ID foreign-key suggestion each; the repository's configured gate passes. No source code or root dependency locks were changed.
