import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const stage = mkdtempSync(join(tmpdir(), "vgi-bundle-"));
try {
  for (const name of ["vgi-packages-worker", "vgi-containers-worker", "vgi-software-index"])
    cpSync(join(import.meta.dir, "../../dist", name), join(stage, name));
  const p = Bun.spawn([process.execPath, "run", join(import.meta.dir, "sql_runner.ts")], {
    env: { ...process.env, SOFTWARE_BIN_DIR: stage },
    stdout: "inherit",
    stderr: "inherit",
    cwd: stage,
  });
  if (await p.exited) throw new Error("Standalone artifact SQL verification failed");
} finally {
  rmSync(stage, { recursive: true, force: true });
}
