import { XMLParser } from "fast-xml-parser";
import type { Http } from "./http.ts";
import {
  arr,
  baseRow,
  dependency,
  json,
  nullable,
  obj,
  type Page,
  type Query,
  RegistryError,
  type Row,
  rowsPage,
  str,
} from "./model.ts";

export function parseXml(text: string): unknown {
  if (/<!DOCTYPE|<!ENTITY/i.test(text))
    throw new RegistryError("MALFORMED", "XML declarations with entities are unsupported");
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    parseTagValue: false,
    removeNSPrefix: true,
    processEntities: false,
  }).parse(text);
}
const escapeSolr = (s: string) => s.replace(/([+\-&|!(){}[\]^"~*?:\\/])/g, "\\$1");
export async function maven(http: Http, q: Query): Promise<Page> {
  const s = http.source,
    root = s.url.replace(/\/$/, "");
  if (q.operation === "search" || q.operation === "versions") {
    const parts = q.name.split(":"),
      offset = Number(q.cursor || 0),
      size = Math.min(q.limit, 100);
    if (q.operation === "versions" && parts.length !== 2)
      throw new RegistryError("ARGUMENT", "Maven names use groupId:artifactId");
    const expression =
      q.operation === "search"
        ? escapeSolr(q.query)
        : `g:"${escapeSolr(parts[0] ?? "")}" AND a:"${escapeSolr(parts[1] ?? "")}"`;
    const params = new URLSearchParams({ q: expression, rows: String(size), start: String(offset), wt: "json" });
    if (q.operation === "versions") params.set("core", "gav");
    const response = obj((await http.object(`${root}/solrsearch/select?${params}`)).response);
    const rows = arr(response.docs).map((value) => {
      const d = obj(value);
      return baseRow(s, `${str(d.g)}:${str(d.a)}`, {
        version: str(d.v) || nullable(d.latestVersion),
        description: nullable(d.description),
        published_at: typeof d.timestamp === "number" ? new Date(d.timestamp).toISOString() : null,
        metadata: json({ packaging: d.p, extensions: d.ec }),
        search_mode: "native",
      });
    });
    return {
      rows,
      next: rows.length && offset + rows.length < Number(response.numFound) ? String(offset + rows.length) : "",
    };
  }
  const parts = q.name.split(":");
  if (parts.length !== 2) throw new RegistryError("ARGUMENT", "Maven names use groupId:artifactId");
  const group = parts[0] ?? "",
    artifact = parts[1] ?? "";
  const base = `${(s.registry_url ?? s.url).replace(/\/$/, "")}/${group.split(".").map(encodeURIComponent).join("/")}/${encodeURIComponent(artifact)}`;
  let version = q.version;
  if (!version && q.operation === "package") {
    const metadata = obj(obj(parseXml(await http.text(`${base}/maven-metadata.xml`))).metadata);
    version = str(obj(metadata.versioning).release) || str(obj(metadata.versioning).latest);
  }
  if (!version) throw new RegistryError("ARGUMENT", "An exact Maven version is required");
  const directory = `${base}/${encodeURIComponent(version)}`,
    pomUrl = `${directory}/${encodeURIComponent(artifact)}-${encodeURIComponent(version)}.pom`;
  const p = obj(obj(parseXml(await http.text(pomUrl))).project);
  if (q.operation === "package")
    return {
      rows: [
        baseRow(s, q.name, {
          version,
          description: nullable(p.description),
          homepage: nullable(p.url),
          repository: nullable(obj(p.scm).url),
          license: json(obj(p.licenses).license),
          metadata: json({ parent: p.parent, packaging: p.packaging, properties: p.properties }),
        }),
      ],
      next: "",
    };
  if (q.operation === "artifacts") {
    const extension = str(p.packaging) || "jar";
    const types = new Set(["pom", extension === "bundle" || extension === "maven-plugin" ? "jar" : extension]);
    return rowsPage(
      [...types].map((type) =>
        baseRow(s, q.name, {
          version,
          filename: `${artifact}-${version}.${type}`,
          url: `${directory}/${encodeURIComponent(artifact)}-${encodeURIComponent(version)}.${type}`,
          artifact_type: type,
          metadata: json({ discovery: "POM packaging; classifier variants require explicit metadata" }),
        }),
      ),
      q,
    );
  }
  const rows: Row[] = [];
  const properties = {
    ...obj(p.properties),
    "project.version": version,
    "project.groupId": group,
    "project.artifactId": artifact,
  };
  for (const [context, container] of [
    ["dependencies", p.dependencies],
    ["dependencyManagement", obj(p.dependencyManagement).dependencies],
  ] as const) {
    for (const value of arr(obj(container).dependency)) {
      const d = obj(value),
        expression = str(d.version);
      const resolved = expression.replace(
        /\$\{([^}]+)\}/g,
        (whole: string, key: string) => str(obj(properties)[key]) || whole,
      );
      rows.push(
        dependency(s, q.name, version, `${str(d.groupId)}:${str(d.artifactId)}`, resolved, str(d.scope) || "compile", {
          declaration_context: context,
          metadata: json({
            original_requirement: expression,
            unresolved: !resolved || resolved.includes("${"),
            parent: p.parent,
            type: d.type,
            classifier: d.classifier,
            optional: d.optional,
            exclusions: d.exclusions,
          }),
        }),
      );
    }
  }
  return rowsPage(rows, q);
}

async function nugetResources(http: Http): Promise<Record<string, string>> {
  const index = await http.object(http.source.url),
    result: Record<string, string> = {};
  for (const item of arr(index.resources)) {
    const r = obj(item);
    for (const type of arr(r["@type"])) {
      const key = str(type).split("/")[0];
      if (key && !result[key]) result[key] = str(r["@id"]);
    }
  }
  return result;
}
export async function nuget(http: Http, q: Query): Promise<Page> {
  const s = http.source,
    resources = await nugetResources(http),
    id = q.name.toLowerCase();
  const resource = (type: string) => {
    const url = resources[type];
    if (!url) throw new RegistryError("UNSUPPORTED", `NuGet feed does not advertise ${type}`);
    return url.replace(/\/$/, "");
  };
  if (q.operation === "search") {
    const offset = Number(q.cursor || 0),
      size = Math.min(100, q.limit);
    const url = new URL(resource("SearchQueryService"));
    for (const [key, value] of Object.entries({
      q: q.query,
      skip: String(offset),
      take: String(size),
      prerelease: "true",
      semVerLevel: "2.0.0",
    }))
      url.searchParams.set(key, value);
    const data = await http.object(url.toString());
    const rows = arr(data.data).map((value) => {
      const p = obj(value);
      return baseRow(s, str(p.id), {
        version: nullable(p.version),
        description: nullable(p.description),
        homepage: nullable(p.projectUrl),
        search_mode: "native",
      });
    });
    return {
      rows,
      next: rows.length && offset + rows.length < Number(data.totalHits) ? String(offset + rows.length) : "",
    };
  }
  if (q.operation === "versions") {
    const data = await http.object(`${resource("PackageBaseAddress")}/${encodeURIComponent(id)}/index.json`);
    return rowsPage(
      arr(data.versions).map((version) => baseRow(s, id, { version: str(version) })),
      q,
    );
  }
  if (q.operation === "artifacts") {
    if (!q.version) throw new RegistryError("ARGUMENT", "An exact version is required");
    const v = q.version.toLowerCase(),
      file = `${id}.${v}.nupkg`;
    return {
      rows: [
        baseRow(s, id, {
          version: v,
          filename: file,
          url: `${resource("PackageBaseAddress")}/${encodeURIComponent(id)}/${encodeURIComponent(v)}/${encodeURIComponent(file)}`,
          artifact_type: "nupkg",
        }),
      ],
      next: "",
    };
  }
  const data = await http.object(`${resource("RegistrationsBaseUrl")}/${encodeURIComponent(id)}/index.json`);
  const leaves: Record<string, unknown>[] = [];
  for (const value of arr(data.items)) {
    let page = obj(value);
    if (!Array.isArray(page.items)) page = await http.object(str(page["@id"]));
    for (const leaf of arr(page.items)) {
      const entry = obj(leaf).catalogEntry;
      const p = typeof entry === "string" ? await http.object(entry) : obj(entry);
      if (!q.version || str(p.version).toLowerCase() === q.version.toLowerCase()) leaves.push(p);
    }
  }
  if (!leaves.length) throw new RegistryError("NOT_FOUND", "No matching NuGet registration");
  if (q.operation === "package") {
    const p = leaves.at(-1) ?? {};
    return {
      rows: [
        baseRow(s, str(p.id) || id, {
          version: nullable(p.version),
          description: nullable(p.description),
          homepage: nullable(p.projectUrl),
          license: nullable(p.licenseExpression),
          metadata: json({
            listed: p.listed,
            selection: "last provider registration entry; inspect versions for all releases",
          }),
        }),
      ],
      next: "",
    };
  }
  if (!q.version) throw new RegistryError("ARGUMENT", "An exact version is required");
  const rows: Row[] = [];
  for (const p of leaves)
    for (const value of arr(p.dependencyGroups)) {
      const group = obj(value);
      for (const value of arr(group.dependencies)) {
        const d = obj(value);
        rows.push(
          dependency(s, id, str(p.version), str(d.id), str(d.range), "dependency", {
            condition: nullable(group.targetFramework),
          }),
        );
      }
    }
  return rowsPage(rows, q);
}
