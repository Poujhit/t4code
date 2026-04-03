import { spawn, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const repoRoot = resolve(appDir, "../..");
const children = [];

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

function start(command, args, cwd = appDir) {
  const child = spawn(command, args, {
    cwd,
    stdio: "inherit",
    env: process.env,
  });

  children.push(child);
  child.once("exit", (code) => {
    if (code && code !== 0) {
      shutdown(code);
    }
  });

  return child;
}

function shutdown(exitCode = 0) {
  while (children.length > 0) {
    const child = children.pop();
    if (!child || child.killed) continue;
    child.kill("SIGTERM");
  }
  process.exit(exitCode);
}

run("bun", ["run", "--cwd", resolve(repoRoot, "apps/server"), "build"]);
start("bunx", ["tsdown", "--watch"], resolve(repoRoot, "apps/server"));
start("bun", ["run", "tauri:frontend:dev"], appDir);
start("bunx", ["tauri", "dev"], appDir);

process.once("SIGINT", () => shutdown(130));
process.once("SIGTERM", () => shutdown(143));
