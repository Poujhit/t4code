import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const entryPath = resolve(here, "dist/index.mjs");

try {
  await import(pathToFileURL(entryPath).href);
} catch (error) {
  console.error("[t4code-sidecar] failed to launch server", error);
  process.exitCode = 1;
}
