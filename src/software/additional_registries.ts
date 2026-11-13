import type { Http } from "./http.ts";
import {
  arr,
  baseRow,
  dependency,
  json,
  nullable,
  obj,
  type Page,
  pathName,
  type Query,
  RegistryError,
  rowsPage,
  str,
} from "./model.ts";

export async function packagist(http: Http, q: Query): Promise<Page> {
  const s = http.source,
    root = s.url.replace(/\/$/, "");
  if (q.operation === "search") {
    const page = Number(q.cursor || 1);
    const data = await http.object(
      `${root}/search.json?${new URLSearchParams({ q: q.query, page: String(page), per_page: "100" })}`,
    );
    return {
      rows: arr(data.results)
        .slice(0, q.limit)
        .map((value) => {
          const p = obj(value);
          return baseRow(s, str(p.name), {
            description: nullable(p.description),
            url: nullable(p.url),
            search_mode: "native",
          });
        }),
      next: data.next ? String(page + 1) : "",
    };
  }
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(q.name))
    throw new RegistryError("ARGUMENT", "Use a Composer vendor/package name");
  const p = obj((await http.object(`${root}/packages/${pathName(q.name)}.json`)).package);
  if (!p.name) throw new RegistryError("MALFORMED", "Packagist response has no package");
  const versions = obj(p.versions);
  if (q.operation === "package")
    return {
      rows: [
        baseRow(s, str(p.name), {
          description: nullable(p.description),
          repository: nullable(p.repository),
          deprecated: p.abandoned ? str(p.abandoned) || "abandoned" : null,
          metadata: json({ type: p.type, abandoned: p.abandoned }),
        }),
      ],
      next: "",
    };
  if (q.operation === "versions")
    return rowsPage(
      Object.entries(versions).map(([version, value]) => {
        const v = obj(value);
        return baseRow(s, q.name, {
          version,
          published_at: nullable(v.time),
          license: json(v.license),
          metadata: json({ normalized: v.version_normalized }),
        });
      }),
      q,
    );
  const v = obj(versions[q.version]);
  if (!Object.keys(v).length) throw new RegistryError("NOT_FOUND", "Composer version was not found");
  if (q.operation === "artifacts")
    return rowsPage(
      ["dist", "source"].flatMap((kind) => {
        const a = obj(v[kind]);
        return a.url
          ? [
              baseRow(s, q.name, {
                version: q.version,
                url: str(a.url),
                artifact_type: str(a.type) || kind,
                hashes: json({ sha1: a.shasum }),
                metadata: json({ kind, reference: a.reference }),
              }),
            ]
          : [];
      }),
      q,
    );
  return rowsPage(
    ["require", "require-dev", "conflict", "provide", "replace", "suggest"].flatMap((kind) =>
      Object.entries(obj(v[kind])).map(([target, requirement]) =>
        dependency(s, q.name, q.version, target, str(requirement), kind),
      ),
    ),
    q,
  );
}

export async function pub(http: Http, q: Query): Promise<Page> {
  const s = http.source,
    root = s.url.replace(/\/$/, "");
  if (!/^[a-zA-Z0-9_]+$/.test(q.name)) throw new RegistryError("ARGUMENT", "Invalid Dart package name");
  const url = `${root}/api/packages/${encodeURIComponent(q.name)}`;
  const exact = q.operation === "artifacts" || q.operation === "dependencies";
  const data = await http.object(exact ? `${url}/versions/${encodeURIComponent(q.version)}` : url, {
    Accept: "application/vnd.pub.v2+json",
  });
  const versionRow = (value: unknown) => {
    const v = obj(value),
      spec = obj(v.pubspec);
    return baseRow(s, q.name, {
      version: str(v.version),
      description: nullable(spec.description),
      homepage: nullable(spec.homepage),
      repository: nullable(spec.repository),
      published_at: nullable(v.published),
      yanked: typeof v.retracted === "boolean" ? v.retracted : null,
      deprecated: data.isDiscontinued === true ? "discontinued" : null,
      metadata: json({ environment: spec.environment, replacedBy: data.replacedBy, topics: spec.topics }),
    });
  };
  if (q.operation === "versions") return rowsPage(arr(data.versions).map(versionRow), q);
  const v = exact ? data : obj(data.latest),
    spec = obj(v.pubspec);
  if (!v.version) throw new RegistryError("MALFORMED", "Pub response has no version");
  const common = versionRow(v);
  if (q.operation === "package") return { rows: [common], next: "" };
  if (q.operation === "artifacts")
    return {
      rows: [
        {
          ...common,
          url: nullable(v.archive_url),
          artifact_type: "tar.gz",
          hashes: json({ sha256: v.archive_sha256 }),
        },
      ],
      next: "",
    };
  return rowsPage(
    ["dependencies", "dev_dependencies"].flatMap((kind) =>
      Object.entries(obj(spec[kind])).map(([target, value]) =>
        dependency(s, q.name, str(v.version), target, typeof value === "string" ? value : json(value), kind, {
          condition: json(spec.environment),
          metadata: json(typeof value === "object" ? value : {}),
        }),
      ),
    ),
    q,
  );
}

export async function hex(http: Http, q: Query): Promise<Page> {
  const s = http.source,
    root = s.url.replace(/\/$/, ""),
    repo = s.options?.repository;
  const api = `${root}/api${repo ? `/repos/${encodeURIComponent(repo)}` : ""}/packages`;
  if (q.operation === "search") {
    const page = Number(q.cursor || 1);
    const data = await http.json(
      `${api}?${new URLSearchParams({ search: q.query, page: String(page), sort: "name" })}`,
    );
    if (!Array.isArray(data)) throw new RegistryError("MALFORMED", "Expected Hex package list");
    return {
      rows: data.slice(0, q.limit).map((value) => {
        const p = obj(value);
        return baseRow(s, str(p.name), {
          version: nullable(p.latest_stable_version) ?? nullable(p.latest_version),
          description: nullable(obj(p.meta).description),
          url: nullable(p.html_url),
          search_mode: "native",
        });
      }),
      next: data.length === 100 ? String(page + 1) : "",
    };
  }
  const endpoint = `${api}/${encodeURIComponent(q.name)}`;
  const p = await http.object(
    ["artifacts", "dependencies"].includes(q.operation)
      ? `${endpoint}/releases/${encodeURIComponent(q.version)}`
      : endpoint,
  );
  if (q.operation === "package")
    return {
      rows: [
        baseRow(s, q.name, {
          version: nullable(p.latest_stable_version) ?? nullable(p.latest_version),
          description: nullable(obj(p.meta).description),
          license: json(obj(p.meta).licenses),
          metadata: json({ links: obj(p.meta).links, repository: p.repository }),
        }),
      ],
      next: "",
    };
  if (q.operation === "versions")
    return rowsPage(
      arr(p.releases).map((value) => {
        const v = obj(value);
        return baseRow(s, q.name, {
          version: str(v.version),
          published_at: nullable(v.inserted_at),
          deprecated: v.retirement ? json(v.retirement) : null,
        });
      }),
      q,
    );
  if (q.operation === "artifacts")
    return {
      rows: [
        baseRow(s, q.name, {
          version: q.version,
          url: `${(s.registry_url ?? "https://repo.hex.pm").replace(/\/$/, "")}${repo ? `/repos/${encodeURIComponent(repo)}` : ""}/tarballs/${encodeURIComponent(q.name)}-${encodeURIComponent(q.version)}.tar`,
          artifact_type: "hex",
          hashes: json({ sha256: p.checksum }),
          metadata: json(p.meta),
        }),
      ],
      next: "",
    };
  return rowsPage(
    Object.entries(obj(p.requirements)).map(([target, value]) => {
      const d = obj(value);
      return dependency(
        s,
        q.name,
        q.version,
        target,
        str(d.requirement),
        d.optional === true ? "optional" : "runtime",
        { metadata: json({ app: d.app, repository: d.repository, elixir: obj(p.meta).elixir }) },
      );
    }),
    q,
  );
}
