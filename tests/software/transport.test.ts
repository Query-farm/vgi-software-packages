import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { Arguments, VgiClient } from "@query-farm/vgi";
import { subprocessConnect } from "@query-farm/vgi-rpc";
import { isContainer } from "../../src/software/service.ts";
import { fixture } from "./fixture.ts";

let f: Awaited<ReturnType<typeof fixture>>;
let packages: VgiClient, containers: VgiClient;
let saved: string | undefined;
beforeAll(async () => {
  f = await fixture();
  saved = process.env.VGI_SOFTWARE_CONFIG;
  process.env.VGI_SOFTWARE_CONFIG = f.configPath;
  packages = new VgiClient(
    subprocessConnect([process.execPath, "run", join(import.meta.dir, "../../src/worker.ts")], {
      env: { VGI_SOFTWARE_CONFIG: f.configPath },
    }),
  );
  containers = new VgiClient(
    subprocessConnect([process.execPath, "run", join(import.meta.dir, "../../src/container_worker.ts")], {
      env: { VGI_SOFTWARE_CONFIG: f.configPath },
    }),
  );
});
afterAll(() => {
  packages?.close();
  containers?.close();
  if (saved === undefined) delete process.env.VGI_SOFTWARE_CONFIG;
  else process.env.VGI_SOFTWARE_CONFIG = saved;
  f?.cleanup();
});
async function table(client: VgiClient, name: string, positional: unknown[], named: Record<string, unknown> = {}) {
  const rows: Record<string, unknown>[] = [];
  for await (const batch of client.tableFunctionRows({
    functionName: name,
    arguments: new Arguments(positional, new Map(Object.entries(named))),
    int64: "bigint",
  }))
    rows.push(...batch);
  return rows;
}
test("both workers expose independent source catalogs and typed booleans", async () => {
  const a = await table(packages, "sources", []),
    b = await table(containers, "sources", []);
  expect(a.length).toBe(20);
  expect(b.length).toBe(4);
  expect(a[0]?.credential_configured).toBe(false);
  expect(
    (await table(packages, "source_status", []))
      .filter((r) => r.search_mode === "indexed")
      .every((r) => r.ready === true),
  ).toBe(true);
});
test("VGI multiple batches preserve typed schemas and respect result budgets", async () => {
  const versions = await table(packages, "versions", ["npm_test", "demo"]);
  expect(versions.length).toBe(600);
  expect(versions[0]?.version).toBe("1.0.0");
  const search = await table(packages, "search", ["npm_test", "demo", 300n]);
  expect(search.length).toBe(300);
  expect((await table(packages, "search", ["npm_test", "absent", 25n])).length).toBe(0);
  const artifacts = await table(packages, "artifacts", ["pypi_test", "demo", "1.0"]);
  expect(artifacts[0]?.size).toBe(42n);
  expect(artifacts[0]?.yanked).toBe(true);
});
test("all adapters bind through the VGI subprocess protocol", async () => {
  for (const source of f.settings.sources) {
    const client = isContainer(source) ? containers : packages;
    const results = await table(client, "search", [source.id, "demo", 25n]);
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(25);
  }
});
test("container configuration and layers stay metadata-only through VGI", async () => {
  const platforms = await table(containers, "platforms", ["dockerhub_test", "library/demo", "latest"]);
  expect(platforms[0]?.digest).toBe(f.manifestDigest);
  const layers = await table(containers, "layers", ["quay_test", "example/demo", f.manifestDigest]);
  expect(layers[0]?.size).toBe(42n);
  await expect(table(packages, "search", ["dockerhub_test", "demo", 25n])).rejects.toThrow("WRONG_WORKER");
  await expect(table(packages, "dependencies", ["nixpkgs_test", "demo", "1.0"])).rejects.toThrow("UNSUPPORTED");
});
