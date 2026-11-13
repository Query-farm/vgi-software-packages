Adds Packagist, pub.dev, Hex, CRAN, Bioconductor and vcpkg to the TypeScript package worker, plus GHCR and GitLab to the container worker. Homebrew casks now have a default source alongside formulae.

- 19 package ecosystems and four container registry providers, with 24 default sources.
- vcpkg: pinned public registry, version/port-revision history, baselines, features, host/target declarations, and local Git/filesystem imports. Recipe metadata is indexed without executing builds. Historical dependency inspection requires preparing that historical snapshot.
- CRAN and Bioconductor: current repository package indexes, archive metadata and native R dependency classes. The Bioconductor preset pins release 3.23's software component.
- pub.dev: complete package-name inventory plus live Hosted Pub v2 metadata. Packagist and Hex use their native search and release APIs.
- GHCR and GitLab: name search within a configured owner/project, plus tags, manifests, platforms, layers and configurations for known images. GHCR inventory calls require API authentication; public OCI reads can remain anonymous.
- Optional source-scoped authentication continues to support SQL secrets and environment/file references, with separate API and OCI credentials.

Download each program needed for Linux x86-64, Linux arm64, macOS arm64 or Windows x86-64. The three standalone programs are `vgi-packages-worker`, `vgi-containers-worker` and `vgi-software-index`. Archives include checksums, signatures and build-provenance attestations.

Prepare indexed sources before searching. See README.md for source configuration and coverage boundaries, and VALIDATION.md for test evidence. Existing SQL function signatures remain compatible.

Validation: 55 unit/transport tests, 54 production SQL assertions per transport, stock DuckDB and standalone-binary checks, live upstream smoke tests, and L3 metadata lint for both workers. All 25 analyst tasks passed with no lint errors or warnings.
