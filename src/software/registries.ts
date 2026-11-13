import type { Http } from "./http.ts";
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
  rowsPage,
  str,
} from "./model.ts";

function root(http: Http) {
  return http.source.url.replace(/\/$/, "");
}
function requireVersion(q: Query) {
  if (!q.version) throw new RegistryError("ARGUMENT", "An exact version is required");
}

export async function npm(http: Http, q: Query): Promise<Page> {
  const s = http.source;
  if (q.operation === "search") {
    const offset = Number(q.cursor || 0),
      size = Math.min(250, q.limit);
    const body = await http.object(
      `${root(http)}/-/v1/search?${new URLSearchParams({ text: q.query, from: String(offset), size: String(size) })}`,
    );
    const rows = arr(body.objects).map((item) => {
      const p = obj(obj(item).package);
      return baseRow(s, str(p.name), {
        version: nullable(p.version),
        description: nullable(p.description),
        url: nullable(obj(p.links).npm),
        score: num(obj(obj(item).score).final),
        search_mode: "native",
      });
    });
    return { rows, next: rows.length && offset + rows.length < Number(body.total) ? String(offset + rows.length) : "" };
  }
  const body = await http.object(`${root(http)}/${encodeURIComponent(q.name)}`);
  const versions = obj(body.versions);
  if (q.operation === "versions")
    return rowsPage(
      Object.entries(versions).map(([version, data]) =>
        baseRow(s, q.name, {
          version,
          published_at: nullable(obj(body.time)[version]),
          deprecated: nullable(obj(data).deprecated),
          metadata: json({ tags: body["dist-tags"] }),
        }),
      ),
      q,
    );
  const v = q.version || str(obj(body["dist-tags"]).latest);
  const p = obj(versions[v]);
  if (!Object.keys(p).length) throw new RegistryError("NOT_FOUND", "Package version was not found");
  if (q.operation === "package")
    return {
      rows: [
        baseRow(s, str(p.name) || q.name, {
          version: v,
          description: nullable(p.description),
          homepage: nullable(p.homepage),
          license: nullable(p.license),
          repository: nullable(obj(p.repository).url),
          metadata: json({ tags: body["dist-tags"] }),
        }),
      ],
      next: "",
    };
  requireVersion(q);
  if (q.operation === "artifacts")
    return {
      rows: [
        baseRow(s, q.name, {
          version: v,
          filename: `${q.name.split("/").at(-1)}-${v}.tgz`,
          url: nullable(obj(p.dist).tarball),
          hashes: json({ integrity: obj(p.dist).integrity, shasum: obj(p.dist).shasum }),
          size: null,
          metadata: json({ unpacked_size: obj(p.dist).unpackedSize }),
          artifact_type: "tarball",
        }),
      ],
      next: "",
    };
  const rows: Row[] = [];
  for (const kind of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"])
    for (const [name, requirement] of Object.entries(obj(p[kind])))
      rows.push(
        dependency(s, q.name, v, name, str(requirement), kind, {
          metadata: json(obj(obj(p.peerDependenciesMeta)[name])),
        }),
      );
  return rowsPage(rows, q);
}

export async function pypi(http: Http, q: Query): Promise<Page> {
  const name = q.name.toLowerCase().replace(/[-_.]+/g, "-");
  const s = http.source;
  if (q.operation === "versions") {
    const body = await http.object(`${root(http)}/simple/${encodeURIComponent(name)}/`, {
      Accept: "application/vnd.pypi.simple.v1+json",
    });
    let versions = arr(body.versions).map(str);
    if (!versions.length) {
      const project = await http.object(`${root(http)}/pypi/${encodeURIComponent(name)}/json`);
      versions = Object.keys(obj(project.releases));
    }
    return rowsPage(
      versions.map((version) => baseRow(s, name, { version })),
      q,
    );
  }
  if (q.operation !== "package") requireVersion(q);
  const body = await http.object(
    `${root(http)}/pypi/${encodeURIComponent(name)}${q.version ? `/${encodeURIComponent(q.version)}` : ""}/json`,
  );
  const info = obj(body.info),
    version = str(info.version);
  if (q.operation === "package")
    return {
      rows: [
        baseRow(s, str(info.name) || name, {
          version,
          description: nullable(info.summary),
          homepage: nullable(info.home_page),
          license: nullable(info.license_expression) ?? nullable(info.license),
          repository: nullable(obj(info.project_urls).Source),
          metadata: json({ requires_python: info.requires_python, project_urls: info.project_urls }),
        }),
      ],
      next: "",
    };
  if (q.operation === "artifacts")
    return rowsPage(
      arr(body.urls).map((value) => {
        const f = obj(value);
        return baseRow(s, name, {
          version,
          filename: str(f.filename),
          url: nullable(f.url),
          hashes: json(f.digests),
          size: num(f.size),
          artifact_type: nullable(f.packagetype),
          yanked: f.yanked === true,
          metadata: json({
            requires_python: f.requires_python,
            python_version: f.python_version,
            core_metadata: f["core-metadata"],
            yanked_reason: f.yanked_reason,
          }),
        });
      }),
      q,
    );
  return rowsPage(
    arr(info.requires_dist).map((value) => {
      const expression = str(value),
        target = expression.match(/^\s*([\w.-]+)/)?.[1] ?? expression;
      return dependency(s, name, version, target, expression, "requires_dist", {
        condition: expression.includes(";") ? expression.slice(expression.indexOf(";") + 1).trim() : null,
        declaration_context: "PyPI release metadata; per-file metadata may differ",
      });
    }),
    q,
  );
}

export async function crates(http: Http, q: Query): Promise<Page> {
  const s = http.source;
  if (q.operation === "search") {
    const page = Number(q.cursor || 1),
      size = 100;
    const data = await http.object(
      `${root(http)}/api/v1/crates?${new URLSearchParams({ q: q.query, page: String(page), per_page: String(size) })}`,
    );
    const rows = arr(data.crates).map((v) => {
      const c = obj(v);
      return baseRow(s, str(c.name) || str(c.id), {
        version: nullable(c.max_version),
        description: nullable(c.description),
        url: `${root(http)}/crates/${encodeURIComponent(str(c.name) || str(c.id))}`,
        search_mode: "native",
      });
    });
    return { rows, next: page * size < Number(obj(data.meta).total) && rows.length ? String(page + 1) : "" };
  }
  if (q.operation === "dependencies") {
    requireVersion(q);
    const body = await http.object(
      `${root(http)}/api/v1/crates/${encodeURIComponent(q.name)}/${encodeURIComponent(q.version)}/dependencies`,
    );
    return rowsPage(
      arr(body.dependencies).map((value) => {
        const d = obj(value);
        return dependency(s, q.name, q.version, str(d.crate_id), str(d.req), str(d.kind), {
          condition: nullable(d.target),
          metadata: json({ optional: d.optional, features: d.features, default_features: d.default_features }),
        });
      }),
      q,
    );
  }
  const data = await http.object(
    `${root(http)}/api/v1/crates/${encodeURIComponent(q.name)}${q.operation === "artifacts" ? `/${encodeURIComponent(q.version)}` : ""}`,
  );
  if (q.operation === "package") {
    const c = obj(data.crate);
    return {
      rows: [
        baseRow(s, q.name, {
          version: nullable(c.max_version),
          description: nullable(c.description),
          homepage: nullable(c.homepage),
          repository: nullable(c.repository),
        }),
      ],
      next: "",
    };
  }
  if (q.operation === "artifacts") {
    requireVersion(q);
    const v = obj(data.version);
    return {
      rows: [
        baseRow(s, q.name, {
          version: q.version,
          filename: `${q.name}-${q.version}.crate`,
          url: new URL(str(v.dl_path) || `/api/v1/crates/${q.name}/${q.version}/download`, s.url).toString(),
          hashes: json({ sha256: v.checksum }),
          size: num(v.crate_size),
          artifact_type: "crate",
          yanked: v.yanked === true,
          metadata: json({ features: v.features }),
        }),
      ],
      next: "",
    };
  }
  return rowsPage(
    arr(data.versions).map((value) => {
      const v = obj(value);
      return baseRow(s, q.name, {
        version: str(v.num),
        published_at: nullable(v.created_at),
        yanked: v.yanked === true,
        license: nullable(v.license),
        metadata: json({ features: v.features, rust_version: v.rust_version }),
      });
    }),
    q,
  );
}

export async function rubygems(http: Http, q: Query): Promise<Page> {
  const s = http.source;
  if (q.operation === "search") {
    const page = Number(q.cursor || 1);
    const values = arr(
      await http.json(
        `${root(http)}/api/v1/search.json?${new URLSearchParams({ query: q.query, page: String(page) })}`,
      ),
    );
    return {
      rows: values.slice(0, q.limit).map((v) => {
        const g = obj(v);
        return baseRow(s, str(g.name), {
          version: nullable(g.version),
          description: nullable(g.info),
          url: nullable(g.project_uri),
          search_mode: "native",
        });
      }),
      next: values.length >= 30 ? String(page + 1) : "",
    };
  }
  if (q.operation === "versions" || q.operation === "artifacts") {
    const values = arr(await http.json(`${root(http)}/api/v1/versions/${encodeURIComponent(q.name)}.json`)).map(obj);
    if (q.operation === "versions")
      return rowsPage(
        values.map((v) =>
          baseRow(s, q.name, {
            version: str(v.number),
            platform: nullable(v.platform),
            published_at: nullable(v.created_at),
            metadata: json({ ruby: v.ruby_version, rubygems: v.rubygems_version, prerelease: v.prerelease }),
          }),
        ),
        q,
      );
    requireVersion(q);
    return rowsPage(
      values
        .filter((v) => str(v.number) === q.version)
        .map((v) => {
          const platform = str(v.platform),
            file = `${q.name}-${q.version}${platform && platform !== "ruby" ? `-${platform}` : ""}.gem`;
          return baseRow(s, q.name, {
            version: q.version,
            filename: file,
            platform,
            url: `${root(http)}/gems/${encodeURIComponent(file)}`,
            hashes: json({ sha256: v.sha }),
            artifact_type: "gem",
          });
        }),
      q,
    );
  }
  const path =
    q.operation === "dependencies"
      ? `/api/v2/rubygems/${encodeURIComponent(q.name)}/versions/${encodeURIComponent(q.version)}.json`
      : `/api/v1/gems/${encodeURIComponent(q.name)}.json`;
  if (q.operation === "dependencies") requireVersion(q);
  const data = await http.object(`${root(http)}${path}`);
  if (q.operation === "package")
    return {
      rows: [
        baseRow(s, q.name, {
          version: nullable(data.version),
          description: nullable(data.info),
          homepage: nullable(data.homepage_uri),
          repository: nullable(data.source_code_uri),
          license: json(data.licenses),
        }),
      ],
      next: "",
    };
  const rows: Row[] = [];
  for (const kind of ["runtime", "development"])
    for (const value of arr(obj(data.dependencies)[kind])) {
      const d = obj(value);
      rows.push(dependency(s, q.name, q.version, str(d.name), str(d.requirements), kind));
    }
  return rowsPage(rows, q);
}

export function goEscape(value: string) {
  return value
    .replace(/[A-Z]/g, (c) => `!${c.toLowerCase()}`)
    .split("/")
    .map(encodeURIComponent)
    .join("/");
}
export function goDependencies(http: Http, name: string, version: string, content: string): Row[] {
  const rows: Row[] = [];
  let block = "";
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === ")") {
      block = "";
      continue;
    }
    const start = trimmed.match(/^(require|replace|exclude)\s+\($/);
    if (start) {
      block = start[1] ?? "";
      continue;
    }
    const single = trimmed.match(/^(require|replace|exclude)\s+(.+)$/);
    const kind = single?.[1] ?? block,
      expression = single?.[2] ?? trimmed;
    if (!kind || !expression || expression.startsWith("//")) continue;
    const words = expression
      .replace(/\s*\/\/.*$/, "")
      .trim()
      .split(/\s+/);
    rows.push(
      dependency(http.source, name, version, (words[0] ?? "").replace(/^"|"$/g, ""), expression, kind, {
        condition: /\/\/\s*indirect/.test(line) ? "indirect" : null,
      }),
    );
  }
  return rows;
}
export async function goModules(http: Http, q: Query): Promise<Page> {
  const base = `${root(http)}/${goEscape(q.name)}`;
  if (q.operation === "versions")
    return rowsPage(
      (await http.text(`${base}/@v/list`))
        .split(/\s+/)
        .filter(Boolean)
        .map((version) => baseRow(http.source, q.name, { version })),
      q,
    );
  if (q.operation === "package") {
    const info = await http.object(`${base}/@latest`);
    return {
      rows: [
        baseRow(http.source, q.name, {
          version: str(info.Version),
          published_at: nullable(info.Time),
          metadata: json(info.Origin),
        }),
      ],
      next: "",
    };
  }
  requireVersion(q);
  if (q.operation === "artifacts")
    return {
      rows: [
        baseRow(http.source, q.name, {
          version: q.version,
          filename: `${q.version}.zip`,
          url: `${base}/@v/${goEscape(q.version)}.zip`,
          artifact_type: "module_zip",
        }),
      ],
      next: "",
    };
  return rowsPage(goDependencies(http, q.name, q.version, await http.text(`${base}/@v/${goEscape(q.version)}.mod`)), q);
}
