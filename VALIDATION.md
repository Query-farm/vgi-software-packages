# Verification record

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

Both workers scored 100/100 with L2 behavioral assurance in vgi-lint: no errors or warnings. Each has one informational suggestion about the `sources.source_id` primary key lacking a foreign key; this table is the referenced source authority. Optional AI documentation/agent reviews were not run.

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

Native Nix evaluation and binary Alpine v3 ADB decoding were not run because their optional external tools are absent; their JSON export paths are fixture-tested. Private authentication is verified against local fixtures, including real SQL secrets, rather than customer accounts. CI/release and Docker definitions are supplied; no hosted CI run, Docker build, publication or deployment is claimed. The tested standalone artifacts target the local host; cross-platform builds are configured in the release workflow.
