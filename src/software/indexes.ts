import { Database } from "bun:sqlite";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { rRecords, vcpkgFiles, vcpkgRecords } from "./additional_indexes.ts";
import { authScope, digest, type Http, type Secrets, safeUrl, sanitize } from "./http.ts";
import { parseXml } from "./maven_nuget.ts";
import {
  arr,
  baseRow,
  dependency,
  json,
  nullable,
  num,
  obj,
  type Page,
  type Query,
  RegistryError,
  type Row,
  type Settings,
  type Source,
  str,
} from "./model.ts";

const runFile = promisify(execFile);
export interface IndexedRecord {
  relation: "package" | "versions" | "artifacts" | "dependencies";
  row: Row;
}
export interface IndexInfo {
  snapshot: string;
  observed_at: string;
  scope: string;
  fields: string;
  complete: boolean;
  checkpoint: string;
  records: number;
  revision: string;
}
const decoder = new TextDecoder();

export function indexPath(settings: Settings, source: Source, secrets: Secrets = {}) {
  return join(settings.cache_dir, `${source.id}-${authScope(source, secrets)}.sqlite`);
}
export function indexInfo(settings: Settings, source: Source, secrets: Secrets = {}): IndexInfo | null {
  const path = indexPath(settings, source, secrets);
  if (!existsSync(path)) return null;
  const db = new Database(path, { readonly: true });
  try {
    const value = db.query<{ value: string }, []>("SELECT value FROM metadata WHERE key='info'").get();
    return value ? (JSON.parse(value.value) as IndexInfo) : null;
  } finally {
    db.close();
  }
}
export function writeIndex(
  settings: Settings,
  source: Source,
  records: Iterable<IndexedRecord>,
  info: Omit<IndexInfo, "records" | "snapshot" | "observed_at">,
  secrets: Secrets = {},
  append = false,
): IndexInfo {
  mkdirSync(settings.cache_dir, { recursive: true, mode: 0o700 });
  const path = indexPath(settings, source, secrets),
    db = new Database(path);
  chmodSync(path, 0o600);
  db.exec(
    "PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, relation TEXT NOT NULL, name TEXT NOT NULL, version TEXT NOT NULL, description TEXT NOT NULL, value TEXT NOT NULL); CREATE INDEX IF NOT EXISTS lookup ON records(relation,name,version); CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  );
  const result: IndexInfo = { ...info, snapshot: randomUUID(), observed_at: new Date().toISOString(), records: 0 };
  try {
    db.transaction(() => {
      if (!append) db.exec("DELETE FROM records");
      const insert = db.prepare("INSERT OR REPLACE INTO records VALUES(?,?,?,?,?,?)");
      for (const { relation, row } of records) {
        if (!row.name) throw new RegistryError("MALFORMED", "Indexed record has no package name");
        const cleaned = JSON.parse(sanitize(json(row), secrets, source)) as Row;
        const identity = relation === "package" ? str(row.name) : json({ ...row, observed_at: null });
        insert.run(
          digest(`${relation}:${identity}`),
          relation,
          str(cleaned.name),
          str(cleaned.version),
          str(cleaned.description),
          json(cleaned),
        );
      }
      result.records = db.query<{ n: number }, []>("SELECT count(*) n FROM records").get()?.n ?? 0;
      if (!result.records && !append && source.options?.allow_empty !== "true")
        throw new RegistryError(
          "EMPTY_INDEX",
          "Refusing an empty snapshot; check the input format or explicitly set options.allow_empty",
        );
      db.prepare("INSERT OR REPLACE INTO metadata VALUES('info',?)").run(json(result));
    })();
    return result;
  } finally {
    db.close();
  }
}
export function readIndex(settings: Settings, source: Source, q: Query, secrets: Secrets = {}): Page {
  if (source.kind === "vcpkg" && q.version.endsWith("#0")) q = { ...q, version: q.version.slice(0, -2) };
  const path = indexPath(settings, source, secrets);
  if (!existsSync(path))
    throw new RegistryError(
      "INDEX_NOT_READY",
      `Run bin/vgi-software-index prepare ${source.id} before indexed queries`,
    );
  const db = new Database(path, { readonly: true });
  try {
    db.exec("BEGIN");
    const entry = db.query<{ value: string }, []>("SELECT value FROM metadata WHERE key='info'").get();
    if (!entry) throw new RegistryError("INDEX_NOT_READY", `No committed snapshot for ${source.id}`);
    if (
      source.kind === "vcpkg" &&
      q.operation === "dependencies" &&
      !db.query("SELECT 1 FROM records WHERE relation='package' AND name=? AND version=?").get(q.name, q.version)
    )
      throw new RegistryError(
        "VERSION_SCOPE",
        "vcpkg dependencies describe the current registry snapshot; prepare the historical commit to inspect its declarations",
      );
    const info = JSON.parse(entry.value) as IndexInfo;
    const cursor = q.cursor
      ? (JSON.parse(q.cursor) as { snapshot: string; offset: number })
      : { snapshot: info.snapshot, offset: 0 };
    if (cursor.snapshot !== info.snapshot)
      throw new RegistryError("SNAPSHOT_CHANGED", "Index changed during scan; retry query");
    if (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0)
      throw new RegistryError("INVALID_CURSOR", "Invalid snapshot offset");
    const relation = q.operation === "search" ? "package" : q.operation;
    const filter =
      q.operation === "search"
        ? " AND (instr(lower(name),lower(?)) > 0 OR instr(lower(description),lower(?)) > 0)"
        : " AND name=?";
    const values: (string | number)[] = [relation, ...(q.operation === "search" ? [q.query, q.query] : [q.name])];
    const requestedVersion = q.operation === "search" || q.operation === "versions" ? "" : q.version;
    if (requestedVersion) values.push(requestedVersion);
    const count = Math.min(q.limit, 256);
    values.push(count + 1, cursor.offset);
    const data = db
      .query<{ value: string }, (string | number)[]>(
        `SELECT value FROM records WHERE relation=?${filter}${requestedVersion ? " AND version=?" : ""} ORDER BY name,version,id LIMIT ? OFFSET ?`,
      )
      .all(...values);
    const rows = data.slice(0, count).map(({ value }) => ({
      ...(JSON.parse(value) as Row),
      snapshot_id: info.snapshot,
      source_revision: info.revision,
      observed_at: info.observed_at,
      search_mode: "indexed",
      coverage: info.scope,
      complete: info.complete,
    }));
    return { rows, next: data.length > count ? json({ snapshot: info.snapshot, offset: cursor.offset + count }) : "" };
  } finally {
    db.close();
  }
}
export function* packageRecords(row: Row): Generator<IndexedRecord> {
  yield { relation: "package", row };
  if (row.version) yield { relation: "versions", row };
}
export function* paragraphs(text: string, colon = true): Generator<Record<string, string>> {
  let record: Record<string, string> = {},
    key = "";
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      if (Object.keys(record).length) yield record;
      record = {};
      key = "";
      continue;
    }
    if (colon && /^\s/.test(line) && key) {
      record[key] += `\n${line.trimStart()}`;
      continue;
    }
    const p = line.indexOf(":");
    if (p < 1) throw new RegistryError("MALFORMED", "Invalid repository control field");
    key = line.slice(0, p);
    record[key] = line.slice(p + 1).trimStart();
  }
  if (Object.keys(record).length) yield record;
}
export function* aptRecords(source: Source, text: string, isSource = false): Generator<IndexedRecord> {
  for (const p of paragraphs(text)) {
    const name = p.Package ?? "",
      version = p.Version ?? "";
    const row = baseRow(source, name, {
      version,
      description: nullable(p.Description),
      architecture: nullable(p.Architecture),
      homepage: nullable(p.Homepage),
      metadata: json({
        source: p.Source,
        source_package: isSource,
        suite: source.options?.suite,
        component: source.options?.component,
      }),
    });
    yield* packageRecords(row);
    if (p.Filename)
      yield {
        relation: "artifacts",
        row: {
          ...row,
          filename: p.Filename,
          url: new URL(p.Filename, `${source.url}/`).toString(),
          size: Number(p.Size) || null,
          hashes: json({ sha256: p.SHA256 }),
          artifact_type: "deb",
        },
      };
    if (isSource)
      for (const file of (p["Checksums-Sha256"] ?? "").split("\n")) {
        const [hash, size, filename] = file.trim().split(/\s+/);
        if (filename)
          yield {
            relation: "artifacts",
            row: {
              ...row,
              filename,
              url: new URL(`${p.Directory}/${filename}`, `${source.url}/`).toString(),
              size: Number(size),
              hashes: json({ sha256: hash }),
              artifact_type: "source",
            },
          };
      }
    for (const kind of [
      "Depends",
      "Pre-Depends",
      "Recommends",
      "Suggests",
      "Provides",
      "Conflicts",
      "Build-Depends",
      "Build-Depends-Indep",
    ])
      for (const expression of (p[kind] ?? "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean)) {
        yield {
          relation: "dependencies",
          row: dependency(source, name, version, expression.split(/[\s(|]/)[0] ?? expression, expression, kind, {
            metadata: json({ alternatives: expression.split("|").map((x) => x.trim()), architecture: p.Architecture }),
          }),
        };
      }
  }
}
export function* condaRecords(source: Source, data: unknown): Generator<IndexedRecord> {
  const body = obj(data);
  for (const group of ["packages", "packages.conda"])
    for (const [file, value] of Object.entries(obj(body[group]))) {
      const p = obj(value),
        name = str(p.name),
        version = str(p.version);
      const row = baseRow(source, name, {
        version,
        license: nullable(p.license),
        platform: nullable(p.subdir) ?? source.options?.subdir ?? null,
        build: nullable(p.build),
        metadata: json({ build_number: p.build_number, channel: source.options?.channel, noarch: p.noarch }),
      });
      yield* packageRecords(row);
      yield {
        relation: "artifacts",
        row: {
          ...row,
          filename: file,
          url: `${source.url.replace(/\/$/, "")}/${encodeURIComponent(file)}`,
          size: num(p.size),
          hashes: json({ sha256: p.sha256, md5: p.md5 }),
          artifact_type: group === "packages.conda" ? "conda" : "tar.bz2",
        },
      };
      for (const kind of ["depends", "constrains"])
        for (const value of arr(p[kind])) {
          const expression = str(value);
          yield {
            relation: "dependencies",
            row: dependency(source, name, version, expression.split(/\s+/)[0] ?? expression, expression, kind, {
              condition: nullable(p.build),
            }),
          };
        }
    }
}
export function* homebrewRecords(source: Source, data: unknown): Generator<IndexedRecord> {
  for (const value of arr(data)) {
    const p = obj(value),
      name = str(p.full_name) || str(p.token) || str(p.name),
      version = str(obj(p.versions).stable) || str(p.version);
    const row = baseRow(source, name, {
      version,
      description: nullable(p.desc),
      homepage: nullable(p.homepage),
      license: nullable(p.license),
      deprecated: p.deprecated === true ? str(p.deprecation_reason) || "deprecated" : null,
      metadata: json({
        tap: p.tap,
        aliases: p.aliases,
        revision: p.revision,
        disabled: p.disabled,
        type: source.options?.type ?? "formula",
      }),
    });
    yield* packageRecords(row);
    const bottles = obj(obj(obj(p.bottle).stable).files);
    for (const [platform, file] of Object.entries(bottles)) {
      const f = obj(file);
      yield {
        relation: "artifacts",
        row: {
          ...row,
          platform,
          filename: nullable(f.url)?.split("/").at(-1) ?? null,
          url: nullable(f.url),
          hashes: json({ sha256: f.sha256 }),
          artifact_type: "bottle",
        },
      };
    }
    const stable = obj(obj(p.urls).stable);
    if (p.url || stable.url)
      yield {
        relation: "artifacts",
        row: {
          ...row,
          url: str(p.url) || str(stable.url),
          hashes: json({ sha256: p.sha256 ?? stable.checksum }),
          artifact_type: p.token ? "cask" : "source",
        },
      };
    for (const kind of [
      "dependencies",
      "build_dependencies",
      "test_dependencies",
      "recommended_dependencies",
      "optional_dependencies",
    ])
      for (const d of arr(p[kind]))
        yield { relation: "dependencies", row: dependency(source, name, version, str(d), str(d), kind) };
    for (const kind of ["formula", "cask"])
      for (const d of arr(obj(p.depends_on)[kind]))
        yield {
          relation: "dependencies",
          row: dependency(source, name, version, str(d), str(d), kind, { condition: json(obj(p.depends_on).macos) }),
        };
  }
}
export function* rpmRecords(source: Source, text: string): Generator<IndexedRecord> {
  const body = obj(obj(parseXml(text)).metadata);
  for (const value of arr(body.package)) {
    const p = obj(value),
      v = obj(p.version),
      format = obj(p.format),
      name = str(p.name),
      version = `${str(v.epoch) || "0"}:${str(v.ver)}-${str(v.rel)}`;
    const row = baseRow(source, name, {
      version,
      architecture: nullable(p.arch),
      description: nullable(p.summary),
      homepage: nullable(p.url),
      license: nullable(format.license),
      metadata: json({ epoch: v.epoch, version: v.ver, release: v.rel, source_rpm: format.sourcerpm }),
    });
    yield* packageRecords(row);
    const href = str(obj(p.location).href);
    yield {
      relation: "artifacts",
      row: {
        ...row,
        filename: href,
        url: new URL(href, `${source.url}/`).toString(),
        size: Number(obj(p.size).package) || null,
        hashes: json({ [str(obj(p.checksum).type) || "unknown"]: obj(p.checksum)["#text"] }),
        artifact_type: "rpm",
      },
    };
    for (const kind of [
      "requires",
      "provides",
      "conflicts",
      "obsoletes",
      "recommends",
      "suggests",
      "supplements",
      "enhances",
    ])
      for (const value of arr(obj(format[kind]).entry)) {
        const d = obj(value);
        yield {
          relation: "dependencies",
          row: dependency(
            source,
            name,
            version,
            str(d.name),
            [d.name, d.flags, d.epoch ? `${str(d.epoch)}:` : "", d.ver, d.rel ? `-${str(d.rel)}` : ""]
              .map(str)
              .filter(Boolean)
              .join(" "),
            kind,
            { metadata: json(d) },
          ),
        };
      }
  }
}
export function* alpineRecords(source: Source, data: string | unknown): Generator<IndexedRecord> {
  const items =
    typeof data === "string"
      ? [...paragraphs(data, false)].map((p) => ({
          name: p.P,
          version: p.V,
          description: p.T,
          arch: p.A,
          url: p.U,
          license: p.L,
          origin: p.o,
          hashes: p.C,
          "file-size": Number(p.S),
          depends: (p.D ?? "").split(" ").filter(Boolean),
          provides: (p.p ?? "").split(" ").filter(Boolean),
        }))
      : arr(obj(data).packages).map(obj);
  for (const value of items) {
    const p = obj(value),
      name = str(p.name),
      version = str(p.version);
    const row = baseRow(source, name, {
      version,
      description: nullable(p.description),
      architecture: nullable(p.arch),
      homepage: nullable(p.url),
      license: nullable(p.license),
      metadata: json({ origin: p.origin, format: source.options?.format ?? "v2" }),
    });
    yield* packageRecords(row);
    yield {
      relation: "artifacts",
      row: {
        ...row,
        filename: `${name}-${version}.apk`,
        url: `${source.url}/${encodeURIComponent(name)}-${encodeURIComponent(version)}.apk`,
        hashes: json({ apk: p.hashes }),
        size: num(p["file-size"]),
        artifact_type: "apk",
      },
    };
    for (const kind of ["depends", "provides", "install-if", "replaces", "recommends"])
      for (const value of arr(p[kind])) {
        const d = obj(value),
          expression = typeof value === "string" ? value : json(d),
          target = typeof value === "string" ? (value.split(/[=<>~]/)[0] ?? value) : str(d.name);
        yield { relation: "dependencies", row: dependency(source, name, version, target, expression, kind) };
      }
  }
}
export function* nixRecords(source: Source, data: unknown): Generator<IndexedRecord> {
  for (const [attribute, value] of Object.entries(obj(data))) {
    const p = obj(value),
      meta = obj(p.meta);
    const version = str(p.version) || str(p.name).match(/-(\d.*)$/)?.[1] || "";
    const row = baseRow(source, attribute, {
      version: version || null,
      description: nullable(meta.description),
      homepage: nullable(meta.homepage),
      license: json(meta.license),
      platform: str(p.system) || source.options?.system || null,
      metadata: json({
        pname: p.pname,
        name: p.name,
        attribute,
        revision: source.options?.revision,
        drvPath: p.drvPath,
        broken: meta.broken,
        platforms: meta.platforms,
      }),
    });
    yield* packageRecords(row);
    for (const [output, path] of Object.entries(obj(p.outputs)))
      yield {
        relation: "artifacts",
        row: {
          ...row,
          filename: output,
          store_path: str(path) || nullable(obj(path).outPath),
          artifact_type: "nix_output",
        },
      };
  }
}
export function tarMember(data: Uint8Array, member: string): Uint8Array {
  let pos = 0;
  while (pos + 512 <= data.length) {
    const header = data.subarray(pos, pos + 512),
      name = decoder.decode(header.subarray(0, 100)).replace(/\0.*$/, "");
    if (!name) {
      pos += 512;
      continue;
    }
    const size = Number.parseInt(decoder.decode(header.subarray(124, 136)).replace(/\0.*$/, "").trim(), 8);
    if (!Number.isSafeInteger(size) || size < 0 || pos + 512 + size > data.length)
      throw new RegistryError("MALFORMED", "Truncated tar index");
    if (name === member || name === `./${member}`) return data.subarray(pos + 512, pos + 512 + size);
    pos += 512 + Math.ceil(size / 512) * 512;
  }
  throw new RegistryError("MALFORMED", `Archive does not contain ${member}`);
}
export async function decompress(data: Uint8Array, url: string, max: number): Promise<Uint8Array> {
  let result: Uint8Array = data;
  if (url.endsWith(".gz")) result = gunzipSync(data, { maxOutputLength: max });
  else if (url.endsWith(".zst")) {
    const output: Uint8Array[] = [];
    let length = 0;
    const { Decompress } = await import("fzstd");
    const d = new Decompress((chunk) => {
      length += chunk.length;
      if (length > max) throw new RegistryError("BUDGET", "Decompressed index exceeds byte limit");
      output.push(chunk);
    });
    d.push(data, true);
    result = new Uint8Array(length);
    let offset = 0;
    for (const part of output) {
      result.set(part, offset);
      offset += part.length;
    }
  } else if (/\.(xz|bz2)$/.test(url)) {
    const tool = url.endsWith(".xz") ? "xz" : "bzip2";
    const directory = mkdtempSync(join(tmpdir(), "vgi-index-"));
    const file = join(directory, "index");
    try {
      writeFileSync(file, data, { mode: 0o600 });
      result = (await runFile(tool, ["-dc", file], { encoding: "buffer", maxBuffer: max, timeout: 30_000 })).stdout;
    } catch {
      throw new RegistryError(
        "DECOMPRESSION",
        `Cannot decode index; ${tool} must be installed and output must fit byte budget`,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  if (result.length > max) throw new RegistryError("BUDGET", "Decompressed index exceeds byte limit");
  return result;
}

export async function prepareIndex(settings: Settings, http: Http, input?: string): Promise<IndexInfo> {
  if (input && statSync(input).size > settings.limits.bytes)
    throw new RegistryError("BUDGET", "Imported index exceeds byte budget");
  const s = http.source,
    root = s.url.replace(/\/$/, ""),
    options = s.options ?? {};
  let revision = options.revision ?? "",
    records: Iterable<IndexedRecord>;
  let fields = "name,description",
    complete = true,
    checkpoint = "",
    append = false;
  const readBytes = async (url: string) =>
    input ? new Uint8Array(readFileSync(input)) : (await http.request(url)).body;
  const readJson = async (url: string, headers?: Record<string, string>) =>
    input ? (JSON.parse(readFileSync(input, "utf8")) as unknown) : http.json(url, headers);
  if (s.kind === "pub") {
    fields = "name";
    const names: IndexedRecord[] = [],
      seen = new Set<string>();
    let url = s.index_url ?? `${root}/api/package-names`;
    do {
      if (seen.has(url)) throw new RegistryError("PAGINATION", "Pub inventory cursor did not advance");
      seen.add(url);
      const data = obj(await readJson(url));
      if (!Array.isArray(data.packages)) throw new RegistryError("MALFORMED", "Pub inventory has no packages array");
      for (const name of data.packages) names.push({ relation: "package", row: baseRow(s, str(name)) });
      url = str(data.nextUrl);
      if (input && url)
        throw new RegistryError("INCOMPLETE_INPUT", "Imported pub inventory must contain all names and no nextUrl");
    } while (url);
    records = names;
  } else if (s.kind === "cran" || s.kind === "bioconductor") {
    const url = s.index_url ?? `${root}/PACKAGES.gz`,
      bytes = await readBytes(url);
    const data = decoder.decode(await decompress(bytes, input ?? url, settings.limits.bytes));
    revision = digest(bytes);
    records = rRecords(s, data);
  } else if (s.kind === "vcpkg") {
    const files = await vcpkgFiles(http, input);
    revision ||= digest(json([...files]));
    records = vcpkgRecords(s, files);
  } else if (s.kind === "pypi") {
    const data = obj(
      await readJson(s.index_url ?? `${root}/simple/`, { Accept: "application/vnd.pypi.simple.v1+json" }),
    );
    revision = str(obj(data.meta)["_last-serial"]);
    fields = "name";
    records = arr(data.projects).map((value) => ({
      relation: "package" as const,
      row: baseRow(
        s,
        str(obj(value).name)
          .toLowerCase()
          .replace(/[-_.]+/g, "-"),
      ),
    }));
  } else if (s.kind === "go") {
    const previous = indexInfo(settings, s, http.secrets);
    checkpoint = previous?.checkpoint ?? options.since ?? "2019-04-10T19:08:52.997264Z";
    const url = new URL(s.index_url ?? "https://index.golang.org/index");
    url.searchParams.set("since", checkpoint);
    url.searchParams.set("limit", "2000");
    const text = input ? readFileSync(input, "utf8") : await http.text(url.toString());
    const values = text
      .trim()
      .split(/\n/)
      .filter(Boolean)
      .map((line) => obj(JSON.parse(line)));
    const last = str(values.at(-1)?.Timestamp);
    if (last === checkpoint && values.length >= 2000)
      throw new RegistryError("INDEX_CHECKPOINT", "Go feed did not advance");
    checkpoint = last || checkpoint;
    fields = "name";
    complete = values.length < 2000;
    append = true;
    records = values.flatMap((p) => [
      ...packageRecords(baseRow(s, str(p.Path), { version: str(p.Version), published_at: nullable(p.Timestamp) })),
    ]);
    revision = checkpoint;
  } else if (s.kind === "conda") records = condaRecords(s, await readJson(s.index_url ?? `${root}/repodata.json`));
  else if (s.kind === "homebrew")
    records = homebrewRecords(
      s,
      await readJson(s.index_url ?? `${root}/api/${options.type === "cask" ? "cask" : "formula"}.json`),
    );
  else if (s.kind === "nixpkgs") {
    if (!/^[a-f0-9]{40}$/.test(revision))
      throw new RegistryError("CONFIG", "nixpkgs requires options.revision pinned to a 40-character Git commit");
    let data: unknown;
    if (input) data = JSON.parse(readFileSync(input, "utf8"));
    else {
      try {
        const result = await runFile(
          options.nix_env ?? "nix-env",
          [
            "-f",
            `${root}/archive/${revision}.tar.gz`,
            "-qa",
            "--json",
            "--meta",
            "--argstr",
            "system",
            options.system ?? "x86_64-linux",
          ],
          { timeout: settings.limits.timeout_ms, maxBuffer: settings.limits.bytes },
        );
        data = JSON.parse(result.stdout);
      } catch {
        throw new RegistryError(
          "EVALUATION",
          "Nix evaluation failed; install nix-env or import a pinned JSON export with --input",
        );
      }
    }
    records = nixRecords(s, data);
  } else if (s.kind === "apt") {
    const isSource = options.type === "source";
    let url =
      s.index_url ??
      `${root}/dists/${options.suite ?? "stable"}/${options.component ?? "main"}/${isSource ? "source/Sources" : `binary-${options.architecture ?? "amd64"}/Packages`}.gz`;
    let expected = "";
    if (!input && !s.index_url) {
      const release = await http.text(`${root}/dists/${options.suite ?? "stable"}/Release`);
      revision = digest(release);
      const p = [...paragraphs(release)][0] ?? {},
        wanted = `${options.component ?? "main"}/${isSource ? "source/Sources" : `binary-${options.architecture ?? "amd64"}/Packages`}`;
      const lines = (p.SHA256 ?? "").split("\n").map((line) => line.trim().split(/\s+/));
      const choice = [".gz", ".xz", ""].map((ext) => lines.find((v) => v[2] === wanted + ext)).find(Boolean);
      if (!choice) throw new RegistryError("MALFORMED", "Release file does not list requested package index");
      expected = choice[0] ?? "";
      url = `${root}/dists/${options.suite ?? "stable"}/${choice[2]}`;
    }
    const bytes = await readBytes(url);
    if (expected && digest(bytes) !== expected)
      throw new RegistryError("CHECKSUM", "APT index changed or failed checksum validation");
    records = aptRecords(s, decoder.decode(await decompress(bytes, input ?? url, settings.limits.bytes)), isSource);
  } else if (s.kind === "rpm") {
    let url = s.index_url ?? "",
      expected = "",
      algorithm = "";
    if (!url && !input) {
      const text = await http.text(`${root}/repodata/repomd.xml`);
      revision = digest(text);
      const metadata = obj(obj(parseXml(text)).repomd);
      const primary = arr(metadata.data)
        .map(obj)
        .find((p) => p.type === "primary");
      if (!primary) throw new RegistryError("MALFORMED", "RPM repository has no primary metadata");
      url = new URL(str(obj(primary.location).href), `${root}/`).toString();
      expected = str(obj(primary.checksum)["#text"]);
      algorithm = str(obj(primary.checksum).type);
    }
    const bytes = await readBytes(url);
    if (expected && !["sha256", "sha512", "sha", "sha1"].includes(algorithm))
      throw new RegistryError("UNSUPPORTED", "Unsupported RPM checksum algorithm");
    if (
      expected &&
      createHash(algorithm === "sha" ? "sha1" : algorithm)
        .update(bytes)
        .digest("hex") !== expected
    )
      throw new RegistryError("CHECKSUM", "RPM primary index checksum mismatch");
    records = rpmRecords(s, decoder.decode(await decompress(bytes, input ?? url, settings.limits.bytes)));
  } else if (s.kind === "alpine") {
    if (options.format === "v3") {
      if (input?.endsWith(".json")) records = alpineRecords(s, JSON.parse(readFileSync(input, "utf8")));
      else {
        const bytes = await readBytes(s.index_url ?? `${root}/Packages.adb`),
          directory = mkdtempSync(join(tmpdir(), "vgi-adb-")),
          file = join(directory, "Packages.adb");
        try {
          writeFileSync(file, bytes, { mode: 0o600 });
          const output = await runFile(options.apk ?? "apk", ["adbdump", "--format", "json", file], {
            timeout: settings.limits.timeout_ms,
            maxBuffer: settings.limits.bytes,
          });
          records = alpineRecords(s, JSON.parse(output.stdout));
        } catch {
          throw new RegistryError(
            "ADB_DECODE",
            "Alpine v3 needs apk-tools with adbdump, or a JSON adbdump export via --input",
          );
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      }
    } else {
      const url = s.index_url ?? `${root}/APKINDEX.tar.gz`,
        bytes = await readBytes(url);
      const data = await decompress(bytes, input ?? url, settings.limits.bytes);
      records = alpineRecords(
        s,
        decoder.decode((input ?? url).endsWith(".tar.gz") ? tarMember(data, "APKINDEX") : data),
      );
    }
  } else throw new RegistryError("UNSUPPORTED", `${s.kind} uses native search and does not need an index`);
  const bounded = function* () {
    for (const record of records) {
      http.remaining();
      yield record;
    }
  };
  return writeIndex(
    settings,
    s,
    bounded(),
    {
      revision,
      fields,
      complete,
      checkpoint,
      scope: json({
        source: safeUrl(s.url),
        options,
        discovery:
          s.kind === "go"
            ? "public feed observed since initial checkpoint or supplied private inventory"
            : "configured repository snapshot",
      }),
    },
    http.secrets,
    append,
  );
}
