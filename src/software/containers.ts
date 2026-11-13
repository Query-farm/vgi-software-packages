import { authorization, authScope, credential, digest, type Http } from "./http.ts";
import {
  arr,
  baseRow,
  json,
  nullable,
  num,
  obj,
  type Page,
  pathName,
  type Query,
  RegistryError,
  type Row,
  rowsPage,
  str,
} from "./model.ts";

const ACCEPT =
  "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json";
const tokens = new Map<string, { value: string; expires: number }>();
function metadataObject(bytes: Uint8Array): Record<string, unknown> {
  try {
    const data: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
    return data as Record<string, unknown>;
  } catch {
    throw new RegistryError("MALFORMED", "Registry returned invalid metadata JSON");
  }
}
export function repositoryName(http: Http, name: string): string {
  const result = http.source.kind === "dockerhub" && !name.includes("/") ? `library/${name}` : name;
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/.test(result))
    throw new RegistryError("ARGUMENT", "Use a namespace/repository name");
  return result;
}
export async function oci(http: Http, repository: string, suffix: string, accept = ACCEPT) {
  const base = (http.source.registry_url ?? http.source.url).replace(/\/$/, "");
  const url = `${base}/v2/${pathName(repository)}/${suffix}`;
  const key = digest(`${authScope(http.source, http.secrets)}:${repository}`);
  const cached = tokens.get(key);
  let response = await http.request(url, {
    headers: { Accept: accept },
    registry: true,
    allow401: true,
    authOverride: cached && cached.expires > Date.now() ? `Bearer ${cached.value}` : undefined,
  });
  if (response.status === 401) {
    const challenge = response.headers["www-authenticate"] ?? "";
    if (!/^Bearer\s/i.test(challenge))
      throw new RegistryError("AUTH_REQUIRED", "Registry requires supported credentials", 401);
    const fields = Object.fromEntries(
      [...challenge.matchAll(/(\w+)="([^"\\]*)"/g)].map((m) => [m[1] ?? "", m[2] ?? ""]),
    );
    if (!fields.realm) throw new RegistryError("AUTH_CHALLENGE", "Registry challenge has no token service");
    const realm = http.checkUrl(fields.realm);
    realm.searchParams.set("scope", `repository:${repository}:pull`);
    if (fields.service) realm.searchParams.set("service", fields.service);
    const c = credential(http.source, http.secrets, true);
    const auth = http.source.registry_auth ?? http.source.auth;
    if (c && realm.origin !== new URL(base).origin && !auth?.origins?.includes(realm.origin))
      throw new RegistryError(
        "ORIGIN_DENIED",
        "Credentialed token service must be explicitly trusted by registry_auth.origins",
      );
    const tokenResponse = await http.request(realm.toString(), {
      registry: true,
      noCache: true,
      authOverride: c ? authorization(c) : undefined,
    });
    let body: Record<string, unknown>;
    try {
      body = obj(JSON.parse(new TextDecoder().decode(tokenResponse.body)));
    } catch {
      throw new RegistryError("AUTH_CHALLENGE", "Token service returned invalid JSON");
    }
    const token = str(body.token) || str(body.access_token);
    if (!token) throw new RegistryError("AUTH_REQUIRED", "Token service did not return a registry token");
    const expires = Date.now() + Math.max(1, (Number(body.expires_in) || 60) - 10) * 1000;
    if (tokens.size > 128) tokens.clear();
    tokens.set(key, { value: token, expires });
    response = await http.request(url, {
      headers: { Accept: accept },
      registry: true,
      authOverride: `Bearer ${token}`,
    });
  }
  return response;
}
export async function manifest(http: Http, name: string, reference: string) {
  if (!/^[\w][\w.:-]{0,255}$/.test(reference)) throw new RegistryError("ARGUMENT", "Invalid image tag or digest");
  if (reference.includes(":") && !/^sha256:[a-f0-9]{64}$/.test(reference))
    throw new RegistryError("UNSUPPORTED", "Image digest references must use SHA256");
  const response = await oci(http, name, `manifests/${encodeURIComponent(reference)}`);
  const computed = `sha256:${digest(response.body)}`,
    declared = response.headers["docker-content-digest"];
  if (
    (reference.startsWith("sha256:") && computed !== reference) ||
    (declared?.startsWith("sha256:") && declared !== computed)
  )
    throw new RegistryError("CHECKSUM", "Image manifest digest mismatch");
  const data = metadataObject(response.body);
  if (data.schemaVersion !== 2 || (!Array.isArray(data.manifests) && !Array.isArray(data.layers)))
    throw new RegistryError("UNSUPPORTED", "Expected an OCI or Docker schema 2 manifest");
  return { data, digest: computed };
}
export async function containers(http: Http, q: Query): Promise<Page> {
  const s = http.source,
    root = s.url.replace(/\/$/, "");
  if (q.operation === "search") {
    const page = Number(q.cursor || 1);
    if (s.kind === "dockerhub") {
      const data = await http.object(
        `${root}/v2/search/repositories/?${new URLSearchParams({ query: q.query, page: String(page), page_size: "100" })}`,
      );
      const rows = arr(data.results)
        .slice(0, q.limit)
        .map((value) => {
          const p = obj(value);
          const name = str(p.repo_name) || `${str(p.namespace)}/${str(p.name)}`;
          return baseRow(s, name, {
            description: nullable(p.short_description),
            stars: num(p.star_count),
            pulls: num(p.pull_count),
            official: p.is_official === true,
            url: `https://hub.docker.com/r/${name}`,
            search_mode: "native",
          });
        });
      return { rows, next: data.next || page * 100 < Number(data.count) ? String(page + 1) : "" };
    }
    const data = await http.object(
      `${root}/api/v1/find/repositories?${new URLSearchParams({ query: q.query, page: String(page), includeUsage: "true" })}`,
    );
    const rows = arr(data.results)
      .slice(0, q.limit)
      .map((value) => {
        const p = obj(value),
          ns = str(p.namespace) || str(obj(p.namespace).name) || str(obj(p.namespace).title);
        const name = `${ns}/${str(p.name)}`;
        return baseRow(s, name, {
          description: nullable(p.description),
          score: num(p.score),
          url: `${root}/repository/${name}`,
          search_mode: "native",
          metadata: json({ is_public: p.is_public }),
        });
      });
    return { rows, next: data.has_additional === true ? String(page + 1) : "" };
  }
  const name = repositoryName(http, q.name);
  if (q.operation === "repository") {
    const body = await http.object(
      s.kind === "dockerhub"
        ? `${root}/v2/namespaces/${pathName(name.split("/")[0] ?? "")}/repositories/${pathName(name.split("/").slice(1).join("/"))}`
        : `${root}/api/v1/repository/${pathName(name)}`,
    );
    return {
      rows: [
        baseRow(s, name, {
          description: nullable(body.description),
          stars: num(body.star_count),
          pulls: num(body.pull_count),
          metadata: json({
            is_private: body.is_private,
            is_public: body.is_public,
            last_updated: body.last_updated,
            kind: body.kind,
          }),
        }),
      ],
      next: "",
    };
  }
  if (q.operation === "tags") {
    const params = new URLSearchParams({ n: String(Math.min(q.limit, 100)) });
    if (q.cursor) params.set("last", q.cursor);
    const response = await oci(http, name, `tags/list?${params}`, "application/json");
    const body = metadataObject(response.body),
      tags = arr(body.tags).map(str);
    const link = response.headers.link ?? "";
    const match = link.match(/<([^>]+)>;\s*rel="?next"?/);
    const next = match ? new URL(match[1] ?? "", s.registry_url ?? s.url).searchParams.get("last") || "" : "";
    if (next === q.cursor && next) throw new RegistryError("PAGINATION", "Registry tag cursor did not advance");
    return { rows: tags.map((tag) => baseRow(s, name, { tag })), next };
  }
  const m = await manifest(http, name, q.version || "latest"),
    data = m.data;
  const common = baseRow(s, name, {
    reference: q.version || "latest",
    digest: m.digest,
    media_type: nullable(data.mediaType),
  });
  if (q.operation === "manifest") return { rows: [{ ...common, metadata: json(data) }], next: "" };
  if (q.operation === "platforms" && Array.isArray(data.manifests))
    return rowsPage(
      data.manifests.map((value) => {
        const d = obj(value),
          platform = obj(d.platform);
        return {
          ...common,
          index_digest: m.digest,
          digest: str(d.digest),
          media_type: nullable(d.mediaType),
          size: num(d.size),
          os: nullable(platform.os),
          architecture: nullable(platform.architecture),
          variant: nullable(platform.variant),
          metadata: json(d.annotations),
        };
      }),
      q,
    );
  if (Array.isArray(data.manifests))
    throw new RegistryError(
      "PLATFORM_REQUIRED",
      "Select a platform manifest digest from platforms() before inspecting layers or configuration",
    );
  if (q.operation === "layers")
    return rowsPage(
      arr(data.layers).map((value, position) => {
        const d = obj(value);
        return {
          ...common,
          manifest_digest: m.digest,
          digest: str(d.digest),
          position,
          size: num(d.size),
          media_type: nullable(d.mediaType),
          metadata: json({ annotations: d.annotations, urls: d.urls }),
        };
      }),
      q,
    );
  const configDigest = str(obj(data.config).digest);
  if (!/^sha256:[a-f0-9]{64}$/.test(configDigest))
    throw new RegistryError("UNSUPPORTED", "Image has no SHA256 configuration descriptor");
  const response = await oci(http, name, `blobs/${encodeURIComponent(configDigest)}`, "application/json");
  if (`sha256:${digest(response.body)}` !== configDigest)
    throw new RegistryError("CHECKSUM", "Image configuration digest mismatch");
  const config = metadataObject(response.body);
  const row: Row = {
    ...common,
    os: nullable(config.os),
    architecture: nullable(config.architecture),
    variant: nullable(config.variant),
    config_digest: configDigest,
  };
  if (q.operation === "configuration") row.metadata = json(config);
  return { rows: [row], next: "" };
}
