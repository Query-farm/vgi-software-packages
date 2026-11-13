export type JsonObject = Record<string, unknown>;
export type Cell = string | number | boolean | null;
export type Row = Record<string, Cell>;
export type Operation =
  | "search"
  | "package"
  | "versions"
  | "artifacts"
  | "dependencies"
  | "repository"
  | "tags"
  | "manifest"
  | "platforms"
  | "layers"
  | "configuration";
export const PACKAGE_KINDS = [
  "npm",
  "pypi",
  "crates",
  "maven",
  "nuget",
  "rubygems",
  "go",
  "conda",
  "homebrew",
  "apt",
  "rpm",
  "alpine",
  "nixpkgs",
  "packagist",
  "pub",
  "hex",
  "cran",
  "bioconductor",
  "vcpkg",
] as const;
export const CONTAINER_KINDS = ["dockerhub", "quay", "ghcr", "gitlab"] as const;
export type Kind = (typeof PACKAGE_KINDS)[number] | (typeof CONTAINER_KINDS)[number];
export const INDEXED = new Set<Kind>([
  "pypi",
  "go",
  "conda",
  "homebrew",
  "apt",
  "rpm",
  "alpine",
  "nixpkgs",
  "pub",
  "cran",
  "bioconductor",
  "vcpkg",
]);
export interface Auth {
  mode?: "anonymous" | "auto" | "required";
  scheme?: "bearer" | "basic" | "token";
  username?: string;
  token_env?: string;
  password_env?: string;
  token_file?: string;
  origins?: string[];
  paths?: string[];
}
export interface Source {
  id: string;
  kind: Kind;
  url: string;
  registry_url?: string;
  index_url?: string;
  auth?: Auth;
  registry_auth?: Auth;
  allowed_origins?: string[];
  options?: Record<string, string>;
}
export interface Limits {
  requests: number;
  bytes: number;
  timeout_ms: number;
  retries: number;
  cache_seconds: number;
}
export interface Settings {
  sources: Source[];
  cache_dir: string;
  limits: Limits;
}
export interface Budget {
  requests: number;
  bytes: number;
  started: number;
}
export interface Query {
  operation: Operation;
  name: string;
  version: string;
  query: string;
  limit: number;
  cursor: string;
}
export interface Page {
  rows: Row[];
  next: string;
}
export class RegistryError extends Error {
  constructor(
    public code: string,
    message: string,
    public status?: number,
  ) {
    super(`${code}: ${message}${status ? ` (HTTP ${status})` : ""}`);
  }
}
export const obj = (value: unknown): JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
export const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : value == null ? [] : [value]);
export const str = (value: unknown): string =>
  typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
export const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
export const nullable = (value: unknown): string | null => str(value) || null;
export const json = (value: unknown): string => JSON.stringify(value ?? null);
export const rowsPage = (rows: Row[], query: Query, batch = 256): Page => {
  const start = Number(query.cursor || 0);
  if (!Number.isSafeInteger(start) || start < 0) throw new RegistryError("INVALID_CURSOR", "Invalid row offset");
  const end = Math.min(rows.length, start + Math.min(batch, query.limit));
  return { rows: rows.slice(start, end), next: end < rows.length ? String(end) : "" };
};
export const pathName = (name: string) => name.split("/").map(encodeURIComponent).join("/");
export function baseRow(source: Source, name: string, values: Row = {}): Row {
  return { source_id: source.id, ecosystem: source.kind, name, observed_at: new Date().toISOString(), ...values };
}
export function dependency(
  source: Source,
  name: string,
  version: string,
  target: string,
  requirement: string,
  kind: string,
  extra: Row = {},
): Row {
  return baseRow(source, name, {
    version,
    dependency: target,
    requirement,
    kind,
    condition: null,
    declaration_context: "declared",
    ...extra,
  });
}
