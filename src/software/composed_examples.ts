/**
 * Example queries that combine two or more of a worker's objects.
 *
 * Table-function arguments must be literals (no LATERAL column arguments), so
 * these compose separate calls with joins. Each SQL string is defined once and
 * published both on the object that drives the query and in the schema list.
 */

export interface ComposedExample {
  description: string;
  sql: string;
}

const PROMETHEUS = "'quay_public', 'prometheus/prometheus'";
const PROMETHEUS_AMD64 = "'sha256:263bb115fe0511598b3533576d0e27d3cfe77ae96b9ff9a9b8ae8e99a9b1fc68'";
const PROMETHEUS_SINGLE = "'sha256:89c1a644817e9ad70fa2af76c84898e327c1de7063735f962e8313b1e28672c3'";

export const PACKAGES_UNPREPARED_SEARCH: ComposedExample = {
  description:
    "Find package sources whose search is not ready yet (indexed sources without a prepared snapshot) and the fields an indexed search would match, joining sources, capabilities and source_status",
  sql: "SELECT s.source_id, s.ecosystem, c.searched_fields FROM packages.main.sources s JOIN packages.main.capabilities c ON c.source_id = s.source_id AND c.operation = 'search' JOIN packages.main.source_status st ON st.source_id = s.source_id WHERE NOT st.ready ORDER BY s.source_id",
};

export const PACKAGES_DEPENDENCY_CHANGES: ComposedExample = {
  description:
    "List dependency names added or removed between two releases of requests on PyPI (2.25.1 to 2.26.0 adds charset-normalizer and drops cryptography and pyOpenSSL) by full-outer-joining two dependencies calls",
  sql: "WITH old AS (SELECT DISTINCT dependency FROM packages.main.dependencies('pypi_public', 'requests', '2.25.1')), new AS (SELECT DISTINCT dependency FROM packages.main.dependencies('pypi_public', 'requests', '2.26.0')) SELECT coalesce(new.dependency, old.dependency) AS dependency, CASE WHEN old.dependency IS NULL THEN 'added' ELSE 'removed' END AS change FROM old FULL OUTER JOIN new ON new.dependency = old.dependency WHERE old.dependency IS NULL OR new.dependency IS NULL ORDER BY change, dependency",
};

export const PACKAGES_CURRENT_RELEASE: ComposedExample = {
  description:
    "Show the current serde release on crates.io with its publication time and yanked flag, joining package metadata to the version inventory on the version string",
  sql: "SELECT p.name, p.version, v.published_at, v.yanked FROM packages.main.package('crates_public', 'serde') p JOIN packages.main.versions('crates_public', 'serde') v ON v.version = p.version ORDER BY p.name",
};

export const CONTAINERS_SEARCH_PROVIDERS: ComposedExample = {
  description:
    "Show each configured container provider's endpoint and whether repository search is available, joining sources to the search row of capabilities (GHCR and GitLab report false until an owner or project is configured)",
  sql: "SELECT s.source_id, s.endpoint, c.supported AS search_supported, c.searched_fields FROM containers.main.sources s JOIN containers.main.capabilities c ON c.source_id = s.source_id AND c.operation = 'search' ORDER BY s.source_id",
};

export const CONTAINERS_PLATFORM_LAYERS: ComposedExample = {
  description:
    "Resolve the prometheus v3.0.0 image index with platforms and total the layers of its linux/amd64 child manifest; the join on the platform digest confirms the child belongs to that tag",
  sql: `SELECT p.os, p.architecture, count(l.position) AS layers, sum(l.size) AS compressed_bytes FROM containers.main.platforms(${PROMETHEUS}, 'v3.0.0') p JOIN containers.main.layers(${PROMETHEUS}, ${PROMETHEUS_AMD64}) l ON l.manifest_digest = p.digest GROUP BY p.os, p.architecture ORDER BY p.architecture`,
};

export const CONTAINERS_CONFIG_LAYERS: ComposedExample = {
  description:
    "Summarize one platform manifest: its verified configuration (OS, architecture, config digest) alongside its layer count and declared compressed size",
  sql: `SELECT c.os, c.architecture, c.config_digest, count(l.position) AS layers, sum(l.size) AS compressed_bytes FROM containers.main.configuration(${PROMETHEUS}, ${PROMETHEUS_SINGLE}) c JOIN containers.main.layers(${PROMETHEUS}, ${PROMETHEUS_SINGLE}) l ON l.manifest_digest = c.digest GROUP BY c.os, c.architecture, c.config_digest ORDER BY c.config_digest`,
};

/** Composed examples by catalog, keyed by the object that drives each query. */
export const COMPOSED_EXAMPLES: Record<"packages" | "containers", Record<string, ComposedExample[]>> = {
  packages: {
    source_status: [PACKAGES_UNPREPARED_SEARCH],
    dependencies: [PACKAGES_DEPENDENCY_CHANGES],
    package: [PACKAGES_CURRENT_RELEASE],
  },
  containers: {
    capabilities: [CONTAINERS_SEARCH_PROVIDERS],
    platforms: [CONTAINERS_PLATFORM_LAYERS],
    configuration: [CONTAINERS_CONFIG_LAYERS],
  },
};
