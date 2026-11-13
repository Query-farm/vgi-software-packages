// Opt-in upstream contract checks for v0.2; never requires or prints real credentials.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings, sourceById } from "../../src/software/config.ts";
import { Http } from "../../src/software/http.ts";
import { prepareIndex } from "../../src/software/indexes.ts";
import type { Operation } from "../../src/software/model.ts";
import { queryAll } from "../../src/software/service.ts";

const settings = loadSettings("");
settings.cache_dir = mkdtempSync(join(tmpdir(), "vgi-additional-live-"));
sourceById(settings, "gitlab_public").options = { project: "gitlab-org/cluster-integration/auto-build-image" };
let failures = 0;
const selected = (id: string) => !process.env.VGI_LIVE_SOURCES || process.env.VGI_LIVE_SOURCES.split(",").includes(id);
async function check(id: string, action: () => Promise<unknown>) {
  if (!selected(id)) return;
  try {
    await action();
    console.log(JSON.stringify({ source: id, status: "passed" }));
  } catch (e) {
    failures++;
    console.log(JSON.stringify({ source: id, status: "failed", error: String(e) }));
  }
}
const read = (id: string, operation: Operation, name: string, version = "") =>
  Array.fromAsync(queryAll(id, { operation, name, version, query: name, limit: 3 }, settings));
try {
  for (const [id, name, version] of [
    ["packagist_public", "monolog/monolog", "3.9.0"],
    ["pub_public", "http", "1.2.0"],
    ["hex_public", "jason", "1.4.4"],
  ] as const)
    await check(id, async () => {
      for (const operation of ["package", "versions", "dependencies", "artifacts"] as const)
        if (!(await read(id, operation, name, ["dependencies", "artifacts"].includes(operation) ? version : "")).length)
          throw new Error(`Empty ${operation}`);
      if (id !== "pub_public" && !(await read(id, "search", name)).length) throw new Error("Empty search");
    });
  for (const [id, query] of [
    ["pub_public", "http"],
    ["cran_public", "jsonlite"],
    ["bioconductor_public", "Biobase"],
    ["vcpkg_public", "zlib"],
    ["homebrew_casks", "firefox"],
  ] as const)
    await check(id, async () => {
      const info = await prepareIndex(settings, new Http(sourceById(settings, id), settings.limits));
      if (!info.complete || !(await read(id, "search", query)).length)
        throw new Error("Incomplete or empty prepared search");
      if (id === "vcpkg_public") {
        const p = (await read(id, "package", "zlib"))[0];
        if (!p?.version || !(await read(id, "dependencies", "zlib", String(p.version))).length)
          throw new Error("Missing vcpkg declarations");
      }
      console.log(JSON.stringify({ source: id, records: info.records, revision: info.revision }));
    });
  await check("ghcr_public", async () => {
    const tags = await read("ghcr_public", "tags", "homebrew/core/zlib");
    if (!tags[0]?.tag) throw new Error("Empty GHCR tags");
    const platforms = await read("ghcr_public", "platforms", "homebrew/core/zlib", String(tags[0].tag));
    const p = platforms.find((r) => r.os === "linux") ?? platforms[0];
    if (!p?.digest || !(await read("ghcr_public", "configuration", "homebrew/core/zlib", String(p.digest))).length)
      throw new Error("Empty GHCR inspection");
  });
  await check("gitlab_public", async () => {
    const repositories = await read("gitlab_public", "search", "master"),
      name = String(repositories[0]?.name ?? "");
    if (!name) throw new Error("Empty GitLab project inventory");
    const tags = await read("gitlab_public", "tags", name);
    if (!tags[0]?.tag) throw new Error("Empty GitLab tags");
    const manifests = await read("gitlab_public", "platforms", name, String(tags[0].tag));
    const platform = manifests.find((r) => r.os === "linux") ?? manifests[0];
    if (!platform?.digest || !(await read("gitlab_public", "configuration", name, String(platform.digest))).length)
      throw new Error("Empty GitLab image inspection");
  });
} finally {
  rmSync(settings.cache_dir, { recursive: true, force: true });
}
process.exitCode = failures ? 1 : 0;
