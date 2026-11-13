// Opt-in network smoke checks. Deterministic fixture tests remain the CI gate.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings } from "../../src/software/config.ts";
import { Http } from "../../src/software/http.ts";
import { prepareIndex } from "../../src/software/indexes.ts";
import type { Operation } from "../../src/software/model.ts";
import { queryAll } from "../../src/software/service.ts";

const settings = loadSettings();
const cache = mkdtempSync(join(tmpdir(), "vgi-live-"));
settings.cache_dir = cache;
settings.limits.timeout_ms = 60_000;
const cases: [string, Operation, string, string][] = [
  ["npm", "package", "typescript", ""],
  ["pypi", "package", "requests", ""],
  ["crates", "package", "serde", ""],
  ["maven", "package", "org.apache.commons:commons-lang3", ""],
  ["nuget", "package", "Newtonsoft.Json", ""],
  ["rubygems", "package", "rails", ""],
  ["go", "versions", "golang.org/x/text", ""],
  ["dockerhub", "search", "postgres", ""],
  ["quay", "search", "prometheus", ""],
  ["dockerhub", "platforms", "library/hello-world", "latest"],
  ["quay", "manifest", "prometheus/prometheus", "latest"],
];
let failed = 0;
try {
  for (const [kind, operation, name, version] of cases) {
    try {
      const rows = [];
      for await (const row of queryAll(`${kind}_public`, { operation, name, version, query: name, limit: 3 }, settings))
        rows.push(row);
      if (!rows.length) throw new Error("Empty result");
      console.log(JSON.stringify({ kind, operation, rows: rows.length, status: "passed" }));
    } catch (error) {
      failed++;
      console.log(JSON.stringify({ kind, operation, error: String(error) }));
    }
  }
  for (const kind of ["alpine", "homebrew"]) {
    try {
      const source = settings.sources.find((s) => s.kind === kind);
      if (!source) continue;
      const info = await prepareIndex(settings, new Http(source, settings.limits));
      const rows = [];
      for await (const row of queryAll(
        source.id,
        { operation: "search", name: "", version: "", query: "curl", limit: 3 },
        settings,
      ))
        rows.push(row);
      if (!rows.length) throw new Error("Empty search");
      console.log(JSON.stringify({ kind, records: info.records, rows: rows.length, status: "passed" }));
    } catch (error) {
      failed++;
      console.log(JSON.stringify({ kind, error: String(error) }));
    }
  }
  for (const [kind, name] of [
    ["dockerhub", "library/hello-world"],
    ["quay", "prometheus/prometheus"],
  ]) {
    try {
      const platforms = await Array.fromAsync(
        queryAll(
          `${kind}_public`,
          { operation: "platforms", name: name ?? "", version: "latest", query: "", limit: 3 },
          settings,
        ),
      );
      const platform = platforms.find((p) => p.os === "linux");
      if (!platform) throw new Error("No Linux platform");
      const rows = await Array.fromAsync(
        queryAll(
          `${kind}_public`,
          { operation: "configuration", name: name ?? "", version: String(platform.digest), query: "", limit: 1 },
          settings,
        ),
      );
      console.log(JSON.stringify({ kind, operation: "configuration", rows: rows.length, status: "passed" }));
    } catch (error) {
      failed++;
      console.log(JSON.stringify({ kind, operation: "configuration", error: String(error) }));
    }
  }
} finally {
  rmSync(cache, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
