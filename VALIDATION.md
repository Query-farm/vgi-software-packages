# Verification record

## v0.2.0

Verified locally on macOS arm64, 2026-11-13, with the same TypeScript/Bun SDK and SQL-engine versions recorded below.

- `make check`: passed Biome, strict TypeScript, 55 unit/transport tests (291 assertions), starter SQL tests on all transports, 54 production SQL checks on each of stdio/launch/HTTP, and both metadata gates.
- `make test-duckdb`: passed 54 checks on stock DuckDB 2.0.0 using Query Farm VGI `e75482339d`.
- `make test-bundle`: passed 54 checks using the three standalone executables outside the source tree, including compiled index preparation.
- `bun run tests/software/live_additional.ts`: passed against Packagist, pub.dev, Hex, CRAN, Bioconductor, vcpkg, Homebrew casks, GHCR and GitLab. Full indexes were prepared within default request/byte/time budgets. Public vcpkg revision: `fe8e78fac7df2793f9848ed0d27aa59d9c035998`; Bioconductor release: 3.23.
- `actionlint` and `git diff --check`: passed.

The new tests preserve native dependency classes, vcpkg port revisions, feature/host/platform conditions, named filesystem baselines, pagination across empty match pages, separate API/OCI credentials, and transactional rollback after invalid registry metadata. Private access is tested with controlled credentials and SQL secrets. GHCR live image inspection is anonymous; its inventory API was confirmed to require authentication.

`make lint-ai LINT_ARGS="--ai-concurrency 4 --execute-concurrency 4"` passed for both workers at L3 semantic assurance: no errors or warnings, static score 100 and overall score 94. All 25 analyst tasks passed (14 package, 11 container). One pre-existing informational `sources.source_id` foreign-key heuristic remains per worker. The catalog documentation was expanded to resolve the AI review finding; no lint thresholds or waivers were weakened.

## v0.1.0 (historical verification)

Verified locally on macOS arm64, 2026-11-13. Implementation language: TypeScript, Bun 1.3.14.

Starter: https://github.com/Query-farm/vgi-starter-typescript at `145aedcb87ed8fadde6dfb8a26197d0d68112369`, version 1.3.0. The initialized starter's unmodified baseline `make check` passed before implementation. Resolved SDK: `@query-farm/vgi` 0.50.0, RPC 0.29.7, Arrow 21.1.1. The starter's SDK constraints remain unchanged.

| Command | Result |
| --- | --- |
| `make check` | Passed: Biome, strict TypeScript, 38 tests / 191 assertions, existing SQL suite on all three transports, production SQL suite, both metadata gates |
| `make test-duckdb` | Passed: 33 checks on stock DuckDB 2.0.0, VGI from `query_farm` |
| `make test-bundle` | Passed: three standalone executables copied outside the source tree; compiled index preparation and 33 SQL checks |
| `bun run tests/software/live.ts` | Passed: seven native package adapters, both registry search APIs, OCI manifests/platforms/configurations, Alpine and Homebrew index preparation/search |
| `git diff --check` | Passed |

Production SQL: 33 checks each over stdio, Unix-socket launch and HTTP with Haybarn 2.0.0rc11. The retained starter SQL tests executed 80 assertions on stdio, 80 on launch, and 43 on HTTP; no unexpected skips. The production suite exercises all 15 adapters, multi-batch pagination, typed fields, empty results, SQL-secret creation/removal, and explicit unsupported-operation errors.

Both workers scored 100/100 with L2 behavioral assurance in vgi-lint: no errors or warnings. Each has one informational suggestion about the `sources.source_id` primary key lacking a foreign key; this table is the referenced source authority. The initial implementation check did not run optional AI reviews; release validation below includes them.

Both SQL engines loaded VGI extension version `e75482339d`. Public-source queries were also run in stock DuckDB against the compiled executables, with this exact SQL after extension repository setup:

```sql
SET allow_extension_repositories = 'allowed';
CREATE EXTENSION REPOSITORY query_farm
  WITH PREFIX 'https://duckdb-extensions.query.farm';
INSTALL vgi FROM query_farm;
LOAD vgi FROM query_farm;

ATTACH 'packages' (TYPE vgi,
  LOCATION '/Users/rusty/Development/vgi-software-packages/dist/vgi-packages-worker');
ATTACH 'containers' (TYPE vgi,
  LOCATION '/Users/rusty/Development/vgi-software-packages/dist/vgi-containers-worker');

SELECT count(*) FROM packages.main.sources; -- 13
SELECT count(*) FROM containers.main.sources; -- 2
SELECT count(*) FROM packages.main.search('npm_public','typescript',5); -- 5
SELECT count(*) FROM containers.main.search('dockerhub_public','postgres',5); -- 5
```

Native Nix evaluation and binary Alpine v3 ADB decoding were not run because their optional external tools are absent; their JSON export paths are fixture-tested. Private authentication is verified against local fixtures, including real SQL secrets, rather than customer accounts. The initial implementation check supplied CI/release and Docker definitions without publishing; hosted release validation is recorded below. The tested standalone artifacts target the local host; cross-platform builds are configured in the release workflow.

## Release validation

Before tagging v0.1.0, `make check`, `make test-duckdb`, `make test-bundle` and `actionlint` passed. The updated agent reference queries were each executed three times and checked for stable results. Graders compare native package/image fields rather than changing observation timestamps.

`make lint-ai LINT_ARGS='--ai-concurrency 4 --execute-concurrency 4'` passed for both workers with **L3 semantic assurance**, no errors or warnings, and quality scores of **94/100** (static 100, agent 100, documentation quality 70). All **22 analyst tasks passed**: 12 package tasks and 10 container tasks. The informational primary-key suggestion remains unchanged.

Hosted [GitHub CI](https://github.com/Query-farm/vgi-software-packages/actions/runs/43376614922) passed for implementation commit `40bb1fcd96f9259e7d3fb4601bf491472127ec92`, including Windows/Linux SQL integration, Docker startup, metadata lint, production SQL and standalone artifacts. The [image publication workflow](https://github.com/Query-farm/vgi-software-packages/actions/runs/43376614909) also passed. Release preparation keeps the GitHub release in draft until all three programs' platform archives, checksums, signatures and provenance are uploaded.
