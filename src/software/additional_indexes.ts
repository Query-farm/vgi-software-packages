import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import type { Http } from "./http.ts";
import { decompress, type IndexedRecord, packageRecords, paragraphs } from "./indexes.ts";
import { arr, baseRow, dependency, json, nullable, obj, RegistryError, type Row, type Source, str } from "./model.ts";

export function* rRecords(s: Source, text: string): Generator<IndexedRecord> {
  for (const p of paragraphs(text)) {
    const name = p.Package ?? "",
      version = p.Version ?? "";
    if (!version) throw new RegistryError("MALFORMED", "R package has no Version field");
    const row = baseRow(s, name, {
      version,
      description: nullable(p.Title) ?? nullable(p.Description),
      license: nullable(p.License),
      platform: nullable(p.OS_type),
      metadata: json({
        needs_compilation: p.NeedsCompilation,
        archs: p.Archs,
        system_requirements: p.SystemRequirements,
        repository: s.url,
        release: s.options?.release,
        component: s.options?.component,
      }),
    });
    yield* packageRecords(row);
    const filename = p.File || `${name}_${version}.tar.gz`;
    yield {
      relation: "artifacts",
      row: {
        ...row,
        filename,
        url: new URL(filename, `${s.url.replace(/\/$/, "")}/`).toString(),
        hashes: json({ md5: p.MD5sum }),
        artifact_type: s.options?.type ?? "source",
      },
    };
    for (const kind of ["Depends", "Imports", "LinkingTo", "Suggests", "Enhances"])
      for (const expression of (p[kind] ?? "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean))
        yield {
          relation: "dependencies",
          row: dependency(s, name, version, expression.split(/[\s(]/)[0] ?? expression, expression, kind, {
            condition: nullable(p.OS_type),
          }),
        };
  }
}

// Read metadata only, without extracting paths or executing port build scripts.
export function* tarEntries(data: Uint8Array): Generator<[string, Uint8Array]> {
  const decoder = new TextDecoder();
  for (let pos = 0; pos + 512 <= data.length; ) {
    const header = data.subarray(pos, pos + 512),
      name = decoder.decode(header.subarray(0, 100)).replace(/\0.*$/, "");
    if (!name) {
      pos += 512;
      continue;
    }
    const prefix = decoder.decode(header.subarray(345, 500)).replace(/\0.*$/, "");
    const size = Number.parseInt(decoder.decode(header.subarray(124, 136)).replace(/\0.*$/, "").trim(), 8);
    if (!Number.isSafeInteger(size) || size < 0 || pos + 512 + size > data.length)
      throw new RegistryError("MALFORMED", "Truncated registry archive");
    if (header[156] === 48 || header[156] === 0)
      yield [prefix ? `${prefix}/${name}` : name, data.subarray(pos + 512, pos + 512 + size)];
    pos += 512 + Math.ceil(size / 512) * 512;
  }
}

function version(value: Record<string, unknown>): { text: string; scheme: string; upstream: string; revision: string } {
  const scheme = ["version", "version-semver", "version-date", "version-string"].find(
    (k) => typeof value[k] === "string",
  );
  if (!scheme) throw new RegistryError("MALFORMED", "vcpkg entry has no native version field");
  const upstream = str(value[scheme]),
    revision = str(value["port-version"] ?? 0);
  if (!/^\d+$/.test(revision)) throw new RegistryError("MALFORMED", "Invalid vcpkg port revision");
  return { text: revision === "0" ? upstream : `${upstream}#${revision}`, scheme, upstream, revision };
}

export function* vcpkgRecords(s: Source, files: Map<string, string>): Generator<IndexedRecord> {
  const baselines = obj(JSON.parse(files.get("versions/baseline.json") ?? "{}"));
  const baselineName = s.options?.baseline ?? "default";
  if (!baselines[baselineName]) throw new RegistryError("CONFIG", "The selected vcpkg baseline does not exist");
  const baseline = obj(baselines[baselineName]);
  for (const [file, text] of files) {
    const match = file.match(/^ports\/([^/]+)\/(vcpkg.json|CONTROL)$/);
    if (!match) continue;
    const name = match[1] ?? "";
    if (match[2] === "CONTROL" && files.has(`ports/${name}/vcpkg.json`)) continue;
    let p: Record<string, unknown>;
    if (match[2] === "CONTROL") {
      const control = [...paragraphs(text)][0] ?? {};
      p = {
        name: control.Source,
        "version-string": control.Version,
        "port-version": Number(control["Port-Version"] ?? 0),
        description: control.Description,
        homepage: control.Homepage,
        supports: control.Supports,
      };
      // Legacy declarations retain their original expression rather than inventing feature resolution.
      p.dependencies = (control["Build-Depends"] ?? "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
    } else p = obj(JSON.parse(text));
    const v = version(p),
      historyFile = `versions/${name[0]}-/${name}.json`;
    const history = arr(obj(JSON.parse(files.get(historyFile) ?? "{}")).versions).map(obj);
    const currentTree = history.find((entry) => version(entry).text === v.text)?.["git-tree"];
    const common = baseRow(s, name, {
      version: v.text,
      build: v.revision,
      description: arr(p.description).map(str).join("\n") || null,
      homepage: nullable(p.homepage),
      license: nullable(p.license),
      metadata: json({
        upstream_version: v.upstream,
        version_scheme: v.scheme,
        port_version: Number(v.revision),
        baseline: baseline[name],
        git_tree: currentTree,
        supports: p.supports,
        default_features: p["default-features"],
        features: p.features,
        revision: s.options?.revision,
      }),
    });
    yield { relation: "package", row: common };
    const entries = history.length ? history : [p];
    if (!entries.some((entry) => version(entry).text === v.text)) entries.push(p);
    for (const entry of entries) {
      const release = version(entry);
      const row: Row = {
        ...baseRow(s, name),
        version: release.text,
        build: release.revision,
        // Historical version records describe identity only; current manifest metadata is not historical metadata.
        description: release.text === v.text ? (common.description ?? null) : null,
        metadata: json({
          upstream_version: release.upstream,
          version_scheme: release.scheme,
          port_version: Number(release.revision),
          git_tree: entry["git-tree"],
          path: entry.path,
          baseline: baseline[name],
        }),
      };
      yield { relation: "versions", row };
      yield {
        relation: "artifacts",
        row: {
          ...row,
          artifact_type: "vcpkg_recipe",
          url:
            release.text === v.text && s.options?.format !== "filesystem"
              ? `${s.url.replace(/\/$/, "")}/tree/${s.options?.revision}/ports/${encodeURIComponent(name)}`
              : null,
        },
      };
    }
    const dependencies = function* (values: unknown, feature: string): Generator<IndexedRecord> {
      for (const value of arr(values)) {
        const d = typeof value === "string" ? { name: value } : obj(value);
        yield {
          relation: "dependencies",
          row: dependency(
            s,
            name,
            v.text,
            str(d.name),
            typeof value === "string" ? value : json(d),
            d.host === true ? "host" : "target",
            {
              condition: json({ feature: feature || null, platform: d.platform, supports: p.supports }),
              metadata: json({ features: d.features, default_features: d["default-features"] }),
            },
          ),
        };
      }
    };
    yield* dependencies(p.dependencies, "");
    for (const [feature, value] of Object.entries(obj(p.features)))
      yield* dependencies(obj(value).dependencies, feature);
  }
}

export async function vcpkgFiles(http: Http, input?: string): Promise<Map<string, string>> {
  const s = http.source,
    revision = s.options?.revision;
  const filesystem = s.options?.format === "filesystem";
  if (!filesystem && (!revision || !/^[a-f0-9]{40}$/.test(revision)))
    throw new RegistryError("CONFIG", "vcpkg requires options.revision pinned to a 40-character Git commit");
  const files = new Map<string, string>();
  const wanted = (name: string) =>
    /^(ports\/[^/]+\/(vcpkg.json|CONTROL)|versions\/(baseline.json|[^/]+\/[^/]+\.json))$/.test(name);
  if (input && lstatSync(input).isDirectory()) {
    let bytes = 0;
    const visit = (relative: string) => {
      http.remaining();
      const path = join(input, relative),
        stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new RegistryError("MALFORMED", "Registry metadata must not use symbolic links");
      if (stat.isDirectory()) {
        for (const child of readdirSync(path)) visit(`${relative}/${child}`);
      } else if (wanted(relative)) {
        bytes += stat.size;
        if (bytes > http.limits.bytes) throw new RegistryError("BUDGET", "Registry metadata exceeds byte budget");
        files.set(relative, readFileSync(path, "utf8"));
      }
    };
    visit("versions");
    if (!filesystem) visit("ports");
    else {
      const baseline = obj(
        obj(JSON.parse(files.get("versions/baseline.json") ?? "{}"))[s.options?.baseline ?? "default"],
      );
      const registryRoot = realpathSync(input);
      for (const [name, value] of Object.entries(baseline)) {
        http.remaining();
        if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new RegistryError("MALFORMED", "Invalid vcpkg port name");
        const pin = obj(value);
        const entries = arr(obj(JSON.parse(files.get(`versions/${name[0]}-/${name}.json`) ?? "{}")).versions).map(obj);
        const entry = entries.find((e) => {
          const v = version(e);
          return v.upstream === pin.baseline && v.revision === str(pin["port-version"] ?? 0);
        });
        const path = str(entry?.path);
        if (!path.startsWith("$/") || path.split(/[\\/]/).includes(".."))
          throw new RegistryError("PATH_SCOPE", "Filesystem registry paths must be inside the imported root using $/");
        const directory = realpathSync(join(input, path.slice(2)));
        if (!directory.startsWith(`${registryRoot}${sep}`))
          throw new RegistryError("PATH_SCOPE", "Port directory escapes the imported root");
        const filename = existsSync(join(directory, "vcpkg.json")) ? "vcpkg.json" : "CONTROL";
        const metadataPath = join(directory, filename),
          stat = lstatSync(metadataPath);
        if (stat.isSymbolicLink()) throw new RegistryError("PATH_SCOPE", "Port manifest must not be a symbolic link");
        bytes += stat.size;
        if (bytes > http.limits.bytes) throw new RegistryError("BUDGET", "Registry metadata exceeds byte budget");
        files.set(`ports/${name}/${filename}`, readFileSync(metadataPath, "utf8"));
      }
    }
  } else {
    if (filesystem)
      throw new RegistryError("CONFIG", "Filesystem registries require --input pointing to a local directory");
    const url = s.index_url ?? `${s.url.replace(/\/$/, "")}/archive/${revision}.tar.gz`;
    const compressed = input ? new Uint8Array(readFileSync(input)) : (await http.request(url)).body;
    const data = await decompress(compressed, input ?? url, http.limits.bytes);
    for (const [full, content] of tarEntries(data)) {
      const name = full.replace(/^\.\//, "").replace(/^[^/]+\//, "");
      if (wanted(name)) files.set(name, new TextDecoder().decode(content));
    }
  }
  if (!files.has("versions/baseline.json"))
    throw new RegistryError("MALFORMED", "vcpkg registry has no default baseline");
  return files;
}
