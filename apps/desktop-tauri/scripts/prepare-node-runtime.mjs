import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const NODE_VERSION = process.env.T4CODE_NODE_VERSION ?? "24.13.1";
const appDir = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const cacheRoot = join(appDir, ".cache", "node", NODE_VERSION);
const stageRoot = join(appDir, ".stage", "node-runtime");

const platform = process.platform;
const arch = process.arch;

if (platform !== "darwin") {
  throw new Error("prepare-node-runtime.mjs currently supports macOS only.");
}

const nodeArch = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null;
if (!nodeArch) {
  throw new Error(`Unsupported Node arch: ${arch}`);
}

const archiveBase = `node-v${NODE_VERSION}-darwin-${nodeArch}`;
const archiveName = `${archiveBase}.tar.gz`;
const archiveUrl = `https://nodejs.org/dist/v${NODE_VERSION}/${archiveName}`;
const archivePath = join(cacheRoot, archiveName);
const extractedRoot = join(cacheRoot, archiveBase);
const sourceNodePath = join(extractedRoot, "bin", "node");
const stagedNodePath = join(stageRoot, "bin", "node");

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

mkdirSync(cacheRoot, { recursive: true });

if (!existsSync(archivePath)) {
  run("curl", ["-L", archiveUrl, "-o", archivePath]);
}

if (!existsSync(sourceNodePath)) {
  run("tar", ["-xzf", archivePath, "-C", cacheRoot]);
}

rmSync(stageRoot, { recursive: true, force: true });
mkdirSync(join(stageRoot, "bin"), { recursive: true });
copyFileSync(sourceNodePath, stagedNodePath);
chmodSync(stagedNodePath, 0o755);
