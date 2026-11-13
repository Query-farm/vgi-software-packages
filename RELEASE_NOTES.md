Initial release of the TypeScript VGI software package and container workers.

- `vgi-packages-worker` searches npm, PyPI, crates.io, Maven Central, NuGet, RubyGems, Go modules, Conda, Homebrew, Debian/APT, RPM repositories, Alpine and pinned nixpkgs metadata.
- `vgi-containers-worker` searches Docker Hub and Quay and inspects OCI tags, manifests, platforms, layer descriptors and image configurations.
- `vgi-software-index` prepares and inspects scoped SQLite snapshots for indexed sources.
- Optional source-scoped authentication supports SQL secrets, environment variables and credential files, with separate API and registry credentials.
- Typed SQL discovery, bounded requests, pagination, checksum validation, credential-isolated caches and explicit index coverage are included.

Download the archive for each program you need and your platform: Linux x86-64, Linux arm64, macOS arm64 or Windows x86-64. Executables include the Bun runtime. Archives have SHA256 checksums, Sigstore bundles and GitHub build-provenance attestations.

Indexed sources require preparation. Nix evaluation needs Nix or an imported pinned JSON export. Alpine v3 ADB decoding needs compatible apk-tools or an imported JSON export. XZ/bzip2 indexes require those decompression tools. Dependencies retain native declarations; package installation, dependency solving and image layer downloads are outside this release.

Validation includes strict TypeScript/Biome checks, 38 unit/transport tests, real SQL on Haybarn 2.0.0rc11 over stdio/Unix sockets/HTTP, stock DuckDB 2.0.0, standalone artifact tests, and both workers' VGI metadata checks. See README.md for setup and VALIDATION.md for the verification record.

Both workers also passed L3 AI-assisted metadata lint with no errors or warnings; all 22 analyst tasks passed. Hosted CI passed on Linux and Windows, including Docker startup and standalone artifact SQL checks.
