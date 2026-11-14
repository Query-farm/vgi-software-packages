# VGI software package and container workers

Two TypeScript workers expose package registries and OCI image metadata to SQL. Most public reads work anonymously; GHCR inventory metadata requires API credentials. Private sources can use optional source-scoped credentials. A separate maintenance command prepares searchable repository snapshots.

- `bin/vgi-packages-worker`: npm, PyPI, crates.io, Maven Central, NuGet, RubyGems, Go modules, Conda, Homebrew, Debian/APT, RPM repositories, Alpine, nixpkgs, Packagist, pub.dev, Hex, CRAN, Bioconductor and vcpkg.
- `bin/vgi-containers-worker`: Docker Hub and Quay search, GHCR owner and GitLab project inventories, plus OCI tags, manifests, platforms, layers and configuration.
- `bin/vgi-software-index`: prepare or inspect local SQLite indexes. Index maintenance is explicit; SQL searches never start a repository crawl.

## Run

Install Bun 1.3 or later, then run `make build`. Development wrappers require Bun; `make bundle` produces three standalone executables in `dist/`. The compiled workers do not require Bun or Node at runtime. Some index formats need optional tools described below.

With stock DuckDB 2.0.0:

```sql
SET allow_extension_repositories = 'allowed';
CREATE EXTENSION REPOSITORY query_farm
  WITH PREFIX 'https://duckdb-extensions.query.farm';
INSTALL vgi FROM query_farm;
LOAD vgi FROM query_farm;

ATTACH 'packages' (TYPE vgi,
  LOCATION '/absolute/path/to/vgi-packages-worker');
ATTACH 'containers' (TYPE vgi,
  LOCATION '/absolute/path/to/vgi-containers-worker');

SELECT * FROM packages.main.sources;
SELECT * FROM packages.main.capabilities;
SELECT * FROM packages.main.source_status;
SELECT name, version, description, score
FROM packages.main.search('npm_public', 'typescript', 25);
SELECT * FROM packages.main.dependencies('pypi_public', 'requests', '2.32.3');
SELECT name, description, stars
FROM containers.main.search('dockerhub_public', 'postgres', 25);
SELECT digest, os, architecture
FROM containers.main.platforms('quay_public', 'prometheus/prometheus', 'latest');
```

Replace the absolute paths for another installation. For the pinned Haybarn test engine, install VGI from `community` and use `LOAD vgi`. `LOCATION 'launch:/absolute/path/to/worker'` uses Unix sockets. Both workers also support `--http --host 127.0.0.1 --port 8000`; load `httpfs` before attaching an HTTP URL.

## SQL interface

Each worker has `sources`, `capabilities` and `source_status` tables, also callable with `()`. They expose configured endpoints, supported operations, authentication modes and index coverage. Native-source readiness reports adapter availability, not a live service health probe.

| Worker | Table function | Inputs |
| --- | --- | --- |
| packages | `search` | source ID, query, maximum results |
| packages | `package`, `versions` | source ID, native package name |
| packages | `artifacts`, `dependencies` | source ID, native package name, exact version |
| containers | `search` | source ID, query, maximum results |
| containers | `repository`, `tags` | source ID, namespace/repository |
| containers | `manifest`, `platforms`, `layers`, `configuration` | source ID, namespace/repository, tag or digest |

All non-search operations accept `max_results := 1000`. Limits must be 1–10,000. A row limit intentionally bounds the result; it is not a claim that all upstream rows were returned. Errors after partial batches fail the SQL statement; do not treat streamed partial rows as a successful complete scan.

Names and versions retain their native meaning. Maven uses `groupId:artifactId`; Go preserves module-path case and proxy escaping; nixpkgs uses attribute paths; OCI uses namespace/repository and immutable digests. No universal version comparison or dependency solver is provided. Nullable columns mean the upstream value is unavailable. `metadata` holds additional sanitized JSON. Artifact bytes and image layer payloads are never downloaded.

Resolve an image index using `platforms`, then pass a chosen platform digest to `layers` or `configuration`. Passing a multi-platform index to those functions fails with `PLATFORM_REQUIRED`. Manifest and configuration SHA256 values are checked against downloaded metadata. Tag discovery does not resolve every tag automatically.

The starter's `greet`, `sequence_table` and `fetch_items` examples remain in the package catalog, with their original tests, for starter compatibility.

## Source coverage and indexing

| Ecosystem | Search | Metadata and scope |
| --- | --- | --- |
| npm | Native | Registry search, packuments, dist-tags, artifacts, dependency categories and peer metadata |
| PyPI | Prepared name index | PEP 691 Simple JSON inventory; live Simple versions and Warehouse project/release JSON, per-file hashes/yanking, Requires-Dist declarations |
| crates.io | Native | Crates, versions, yanking, features, targets and optional dependencies |
| Maven Central | Native Solr | Coordinates and versions; repository POM metadata, packaging artifact and POM; unresolved parent/BOM properties remain explicit |
| NuGet | Native service-index discovery | Flat-container versions/artifacts and registration metadata; dependency groups preserve target frameworks |
| RubyGems | Native | Releases and platform variants; runtime/development requirements |
| Go modules | Prepared name index | Incremental public feed or imported inventory; exact metadata from configured module proxy, raw go.mod require/replace/exclude declarations |
| Conda | Prepared | Full repodata for one configured channel/subdir; `.conda` and `.tar.bz2`, builds, depends and constrains |
| Homebrew | Prepared | Formula and cask JSON; bottles/platforms and declared requirements; defaults `homebrew_public` and `homebrew_casks` |
| Debian/APT | Prepared | Release-selected Packages or Sources for one suite/component/architecture, SHA256 checks, alternative dependency groups |
| RPM | Prepared | repomd-selected primary XML, compressed-index checksum checks, epoch/version/release, architectures and dependency capabilities |
| Alpine | Prepared | v2 APKINDEX archive or v3 ADB export; architecture, native constraints and package hashes |
| nixpkgs | Prepared | Pinned 40-hex Git revision and system; evaluated attributes, metadata, derivation/output paths; dependencies explicitly unsupported |
| Docker Hub / Quay | Native | Provider search and repository metadata; OCI Distribution API for image inspection |
| Packagist | Native | Packagist search and full package API; Composer versions, source/dist references, platform requirements and dependency categories |
| pub.dev | Prepared name index | Complete paginated package-name feed; live Hosted Pub v2 versions, archives, retraction flags and pubspec dependencies |
| Hex | Native | Package search/releases, checksums, retirement and optional requirements; private repositories via `options.repository` |
| CRAN / Bioconductor | Prepared | CRAN-style `PACKAGES.gz` for one source repository; current versions, MD5 checksums and R dependency classes; Bioconductor default pins release 3.23 software (`bioc`) |
| vcpkg | Prepared | Pinned registry archive or local directory; ports, version history, baselines, features, platform conditions and host/target dependencies |
| GHCR | Scoped inventory | Name filtering within `options.owner`, with `owner_type: org` (default) or `user`; GitHub Packages API credentials required; known-image OCI inspection works without an owner setting |
| GitLab | Scoped inventory | Name filtering and repository metadata within `options.project` (ID or path); known-image OCI inspection works without a project setting |

Search order follows the native provider or local snapshot's deterministic name order. Provider scores are not comparable between registries. Index search is case-insensitive substring matching over the advertised fields. PyPI/Go/pub search names only. A source's `complete` flag means its configured input has been exhausted, not that all packages in the ecosystem are covered. Homebrew/R/distribution indexes represent currently published records rather than historical releases. Maven artifacts do not enumerate every classifier. NuGet package metadata selects the last registration entry; use versions for the release inventory. Private PyPI metadata requires a Warehouse-compatible JSON API in addition to a Simple index. Custom Packagist endpoints must implement the Packagist API; a generic Composer p2 repository alone is insufficient. Custom pub hosts need a compatible package-name inventory for search, or an imported complete inventory.

```sh
bin/vgi-software-index prepare alpine_public
bin/vgi-software-index status alpine_public
bin/vgi-software-index prepare homebrew_public
bin/vgi-software-index prepare homebrew_casks
bin/vgi-software-index prepare pub_public
bin/vgi-software-index prepare cran_public
bin/vgi-software-index prepare bioconductor_public
bin/vgi-software-index prepare vcpkg_public
# Go consumes one 2,000-event page per invocation, committing its checkpoint.
# Repeat prepare until complete=true; rerun later to discover newer events.
bin/vgi-software-index prepare go_public
```

`prepare SOURCE --input /absolute/path/to/export` imports the source's native format. Go accepts newline-delimited index events; nixpkgs accepts `nix-env -qa --json --meta` output; Alpine v3 accepts `apk adbdump --format json` output. Other sources accept the same JSON, XML, paragraph file or compressed index their adapter normally downloads. APT imports can be raw Packages/Sources or compressed files; Alpine v2 accepts APKINDEX text or `.tar.gz`.

Nix requires `options.revision` pinned to a full commit. Without `--input`, preparation invokes `nix-env -f <repository>/archive/<revision>.tar.gz -qa --json --meta --argstr system <system>`; install Nix and allow a sufficient timeout for evaluation. For authenticated/private Nix evaluation, supply an independently generated pinned export. Alpine v3 binary ADB preparation invokes an installed `apk` supporting `adbdump --format json`; JSON import works without it. XZ and bzip2 index compression require `xz` and `bzip2`; gzip and zstd are built in. No evaluator installs packages.

Snapshot replacement is transactional. Readers detect a changed snapshot between batches and fail with `SNAPSHOT_CHANGED`, so retry the query after a refresh. Empty replacements are rejected unless `options.allow_empty` is explicitly `"true"`. Source settings and credential identity partition caches; rotating credentials requires preparing a new private snapshot. SQLite files use mode 0600 and newly created cache directories use 0700.

## Configuration and optional authentication

vcpkg's public preset pins `fe8e78fac7df2793f9848ed0d27aa59d9c035998`; override `options.revision` to another full Git commit to refresh it. `prepare vcpkg_public --input /path/to/registry` reads a local Git checkout or filesystem registry containing `ports/` and `versions/`. Authenticate a private checkout with your Git tooling before importing, or configure an HTTPS archive with `index_url` and scoped credentials. Local inputs' revision labels are supplied by the caller. The worker reads manifests and version databases without running CMake or installing packages. `versions()` includes historical records for ports present in the snapshot; `dependencies()` describes only their current manifest and returns `VERSION_SCOPE` for older versions. Use `upstream#port-revision` as the exact version; revision zero is omitted, matching vcpkg notation. An explicit `#0` is also accepted. Artifacts describe recipes and Git tree identities, not a binary cache.

For a filesystem registry with version paths, set `options.format: "filesystem"` and optionally `options.baseline` (default `default`), then import its root directory. Version paths must use `$/` and remain inside that directory. These imports derive a content-hash revision; no Git commit is required.

CRAN and Bioconductor sources point directly at a `src/contrib` directory. To query Bioconductor annotation or experiment packages, configure separate sources for those components and preserve `options.release` and `options.component`. Package descriptions may be absent from native `PACKAGES` indexes; missing fields remain NULL. R archive inventories are outside the prepared snapshot. Pub imports use `{"packages":["name", ...],"nextUrl":null}` and must contain a complete supplied inventory.

GHCR and GitLab do not expose global keyword search through these adapters. Configure a GHCR owner or GitLab project, then `search()` filters names across that inventory's pages. Default unscoped sources advertise search as unsupported while allowing tags/manifests for known image names. For GHCR discovery, use a GitHub token with package-read access; OCI pulls may use a separate Basic username/token credential. GitLab private API reads use a Bearer token; private OCI reads can use Basic credentials with the token-service origin explicitly trusted. Examples are in `config.example.json`.

Set `VGI_SOFTWARE_CONFIG` to an absolute JSON file path **before starting the SQL engine or worker**. Without it, 24 source presets are available; indexed sources still need preparation, and hosted-container discovery needs an explicit scope. See [config.example.json](config.example.json). `include_defaults: true` merges custom sources by ID. Otherwise, `sources` replaces the presets. Override a preset by using its existing ID. The cache defaults to `~/.cache/vgi-software`, overridable with `VGI_SOFTWARE_CACHE` or `cache_dir`.

Each source has `id`, `kind`, `url`, optional `registry_url`, `index_url`, `allowed_origins`, `auth`, `registry_auth` and ecosystem-specific `options`. Options are string values. Common repository boundaries include `suite`, `component`, `architecture`, `subdir`, `channel`, `type`, `format`, `revision`, `system`, `since` and `index_ttl_seconds` (default 86400). `index_url` overrides the selected metadata location, which can bypass Release/repomd checksum discovery.

Authentication modes are `auto` (default), `anonymous` (ignore credentials) and `required` (fail when missing). Credentials are resolved in this order:

1. A `software_registry` SQL secret matching `source_id` and optional `purpose` (`api` or `registry`).
2. A configured `token_file`, `token_env`, or `password_env` reference.
3. Anonymous access, if allowed. A configured but missing credential fails explicitly.

```sql
-- After ATTACH has registered the secret type:
CREATE SECRET private_packages (
  TYPE software_registry,
  SOURCE_ID 'npm_private',
  TOKEN 'your-read-token',
  SCHEME 'bearer'
);
SELECT name FROM packages.main.search('npm_private', 'internal', 25);
DROP SECRET private_packages;
```

Use a secret manager or environment/file references for real credentials rather than storing literals in shared SQL. `scheme` supports `bearer`, `basic` (with `username`) and `token` (the complete Authorization header value). Docker Hub API tokens and OCI registry credentials can differ: use `auth` for the Hub API, `registry_auth` for the registry, and secret `purpose` to separate them. Docker Hub PAT/username credentials can use Basic for the OCI token exchange; Hub API access uses its API bearer token. Quay OAuth API tokens and robot registry credentials can likewise be separate.

`allowed_origins` controls which hosts may be fetched. It does **not** automatically authorize forwarding credentials. Credentials go to the primary API/registry origin and explicitly listed `auth.origins`/`registry_auth.origins`; `paths` optionally narrows them to URL path prefixes. OCI credentials are sent to a cross-origin token service only when explicitly trusted by `registry_auth.origins`. Default Docker Hub settings trust its official token service. Known metadata CDN origins are allowed for Docker Hub and Quay; redirects strip registry authorization before CDN requests. Add any deployment-specific CDN explicitly.

SQL secrets use the VGI secret channel. Credentials are excluded from serialized query state and are redacted from result metadata. HTTP caches and OCI tokens are partitioned by source and credentials. HTTP cache entries expire after 60 seconds by default; missing required credentials fail even if a prior request was cached. Upstream revocation of still-configured credentials can take until cache expiry to be observed.

Default per-query limits are 100 HTTP requests, 128 MiB received bytes, 30 seconds elapsed, three retries, and 60-second HTTP cache TTL. Retry-After, ETag revalidation, response streaming byte limits, origin checks and pagination-cycle checks are implemented. Imports/decompressed payloads have byte limits too; parsing may materialize a bounded JSON/XML document in memory. Large Conda/RPM catalogs and Nix evaluation often need larger administrator-configured budgets. Request/byte exhaustion fails explicitly. Cancellation stops future page requests; an in-flight VGI request is bounded by its configured timeout.

APT/RPM checksums detect inconsistent metadata downloads; repository signature verification and package installation are not implemented. Image inspection covers metadata, not image contents, vulnerability scanning or generated SBOMs.

## HTTP and containers

```sh
# Local HTTP servers use different ports.
bin/vgi-packages-worker --http --port 8000
bin/vgi-containers-worker --http --port 8001

# One Docker image contains both workers and the index CLI.
docker build -t vgi-software .
docker run --rm -p 8000:8000 vgi-software
# Select the container-image worker:
docker run --rm -e VGI_WORKER=containers -p 8001:8000 vgi-software
```

Mount configuration, credential files and a writable cache for persistent/private deployments. Set `VGI_SIGNING_KEY` consistently across HTTP replicas to preserve SDK state tokens across requests/restarts. Upstream registry credentials are separate from access control for the worker's HTTP endpoint; use authenticated ingress when hosting private sources. The Docker image includes XZ/bzip2, but Nix/apk tooling is optional and must be supplied when needed.

## Development and verification

The project uses the published [TypeScript starter](https://github.com/Query-farm/vgi-starter-typescript) at commit `145aedcb87ed8fadde6dfb8a26197d0d68112369` (starter 1.3.0). Its baseline `make check` passed before implementation. The SDK constraint remains `@query-farm/vgi ~0.50.0`, resolved to **0.50.0** in `bun.lock`; RPC is **0.29.7** and Arrow **21.1.1**. Starter tests and metadata gates remain enabled.

```sh
make check                 # formatting, types, unit/VGI tests, SQL on 3 transports, both metadata gates
make test-duckdb            # stock DuckDB 2.0.0, VGI from query_farm
make test-bundle            # compiled workers + index CLI, SQL outside the source tree
bun run tests/software/live.ts  # optional public-service smoke tests; network dependent
bun run tests/software/live_additional.ts # v0.2 upstream APIs and prepared indexes
```

Deterministic fixtures cover all 23 adapters plus separate Homebrew casks, native dependency conditions, more than one Arrow batch, empty results, pagination, source/credential cache isolation, retry/ETag/budgets, optional credentials, atomic snapshots and verified OCI descriptors. Production SQL tests use **Haybarn 2.0.0rc11** over stdio, launch and HTTP, plus a separate **stock DuckDB 2.0.0** run. SQL tests create/drop a source-scoped secret and verify access is withdrawn. `tests/software/verify_sql.py` contains the exact ATTACH and SELECT assertions.

Live smoke tests exercise the original package and container adapters plus the v0.2 APIs, full pub/CRAN/Bioconductor/vcpkg/cask preparation, GHCR anonymous image inspection and GitLab project discovery. GHCR inventory authentication is fixture-tested; the live inventory endpoint returns 401 without credentials. Nix evaluation and binary ADB decoding require their optional external tools; this environment tests their JSON export paths. The release workflow compiles all three programs; CI also runs production SQL and standalone-artifact verification. Release archives are available from https://github.com/Query-farm/vgi-software-packages/releases.

Upstream protocol references: [PyPI Simple](https://packaging.python.org/en/latest/specifications/simple-repository-api/), [NuGet API](https://learn.microsoft.com/en-us/nuget/api/overview), [Go proxy](https://go.dev/ref/mod#goproxy-protocol), [OCI Distribution](https://github.com/opencontainers/distribution-spec/blob/main/spec.md), [Docker Hub API](https://docs.docker.com/reference/api/hub/latest/), [Quay API](https://docs.projectquay.io/api_reference.html), [Alpine ADB schema](https://github.com/alpinelinux/apk-tools/blob/master/src/apk_adb.c).

## Support

Additional protocol references: [Packagist API](https://packagist.org/apidoc), [pub.dev API](https://pub.dev/help/api), [Hex endpoints](https://github.com/hexpm/specifications/blob/main/endpoints.md), [R package metadata](https://cran.r-project.org/doc/manuals/r-release/R-exts.html), [vcpkg registries](https://learn.microsoft.com/en-us/vcpkg/concepts/registries), [GitHub Packages API](https://docs.github.com/en/rest/packages/packages), [GitLab container API](https://docs.gitlab.com/api/container_registry/).

Report reproducible worker defects through the repository issue tracker. Include the worker version, ecosystem, transport and a sanitized query. Do not include credentials or private package metadata. Upstream registry availability and access permissions remain controlled by each provider.

## Executed notebooks

[Package and container metadata notebooks](notebooks/README.md) compare Python wheel inventories and resolve image platforms into ordered layer sizes using public registry metadata.
