import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { secretsOfType } from "@query-farm/vgi";
import { type Auth, type Budget, type Limits, obj, RegistryError, type Source, str } from "./model.ts";

export interface Credential {
  scheme: "bearer" | "basic" | "token";
  token: string;
  username: string;
}
export type Secrets = Record<string, Record<string, unknown>>;
interface Cached {
  body: Uint8Array;
  headers: Record<string, string>;
  expires: number;
  etag: string | null;
}
const cache = new Map<string, Cached>();
let cacheBytes = 0;
export const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

export function credential(source: Source, secrets: Secrets = {}, registry = false): Credential | undefined {
  const auth = registry ? (source.registry_auth ?? source.auth) : source.auth;
  if (auth?.mode === "anonymous") return;
  for (const secret of secretsOfType(secrets, "software_registry")) {
    if (secret.source_id === source.id && (!secret.purpose || secret.purpose === (registry ? "registry" : "api"))) {
      const token = str(secret.token) || str(secret.password);
      const scheme = str(secret.scheme) || auth?.scheme || "bearer";
      if (!["bearer", "basic", "token"].includes(scheme))
        throw new RegistryError("AUTH_CONFIG", "Unsupported secret scheme");
      if (token)
        return {
          scheme: scheme as Credential["scheme"],
          token,
          username: str(secret.username) || auth?.username || "",
        };
    }
  }
  let token = "";
  try {
    token = auth?.token_file
      ? readFileSync(auth.token_file, "utf8").trim()
      : process.env[auth?.token_env ?? auth?.password_env ?? ""] || "";
  } catch {
    throw new RegistryError("AUTH_REQUIRED", `Cannot read credential file for ${source.id}`);
  }
  if (token) return { token, scheme: auth?.scheme ?? "bearer", username: auth?.username ?? "" };
  if (auth?.mode === "required" || auth?.token_env || auth?.password_env || auth?.token_file)
    throw new RegistryError("AUTH_REQUIRED", `Missing configured credentials for ${source.id}`);
}
export function authorization(c: Credential): string {
  return c.scheme === "basic"
    ? `Basic ${Buffer.from(`${c.username}:${c.token}`).toString("base64")}`
    : c.scheme === "token"
      ? c.token
      : `Bearer ${c.token}`;
}
export function authScope(source: Source, secrets: Secrets = {}): string {
  return digest(JSON.stringify([source, credential(source, secrets), credential(source, secrets, true)]));
}
export function safeUrl(value: string): string {
  try {
    const u = new URL(value);
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    u.pathname = u.pathname.replace(/\/t\/[^/]+/g, "/t/[redacted]");
    return u.toString();
  } catch {
    return "[invalid URL]";
  }
}
export function sanitize(value: string, secrets: Secrets, source: Source): string {
  if (/^\s*[[{]/.test(value)) {
    try {
      const clean = (input: unknown): unknown =>
        typeof input === "string"
          ? sanitize(input, secrets, source)
          : Array.isArray(input)
            ? input.map(clean)
            : input && typeof input === "object"
              ? Object.fromEntries(Object.entries(input).map(([k, v]) => [sanitize(k, secrets, source), clean(v)]))
              : input;
      return JSON.stringify(clean(JSON.parse(value)));
    } catch {
      /* Non-JSON descriptions are cleaned as text. */
    }
  }
  let result = value;
  for (const c of [credential(source, secrets), credential(source, secrets, true)])
    if (c?.token)
      result = result.split(c.token).join("[redacted]").split(encodeURIComponent(c.token)).join("[redacted]");
  return result.replace(/https?:\/\/[^\s"<>]+/g, (u) => safeUrl(u));
}
export class Http {
  constructor(
    public source: Source,
    public limits: Limits,
    public budget: Budget = { requests: 0, bytes: 0, started: Date.now() },
    public secrets: Secrets = {},
    public signal?: AbortSignal,
  ) {}
  remaining(): number {
    const time = this.limits.timeout_ms - (Date.now() - this.budget.started);
    if (this.signal?.aborted) throw new RegistryError("CANCELLED", "Query was cancelled");
    if (time <= 0) throw new RegistryError("BUDGET", "Elapsed-time budget exceeded");
    return time;
  }
  checkUrl(value: string): URL {
    const u = new URL(value);
    const origins = [
      this.source.url,
      this.source.registry_url,
      this.source.index_url,
      ...(this.source.allowed_origins ?? []),
    ]
      .filter(Boolean)
      .map((x) => new URL(x as string).origin);
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || !origins.includes(u.origin))
      throw new RegistryError("ORIGIN_DENIED", `Source ${this.source.id} does not allow origin ${u.origin}`);
    return u;
  }
  private authFor(url: URL, registry: boolean): string | undefined {
    const auth: Auth | undefined = registry ? (this.source.registry_auth ?? this.source.auth) : this.source.auth;
    const primary = new URL(registry ? (this.source.registry_url ?? this.source.url) : this.source.url).origin;
    const c = credential(this.source, this.secrets, registry);
    const pathAllowed =
      !auth?.paths ||
      auth.paths.some(
        (path) => url.pathname === path || url.pathname.startsWith(path.endsWith("/") ? path : `${path}/`),
      );
    return c && pathAllowed && (url.origin === primary || auth?.origins?.includes(url.origin))
      ? authorization(c)
      : undefined;
  }
  async request(
    value: string,
    options: {
      headers?: Record<string, string>;
      registry?: boolean;
      noCache?: boolean;
      allow401?: boolean;
      authOverride?: string;
    } = {},
  ): Promise<{ body: Uint8Array; headers: Record<string, string>; status: number }> {
    let url = this.checkUrl(value);
    const registry = options.registry ?? false;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "vgi-software-packages/0.1.0 (https://query.farm)",
      ...options.headers,
    };
    const auth = options.authOverride ?? this.authFor(url, registry);
    if (auth) headers.Authorization = auth;
    const key = digest(JSON.stringify([authScope(this.source, this.secrets), value, headers]));
    const cached = options.noCache ? undefined : cache.get(key);
    this.remaining();
    if (cached && cached.expires > Date.now()) return { ...cached, status: 200 };
    if (cached?.etag) headers["If-None-Match"] = cached.etag;
    let redirects = 0;
    for (let attempt = 0; ; attempt++) {
      if (++this.budget.requests > this.limits.requests)
        throw new RegistryError("BUDGET", "HTTP request budget exceeded");
      const timeout = AbortSignal.timeout(this.remaining());
      const signal = this.signal ? AbortSignal.any([timeout, this.signal]) : timeout;
      let response: Response;
      try {
        response = await fetch(url, { headers, redirect: "manual", signal });
      } catch {
        this.remaining();
        if (attempt >= this.limits.retries) throw new RegistryError("NETWORK", `Request failed for ${this.source.id}`);
        await this.delay(100 * 2 ** attempt);
        continue;
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location || ++redirects > 5) throw new RegistryError("REDIRECT", "Invalid or excessive redirects");
        const next = this.checkUrl(new URL(location, url).toString());
        if (next.origin !== url.origin || !options.authOverride) {
          delete headers.Authorization;
          const nextAuth = this.authFor(next, registry);
          if (nextAuth) headers.Authorization = nextAuth;
        }
        url = next;
        continue;
      }
      if (response.status === 304 && cached) {
        await response.body?.cancel();
        cached.expires = Date.now() + this.limits.cache_seconds * 1000;
        return { ...cached, status: 200 };
      }
      const responseHeaders = Object.fromEntries(response.headers);
      if (response.status === 401 && options.allow401) {
        await response.body?.cancel();
        return { body: new Uint8Array(), headers: responseHeaders, status: 401 };
      }
      if (!response.ok) {
        await response.body?.cancel();
        if ((response.status === 429 || response.status >= 500) && attempt < this.limits.retries) {
          const retry = response.headers.get("retry-after");
          const delay = retry
            ? /^\d+$/.test(retry)
              ? Number(retry) * 1000
              : Math.max(0, Date.parse(retry) - Date.now())
            : 100 * 2 ** attempt;
          await this.delay(Number.isFinite(delay) ? delay : 100);
          continue;
        }
        const code =
          response.status === 401
            ? "AUTH_REQUIRED"
            : response.status === 403
              ? "ACCESS_DENIED"
              : response.status === 404
                ? "NOT_FOUND"
                : response.status === 429
                  ? "RATE_LIMIT"
                  : "UPSTREAM";
        throw new RegistryError(code, `Request to ${this.source.id} failed`, response.status);
      }
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      const reader = response.body?.getReader();
      try {
        if (reader)
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            bytes += part.value.length;
            this.budget.bytes += part.value.length;
            if (this.budget.bytes > this.limits.bytes)
              throw new RegistryError("BUDGET", "Response byte budget exceeded");
            chunks.push(part.value);
          }
      } catch (err) {
        await reader?.cancel();
        if (err instanceof RegistryError) throw err;
        throw new RegistryError("NETWORK", `Response interrupted for ${this.source.id}`);
      }
      const body = new Uint8Array(bytes);
      let offset = 0;
      for (const part of chunks) {
        body.set(part, offset);
        offset += part.length;
      }
      if (
        !options.noCache &&
        !/no-store/i.test(response.headers.get("cache-control") ?? "") &&
        bytes < 16 * 1024 * 1024
      ) {
        if (cache.has(key)) cacheBytes -= cache.get(key)?.body.length ?? 0;
        cache.set(key, {
          body,
          headers: responseHeaders,
          etag: response.headers.get("etag"),
          expires: Date.now() + this.limits.cache_seconds * 1000,
        });
        cacheBytes += bytes;
        while (cacheBytes > 64 * 1024 * 1024 || cache.size > 128) {
          const first = cache.keys().next().value;
          if (!first) break;
          cacheBytes -= cache.get(first)?.body.length ?? 0;
          cache.delete(first);
        }
      }
      return { body, headers: responseHeaders, status: response.status };
    }
  }
  private async delay(ms: number): Promise<void> {
    if (ms >= this.remaining()) throw new RegistryError("BUDGET", "Retry delay exceeds deadline");
    await Bun.sleep(ms);
    this.remaining();
  }
  async text(url: string, headers?: Record<string, string>): Promise<string> {
    return new TextDecoder().decode((await this.request(url, { headers })).body);
  }
  async json(url: string, headers?: Record<string, string>): Promise<unknown> {
    try {
      return JSON.parse(await this.text(url, headers));
    } catch (err) {
      if (err instanceof RegistryError) throw err;
      throw new RegistryError("MALFORMED", `Invalid JSON from ${this.source.id}`);
    }
  }
  async object(url: string, headers?: Record<string, string>) {
    const value = await this.json(url, headers);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new RegistryError("MALFORMED", `Expected a JSON object from ${this.source.id}`);
    return obj(value);
  }
}
