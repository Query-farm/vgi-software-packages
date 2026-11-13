import type { CatalogDescriptor } from "@query-farm/vgi";
import { serve } from "./cli.ts";
import { CATALOG_TAGS, SCHEMA_TAGS, SOURCE_URL, VERSION } from "./meta.ts";
import { REGISTRY_SECRET, softwareFunctions, softwareTables } from "./software/functions.ts";

const functions = softwareFunctions(true);
for (const fn of functions)
  fn.meta.tags = { ...fn.meta.tags, "vgi.example_queries": JSON.stringify(fn.meta.examples ?? []) };
const doc =
  "Search Docker Hub and Quay repositories from SQL and inspect OCI tags, verified manifests, platforms, layers and image configurations. Optional source-scoped credentials support private reads. Configure source endpoints, request budgets and credential references with VGI_SOFTWARE_CONFIG. Layer payloads are never downloaded. Use sources(), capabilities(), and source_status() for discovery.";
export const CONTAINER_CATALOG: CatalogDescriptor = {
  name: "containers",
  comment: doc,
  sourceUrl: SOURCE_URL,
  secretTypes: [REGISTRY_SECRET],
  tags: {
    ...CATALOG_TAGS,
    "vgi.title": "VGI Container Registry Worker",
    "vgi.subtitle": "Search Docker Hub and Quay and inspect OCI image metadata with optional authentication.",
    "vgi.doc_llm": doc,
    "vgi.doc_md":
      "## Container registry metadata\n\n" +
      doc +
      "\n\n### Immutable references\n\nResolve tags with manifest, inspect platforms, and select a platform digest before reading layers or configuration. Search coverage is determined by each provider and account permissions.",
    "vgi.keywords": JSON.stringify(["docker", "quay", "oci", "containers", "image search", "authentication"]),
    "vgi.agent_test_tasks": JSON.stringify([
      {
        name: "containers_sources",
        prompt: "Using the containers worker, return all columns from sources for all configured sources.",
      },
      {
        name: "containers_capabilities",
        prompt: "Using the containers worker, return all columns from capabilities for all configured sources.",
      },
      {
        name: "containers_source_status",
        prompt: "Using the containers worker, return all columns from source_status for all configured sources.",
      },
      {
        name: "containers_search",
        prompt:
          "Using the containers worker, return all columns from search for the inputs 'dockerhub_public', 'postgres', 5.",
      },
      {
        name: "containers_repository",
        prompt:
          "Using the containers worker, return all columns from repository for the inputs 'dockerhub_public', 'library/hello-world'.",
      },
      {
        name: "containers_tags",
        prompt:
          "Using the containers worker, return all columns from tags for the inputs 'dockerhub_public', 'library/hello-world'.",
      },
      {
        name: "containers_manifest",
        prompt:
          "Using the containers worker, return all columns from manifest for the inputs 'quay_public', 'prometheus/prometheus', 'sha256:89c1a644817e9ad70fa2af76c84898e327c1de7063735f962e8313b1e28672c3'.",
      },
      {
        name: "containers_platforms",
        prompt:
          "Using the containers worker, return all columns from platforms for the inputs 'quay_public', 'prometheus/prometheus', 'sha256:89c1a644817e9ad70fa2af76c84898e327c1de7063735f962e8313b1e28672c3'.",
      },
      {
        name: "containers_layers",
        prompt:
          "Using the containers worker, return all columns from layers for the inputs 'quay_public', 'prometheus/prometheus', 'sha256:89c1a644817e9ad70fa2af76c84898e327c1de7063735f962e8313b1e28672c3'.",
      },
      {
        name: "containers_configuration",
        prompt:
          "Using the containers worker, return all columns from configuration for the inputs 'quay_public', 'prometheus/prometheus', 'sha256:89c1a644817e9ad70fa2af76c84898e327c1de7063735f962e8313b1e28672c3'.",
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
