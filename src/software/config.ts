import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONTAINER_KINDS, PACKAGE_KINDS, RegistryError, type Settings, type Source } from "./model.ts";

export const DEFAULT_SOURCES: Source[] = [
  { id: "npm_public", kind: "npm", url: "https://registry.npmjs.org" },
  { id: "pypi_public", kind: "pypi", url: "https://pypi.org", index_url: "https://pypi.org/simple/" },
  { id: "crates_public", kind: "crates", url: "https://crates.io" },
  {
    id: "maven_public",
    kind: "maven",
    url: "https://search.maven.org",
    registry_url: "https://repo.maven.apache.org/maven2",
    allowed_origins: ["https://repo.maven.apache.org"],
  },
  {
    id: "nuget_public",
    kind: "nuget",
    url: "https://api.nuget.org/v3/index.json",
    allowed_origins: [
      "https://azuresearch-usnc.nuget.org",
      "https://azuresearch-ussc.nuget.org",
      "https://api.nuget.org",
    ],
  },
  { id: "rubygems_public", kind: "rubygems", url: "https://rubygems.org" },
  {
    id: "go_public",
    kind: "go",
    url: "https://proxy.golang.org",
    index_url: "https://index.golang.org/index",
    allowed_origins: ["https://index.golang.org"],
  },
  {
    id: "conda_public",
    kind: "conda",
    url: "https://conda.anaconda.org/conda-forge/linux-64",
    options: { subdir: "linux-64", channel: "conda-forge" },
  },
  { id: "homebrew_public", kind: "homebrew", url: "https://formulae.brew.sh", options: { type: "formula" } },
  { id: "homebrew_casks", kind: "homebrew", url: "https://formulae.brew.sh", options: { type: "cask" } },
  { id: "packagist_public", kind: "packagist", url: "https://packagist.org" },
  { id: "pub_public", kind: "pub", url: "https://pub.dev" },
  {
    id: "hex_public",
    kind: "hex",
    url: "https://hex.pm",
    registry_url: "https://repo.hex.pm",
    auth: { scheme: "token" },
  },
  { id: "cran_public", kind: "cran", url: "https://cran.r-project.org/src/contrib" },
  {
    id: "bioconductor_public",
    kind: "bioconductor",
    url: "https://bioconductor.org/packages/3.23/bioc/src/contrib",
    options: { release: "3.23", component: "bioc" },
    allowed_origins: ["https://bioconductor.posit.co", "https://mghp.osn.xsede.org"],
  },
  {
    id: "vcpkg_public",
    kind: "vcpkg",
    url: "https://github.com/microsoft/vcpkg",
    options: { revision: "fe8e78fac7df2793f9848ed0d27aa59d9c035998" },
    allowed_origins: ["https://codeload.github.com"],
  },
  {
    id: "apt_public",
    kind: "apt",
    url: "https://deb.debian.org/debian",
    options: { suite: "stable", component: "main", architecture: "amd64" },
  },
  {
    id: "rpm_public",
    kind: "rpm",
    url: "https://dl.fedoraproject.org/pub/fedora/linux/development/rawhide/Everything/x86_64/os",
    options: { architecture: "x86_64" },
    allowed_origins: ["https://download.fedoraproject.org"],
  },
  {
    id: "alpine_public",
    kind: "alpine",
    url: "https://dl-cdn.alpinelinux.org/alpine/latest-stable/main/x86_64",
    options: { architecture: "x86_64", format: "v2" },
  },
  {
    id: "nixpkgs_public",
    kind: "nixpkgs",
    url: "https://github.com/NixOS/nixpkgs",
    options: { system: "x86_64-linux" },
  },
  {
    id: "dockerhub_public",
    kind: "dockerhub",
    url: "https://hub.docker.com",
    registry_url: "https://registry-1.docker.io",
    registry_auth: { origins: ["https://auth.docker.io"] },
    allowed_origins: [
      "https://registry-1.docker.io",
      "https://auth.docker.io",
      "https://production.cloudfront.docker.com",
      "https://production.cloudflare.docker.com",
    ],
  },
  {
    id: "quay_public",
    kind: "quay",
    url: "https://quay.io",
    registry_url: "https://quay.io",
    allowed_origins: ["https://cdn01.quay.io", "https://cdn02.quay.io", "https://cdn03.quay.io"],
  },
  {
    id: "ghcr_public",
    kind: "ghcr",
    url: "https://api.github.com",
    registry_url: "https://ghcr.io",
    allowed_origins: ["https://pkg-containers.githubusercontent.com"],
  },
  {
    id: "gitlab_public",
    kind: "gitlab",
    url: "https://gitlab.com/api/v4",
    registry_url: "https://registry.gitlab.com",
    registry_auth: { origins: ["https://gitlab.com"] },
    allowed_origins: ["https://cdn.registry.gitlab-static.net"],
  },
];

export function loadSettings(filename = process.env.VGI_SOFTWARE_CONFIG): Settings {
  const data = filename
    ? (JSON.parse(readFileSync(filename, "utf8")) as Partial<Settings> & { include_defaults?: boolean })
    : {};
  const sources = data.sources ?? DEFAULT_SOURCES;
  const combined = data.include_defaults
    ? [...DEFAULT_SOURCES.filter((s) => !sources.some((x) => x.id === s.id)), ...sources]
    : sources;
  const ids = new Set<string>();
  for (const source of combined) {
    if (!/^[a-zA-Z0-9_-]+$/.test(source.id) || ids.has(source.id))
      throw new RegistryError("CONFIG", "Source IDs must be unique identifiers");
    ids.add(source.id);
    if (![...PACKAGE_KINDS, ...CONTAINER_KINDS].includes(source.kind))
      throw new RegistryError("CONFIG", `Unknown ecosystem for ${source.id}`);
    for (const value of [source.url, source.index_url, source.registry_url, ...(source.allowed_origins ?? [])].filter(
      Boolean,
    )) {
      const url = new URL(value as string);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
        throw new RegistryError("CONFIG", `Use HTTP URLs without embedded credentials for ${source.id}`);
    }
    for (const auth of [source.auth, source.registry_auth]) {
      for (const origin of auth?.origins ?? []) {
        const parsed = new URL(origin);
        if (parsed.origin !== origin || !["http:", "https:"].includes(parsed.protocol))
          throw new RegistryError("CONFIG", "Credential origins must be HTTP origins without paths");
      }
      if (auth?.paths?.some((path) => !path.startsWith("/") || path.includes("..")))
        throw new RegistryError("CONFIG", "Credential paths must be absolute URL path prefixes");
      if (auth?.mode && !["anonymous", "auto", "required"].includes(auth.mode))
        throw new RegistryError("CONFIG", "Invalid authentication mode");
      if (auth?.scheme && !["bearer", "basic", "token"].includes(auth.scheme))
        throw new RegistryError("CONFIG", "Invalid credential scheme");
    }
  }
  const limits = {
    requests: 100,
    bytes: 128 * 1024 * 1024,
    timeout_ms: 30_000,
    retries: 3,
    cache_seconds: 60,
    ...data.limits,
  };
  for (const [key, value] of Object.entries(limits))
    if (!Number.isSafeInteger(value) || value < (key === "retries" || key === "cache_seconds" ? 0 : 1))
      throw new RegistryError("CONFIG", `Invalid limit ${key}`);
  return {
    sources: combined,
    cache_dir: data.cache_dir ?? process.env.VGI_SOFTWARE_CACHE ?? join(homedir(), ".cache", "vgi-software"),
    limits,
  };
}
export function sourceById(settings: Settings, id: string): Source {
  const source = settings.sources.find((s) => s.id === id);
  if (!source) throw new RegistryError("UNKNOWN_SOURCE", `No configured source named ${id}`);
  return source;
}
