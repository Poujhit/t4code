import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const repoRoot = resolve(appDir, "../..");

function run(command, args, cwd = appDir) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: process.env,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run("bun", ["run", "--cwd", resolve(repoRoot, "apps/server"), "build"]);
run("node", [resolve(appDir, "scripts/stage-server-runtime.mjs")]);
run("node", [resolve(appDir, "scripts/prepare-node-runtime.mjs")]);
run("bun", ["run", "tauri:frontend:build"]);
run("bunx", ["tauri", "build"]);
