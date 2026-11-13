import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { rRecords, tarEntries, vcpkgRecords } from "../../src/software/additional_indexes.ts";
import { loadSettings } from "../../src/software/config.ts";
import { Http } from "../../src/software/http.ts";
import { indexInfo, prepareIndex } from "../../src/software/indexes.ts";
import type { Operation, Source } from "../../src/software/model.ts";
import { capabilityRows, queryAll } from "../../src/software/service.ts";
import { R_PACKAGES, VCPKG_FILES } from "./additional_fixture.ts";
import { fixture, tar } from "./fixture.ts";

let f: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => {
  f = await fixture();
});
afterAll(() => f?.cleanup());
function rows(kind: string, operation: Operation, name = "demo", version = "1.0", limit = 1000) {
  return Array.fromAsync(queryAll(`${kind}_test`, { operation, name, version, query: "demo", limit }, f.settings));
}
for (const kind of ["packagist", "pub", "hex", "cran", "bioconductor", "vcpkg", "homebrew_casks"]) {
  test(`${kind}: package identity, search, versions, artifacts and declarations`, async () => {
    const name = kind === "packagist" ? "vendor/demo" : kind === "homebrew_casks" ? "demo-app" : "demo";
    const version = kind === "vcpkg" ? "1.0#2" : "1.0";
    expect((await rows(kind, "search"))[0]?.name).toBe(name);
    expect((await rows(kind, "package", name, ""))[0]?.name).toBe(name);
    expect((await rows(kind, "versions", name, "")).map((r) => r.version)).toContain(version);
    expect((await rows(kind, "artifacts", name, version)).length).toBeGreaterThan(0);
    expect((await rows(kind, "dependencies", name, version)).length).toBeGreaterThan(0);
  });
}
test("Composer preserves platform constraints, development requirements, suggestions and source references", async () => {
  const deps = await rows("packagist", "dependencies", "vendor/demo");
  expect(deps.find((r) => r.dependency === "php")?.requirement).toBe(">=8.1");
  expect(deps.find((r) => r.kind === "suggest")?.requirement).toBe("JSON support");
  expect((await rows("packagist", "artifacts", "vendor/demo")).map((r) => r.artifact_type)).toEqual(["zip", "git"]);
  expect((await rows("packagist", "versions", "vendor/demo", "")).map((r) => r.version)).toContain("dev-main");
  await expect(rows("packagist", "dependencies", "vendor/demo", "missing")).rejects.toThrow("NOT_FOUND");
});
test("Pub follows the full inventory, preserves SDK dependencies and retracts, rejects missing versions", async () => {
  expect(f.requests.some((r) => r.path === "/pub/api/package-names?page=2")).toBe(true);
  expect((await rows("pub", "versions", "demo", ""))[0]?.yanked).toBe(true);
  expect((await rows("pub", "dependencies")).find((r) => r.dependency === "flutter")?.requirement).toBe(
    '{"sdk":"flutter"}',
  );
  await expect(rows("pub", "artifacts", "demo", "missing")).rejects.toThrow("NOT_FOUND");
  const source: Source = { id: "pub_loop", kind: "pub", url: `${f.origin}/pub`, index_url: `${f.origin}/pub-loop` };
  await expect(prepareIndex(f.settings, new Http(source, f.settings.limits))).rejects.toThrow("PAGINATION");
  expect(indexInfo(f.settings, source)).toBeNull();
});
test("Hex preserves optional dependencies and accepts scoped private repository credentials", async () => {
  expect((await rows("hex", "dependencies"))[0]?.kind).toBe("optional");
  const source: Source = {
    id: "hex_private",
    kind: "hex",
    url: `${f.origin}/hex`,
    auth: { mode: "required", scheme: "token" },
    options: { repository: "private" },
  };
  const settings = { ...f.settings, sources: [source] };
  const query = { operation: "dependencies" as const, name: "demo", version: "1.0", query: "", limit: 10 };
  await expect(Array.fromAsync(queryAll(source.id, query, settings))).rejects.toThrow("AUTH_REQUIRED");
  const secrets = { hex: { type: "software_registry", source_id: source.id, token: "fixture-hex-token" } };
  expect(await Array.fromAsync(queryAll(source.id, query, settings, secrets))).toEqual([]);
});
test("R packages preserve dependency classes, R runtime and index checksums", () => {
  const s = f.settings.sources.find((s) => s.kind === "cran") as Source;
  const records = [...rRecords(s, R_PACKAGES)];
  expect(records.find((r) => r.row.dependency === "R")?.row.requirement).toBe("R (>= 4.4)");
  expect(records.find((r) => r.row.dependency === "Rcpp")?.row.kind).toBe("LinkingTo");
  expect(records.find((r) => r.relation === "artifacts")?.row.hashes).toBe('{"md5":"abc"}');
});
test("vcpkg preserves revisions, historical trees, features, host dependencies and metadata-only reads", async () => {
  expect((await rows("vcpkg", "versions", "demo", "")).map((r) => r.version)).toEqual(["1.0#2", "old"]);
  const deps = await rows("vcpkg", "dependencies", "demo", "1.0#2");
  expect(deps.find((r) => r.dependency === "vcpkg-cmake")?.kind).toBe("host");
  expect(JSON.parse(String(deps.find((r) => r.dependency === "openssl")?.condition)).feature).toBe("ssl");
  await expect(rows("vcpkg", "dependencies", "demo", "old")).rejects.toThrow("VERSION_SCOPE");
  const s = f.settings.sources.find((s) => s.kind === "vcpkg") as Source;
  const directory = join(f.directory, "registry");
  for (const [name, text] of VCPKG_FILES) {
    const file = join(directory, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  writeFileSync(join(directory, "ports/demo/portfile.cmake"), "this must never execute");
  const info = await prepareIndex(f.settings, new Http(s, f.settings.limits), directory);
  expect(info.revision).toBe(s.options?.revision ?? "");
  const legacy = new Map(VCPKG_FILES);
  legacy.set(
    "ports/legacy/CONTROL",
    "Source: legacy\nVersion: 2\nPort-Version: 1\nDescription: Legacy port\nBuild-Depends: zlib\n",
  );
  expect([...vcpkgRecords(s, legacy)].some((r) => r.row.name === "legacy" && r.row.version === "2#1")).toBe(true);
  const unpinned = { ...s, options: {} };
  await expect(prepareIndex(f.settings, new Http(unpinned, f.settings.limits), directory)).rejects.toThrow("CONFIG");
  const truncated = tar("foo", "a");
  truncated.fill(55, 124, 135);
  expect(() => [...tarEntries(truncated)]).toThrow("MALFORMED");
});
for (const kind of ["ghcr", "gitlab"]) {
  test(`${kind}: scoped discovery crosses empty matches and retains OCI verification`, async () => {
    expect((await rows(kind, "search", "", "", 1)).map((r) => r.name)).toEqual(["example/demo"]);
    expect((await rows(kind, "repository", "example/demo", ""))[0]?.name).toBe("example/demo");
    expect((await rows(kind, "tags", "example/demo", "")).map((r) => r.tag)).toEqual(["latest", "single"]);
    expect((await rows(kind, "platforms", "example/demo", "latest"))[0]?.digest).toBe(f.manifestDigest);
    expect((await rows(kind, "configuration", "example/demo", f.manifestDigest))[0]?.os).toBe("linux");
    const source = { ...(f.settings.sources.find((s) => s.kind === kind) as Source), options: {} };
    expect(
      capabilityRows({ ...f.settings, sources: [source] }, true).find((r) => r.operation === "search")?.supported,
    ).toBe(false);
  });
}
test("default sources include casks and advertise scoped hosted-container discovery", () => {
  const settings = loadSettings("");
  expect(settings.sources.find((s) => s.id === "homebrew_casks")?.options?.type).toBe("cask");
  expect(settings.sources.find((s) => s.id === "bioconductor_public")?.options?.release).toBe("3.23");
});

test("GHCR keeps API and OCI credentials separate", async () => {
  const source: Source = {
    id: "ghcr_private",
    kind: "ghcr",
    url: `${f.origin}/ghcr`,
    registry_url: `${f.origin}/oci`,
    options: { owner: "private" },
    auth: { mode: "required" },
    registry_auth: { mode: "required", scheme: "basic", username: "fixture-user" },
  };
  const secrets = {
    api: { type: "software_registry", source_id: source.id, purpose: "api", token: "fixture-api-token" },
    registry: { type: "software_registry", source_id: source.id, purpose: "registry", token: "fixture-pull-token" },
  };
  const settings = { ...f.settings, sources: [source] };
  const query = { operation: "search" as const, name: "", version: "", query: "demo", limit: 10 };
  await expect(Array.fromAsync(queryAll(source.id, query, settings))).rejects.toThrow("AUTH_REQUIRED");
  expect((await Array.fromAsync(queryAll(source.id, query, settings, secrets)))[0]?.name).toBe("private/demo");
  await Array.fromAsync(queryAll(source.id, { ...query, operation: "tags", name: "private/demo" }, settings, secrets));
  expect(
    f.requests.findLast((r) => r.path === "/ghcr/orgs/private/packages?package_type=container&per_page=100&page=1")
      ?.authorization,
  ).toBe("Bearer fixture-api-token");
  expect(f.requests.findLast((r) => r.path.startsWith("/token?"))?.authorization).toBe(
    `Basic ${Buffer.from("fixture-user:fixture-pull-token").toString("base64")}`,
  );
});

test("vcpkg filesystem registries resolve named baselines and contain metadata paths", async () => {
  const directory = join(f.directory, "filesystem-registry");
  const files = new Map([
    ["versions/baseline.json", JSON.stringify({ release: { demo: { baseline: "2", "port-version": 0 } } })],
    ["versions/d-/demo.json", JSON.stringify({ versions: [{ version: "2", path: "$/recipes/demo/2" }] })],
    ["recipes/demo/2/vcpkg.json", JSON.stringify({ name: "demo", version: "2", dependencies: ["zlib"] })],
  ]);
  for (const [name, text] of files) {
    const file = join(directory, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  const source: Source = {
    id: "vcpkg_filesystem",
    kind: "vcpkg",
    url: `${f.origin}/vcpkg`,
    options: { format: "filesystem", baseline: "release" },
  };
  const settings = { ...f.settings, sources: [source] };
  const info = await prepareIndex(settings, new Http(source, settings.limits), directory);
  expect(info.revision).toMatch(/^[a-f0-9]{64}$/);
  const query = { operation: "dependencies" as const, name: "demo", version: "2#0", query: "", limit: 10 };
  expect((await Array.fromAsync(queryAll(source.id, query, settings)))[0]?.dependency).toBe("zlib");
  writeFileSync(
    join(directory, "versions/d-/demo.json"),
    JSON.stringify({ versions: [{ version: "2", path: "$/../outside" }] }),
  );
  await expect(prepareIndex(settings, new Http(source, settings.limits), directory)).rejects.toThrow("PATH_SCOPE");
  expect(indexInfo(settings, source)?.snapshot).toBe(info.snapshot);
});
