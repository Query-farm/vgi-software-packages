/**
 * Discovery metadata: the one file to edit when you rename or extend the worker.
 *
 * DuckDB, coding agents and the `vgi-lint` metadata checker all read these
 * tags. Keep every object documented and `make lint-explain` stays at 100.
 *
 * - Catalog-level tags (title, license, author, links, long description) live in
 *   `CATALOG_TAGS` below.
 * - Every function carries `objectTags(...)`: a title, a category from
 *   `SCHEMA_CATEGORIES`, search keywords, and LLM- and human-facing docs.
 */

import { field, type VgiDataType, type VgiField } from "@query-farm/vgi";

export const CATALOG_NAME = "packages";
export const VERSION = "0.2.0";

export const SOURCE_URL = "https://github.com/Query-farm/vgi-software-packages";

/**
 * Categories group functions in docs and agent tools. Every object's
 * `vgi.category` must name one of these.
 */
export const SCHEMA_CATEGORIES = [
  { name: "text", title: "Text", description: "Functions that build or transform strings." },
  { name: "generators", title: "Generators", description: "Table functions that generate rows." },
  { name: "api", title: "REST APIs", description: "Table functions that read from HTTP APIs." },
] as const;

export type Category = (typeof SCHEMA_CATEGORIES)[number]["name"];

/** Turn `"a, b, c"` into the JSON array string `vgi.keywords` requires. */
export function keywordsArray(keywords: string): string {
  return JSON.stringify(
    keywords
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
  );
}

/** Build the standard per-object discovery tags. */
export function objectTags(opts: {
  title: string;
  category: Category;
  keywords: string;
  docLlm: string;
  docMd: string;
}): Record<string, string> {
  return {
    "vgi.title": opts.title,
    "vgi.category": opts.category,
    "vgi.keywords": keywordsArray(opts.keywords),
    "vgi.doc_llm": opts.docLlm,
    "vgi.doc_md": opts.docMd,
  };
}

/** Build an Arrow field whose `comment` shows up in DuckDB's `DESCRIBE` and agent tools. */
export function column(name: string, type: VgiDataType, comment: string, nullable = true): VgiField {
  return field(name, type, nullable, new Map([["comment", comment]]));
}

const PACKAGE_SQL_SURFACE =
  "All objects are in schema main. The sources table lists configured source_id, ecosystem, endpoint and search_mode (`VARCHAR`), plus credential_configured (`BOOLEAN`). The capabilities table lists source_id and operation (`VARCHAR`), supported (`BOOLEAN`), searched_fields and scope descriptions. The source_status table reports ready/complete/stale (`BOOLEAN`), records (`BIGINT`), and snapshot/revision identifiers (`VARCHAR`); native-source readiness does not perform a network probe. These three tables also have zero-argument table-function forms. " +
  "search(source_id `VARCHAR`, query `VARCHAR`, max_results `BIGINT`) returns native name, version and description (`VARCHAR`), nullable provider score (`DOUBLE`), and indexed coverage. package(source_id `VARCHAR`, package_name `VARCHAR`) returns name, version, homepage, repository and license (`VARCHAR`). versions(source_id `VARCHAR`, package_name `VARCHAR`) returns native version and published_at (`VARCHAR`), plus nullable yanked (`BOOLEAN`). artifacts(source_id `VARCHAR`, package_name `VARCHAR`, version `VARCHAR`) returns filename, url, hashes JSON text, artifact_type (`VARCHAR`) and nullable size (`BIGINT`). dependencies(source_id `VARCHAR`, package_name `VARCHAR`, version `VARCHAR`) returns dependency, requirement, kind, condition and declaration_context (`VARCHAR`). All package result sets include source_id, ecosystem and observation time; metadata is nullable sanitized JSON text. " +
  "All query functions are table functions with positional source/name/query/version inputs. Search requires an explicit positional max_results; the other query functions accept named max_results with default 1000. Limits must be 1 through 10000. Empty search strings and empty package names are rejected. Artifact and dependency queries require an exact native version from versions(). Missing upstream metadata remains SQL NULL. Result row order is not a version ordering; use explicit ORDER BY for deterministic presentation.";
export const CATALOG_DOC_LLM =
  "Search 19 software package ecosystems from SQL: npm, PyPI, crates.io, Maven Central, NuGet, RubyGems, Go, Conda, Homebrew formulae and casks, APT, RPM, Alpine, pinned nixpkgs, Packagist, pub.dev, Hex, CRAN, Bioconductor and pinned vcpkg. Read native versions, artifacts and dependency declarations. Use sources, capabilities and source_status for discovery; prepare indexed sources using bin/vgi-software-index. vcpkg versions use upstream#port-revision (omit revision zero); its historical version inventory is available, but dependency declarations describe only the pinned snapshot's current ports. Authentication is optional and source-scoped. Container images have a separate containers worker. Starter example functions remain available for compatibility. " +
  PACKAGE_SQL_SURFACE;
export const CATALOG_DOC_MD =
  "## Software package metadata\n\n" +
  CATALOG_DOC_LLM +
  "\n\n### Usage\n\nDiscover configured sources, prepare any required index, then query search, package, versions, artifacts and dependencies. The separate container worker provides OCI image inspection.";
export const SCHEMA_DOC_LLM =
  "Inspect sources and capabilities, then search a selected registry with an explicit result limit. Indexed registries require an administrator-prepared snapshot; source_status reports its scope, freshness and completeness. Package versions and dependency conditions retain ecosystem semantics. HTTP requests are bounded by request, time and byte budgets. Private reads accept software_registry SQL secrets or configured environment/file credential references. Artifacts are metadata only; no packages are installed.";
export const SCHEMA_DOC_MD =
  "## Package functions and discovery tables\n\n" +
  SCHEMA_DOC_LLM +
  "\n\n### Source boundaries\n\nSearch completeness refers to the configured channel, suite, architecture, revision or feed checkpoint. It does not imply coverage of an entire ecosystem. Use the metadata JSON column for native details that do not fit the shared columns.";

export const AGENT_TEST_TASKS = [
  {
    name: "packages_new_sources",
    prompt:
      "Using the packages worker, list sources for the Packagist, pub, Hex, CRAN, Bioconductor and vcpkg ecosystems. Return exactly source_id, ecosystem, search_mode, ordered by source_id.",
  },
  {
    name: "packages_composer_dependencies",
    prompt:
      "Using the packages worker, show the declared runtime requirements (kind require) for monolog/monolog version 3.9.0 from packagist_public. Return exactly dependency, requirement, ordered by dependency.",
  },
  {
    name: "packages_sources",
    prompt:
      "Using the packages worker, list sources for all configured sources. Return exactly the columns source_id, ecosystem, authentication, search_mode, ordered by source_id.",
  },
  {
    name: "packages_capabilities",
    prompt:
      "Using the packages worker, list capabilities for all configured sources. Return exactly the columns source_id, operation, supported, search_mode, ordered by source_id, operation.",
  },
  {
    name: "packages_source_status",
    prompt:
      "Using the packages worker, list source_status for all configured sources. Return exactly the columns source_id, search_mode, ready, ordered by source_id.",
  },
  {
    name: "packages_search",
    prompt:
      "Using the packages worker, query search with inputs 'npm_public', 'typescript', 5. Return exactly the columns name, ordered by name.",
  },
  {
    name: "packages_package",
    prompt:
      "Using the packages worker, query package with inputs 'pypi_public', 'requests'. Return exactly the columns name, version, description, ordered by name.",
  },
  {
    name: "packages_versions",
    prompt:
      "Using the packages worker, query versions with inputs 'pypi_public', 'requests'. Return exactly the columns version, ordered by version.",
  },
  {
    name: "packages_artifacts",
    prompt:
      "Using the packages worker, query artifacts with inputs 'pypi_public', 'requests', '2.32.3'. Return exactly the columns filename, artifact_type, hashes, ordered by filename.",
  },
  {
    name: "packages_dependencies",
    prompt:
      "Using the packages worker, query dependencies with inputs 'pypi_public', 'requests', '2.32.3'. Return exactly the columns dependency, requirement, kind, condition, ordered by dependency, requirement, kind, condition.",
  },
  { name: "formal_greeting", prompt: "Using the packages worker, greet the name 'Grace' formally." },
  {
    name: "sum_of_squares",
    prompt:
      "Using the packages worker, what is the sum of the squared column for the first 10 rows " +
      "of the sequence with the default step? Return one column named total.",
  },
  {
    name: "stepped_sequence",
    prompt: "List the n values of a 4-row sequence that steps by 5, in ascending order.",
  },
  {
    name: "items_per_category",
    prompt:
      "The items API is running at https://vgi-starter-api.query-farm.services/v1. How many items does it have in each category?",
  },
];

export const CATALOG_TAGS: Record<string, string> = {
  "vgi.title": "VGI Packages Worker",
  "vgi.subtitle": "Search software packages and inspect native release metadata with optional authentication.",
  "vgi.doc_llm": CATALOG_DOC_LLM,
  "vgi.doc_md": CATALOG_DOC_MD,
  "vgi.source_url": SOURCE_URL,
  "vgi.icon_url": "https://query.farm/media-kit/products/vgi/vgi-logo.png",
  "vgi.license": "0BSD",
  "vgi.author": "Query.Farm",
  "vgi.copyright": "Copyright 2026 Query.Farm LLC",
  "vgi.keywords": keywordsArray("vgi, duckdb, software packages, registry, authentication, metadata"),
  "vgi.support_contact": `${SOURCE_URL}/issues`,
  "vgi.support_policy_url": SOURCE_URL,
  // Public analyst tasks for `vgi-lint simulate`; private graders live in vgi-agent-tests.yaml.
  "vgi.agent_test_tasks": JSON.stringify(AGENT_TEST_TASKS),
};

export const SCHEMA_TAGS: Record<string, string> = {
  "vgi.title": "Packages Functions",
  domain: "software",
  "vgi.keywords": keywordsArray("packages, registries, artifacts, dependencies, pagination"),
  "vgi.doc_llm": SCHEMA_DOC_LLM,
  "vgi.doc_md": SCHEMA_DOC_MD,
  "vgi.categories": JSON.stringify(SCHEMA_CATEGORIES),
};
