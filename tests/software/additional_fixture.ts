import { gzipSync } from "node:zlib";
import type { Source } from "../../src/software/model.ts";

export const VCPKG_REVISION = "1234567890123456789012345678901234567890";
export const R_PACKAGES =
  "Package: demo\nVersion: 1.0\nTitle: Demo R package\nLicense: MIT\nImports: helper (>= 2.0), methods\nDepends: R (>= 4.4)\nLinkingTo: Rcpp\nSuggests: testthat\nOS_type: unix\nMD5sum: abc\nNeedsCompilation: yes\n\n";
export const VCPKG_FILES = new Map([
  ["versions/baseline.json", JSON.stringify({ default: { demo: { baseline: "1.0", "port-version": 2 } } })],
  [
    "versions/d-/demo.json",
    JSON.stringify({
      versions: [
        { version: "1.0", "port-version": 2, "git-tree": "a".repeat(40) },
        { "version-string": "old", "port-version": 0, "git-tree": "b".repeat(40) },
      ],
    }),
  ],
  [
    "ports/demo/vcpkg.json",
    JSON.stringify({
      name: "demo",
      version: "1.0",
      "port-version": 2,
      description: ["Demo library", "C++"],
      license: "MIT",
      supports: "!uwp",
      "default-features": ["ssl"],
      dependencies: ["zlib", { name: "vcpkg-cmake", host: true, platform: "windows", "version>=": "1.0" }],
      features: { ssl: { description: "TLS", dependencies: [{ name: "openssl", "default-features": false }] } },
    }),
  ],
]);
export function additionalSources(origin: string): Source[] {
  return [
    ...["packagist", "pub", "hex", "cran", "bioconductor"].map((kind) => ({
      id: `${kind}_test`,
      kind: kind as Source["kind"],
      url: `${origin}/${kind}`,
    })),
    { id: "vcpkg_test", kind: "vcpkg", url: `${origin}/vcpkg`, options: { revision: VCPKG_REVISION } },
    { id: "homebrew_casks_test", kind: "homebrew", url: `${origin}/homebrew`, options: { type: "cask" } },
    {
      id: "ghcr_test",
      kind: "ghcr",
      url: `${origin}/ghcr`,
      registry_url: `${origin}/oci`,
      options: { owner: "example" },
    },
    {
      id: "gitlab_test",
      kind: "gitlab",
      url: `${origin}/gitlab`,
      registry_url: `${origin}/oci`,
      options: { project: "example/project" },
    },
  ];
}

export function additionalResponse(
  request: Request,
  tar: (name: string, text: string) => Uint8Array,
): Response | undefined {
  const url = new URL(request.url),
    path = decodeURIComponent(url.pathname),
    page = Number(url.searchParams.get("page") ?? 1);
  const response = (value: unknown) => Response.json(value);
  if (path === "/packagist/search.json")
    return response({
      results: [{ name: "vendor/demo", description: "Demo Composer package" }],
      next: page === 1 ? `${url.origin}/packagist/search.json?page=2` : null,
    });
  if (path === "/packagist/packages/vendor/demo.json")
    return response({
      package: {
        name: "vendor/demo",
        description: "Demo Composer package",
        versions: {
          "1.0": {
            version: "1.0",
            license: ["MIT"],
            time: "2025-01-01T00:00:00Z",
            require: { php: ">=8.1", "vendor/helper": "^2" },
            "require-dev": { "phpunit/phpunit": "^10" },
            suggest: { "ext-json": "JSON support" },
            dist: { type: "zip", url: "https://example.org/demo.zip", shasum: "abc" },
            source: { type: "git", url: "https://example.org/demo.git", reference: "abc" },
          },
          "dev-main": { version: "dev-main" },
        },
      },
    });
  if (path === "/pub/api/package-names")
    return response({
      packages: [page === 1 ? "demo" : "helper"],
      nextUrl: page === 1 ? `${url.origin}/pub/api/package-names?page=2` : null,
    });
  if (path === "/pub-loop") return response({ packages: ["demo"], nextUrl: request.url });
  const pubVersion = {
    version: "1.0",
    pubspec: {
      name: "demo",
      description: "Demo Dart package",
      environment: { sdk: ">=3" },
      dependencies: { helper: "^2", flutter: { sdk: "flutter" } },
      dev_dependencies: { test: "^1" },
    },
    archive_url: "https://example.org/demo.tar.gz",
    archive_sha256: "abc",
    published: "2025-01-01T00:00:00Z",
    retracted: true,
  };
  if (path === "/pub/api/packages/demo")
    return response({ name: "demo", latest: pubVersion, versions: [pubVersion], isDiscontinued: true });
  if (path === "/pub/api/packages/demo/versions/1.0") return response(pubVersion);
  if (path === "/pub/api/packages/demo/versions/missing") return new Response("", { status: 404 });
  const hexPackage = {
    name: "demo",
    latest_stable_version: "1.0",
    meta: { description: "Demo Hex package", licenses: ["MIT"] },
    releases: [{ version: "1.0", retirement: { reason: "deprecated" } }],
  };
  if (path === "/hex/api/packages") return response([hexPackage]);
  if (path === "/hex/api/packages/demo") return response(hexPackage);
  if (path === "/hex/api/packages/demo/releases/1.0")
    return response({
      version: "1.0",
      checksum: "abc",
      meta: { elixir: "~>1.14" },
      requirements: { helper: { requirement: "~>2.0", optional: true, app: "helper" } },
    });
  if (path === "/hex/api/repos/private/packages/demo/releases/1.0")
    return request.headers.get("authorization") === "fixture-hex-token"
      ? response({ version: "1.0", requirements: {} })
      : new Response("", { status: 401 });
  if (path === "/cran/PACKAGES.gz" || path === "/bioconductor/PACKAGES.gz") return new Response(gzipSync(R_PACKAGES));
  if (path === `/vcpkg/archive/${VCPKG_REVISION}.tar.gz`)
    return new Response(
      gzipSync(Buffer.concat([...VCPKG_FILES].map(([name, text]) => tar(`vcpkg-${VCPKG_REVISION}/${name}`, text)))),
    );
  if (path === "/homebrew/api/cask.json")
    return response([
      {
        token: "demo-app",
        version: "1.0",
        desc: "Demo application",
        url: "https://example.org/demo.dmg",
        sha256: "abc",
        depends_on: { formula: ["helper"], macos: { ">=": ["12"] } },
      },
    ]);
  if (path === "/ghcr/orgs/example/packages" || path === "/gitlab/projects/example/project/registry/repositories") {
    // Exercise continuation across a full page containing no matching names.
    if (page === 1)
      return response(Array.from({ length: 100 }, (_, i) => ({ name: `other${i}`, path: `example/other${i}` })));
    return response([{ name: "demo", path: "example/demo", id: 42, project_id: 7, visibility: "public" }]);
  }
  if (path === "/ghcr/orgs/example/packages/container/demo")
    return response({ name: "demo", visibility: "public", repository: { full_name: "example/demo" } });
  if (path === "/ghcr/orgs/private/packages")
    return request.headers.get("authorization") === "Bearer fixture-api-token"
      ? response([{ name: "demo", visibility: "private" }])
      : new Response("", { status: 401 });
  return undefined;
}
