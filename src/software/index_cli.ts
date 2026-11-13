import { VERSION } from "../meta.ts";
import { loadSettings, sourceById } from "./config.ts";
import { Http } from "./http.ts";
import { indexInfo, prepareIndex } from "./indexes.ts";
import { RegistryError } from "./model.ts";

export async function main(args: string[]) {
  const [command, id, ...options] = args;
  if (command === "--version") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (!command || command === "--help") {
    process.stdout.write(
      "Usage: vgi-software-index prepare|status SOURCE_ID [--input PATH]\nConfiguration: VGI_SOFTWARE_CONFIG; optional credentials use configured environment/file references.\nGo prepare consumes one checkpointed feed page; repeat until complete. Nix requires a pinned revision.\n",
    );
    return;
  }
  if (
    !["prepare", "status"].includes(command) ||
    !id ||
    (options.length && (options.length !== 2 || options[0] !== "--input"))
  )
    throw new RegistryError("ARGUMENT", "Expected prepare|status SOURCE_ID [--input PATH]");
  const settings = loadSettings(),
    source = sourceById(settings, id);
  const result =
    command === "status"
      ? indexInfo(settings, source)
      : await prepareIndex(settings, new Http(source, settings.limits), options[1]);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
if (import.meta.main)
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `${error instanceof RegistryError ? error.message : "Index preparation failed; check metadata format and configured paths"}\n`,
    );
    process.exitCode = 1;
  });
