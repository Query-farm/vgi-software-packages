import type { CatalogDescriptor } from "@query-farm/vgi";
import { serve } from "./cli.ts";
import { CATALOG_TAGS, SCHEMA_TAGS, SOURCE_URL, VERSION } from "./meta.ts";
import { REGISTRY_SECRET, softwareFunctions, softwareTables } from "./software/functions.ts";

const functions = softwareFunctions(true);
for (const fn of functions)
  fn.meta.tags = { ...fn.meta.tags, "vgi.example_queries": JSON.stringify(fn.meta.examples ?? []) };
const doc =
  "Search Docker Hub and Quay repositories, configured GHCR owner inventories, and configured GitLab project inventories from SQL. Inspect OCI tags, verified manifests, platforms, layers and image configurations on all four providers. GHCR search requires options.owner (and owner_type org or user); GitLab search and repository metadata require options.project. GHCR inventory API calls require API authentication even when public image inspection is anonymous. Optional source-scoped credentials support private reads; API and OCI registry credentials can differ. Configure endpoints, budgets and credential references with VGI_SOFTWARE_CONFIG. Layer payloads are never downloaded. Use sources(), capabilities(), and source_status() for discovery. " +
  "Results preserve native namespace/repository identities as `VARCHAR` and include the configured source ID and ecosystem. Optional provider summaries and star/pull counts (`BIGINT`) may be NULL; absence is not a zero count. Image manifests are verified by SHA256. A multi-platform index holds descriptors with digest, operating system, architecture and variant; choose a platform descriptor before requesting layer or configuration details. Layer positions and declared sizes are `BIGINT`; configuration exposes the operating system, architecture and verified configuration digest. Native details remain sanitized JSON text in metadata. " +
  "Read configured source capabilities before choosing a provider. SQL calls require nonempty search text or repository names. Row limits are from 1 through 10000; repository searches require an explicit limit, while other reads default to 1000 via a named max_results argument. Missing optional upstream fields remain SQL NULL. API requests also have independent byte, request and elapsed-time budgets. No function installs packages, executes image commands or downloads layer payloads. Private reads use source-scoped software_registry secrets or configured environment/file references; secrets are not returned in metadata.";

export const CONTAINER_CATALOG: CatalogDescriptor = {
  name: "containers",
  comment: doc,
  sourceUrl: SOURCE_URL,
  secretTypes: [REGISTRY_SECRET],
  tags: {
    ...CATALOG_TAGS,
    "vgi.title": "VGI Container Registry Worker",
    "vgi.subtitle": "Discover Docker Hub, Quay, GHCR and GitLab containers and inspect OCI metadata.",
    "vgi.doc_llm": doc,
    "vgi.doc_md":
      "## Container registry metadata\n\n" +
      doc +
      "\n\n### Immutable references\n\nResolve tags with manifest, inspect platforms, and select a platform digest before reading layers or configuration. Search coverage is determined by each provider and account permissions.",
    "vgi.keywords": JSON.stringify(["docker", "quay", "oci", "containers", "image search", "authentication"]),
    "vgi.agent_test_tasks": JSON.stringify([
      {
        name: "containers_scoped_discovery",
        prompt:
          "Using the containers worker, show whether search is supported for the default ghcr_public and gitlab_public sources. Return exactly source_id, supported, ordered by source_id.",
      },
      {
        name: "containers_sources",
        prompt:
          "Using the containers worker, list sources for all configured sources. Return exactly the columns source_id, ecosystem, authentication, search_mode, ordered by source_id.",
      },
      {
        name: "containers_capabilities",
        prompt:
          "Using the containers worker, list capabilities for all configured sources. Return exactly the columns source_id, operation, supported, search_mode, ordered by source_id, operation.",
      },
      {
        name: "containers_source_status",
        prompt:
          "Using the containers worker, list source_status for all configured sources. Return exactly the columns source_id, search_mode, ready, ordered by source_id.",
      },
      {
        name: "containers_search",
        prompt:
          "Using the containers worker, query search with inputs 'dockerhub_public', 'postgres', 5. Return exactly the columns name, ordered by name.",
      },
      {
        name: "containers_repository",
        prompt:
          "Using the containers worker, query repository with inputs 'dockerhub_public', 'library/hello-world'. Return exactly the columns name, description, ordered by name.",
      },
      {
        name: "containers_tags",
        prompt:
          "Using the containers worker, query tags with inputs 'dockerhub_public', 'library/hello-world', max_results := 10. Return exactly the columns tag, ordered by tag.",
      },
      {
        name: "containers_manifest",
        prompt:
          "Using the containers worker, query manifest with inputs 'quay_public', 'prometheus/prometheus', 'sha256:89c1a644817e9ad70fa2af76c84898e327c1de7063735f962e8313b1e28672c3'. Return exactly the columns digest, media_type, ordered by digest.",
      },
      {
        name: "containers_platforms",
        prompt:
          "Using the containers worker, query platforms with inputs 'quay_public', 'prometheus/prometheus', 'sha256:89c1a644817e9ad70fa2af76c84898e327c1de7063735f962e8313b1e28672c3'. Return exactly the columns digest, os, architecture, ordered by digest.",
      },
      {
        name: "containers_layers",
        prompt:
          "Using the containers worker, query layers with inputs 'quay_public', 'prometheus/prometheus', 'sha256:89c1a644817e9ad70fa2af76c84898e327c1de7063735f962e8313b1e28672c3'. Return exactly the columns position, digest, size, ordered by position.",
      },
      {
        name: "containers_configuration",
        prompt:
          "Using the containers worker, query configuration with inputs 'quay_public', 'prometheus/prometheus', 'sha256:89c1a644817e9ad70fa2af76c84898e327c1de7063735f962e8313b1e28672c3'. Return exactly the columns os, architecture, config_digest, ordered by config_digest.",
      },
    ]),
  },
  schemas: [
    {
      path: ["main"],
      comment:
        "Container repository discovery and OCI inspection functions. Resolve a tag to platform descriptors before reading a selected manifest's layers and configuration. Source discovery tables describe endpoints, authentication and provider capabilities.",
      functions,
      tables: softwareTables(functions),
      tags: {
        ...SCHEMA_TAGS,
        "vgi.title": "Container Metadata",
        domain: "software",
        "vgi.doc_llm":
          "Search repositories, inspect registry tags, resolve immutable manifest digests and select an image platform. Layers returns descriptor metadata; configuration downloads and verifies only the small configuration blob. Discovery tables report the configured API and registry sources.",
        "vgi.categories": JSON.stringify([
          { name: "api", title: "Registry APIs", description: "Read repository search and OCI image metadata." },
        ]),
        "vgi.executable_examples": JSON.stringify([
          {
            description: "Inspect configured container providers",
            sql: "SELECT ecosystem FROM containers.main.sources ORDER BY ecosystem",
          },
        ]),
        "vgi.doc_md":
          "## Image search and inspection\n\n" +
          doc +
          "\n\n### Platform selection\n\nAn image index contains platform descriptors. Use the selected descriptor digest for layers and configuration. Layer payloads are outside this worker's scope.",
        "vgi.example_queries": JSON.stringify(functions.flatMap((fn) => fn.meta.examples ?? [])),
      },
    },
  ],
};
if (import.meta.main) serve(CONTAINER_CATALOG, { version: VERSION, doc, repositoryUrl: SOURCE_URL });
