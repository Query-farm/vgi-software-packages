import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { digest, Http } from "../../src/software/http.ts";
import { prepareIndex } from "../../src/software/indexes.ts";
import type { Settings, Source } from "../../src/software/model.ts";

export const NIX_REVISION = "1234567890123456789012345678901234567890";
export const APT =
  "Package: demo\nVersion: 1:1.0-2\nArchitecture: amd64\nDescription: Demo package\n with continuation\nDepends: libc6 (>= 2.30) | musl, helper:any\nProvides: demo-capability\nFilename: pool/d/demo.deb\nSize: 42\nSHA256: abcdef\n\n";
export const RPM =
  '<metadata><package><name>demo</name><arch>x86_64</arch><version epoch="1" ver="1.0" rel="2"/><summary>Demo package</summary><checksum type="sha256">abcd</checksum><size package="42"/><location href="Packages/demo.rpm"/><format><license>MIT</license><sourcerpm>demo.src.rpm</sourcerpm><requires><entry name="libc.so.6" flags="GE" ver="2.30"/></requires></format></package></metadata>';
export const ALPINE =
  "P:demo\nV:1.0-r2\nA:x86_64\nT:Demo package\nU:https://example.org/demo\nL:MIT\nS:42\nC:Q1fakehash\nD:so:libc.musl-x86_64.so.1 helper>=1\np:demo-capability\n\n";
export const CONDA = {
  packages: {
    "demo-1.0-0.tar.bz2": {
      name: "demo",
      version: "1.0",
      build: "0",
      build_number: 0,
      subdir: "linux-64",
      size: 42,
      sha256: "abc",
      license: "MIT",
      depends: ["python >=3.10"],
      constrains: ["helper <2"],
    },
  },
  "packages.conda": {
    "demo-1.0-1.conda": { name: "demo", version: "1.0", build: "1", depends: ["python >=3.11"], size: 43 },
  },
};
export const BREW = [
  {
    name: "demo",
    full_name: "demo",
    desc: "Demo package",
    versions: { stable: "1.0" },
    dependencies: ["helper"],
    build_dependencies: ["cmake"],
    urls: { stable: { url: "https://example.org/demo.tar.gz", checksum: "abc" } },
    bottle: { stable: { files: { arm64_linux: { url: "https://example.org/demo.bottle.tar.gz", sha256: "def" } } } },
  },
];
export const NIX = {
  demo: {
    name: "demo-1.0",
    version: "1.0",
    system: "x86_64-linux",
    drvPath: "/nix/store/example.drv",
    outputs: { out: "/nix/store/example-demo" },
    meta: { description: "Demo package", license: { spdxId: "MIT" } },
  },
};
export function tar(name: string, text: string): Uint8Array {
  const content = Buffer.from(text),
    result = Buffer.alloc(512 + Math.ceil(content.length / 512) * 512 + 1024);
  result.write(name);
  result.write(content.length.toString(8).padStart(11, "0"), 124);
  result.fill(32, 148, 156);
  result[156] = 48;
  const sum = result.subarray(0, 512).reduce((a, b) => a + b, 0);
  result.write(sum.toString(8).padStart(6, "0"), 148);
  result[154] = 0;
  content.copy(result, 512);
  return result;
}
export async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "vgi-software-test-"));
  const requests: { path: string; authorization: string | null }[] = [];
  const configBody = JSON.stringify({
    architecture: "amd64",
    os: "linux",
    config: { Labels: { "org.opencontainers.image.title": "Demo" } },
    rootfs: { type: "layers", diff_ids: [] },
  });
  const configDigest = `sha256:${digest(configBody)}`;
  const manifestBody = JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: { digest: configDigest, size: configBody.length, mediaType: "application/vnd.oci.image.config.v1+json" },
    layers: [
      { digest: `sha256:${"a".repeat(64)}`, size: 42, mediaType: "application/vnd.oci.image.layer.v1.tar+gzip" },
    ],
  });
  const manifestDigest = `sha256:${digest(manifestBody)}`;
  const indexBody = JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [
      {
        digest: manifestDigest,
        size: manifestBody.length,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        platform: { architecture: "amd64", os: "linux" },
      },
    ],
  });
  const compressedApt = gzipSync(APT),
    compressedRpm = gzipSync(RPM);
  const versions = Object.fromEntries(
    Array.from({ length: 600 }, (_, i) => [
      `1.0.${i}`,
      {
        name: "demo",
        version: `1.0.${i}`,
        description: "Demo package",
        license: "MIT",
        dependencies: { helper: "^1.0" },
        optionalDependencies: { optional: "~2" },
        peerDependencies: { peer: ">=1" },
        peerDependenciesMeta: { peer: { optional: true } },
        dist: { tarball: "https://example.org/demo.tgz", integrity: "sha512-example", unpackedSize: 42 },
      },
    ]),
  );
  let flaky = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url),
        path = decodeURIComponent(url.pathname),
        origin = url.origin;
      requests.push({ path: url.pathname + url.search, authorization: request.headers.get("authorization") });
      const response = (value: unknown, headers: Record<string, string> = {}) => Response.json(value, { headers });
      if (path === "/slow") return Bun.sleep(100).then(() => response({ ok: true }));
      if (path === "/flaky")
        return ++flaky === 1
          ? new Response("", { status: 429, headers: { "Retry-After": "0" } })
          : response({ ok: true });
      if (path === "/oversize") return new Response("x".repeat(10000));
      if (path === "/redirect") return Response.redirect("https://example.invalid/secret", 302);
      if (path === "/etag")
        return request.headers.get("if-none-match") === '"one"'
          ? new Response(null, { status: 304 })
          : response({ ok: true }, { ETag: '"one"' });
      if (path.startsWith("/private/") && request.headers.get("authorization") !== "Bearer fixture-read-token")
        return new Response("secret response must not leak", { status: 401 });
      const relative = path.replace(/^\/private/, "");
      if (relative === "/npm/-/v1/search") {
        if (url.searchParams.get("text") === "absent") return response({ objects: [], total: 0 });
        const start = Number(url.searchParams.get("from")),
          size = Number(url.searchParams.get("size"));
        return response({
          objects: Array.from({ length: Math.max(0, Math.min(size, 350 - start)) }, (_, i) => ({
            package: { name: `demo-${start + i}`, version: "1.0", description: "Demo" },
            score: { final: 0.5 },
          })),
          total: 350,
        });
      }
      if (relative === "/npm/demo" || relative === "/npm/@scope/demo")
        return response({
          name: "demo",
          versions,
          "dist-tags": { latest: "1.0.599" },
          time: { "1.0.0": "2020-01-01T00:00:00Z" },
        });
      if (path === "/pypi/simple/")
        return response({ meta: { "_last-serial": 7 }, projects: [{ name: "Demo_Package" }, { name: "demo" }] });
      if (path === "/pypi/simple/demo/" || path === "/pypi/simple/demo-package/")
        return response({ versions: ["1.0", "2.0"], files: [] });
      if (path.startsWith("/pypi/pypi/demo"))
        return response({
          info: {
            name: "demo",
            version: "1.0",
            summary: "Demo",
            requires_dist: ['helper[extra]>=2; python_version > "3.10"'],
            license_expression: "MIT",
          },
          urls: [
            {
              filename: "demo-1.0-py3-none-any.whl",
              url: "https://example.org/demo.whl",
              size: 42,
              digests: { sha256: "abc" },
              packagetype: "bdist_wheel",
              yanked: true,
              yanked_reason: "test",
            },
          ],
        });
      if (path === "/crates/api/v1/crates")
        return response({ crates: [{ name: "demo", max_version: "1.0", description: "Demo" }], meta: { total: 1 } });
      if (path.endsWith("/dependencies") && path.startsWith("/crates"))
        return response({
          dependencies: [
            { crate_id: "helper", req: "^1", kind: "normal", optional: true, target: "cfg(unix)", features: ["x"] },
          ],
        });
      if (path === "/crates/api/v1/crates/demo/1.0")
        return response({
          version: { num: "1.0", dl_path: "/api/v1/crates/demo/1.0/download", checksum: "abc", crate_size: 42 },
        });
      if (path === "/crates/api/v1/crates/demo")
        return response({
          crate: { name: "demo", max_version: "1.0", description: "Demo" },
          versions: [{ num: "1.0", yanked: true, features: { x: [] } }],
        });
      if (path === "/maven/solrsearch/select")
        return response({
          response: { numFound: 1, docs: [{ g: "org.demo", a: "demo", v: "1.0", latestVersion: "1.0", p: "jar" }] },
        });
      if (path.endsWith("maven-metadata.xml"))
        return new Response("<metadata><versioning><release>1.0</release></versioning></metadata>");
      if (path.endsWith("demo-1.0.pom"))
        return new Response(
          // biome-ignore lint/suspicious/noTemplateCurlyInString: Maven property placeholders must stay literal.
          "<project><description>Demo</description><packaging>jar</packaging><properties><helper.version>2</helper.version></properties><dependencies><dependency><groupId>org.demo</groupId><artifactId>helper</artifactId><version>${helper.version}</version></dependency></dependencies><dependencyManagement><dependencies><dependency><groupId>org.demo</groupId><artifactId>bom</artifactId><version>${unknown}</version><scope>import</scope><type>pom</type></dependency></dependencies></dependencyManagement></project>",
        );
      if (path === "/nuget/index.json")
        return response({
          version: "3.0.0",
          resources: [
            { "@type": "SearchQueryService/3.5.0", "@id": `${origin}/nuget/search` },
            { "@type": "PackageBaseAddress/3.0.0", "@id": `${origin}/nuget/flat/` },
            { "@type": "RegistrationsBaseUrl/3.6.0", "@id": `${origin}/nuget/reg/` },
          ],
        });
      if (path === "/nuget/search")
        return response({ totalHits: 1, data: [{ id: "Demo", version: "1.0", description: "Demo" }] });
      if (path === "/nuget/flat/demo/index.json") return response({ versions: ["1.0", "2.0"] });
      if (path === "/nuget/reg/demo/index.json")
        return response({
          items: [
            {
              items: [
                {
                  catalogEntry: {
                    id: "Demo",
                    version: "1.0",
                    description: "Demo",
                    listed: true,
                    dependencyGroups: [
                      { targetFramework: "net8.0", dependencies: [{ id: "Helper", range: "[1.0,2.0)" }] },
                    ],
                  },
                },
              ],
            },
          ],
        });
      if (path === "/rubygems/api/v1/search.json") return response([{ name: "demo", version: "1.0", info: "Demo" }]);
      if (path === "/rubygems/api/v1/versions/demo.json")
        return response([
          { number: "1.0", platform: "ruby", sha: "abc" },
          { number: "1.0", platform: "x86_64-linux", sha: "def" },
        ]);
      if (path.startsWith("/rubygems/api/"))
        return response({
          name: "demo",
          version: "1.0",
          info: "Demo",
          dependencies: { runtime: [{ name: "helper", requirements: ">= 1" }], development: [] },
        });
      if (path === "/go/index")
        return new Response(
          `${JSON.stringify({ Path: "example.org/demo", Version: "v1.0.0", Timestamp: "2020-01-01T00:00:00Z" })}\n`,
        );
      if (path.endsWith("/@v/list")) return new Response("v1.0.0\nv1.1.0\n");
      if (path.endsWith("/@latest")) return response({ Version: "v1.0.0", Time: "2020-01-01T00:00:00Z" });
      if (path.endsWith(".mod"))
        return new Response(
          "module example.org/demo\nrequire (\n example.org/helper v1.0.0 // indirect\n)\nreplace example.org/old => example.org/new v2.0.0\n",
        );
      if (path === "/conda/repodata.json") return response(CONDA);
      if (path === "/homebrew/api/formula.json") return response(BREW);
      if (path === "/apt/dists/stable/Release")
        return new Response(
          `Suite: stable\nSHA256:\n ${digest(compressedApt)} ${compressedApt.length} main/binary-amd64/Packages.gz\n`,
        );
      if (path === "/apt/dists/stable/main/binary-amd64/Packages.gz") return new Response(compressedApt);
      if (path === "/rpm/repodata/repomd.xml")
        return new Response(
          `<repomd><revision>7</revision><data type="primary"><checksum type="sha256">${digest(compressedRpm)}</checksum><location href="repodata/primary.xml.gz"/></data></repomd>`,
        );
      if (path === "/rpm/repodata/primary.xml.gz") return new Response(compressedRpm);
      if (path === "/alpine/APKINDEX.tar.gz") return new Response(gzipSync(tar("APKINDEX", ALPINE)));
      if (path === "/dockerhub/v2/search/repositories/")
        return response({
          count: 1,
          results: [{ repo_name: "library/demo", short_description: "Demo", is_official: true, star_count: 4 }],
        });
      if (path === "/quay/api/v1/find/repositories")
        return response({
          results: [{ name: "demo", namespace: { title: "example" }, description: "Demo" }],
          has_additional: false,
        });
      if (path.includes("/namespaces/") || path.startsWith("/quay/api/v1/repository/"))
        return response({ description: "Demo image", star_count: 4, pull_count: 100 });
      if (path === "/token") return response({ token: "fixture-registry-token", expires_in: 60 });
      if (path.startsWith("/oci/v2/")) {
        if (request.headers.get("authorization") !== "Bearer fixture-registry-token")
          return new Response("", {
            status: 401,
            headers: { "WWW-Authenticate": `Bearer realm="${origin}/token",service="fixture"` },
          });
        if (path.endsWith("/tags/list")) return response({ tags: ["latest", "single"] });
        if (path.endsWith("/manifests/latest"))
          return new Response(indexBody, { headers: { "Docker-Content-Digest": `sha256:${digest(indexBody)}` } });
        if (path.endsWith(`/manifests/${manifestDigest}`) || path.endsWith("/manifests/single"))
          return new Response(manifestBody, { headers: { "Docker-Content-Digest": manifestDigest } });
        if (path.endsWith(`/blobs/${configDigest}`)) return new Response(configBody);
      }
      return new Response(`No fixture route for ${path}`, { status: 404 });
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  const sources: Source[] = [
    ...["npm", "pypi", "crates", "maven", "rubygems", "conda", "homebrew", "apt", "rpm", "alpine"].map((kind) => ({
      id: `${kind}_test`,
      kind: kind as Source["kind"],
      url: `${origin}/${kind}`,
    })),
    { id: "nuget_test", kind: "nuget", url: `${origin}/nuget/index.json` },
    { id: "go_test", kind: "go", url: `${origin}/go`, index_url: `${origin}/go/index` },
    {
      id: "nixpkgs_test",
      kind: "nixpkgs",
      url: `${origin}/nixpkgs`,
      options: { revision: NIX_REVISION, system: "x86_64-linux" },
    },
    ...["dockerhub", "quay"].map((kind) => ({
      id: `${kind}_test`,
      kind: kind as Source["kind"],
      url: `${origin}/${kind}`,
      registry_url: `${origin}/oci`,
    })),
  ];
  const maven = sources.find((s) => s.kind === "maven");
  if (maven) maven.registry_url = `${origin}/maven/repository`;
  const settings: Settings = {
    sources,
    cache_dir: join(directory, "cache"),
    limits: { requests: 100, bytes: 16 * 1024 * 1024, timeout_ms: 30_000, retries: 2, cache_seconds: 60 },
  };
  const configPath = join(directory, "config.json");
  writeFileSync(configPath, JSON.stringify(settings));
  const nixPath = join(directory, "nix.json");
  writeFileSync(nixPath, JSON.stringify(NIX));
  for (const source of sources.filter((s) =>
    ["pypi", "go", "conda", "homebrew", "apt", "rpm", "alpine", "nixpkgs"].includes(s.kind),
  ))
    await prepareIndex(settings, new Http(source, settings.limits), source.kind === "nixpkgs" ? nixPath : undefined);
  return {
    settings,
    origin,
    server,
    requests,
    directory,
    configPath,
    manifestDigest,
    configDigest,
    cleanup: () => {
      server.stop(true);
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
