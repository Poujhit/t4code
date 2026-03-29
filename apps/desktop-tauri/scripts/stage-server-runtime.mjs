import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  chmodSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const repoRoot = resolve(appDir, "../..");
const stageDir = join(appDir, ".stage", "server-runtime");
const serverDir = join(repoRoot, "apps", "server");
const rootPackageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const serverPackageJson = JSON.parse(readFileSync(join(serverDir, "package.json"), "utf8"));

function resolveCatalogDependencies(dependencies) {
  const catalog = rootPackageJson.workspaces?.catalog ?? {};
  return Object.fromEntries(
    Object.entries(dependencies ?? {}).map(([name, version]) => {
      if (version === "catalog:") {
        const resolved = catalog[name];
        if (typeof resolved !== "string" || resolved.length === 0) {
          throw new Error(`Missing catalog dependency for ${name}`);
        }
        return [name, resolved];
      }
      return [name, version];
    }),
  );
}

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

rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

const stagedPackageJson = {
  name: "t4code-sidecar-server",
  version: serverPackageJson.version,
  private: true,
  type: "module",
  dependencies: resolveCatalogDependencies(serverPackageJson.dependencies),
};

writeFileSync(join(stageDir, "package.json"), `${JSON.stringify(stagedPackageJson, null, 2)}\n`);
cpSync(join(serverDir, "dist"), join(stageDir, "dist"), { recursive: true });
cpSync(join(appDir, "scripts", "server-launcher.mjs"), join(stageDir, "server-launcher.mjs"));

run("bun", ["install", "--production"], stageDir);

const helperCandidates = [
  join(stageDir, "node_modules", "node-pty", "build", "Release", "spawn-helper"),
  join(stageDir, "node_modules", "node-pty", "build", "Debug", "spawn-helper"),
  join(
    stageDir,
    "node_modules",
    "node-pty",
    "prebuilds",
    `${process.platform}-${process.arch}`,
    "spawn-helper",
  ),
];

for (const candidate of helperCandidates) {
  if (existsSync(candidate)) {
    chmodSync(candidate, 0o755);
  }
}
