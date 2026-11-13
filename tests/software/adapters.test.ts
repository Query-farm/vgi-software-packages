import { afterAll, beforeAll, expect, test } from "bun:test";
import { authScope, credential, Http, sanitize } from "../../src/software/http.ts";
import { alpineRecords, aptRecords, indexInfo, readIndex, writeIndex } from "../../src/software/indexes.ts";
import type { Operation, Row, Source } from "../../src/software/model.ts";
import { capabilityRows, queryAll } from "../../src/software/service.ts";
import { fixture } from "./fixture.ts";

let f: Awaited<ReturnType<typeof fixture>>;
beforeAll(async () => {
  f = await fixture();
});
afterAll(() => f?.cleanup());
const names: Record<string, string> = {
  maven: "org.demo:demo",
  go: "example.org/demo",
  dockerhub: "library/demo",
  quay: "example/demo",
};
const versions: Record<string, string> = {
  npm: "1.0.0",
  go: "v1.0.0",
  apt: "1:1.0-2",
  rpm: "1:1.0-2",
  alpine: "1.0-r2",
};
async function rows(
  kind: string,
  operation: Operation,
  options: { name?: string; version?: string; query?: string; limit?: number } = {},
) {
  return Array.fromAsync(
    queryAll(
      `${kind}_test`,
      {
        operation,
        name: options.name ?? names[kind] ?? "demo",
        version: options.version ?? versions[kind] ?? "1.0",
        query: options.query ?? "demo",
        limit: options.limit ?? 1000,
      },
      f.settings,
    ),
  );
}
for (const kind of [
  "npm",
  "pypi",
  "crates",
  "maven",
  "nuget",
  "rubygems",
  "go",
  "conda",
  "homebrew",
  "apt",
  "rpm",
  "alpine",
  "nixpkgs",
]) {
  test(`${kind}: real search, versions, artifacts and native identity`, async () => {
    expect((await rows(kind, "search")).length).toBeGreaterThan(0);
    expect((await rows(kind, "versions")).length).toBeGreaterThan(0);
    expect((await rows(kind, "artifacts")).length).toBeGreaterThan(0);
    if (kind !== "nixpkgs") expect((await rows(kind, "dependencies")).length).toBeGreaterThan(0);
    const p = await rows(kind, "package", { version: "" });
    expect(p.length).toBeGreaterThan(0);
    expect(p[0]?.source_id).toBe(`${kind}_test`);
  });
}
for (const kind of ["dockerhub", "quay"]) {
  test(`${kind}: discovery, tags, verified multi-platform image inspection`, async () => {
    expect((await rows(kind, "search"))[0]?.name).toContain("demo");
    expect((await rows(kind, "repository"))[0]?.description).toBe("Demo image");
    expect((await rows(kind, "tags")).length).toBe(2);
    const platforms = await rows(kind, "platforms", { version: "latest" });
    expect(platforms[0]?.digest).toBe(f.manifestDigest);
    expect(platforms[0]?.architecture).toBe("amd64");
    expect((await rows(kind, "configuration", { version: f.manifestDigest }))[0]?.config_digest).toBe(f.configDigest);
    expect((await rows(kind, "layers", { version: f.manifestDigest }))[0]?.size).toBe(42);
    await expect(rows(kind, "layers", { version: "latest" })).rejects.toThrow("PLATFORM_REQUIRED");
    expect(f.requests.some((r) => r.path.includes(`blobs/sha256%3A${"a".repeat(64)}`))).toBe(false);
  });
}
test("pagination obeys limits, including multiple batches and empty search", async () => {
  expect((await rows("npm", "search", { limit: 300 })).length).toBe(300);
  expect((await rows("npm", "versions", { limit: 600 })).length).toBe(600);
  expect((await rows("npm", "search", { query: "absent" })).length).toBe(0);
});
test("native dependency distinctions survive normalization", async () => {
  expect((await rows("pypi", "dependencies"))[0]?.condition).toContain("python_version");
  expect((await rows("nuget", "dependencies"))[0]?.condition).toBe("net8.0");
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Maven uses literal property placeholders.
  expect((await rows("maven", "dependencies")).map((r) => r.requirement)).toEqual(["2", "${unknown}"]);
  expect((await rows("apt", "dependencies")).some((r) => String(r.requirement).includes(" | "))).toBe(true);
  expect((await rows("rubygems", "artifacts")).length).toBe(2);
  expect((await rows("conda", "artifacts")).length).toBe(2);
});
test("source discovery advertises actual capabilities and index scope", () => {
  expect(new Set(capabilityRows(f.settings, false).map((r) => r.ecosystem)).size).toBe(19);
  expect(
    capabilityRows(f.settings, false).find((r) => r.ecosystem === "nixpkgs" && r.operation === "dependencies")
      ?.supported,
  ).toBe(false);
  const source = f.settings.sources.find((s) => s.kind === "go") as Source;
  expect(indexInfo(f.settings, source)?.checkpoint).toBe("2020-01-01T00:00:00Z");
});
test("optional authentication, missing credentials, redacted errors and isolation", async () => {
  const source: Source = {
    id: "private_test",
    kind: "npm",
    url: `${f.origin}/private/npm`,
    auth: { mode: "auto", token_env: "VGI_TEST_REGISTRY_TOKEN" },
  };
  delete process.env.VGI_TEST_REGISTRY_TOKEN;
  expect(() => credential(source)).toThrow("AUTH_REQUIRED");
  process.env.VGI_TEST_REGISTRY_TOKEN = "fixture-read-token";
  try {
    const scope = authScope(source);
    const good = new Http(source, f.settings.limits);
    expect((await good.object(`${source.url}/demo`)).name).toBe("demo");
    process.env.VGI_TEST_REGISTRY_TOKEN = "invalid-fixture-token";
    expect(authScope(source)).not.toBe(scope);
    await expect(new Http(source, f.settings.limits).object(`${source.url}/demo`)).rejects.toThrow("HTTP 401");
    const secrets = { fixture: { type: "software_registry", source_id: source.id, token: "fixture-read-token" } };
    expect(credential(source, secrets)?.token).toBe("fixture-read-token");
    expect(credential(source, { foreign: { ...secrets.fixture, type: "different_secret" } })?.token).toBe(
      "invalid-fixture-token",
    );
  } finally {
    delete process.env.VGI_TEST_REGISTRY_TOKEN;
  }
});
test("HTTP budgets, origin checks, retries, conditional cache and cancellation", async () => {
  const source: Source = { id: "http_test", kind: "npm", url: f.origin };
  expect((await new Http(source, f.settings.limits).object(`${f.origin}/flaky`)).ok).toBe(true);
  await expect(new Http(source, { ...f.settings.limits, bytes: 100 }).text(`${f.origin}/oversize`)).rejects.toThrow(
    "BUDGET",
  );
  await expect(new Http(source, f.settings.limits).text(`${f.origin}/redirect`)).rejects.toThrow("ORIGIN_DENIED");
  const http = new Http(source, { ...f.settings.limits, cache_seconds: 0 });
  await http.json(`${f.origin}/etag`);
  await http.json(`${f.origin}/etag`);
  expect(http.budget.requests).toBe(2);
  const hit = new Http(source, f.settings.limits);
  await hit.json(`${f.origin}/flaky`);
  expect(hit.budget.requests).toBe(0);
  const controller = new AbortController();
  controller.abort();
  await expect(
    new Http(source, f.settings.limits, undefined, {}, controller.signal).json(`${f.origin}/slow`),
  ).rejects.toThrow("CANCELLED");
});
test("index writes are atomic, source-scoped, and scans reject changed snapshots", () => {
  const source: Source = { id: "index_test", kind: "conda", url: f.origin };
  const records = Array.from({ length: 300 }, (_, i) => ({
    relation: "package" as const,
    row: { name: `demo-${i}`, source_id: source.id, description: "Demo" } as Row,
  }));
  const info = { scope: "fixture", fields: "name,description", complete: true, checkpoint: "", revision: "1" };
  writeIndex(f.settings, source, records, info);
  const q = { operation: "search" as const, name: "", query: "demo", version: "", cursor: "", limit: 300 };
  const first = readIndex(f.settings, source, q);
  expect(first.rows.length).toBe(256);
  expect(() => writeIndex(f.settings, source, [{ relation: "package", row: {} }], info)).toThrow("MALFORMED");
  expect(indexInfo(f.settings, source)?.records).toBe(300);
  expect(() => writeIndex(f.settings, source, [], info)).toThrow("EMPTY_INDEX");
  expect(indexInfo(f.settings, source)?.records).toBe(300);
  writeIndex(f.settings, source, records, { ...info, revision: "2" });
  expect(() => readIndex(f.settings, source, { ...q, cursor: first.next })).toThrow("SNAPSHOT_CHANGED");
  expect(() => readIndex(f.settings, { ...source, id: "missing" }, q)).toThrow("INDEX_NOT_READY");
});

test("credentials are path scoped and redacted without corrupting metadata JSON", async () => {
  const source: Source = { id: "redaction", kind: "npm", url: f.origin, auth: { paths: ["/private"] } };
  const secrets = { one: { type: "software_registry", source_id: source.id, token: 'secret"with\\escapes' } };
  const http = new Http(source, f.settings.limits, undefined, secrets);
  await http.json(`${f.origin}/etag`);
  expect(f.requests.at(-1)?.authorization).toBeNull();
  const clean = JSON.parse(
    sanitize(
      JSON.stringify({ value: secrets.one.token, url: "https://example.com/file?token=private" }),
      secrets,
      source,
    ),
  );
  expect(clean).toEqual({ value: "[redacted]", url: "https://example.com/file" });
});
test("Alpine v3 exports and Debian source indexes preserve native data", () => {
  const alpine: Source = { id: "v3", kind: "alpine", url: f.origin, options: { format: "v3" } };
  const records = [
    ...alpineRecords(alpine, {
      packages: [
        { name: "demo", version: "1-r0", arch: "x86_64", depends: [{ name: "libc", version: "1", match: 2 }] },
      ],
    }),
  ];
  expect(records.find((r) => r.relation === "dependencies")?.row.dependency).toBe("libc");
  const source: Source = { id: "deb_source", kind: "apt", url: f.origin };
  const deb = [
    ...aptRecords(
      source,
      "Package: demo\nVersion: 1\nDirectory: pool/main/d/demo\nChecksums-Sha256:\n abcd 42 demo.dsc\nBuild-Depends: debhelper\n",
      true,
    ),
  ];
  expect(deb.find((r) => r.relation === "artifacts")?.row.filename).toBe("demo.dsc");
});

test("OCI inspection rejects unsupported digest algorithms rather than claiming verification", async () => {
  await expect(rows("dockerhub", "manifest", { version: `sha512:${"a".repeat(128)}` })).rejects.toThrow("UNSUPPORTED");
});
