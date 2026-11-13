import { loadSettings, sourceById } from "./config.ts";
import { containers } from "./containers.ts";
import { Http, type Secrets, safeUrl } from "./http.ts";
import { indexInfo, readIndex } from "./indexes.ts";
import { maven, nuget } from "./maven_nuget.ts";
import {
  type Budget,
  INDEXED,
  json,
  type Operation,
  type Page,
  type Query,
  RegistryError,
  type Row,
  type Settings,
  type Source,
} from "./model.ts";
import { crates, goModules, npm, pypi, rubygems } from "./registries.ts";

export const PACKAGE_OPERATIONS: Operation[] = ["search", "package", "versions", "artifacts", "dependencies"];
export const CONTAINER_OPERATIONS: Operation[] = [
  "search",
  "repository",
  "tags",
  "manifest",
  "platforms",
  "layers",
  "configuration",
];
export function isContainer(source: Source) {
  return source.kind === "dockerhub" || source.kind === "quay";
}
export function supports(source: Source, operation: Operation) {
  return (
    (isContainer(source) ? CONTAINER_OPERATIONS : PACKAGE_OPERATIONS).includes(operation) &&
    !(source.kind === "nixpkgs" && operation === "dependencies")
  );
}
export function sourcesRows(settings: Settings, container: boolean): Row[] {
  return settings.sources
    .filter((s) => isContainer(s) === container)
    .map((s) => ({
      source_id: s.id,
      ecosystem: s.kind,
      endpoint: safeUrl(s.url),
      authentication: s.auth?.mode ?? "auto",
      credential_configured: !!(s.auth?.token_env || s.auth?.token_file || s.auth?.password_env),
      search_mode: INDEXED.has(s.kind) ? "indexed" : "native",
      metadata: json(s.options ?? {}),
    }));
}
export function capabilityRows(settings: Settings, container: boolean): Row[] {
  return settings.sources
    .filter((s) => isContainer(s) === container)
    .flatMap((s) =>
      (container ? CONTAINER_OPERATIONS : PACKAGE_OPERATIONS).map((operation) => ({
        source_id: s.id,
        ecosystem: s.kind,
        operation,
        supported: supports(s, operation),
        search_mode: operation === "search" ? (INDEXED.has(s.kind) ? "indexed" : "native") : null,
        searched_fields:
          operation === "search" ? (["go", "pypi"].includes(s.kind) ? "name" : "name,description") : null,
        authentication: s.auth?.mode ?? "auto",
        description:
          s.kind === "nixpkgs" && operation === "dependencies"
            ? "Derivation dependencies are not advertised by this metadata export"
            : "Metadata over the configured source boundaries; see source_status for indexed coverage",
      })),
    );
}
export function statusRows(settings: Settings, container: boolean, secrets: Secrets): Row[] {
  return settings.sources
    .filter((s) => isContainer(s) === container)
    .map((s): Row => {
      if (!INDEXED.has(s.kind))
        return {
          source_id: s.id,
          ecosystem: s.kind,
          ready: true,
          search_mode: "native",
          complete: null,
          coverage: "Provider search coverage and pagination",
          error: null,
        };
      try {
        const info = indexInfo(settings, s, secrets);
        return {
          source_id: s.id,
          ecosystem: s.kind,
          ready: !!info,
          search_mode: "indexed",
          snapshot_id: info?.snapshot ?? null,
          observed_at: info?.observed_at ?? null,
          source_revision: info?.revision ?? null,
          complete: info?.complete ?? false,
          coverage: info?.scope ?? null,
          searched_fields: info?.fields ?? null,
          records: info?.records ?? 0,
          checkpoint: info?.checkpoint ?? null,
          stale: info
            ? Date.now() - Date.parse(info.observed_at) > Number(s.options?.index_ttl_seconds ?? 86400) * 1000
            : true,
          error: null,
        };
      } catch (e) {
        return {
          source_id: s.id,
          ecosystem: s.kind,
          ready: false,
          error: e instanceof RegistryError ? e.code : "INDEX_ERROR",
        };
      }
    });
}
export async function queryPage(
  settings: Settings,
  source: Source,
  q: Query,
  budget: Budget,
  secrets: Secrets = {},
  signal?: AbortSignal,
): Promise<Page> {
  if (!supports(source, q.operation))
    throw new RegistryError("UNSUPPORTED", `${source.kind} does not support ${q.operation}`);
  if (!Number.isSafeInteger(q.limit) || q.limit < 1 || q.limit > 10_000)
    throw new RegistryError("ARGUMENT", "max_results must be from 1 to 10000");
  if (q.operation === "search" && !q.query.trim())
    throw new RegistryError("ARGUMENT", "Search query must not be empty");
  if (q.operation !== "search" && !q.name.trim())
    throw new RegistryError("ARGUMENT", "Package or repository name must not be empty");
  if (["artifacts", "dependencies"].includes(q.operation) && !q.version)
    throw new RegistryError("ARGUMENT", "An exact version is required");
  const http = new Http(source, settings.limits, budget, secrets, signal);
  http.remaining();
  if (INDEXED.has(source.kind) && (q.operation === "search" || !["pypi", "go"].includes(source.kind)))
    return readIndex(settings, source, q, secrets);
  switch (source.kind) {
    case "npm":
      return npm(http, q);
    case "pypi":
      return pypi(http, q);
    case "crates":
      return crates(http, q);
    case "maven":
      return maven(http, q);
    case "nuget":
      return nuget(http, q);
    case "rubygems":
      return rubygems(http, q);
    case "go":
      return goModules(http, q);
    case "dockerhub":
    case "quay":
      return containers(http, q);
    default:
      throw new RegistryError("UNSUPPORTED", "No live operation for this source");
  }
}
export async function* queryAll(
  sourceId: string,
  query: Omit<Query, "cursor">,
  settings = loadSettings(),
  secrets: Secrets = {},
  signal?: AbortSignal,
): AsyncGenerator<Row> {
  const source = sourceById(settings, sourceId),
    budget = { requests: 0, bytes: 0, started: Date.now() };
  let cursor = "",
    emitted = 0;
  const cursors = new Set<string>(),
    identities = new Set<string>();
  do {
    if (cursors.has(cursor)) throw new RegistryError("PAGINATION", "Pagination cursor did not advance");
    cursors.add(cursor);
    const page = await queryPage(
      settings,
      source,
      { ...query, cursor, limit: query.limit - emitted },
      budget,
      secrets,
      signal,
    );
    for (const row of page.rows) {
      const key = json({ ...row, observed_at: null });
      if (identities.has(key)) continue;
      identities.add(key);
      yield row;
      if (++emitted >= query.limit) return;
    }
    cursor = page.next;
  } while (cursor);
}
