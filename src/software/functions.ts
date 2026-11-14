import {
  batchFromColumns,
  bool,
  constraintRecord,
  defineTableFunction,
  field,
  float64,
  int64,
  type SecretTypeDescriptor,
  schema,
  type TableDescriptor,
  utf8,
  type VgiFunction,
} from "@query-farm/vgi";
import { column, objectTags } from "../meta.ts";
import { COMPOSED_EXAMPLES } from "./composed_examples.ts";
import { loadSettings, sourceById } from "./config.ts";
import { authScope, digest, sanitize } from "./http.ts";
import { type Cell, json, type Operation, RegistryError, type Row } from "./model.ts";
import {
  CONTAINER_OPERATIONS,
  capabilityRows,
  isContainer,
  PACKAGE_OPERATIONS,
  queryPage,
  sourcesRows,
  statusRows,
} from "./service.ts";

export const REGISTRY_SECRET: SecretTypeDescriptor = {
  name: "software_registry",
  description:
    "Source-scoped credentials for package or image registry reads. Credentials remain in the SDK secret channel.",
  schema: schema(
    [
      field(
        "source_id",
        utf8(),
        false,
        new Map([["vgi_doc", "Configured source ID to which this credential applies."]]),
      ),
      ...["token", "password"].map((name) =>
        field(
          name,
          utf8(),
          true,
          new Map([
            ["redact", "true"],
            ["vgi_doc", "Private credential value."],
          ]),
        ),
      ),
      ...["username", "scheme", "purpose"].map((name) =>
        field(
          name,
          utf8(),
          true,
          new Map([
            [
              "vgi_doc",
              name === "scheme"
                ? "bearer, basic, or token; defaults to bearer."
                : name === "purpose"
                  ? "api or registry; omit to use for either."
                  : "Username for Basic authentication.",
            ],
          ]),
        ),
      ),
    ],
    new Map([["vgi_doc_url", "https://query.farm/vgi/"]]),
  ),
};

type FieldSpec = [name: string, type: "VARCHAR" | "BIGINT" | "BOOLEAN" | "DOUBLE", description: string];
const common: FieldSpec[] = [
  ["source_id", "VARCHAR", "Configured source identifier."],
  ["ecosystem", "VARCHAR", "Native package ecosystem or registry provider."],
  ["name", "VARCHAR", "Native package or repository identity, including its namespace."],
  ["version", "VARCHAR", "Original ecosystem version string; NULL where not applicable."],
  ["description", "VARCHAR", "Upstream summary where available."],
  ["observed_at", "VARCHAR", "UTC ISO timestamp when metadata was observed."],
  ["snapshot_id", "VARCHAR", "Prepared snapshot identifier; NULL for live requests."],
  ["source_revision", "VARCHAR", "Upstream revision or checkpoint when available."],
  ["metadata", "VARCHAR", "Sanitized JSON containing ecosystem-specific details."],
];
const fields: Record<string, FieldSpec[]> = {
  search: [
    ["score", "DOUBLE", "Provider relevance score; scores are not comparable across providers."],
    ["stars", "BIGINT", "Provider star count when available."],
    ["pulls", "BIGINT", "Provider pull count when available."],
    ["official", "BOOLEAN", "Provider designation of an official repository, when available."],
    ["url", "VARCHAR", "Public package or repository URL."],
    ["search_mode", "VARCHAR", "native provider search or indexed snapshot."],
    ["coverage", "VARCHAR", "Prepared index source boundaries as JSON."],
    ["complete", "BOOLEAN", "Whether indexing reached the end of the declared input scope."],
  ],
  package: [
    ["homepage", "VARCHAR", "Upstream project homepage."],
    ["repository", "VARCHAR", "Upstream source code repository URL."],
    ["license", "VARCHAR", "Upstream license metadata, not an inferred license determination."],
    ["platform", "VARCHAR", "Platform or target system."],
    ["architecture", "VARCHAR", "Package architecture."],
    ["build", "VARCHAR", "Ecosystem build identifier."],
    ["deprecated", "VARCHAR", "Deprecation reason if supplied."],
  ],
  versions: [
    ["published_at", "VARCHAR", "Upstream publication time, distinct from observation time."],
    ["platform", "VARCHAR", "Native platform variant."],
    ["architecture", "VARCHAR", "Package architecture."],
    ["build", "VARCHAR", "Build identifier."],
    ["yanked", "BOOLEAN", "Upstream yanked status, NULL when unknown."],
    ["deprecated", "VARCHAR", "Upstream deprecation reason."],
    ["license", "VARCHAR", "License metadata if present."],
  ],
  artifacts: [
    ["filename", "VARCHAR", "Artifact filename or output name."],
    ["url", "VARCHAR", "Artifact URL with sensitive query parameters removed."],
    ["hashes", "VARCHAR", "Upstream checksum or integrity fields as JSON."],
    ["size", "BIGINT", "Upstream size in bytes, where provided."],
    ["artifact_type", "VARCHAR", "Native artifact format or output kind."],
    ["platform", "VARCHAR", "Platform variant."],
    ["architecture", "VARCHAR", "Native package architecture."],
    ["build", "VARCHAR", "Build identifier."],
    ["yanked", "BOOLEAN", "Whether this particular file was yanked."],
    ["store_path", "VARCHAR", "Nix output store path; this does not imply binary availability."],
  ],
  dependencies: [
    ["dependency", "VARCHAR", "Target package identity or capability."],
    ["requirement", "VARCHAR", "Native dependency requirement expression."],
    ["kind", "VARCHAR", "Native dependency category."],
    ["condition", "VARCHAR", "Platform, feature, framework or environment condition."],
    ["declaration_context", "VARCHAR", "Where the dependency was declared; no universal resolution is implied."],
  ],
  repository: [
    ["stars", "BIGINT", "Provider star count, if available."],
    ["pulls", "BIGINT", "Provider pull count, if available."],
  ],
  tags: [["tag", "VARCHAR", "Mutable image tag; use manifest to resolve its digest."]],
  manifest: [
    ["reference", "VARCHAR", "Requested tag or digest."],
    ["digest", "VARCHAR", "Verified SHA256 manifest digest."],
    ["media_type", "VARCHAR", "Manifest media type."],
  ],
  platforms: [
    ["reference", "VARCHAR", "Requested tag or digest."],
    ["index_digest", "VARCHAR", "Parent multi-platform index digest where present."],
    ["digest", "VARCHAR", "Platform manifest digest."],
    ["media_type", "VARCHAR", "Descriptor media type."],
    ["size", "BIGINT", "Manifest descriptor size in bytes."],
    ["os", "VARCHAR", "Image operating system."],
    ["architecture", "VARCHAR", "Image CPU architecture."],
    ["variant", "VARCHAR", "Architecture variant."],
    ["config_digest", "VARCHAR", "Configuration digest for a single-platform manifest."],
  ],
  layers: [
    ["manifest_digest", "VARCHAR", "Verified owning manifest digest."],
    ["digest", "VARCHAR", "Layer blob digest; layer bytes are not downloaded."],
    ["position", "BIGINT", "Zero-based layer order."],
    ["size", "BIGINT", "Declared compressed layer byte size."],
    ["media_type", "VARCHAR", "Layer media type."],
  ],
  configuration: [
    ["digest", "VARCHAR", "Verified image manifest digest."],
    ["config_digest", "VARCHAR", "Verified image configuration digest."],
    ["os", "VARCHAR", "Image operating system."],
    ["architecture", "VARCHAR", "Image CPU architecture."],
    ["variant", "VARCHAR", "Architecture variant."],
  ],
  sources: [
    ["source_id", "VARCHAR", "Configured source identifier."],
    ["ecosystem", "VARCHAR", "Adapter ecosystem."],
    ["endpoint", "VARCHAR", "Configured upstream URL."],
    ["authentication", "VARCHAR", "anonymous, auto, or required."],
    [
      "credential_configured",
      "BOOLEAN",
      "Whether the configuration references a credential; SQL secrets may also apply.",
    ],
    ["search_mode", "VARCHAR", "native or indexed search."],
    ["metadata", "VARCHAR", "Configured source boundaries as JSON."],
  ],
  capabilities: [
    ["source_id", "VARCHAR", "Configured source identifier."],
    ["ecosystem", "VARCHAR", "Adapter ecosystem."],
    ["operation", "VARCHAR", "Operation name."],
    ["supported", "BOOLEAN", "Whether this adapter supports the operation."],
    ["search_mode", "VARCHAR", "native or indexed for search."],
    ["searched_fields", "VARCHAR", "Fields included in search."],
    ["authentication", "VARCHAR", "Configured authentication mode."],
    ["description", "VARCHAR", "Operation constraints."],
  ],
  source_status: [
    ["source_id", "VARCHAR", "Configured source identifier."],
    ["ecosystem", "VARCHAR", "Adapter ecosystem."],
    ["ready", "BOOLEAN", "Whether search can use the configured source."],
    ["search_mode", "VARCHAR", "native or indexed."],
    ["complete", "BOOLEAN", "Index input exhausted within declared boundaries; NULL for native search."],
    ["coverage", "VARCHAR", "Declared index scope."],
    ["searched_fields", "VARCHAR", "Indexed fields."],
    ["snapshot_id", "VARCHAR", "Unique identifier for the last atomically committed index refresh."],
    ["source_revision", "VARCHAR", "Upstream revision or checkpoint."],
    ["observed_at", "VARCHAR", "Last successful index refresh."],
    ["records", "BIGINT", "Stored metadata record count."],
    ["checkpoint", "VARCHAR", "Resume cursor for incremental feeds."],
    ["stale", "BOOLEAN", "Index older than configured freshness interval."],
    ["error", "VARCHAR", "Safe status error code if inspection failed."],
  ],
};
const descriptions: Record<string, string> = {
  sources: "List configured software sources and their optional authentication modes",
  capabilities: "Inspect supported source operations and native or indexed search coverage",
  source_status: "Inspect prepared index readiness, revisions, freshness and discovery boundaries",
  search: "Search package or image repository metadata within an explicit source and row budget",
  package: "Read native package identity and descriptive metadata",
  versions: "List versions available in the configured registry or prepared snapshot",
  artifacts: "Inspect release artifact locations, platforms and upstream checksums",
  dependencies: "Read declared dependency requirements and their native conditions",
  repository: "Inspect a container repository description and provider metadata",
  tags: "List mutable image tags with bounded registry pagination",
  manifest: "Resolve an image reference and inspect its verified manifest",
  platforms: "Inspect image platform descriptors and their exact manifest digests",
  layers: "Inspect ordered layer descriptors without downloading image layer content",
  configuration: "Read and verify the image configuration JSON for a platform manifest",
};
const guidance: Record<string, string> = {
  sources:
    "One row per configured source. Use source_id to call registry functions. Endpoint URLs are sanitized; authentication reports anonymous, auto, or required. credential_configured describes environment/file references, not SQL-secret availability. search_mode distinguishes native provider search from a prepared local index. This relation is available as both a table and a zero-argument function.",
  capabilities:
    "One row per source_id and operation. Join this relation to sources using source_id to obtain the endpoint and authentication settings. supported reports adapter support even when an index has not been prepared. Package operations are search, package, versions, artifacts and dependencies; container operations are search, repository, tags, manifest, platforms, layers and configuration. searched_fields is a comma-separated list for search and NULL for other operations. Inspect description for operation-specific limits. This relation is both a table and a zero-argument function.",
  source_status:
    "One row per source_id describing search readiness. Join to sources using source_id for endpoint details. Indexed sources report the last committed snapshot, observation time, source revision, record count, checkpoint, declared coverage and completeness. complete means the declared input was exhausted, not ecosystem-wide coverage. Native readiness indicates adapter availability, not a remote health probe. Failed inspection produces ready=false and a safe error code. This relation is both a table and a zero-argument function.",
  search:
    "Find package names or image repositories before requesting their detailed metadata. Native search keeps provider ranking; scores are provider-specific and nullable. Prepared indexes use case-insensitive substring matching and deterministic name order. PyPI, Go and pub search names only (as do GHCR and GitLab inventories); other sources include descriptions. Inspect source_status before indexed search. The explicit row budget caps output without an additional truncation flag; coverage and complete describe the index input, not the result count.",
  package:
    "Read descriptive metadata for one native package identity, normally one row. npm/PyPI/RubyGems use provider-selected current metadata; NuGet selects the last registration entry; prepared repositories expose one representative indexed package record. Maven names use groupId:artifactId and Go names preserve module-path case. Missing live packages raise NOT_FOUND; a missing indexed name returns zero rows. Use versions for the release inventory, artifacts for files, and dependencies for requirements.",
  versions:
    "List original version strings and available publication, platform, build, yanked and deprecation fields. Unknown provider fields are NULL. Order follows provider metadata or the prepared snapshot and is not a universal newest-first ordering. Use the returned version strings verbatim for artifacts and dependencies. Prepared repositories expose releases present in their configured snapshot, not complete historical archives. Output is capped by the row budget without a separate truncation flag.",
  artifacts:
    "Inspect files or Nix outputs for an exact package release. Rows include native filenames, artifact types, platforms, upstream size when available, URLs and hashes JSON keyed by the upstream algorithm or integrity field. Checksums are reported metadata; artifact bytes are not downloaded or verified here. URL credentials and query parameters are stripped. Maven returns the POM and packaging artifact, not every classifier. Nix store paths do not imply binary-cache availability.",
  dependencies:
    "One row per declared requirement of an exact package version. dependency identifies the target or capability; requirement retains the ecosystem expression; kind preserves dependency category; condition holds markers, frameworks or platform restrictions when available. metadata preserves additional native details such as features and optional flags. Declarations are not a solved installation graph. Maven parent/BOM properties can remain unresolved and PyPI per-file metadata can differ. nixpkgs dependencies are explicitly unsupported. Choose a release from versions first.",
  repository:
    "Read one Docker Hub or Quay repository's provider description and available star/pull counts. Counts may be NULL and can change over time. Private reads require an API credential with visibility into the repository; registry pull credentials can be configured separately. A missing repository raises NOT_FOUND. Use tags for its image references and manifest for immutable content identification.",
  tags: "List mutable image tag strings using OCI registry pagination. Tags are not resolved to digests here; call manifest for a selected tag. Output follows registry pagination order and stops at the row budget without an extra truncation flag. New or deleted tags can change the inventory between requests. Registry authentication can differ from the provider search API credential.",
  manifest:
    "Resolve an image tag or SHA256 digest to a verified OCI/Docker schema 2 manifest. Returns the computed digest, media_type and complete sanitized manifest JSON. The bytes are checked against a requested SHA256 digest and the server's SHA256 digest header when present. Unsupported digest algorithms fail explicitly. A manifest may be a platform index; use platforms to inspect its child descriptors before requesting layers or configuration.",
  platforms:
    "For a multi-platform index, return each child manifest's digest, media type, size, OS, architecture and optional variant; index_digest identifies the verified parent. A single-platform manifest returns its platform from a verified configuration blob. Descriptor values are preserved as reported; child manifests are verified when fetched. Select a platform digest for layers or configuration rather than passing the multi-platform index.",
  layers:
    "Return ordered layer descriptors from one verified platform manifest. position is zero-based; digest is the layer blob digest; size is the declared compressed byte count. Only manifest metadata is downloaded: layer contents and layer checksums are not fetched or verified. Passing a multi-platform index raises PLATFORM_REQUIRED; obtain a child digest with platforms first.",
  configuration:
    "Download and verify the small configuration blob referenced by one platform manifest. digest identifies the verified owning manifest and config_digest identifies the verified configuration. OS, architecture and variant are projected into columns; sanitized metadata JSON contains the configuration, including history and runtime settings. Layer payloads are not fetched. Passing a multi-platform index raises PLATFORM_REQUIRED.",
};
interface Args {
  source_id: string;
  package_name: string;
  query: string;
  version: string;
  max_results: bigint;
}
interface State {
  cursor: string;
  done: boolean;
  emitted: number;
  requests: number;
  bytes: number;
  started: number;
  identity: string;
  seen: string;
  cursors: string;
}
export function softwareFunctions(container: boolean): VgiFunction[] {
  const catalog = container ? "containers" : "packages";
  return ["sources", "capabilities", "source_status", ...(container ? CONTAINER_OPERATIONS : PACKAGE_OPERATIONS)].map(
    (name) => {
      const staticFn = ["sources", "capabilities", "source_status"].includes(name);
      const specs = staticFn ? (fields[name] ?? []) : [...common, ...(fields[name] ?? [])];
      const outputSchema = schema(
        specs.map(([n, t, description]) =>
          column(
            n,
            t === "BIGINT" ? int64() : t === "BOOLEAN" ? bool : t === "DOUBLE" ? float64() : utf8(),
            description,
          ),
        ),
      );
      const args: Record<string, ReturnType<typeof utf8> | ReturnType<typeof int64>> = {},
        docs: Record<string, string> = {},
        defaults: Record<string, unknown> = {};
      if (!staticFn) {
        args.source_id = utf8();
        docs.source_id = "Configured source identifier from sources().";
        if (name === "search") {
          args.query = utf8();
          docs.query = "Nonempty search text over the fields advertised by capabilities().";
        } else {
          args.package_name = utf8();
          docs.package_name = container
            ? "Image repository as namespace/repository; Docker Hub also accepts official short names."
            : "Native package identity; Maven uses groupId:artifactId and nixpkgs uses an attribute path.";
        }
        if (["artifacts", "dependencies", "manifest", "platforms", "layers", "configuration"].includes(name)) {
          args.version = utf8();
          docs.version = container
            ? "Image tag or SHA256 digest. Layers and configuration require a single-platform manifest."
            : "Exact native package version from versions().";
        }
        args.max_results = int64();
        docs.max_results = "Maximum returned rows, 1 through 10000. Remote requests also obey the configured budgets.";
        if (name !== "search") defaults.max_results = 1000;
      }
      const exampleArgs =
        container && ["layers", "configuration"].includes(name)
          ? "'quay_public', 'prometheus/prometheus', 'sha256:89c1a644817e9ad70fa2af76c84898e327c1de7063735f962e8313b1e28672c3'"
          : name === "search"
            ? `'${container ? "dockerhub" : "npm"}_public', '${container ? "postgres" : "arrow"}', 25`
            : staticFn
              ? ""
              : `'${container ? "quay" : "pypi"}_public', '${container ? "prometheus/prometheus" : "requests"}'${["artifacts", "dependencies", "manifest", "platforms", "layers", "configuration"].includes(name) ? `, '${container ? "latest" : "2.32.3"}'` : ""}`;
      const projection =
        (
          {
            capabilities: "source_id, operation, supported",
            source_status: "source_id, ready, search_mode",
            versions: "version, published_at",
            artifacts: "filename, artifact_type, hashes",
            dependencies: "dependency, requirement, condition",
            tags: "tag",
            manifest: "digest, media_type",
            platforms: "digest, os, architecture",
            layers: "position, digest, size",
            configuration: "os, architecture, config_digest",
          } as Record<string, string>
        )[name] ?? (staticFn ? "source_id" : "name");
      const example = `SELECT ${projection} FROM ${catalog}.main.${name}(${exampleArgs}) ORDER BY ${projection} LIMIT 10`;
      const description = descriptions[name] ?? name;
      return defineTableFunction<Args, State>({
        name,
        description,
        args,
        argDocs: docs,
        argDefaults: defaults,
        argConstraints: staticFn ? {} : { max_results: { ge: 1, le: 10000 } },
        onBind: (params) => ({
          outputSchema,
          ...(!params.resolvedSecretsProvided ? { lookupSecretTypes: [REGISTRY_SECRET.name] } : {}),
        }),
        initialState: () => ({
          cursor: "",
          done: false,
          emitted: 0,
          requests: 0,
          bytes: 0,
          started: Date.now(),
          identity: "",
          seen: "[]",
          cursors: "[]",
        }),
        process: async (params, state, out) => {
          if (state.done) {
            out.finish();
            return;
          }
          const settings = loadSettings();
          let rows: Row[];
          if (staticFn) {
            rows =
              name === "sources"
                ? sourcesRows(settings, container)
                : name === "capabilities"
                  ? capabilityRows(settings, container)
                  : statusRows(settings, container, params.secrets);
            state.done = true;
          } else {
            const s = sourceById(settings, params.args.source_id);
            if (isContainer(s) !== container)
              throw new RegistryError("WRONG_WORKER", "Source belongs to the other software worker");
            const identity = authScope(s, params.secrets);
            if (state.identity && state.identity !== identity)
              throw new RegistryError("SOURCE_CHANGED", "Source or credentials changed during query");
            state.identity = identity;
            const cursors = new Set<string>(JSON.parse(state.cursors));
            if (cursors.has(state.cursor)) throw new RegistryError("PAGINATION", "Upstream cursor repeated");
            cursors.add(state.cursor);
            state.cursors = json([...cursors]);
            const budget = { requests: state.requests, bytes: state.bytes, started: state.started };
            const page = await queryPage(
              settings,
              s,
              {
                operation: name as Operation,
                name: params.args.package_name ?? "",
                query: params.args.query ?? "",
                version: params.args.version ?? "",
                limit: Number(params.args.max_results) - state.emitted,
                cursor: state.cursor,
              },
              budget,
              params.secrets,
            );
            state.requests = budget.requests;
            state.bytes = budget.bytes;
            const seen = new Set<string>(JSON.parse(state.seen));
            rows = [];
            for (const row of page.rows) {
              if (state.emitted + rows.length >= Number(params.args.max_results)) break;
              const key = digest(json({ ...row, observed_at: null }));
              if (seen.has(key)) continue;
              seen.add(key);
              rows.push(
                Object.fromEntries(
                  Object.entries(row).map(([k, v]) => [k, typeof v === "string" ? sanitize(v, params.secrets, s) : v]),
                ),
              );
            }
            state.seen = json([...seen]);
            state.emitted += rows.length;
            state.cursor = page.next;
            state.done = !page.next || state.emitted >= Number(params.args.max_results);
          }
          const columns: Record<string, (Cell | bigint)[]> = {};
          for (const [key, type] of specs)
            columns[key] = rows.map((row) => {
              const v = row[key] ?? null;
              return type === "BIGINT" && typeof v === "number" ? BigInt(Math.trunc(v)) : v;
            });
          out.emit(batchFromColumns(columns, params.outputSchema));
          if (state.done) out.finish();
        },
        tags: {
          ...objectTags({
            title: name
              .split("_")
              .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
              .join(" "),
            category: "api",
            keywords: "software, registry, package, container, metadata, authentication, search",
            docLlm: `${description}. ${guidance[name]} Result columns (nullable when upstream data is unavailable): ${specs.map(([n, t, d]) => `${n} \`${t}\`: ${d}`).join(" ")}`,
            docMd: `${guidance[name]}\n\n### Returned columns\n\nUnknown or inapplicable values are NULL.\n\n| Column | SQL type | Meaning |\n| --- | --- | --- |\n${specs.map(([n, t, d]) => `| ${n} | \`${t}\` | ${d} |`).join("\n")}`,
          }),
          "vgi.result_columns_schema": json(specs.map(([n, type, description]) => ({ name: n, type, description }))),
        },
        examples: [
          { sql: example, description: `${description}; inspect the first ten identities` },
          ...(COMPOSED_EXAMPLES[catalog][name] ?? []),
        ],
      });
    },
  );
}

export function softwareTables(functions: VgiFunction[]): TableDescriptor[] {
  return functions
    .filter((fn) => ["sources", "capabilities", "source_status"].includes(fn.meta.name))
    .map((fn) => ({
      name: fn.meta.name,
      columns: schema(
        (fields[fn.meta.name] ?? []).map(([n, t, d]) =>
          column(n, t === "BIGINT" ? int64() : t === "BOOLEAN" ? bool : utf8(), d),
        ),
      ),
      function: fn,
      exposeScan: true,
      constraints: [
        constraintRecord({
          schemaPath: ["main"],
          table: fn.meta.name,
          id: "source_not_null",
          kind: "NOT_NULL",
          columns: [["source_id"]],
          enforcement: "ENFORCED",
          validation: "ALL_ROWS",
        }),
        constraintRecord({
          schemaPath: ["main"],
          table: fn.meta.name,
          id: "pk",
          kind: "PRIMARY_KEY",
          columns: fn.meta.name === "capabilities" ? [["source_id"], ["operation"]] : [["source_id"]],
          enforcement: "ENFORCED",
          validation: "ALL_ROWS",
        }),
        ...(fn.meta.name === "sources"
          ? []
          : [
              constraintRecord({
                schemaPath: ["main"],
                table: fn.meta.name,
                id: "source_fk",
                kind: "FOREIGN_KEY",
                columns: [["source_id"]],
                references: { schemaPath: ["main"], table: "sources", columns: [["source_id"]], constraintId: "pk" },
                enforcement: "ENFORCED",
                validation: "ALL_ROWS",
              }),
            ]),
      ],
      comment: descriptions[fn.meta.name],
      tags: {
        ...fn.meta.tags,
        domain: "software",
        "vgi.title":
          (
            {
              sources: "Registry Sources",
              capabilities: "Source Operations",
              source_status: "Index Readiness",
            } as Record<string, string>
          )[fn.meta.name] ?? fn.meta.name,
        "vgi.example_queries": JSON.stringify(
          fn.meta.examples?.map((e) => ({ ...e, sql: e.sql.replace(`${fn.meta.name}()`, fn.meta.name) })),
        ),
      },
    }));
}
