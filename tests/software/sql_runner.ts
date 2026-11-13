import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture } from "./fixture.ts";

// Keep the fixture event loop alive while a real engine executes SQL in another process.
const f = await fixture();
try {
  f.settings.sources.push({
    id: "npm_private",
    kind: "npm",
    url: `${f.origin}/private/npm`,
    auth: { mode: "required" },
  });
  writeFileSync(f.configPath, JSON.stringify(f.settings));
  const root = join(import.meta.dir, "../..");
  const engine = process.env.ENGINE ?? "haybarn";
  if (process.env.SOFTWARE_BIN_DIR) {
    const cli = Bun.spawn([join(process.env.SOFTWARE_BIN_DIR, "vgi-software-index"), "prepare", "pypi_test"], {
      env: { ...process.env, VGI_SOFTWARE_CONFIG: f.configPath },
      cwd: f.directory,
      stdout: "pipe",
      stderr: "inherit",
    });
    const output = (await new Response(cli.stdout).json()) as { complete: boolean };
    if ((await cli.exited) || output.complete !== true) throw new Error("Compiled index preparation failed");
  }
  const cmd =
    engine === "duckdb"
      ? ["uv", "run", "--no-project", "--with", "duckdb==2.0.0", "python"]
      : [join(root, process.platform === "win32" ? ".tools/Scripts/python.exe" : ".tools/bin/python")];
  const p = Bun.spawn([...cmd, join(root, "tests/software/verify_sql.py")], {
    env: { ...process.env, VGI_SOFTWARE_CONFIG: f.configPath, VGI_FIXTURE_DIGEST: f.manifestDigest, ENGINE: engine },
    stdout: "inherit",
    stderr: "inherit",
    cwd: f.directory,
  });
  const timeout = setTimeout(() => p.kill(), 180_000);
  const code = await p.exited;
  clearTimeout(timeout);
  if (code) throw new Error(`SQL verification failed (${code})`);
} finally {
  f.cleanup();
}
