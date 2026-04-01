import fs from "node:fs/promises";
import path from "node:path";

import type {
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "@t3tools/contracts";

export const WORKSPACE_EDITABLE_TEXT_SIZE_LIMIT_BYTES = 1024 * 1024;
const WORKSPACE_BINARY_SAMPLE_BYTES = 8192;
const WORKSPACE_MTIME_MATCH_TOLERANCE_MS = 0.5;

export class WorkspacePathError extends Error {}
export class WorkspaceFileMissingError extends Error {}
export class WorkspaceFileConflictError extends Error {}
export class WorkspaceFileNotReadableError extends Error {}

function toPosixRelativePath(input: string): string {
  return input.replaceAll("\\", "/");
}

export function resolveWorkspaceFilePath(params: { workspaceRoot: string; relativePath: string }): {
  absolutePath: string;
  relativePath: string;
} {
  const normalizedInputPath = params.relativePath.trim();
  if (path.isAbsolute(normalizedInputPath)) {
    throw new WorkspacePathError("Workspace file path must be relative to the project root.");
  }

  const absolutePath = path.resolve(params.workspaceRoot, normalizedInputPath);
  const relativeToRoot = toPosixRelativePath(path.relative(params.workspaceRoot, absolutePath));
  if (
    relativeToRoot.length === 0 ||
    relativeToRoot === "." ||
    relativeToRoot.startsWith("../") ||
    relativeToRoot === ".." ||
    path.isAbsolute(relativeToRoot)
  ) {
    throw new WorkspacePathError("Workspace file path must stay within the project root.");
  }

  return {
    absolutePath,
    relativePath: relativeToRoot,
  };
}

export function bufferLooksBinary(buffer: Uint8Array): boolean {
  for (const byte of buffer) {
    if (byte === 0) {
      return true;
    }
  }
  return false;
}

async function readBinarySample(absolutePath: string): Promise<Buffer> {
  const handle = await fs.open(absolutePath, "r");
  try {
    const sample = Buffer.allocUnsafe(WORKSPACE_BINARY_SAMPLE_BYTES);
    const { bytesRead } = await handle.read(sample, 0, WORKSPACE_BINARY_SAMPLE_BYTES, 0);
    return sample.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function asReadableError(error: unknown, absolutePath: string): Error {
  if (error instanceof WorkspacePathError) {
    return error;
  }

  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return new WorkspaceFileMissingError(`Workspace file not found: ${absolutePath}`);
    }
  }

  return new WorkspaceFileNotReadableError(`Failed to read workspace file: ${String(error)}`);
}

export async function readWorkspaceFile(
  input: ProjectReadFileInput,
): Promise<ProjectReadFileResult> {
  const target = resolveWorkspaceFilePath({
    workspaceRoot: input.cwd,
    relativePath: input.relativePath,
  });

  try {
    const stats = await fs.stat(target.absolutePath);
    if (!stats.isFile()) {
      throw new WorkspaceFileNotReadableError(
        `Workspace path is not a readable file: ${target.relativePath}`,
      );
    }

    const binarySample = await readBinarySample(target.absolutePath);
    const isBinary = bufferLooksBinary(binarySample);
    const isTooLarge = stats.size > WORKSPACE_EDITABLE_TEXT_SIZE_LIMIT_BYTES;

    return {
      relativePath: target.relativePath,
      contents: isBinary || isTooLarge ? "" : await fs.readFile(target.absolutePath, "utf8"),
      mtimeMs: stats.mtimeMs,
      sizeBytes: stats.size,
      isBinary,
      isTooLarge,
    };
  } catch (error) {
    throw asReadableError(error, target.absolutePath);
  }
}

export async function writeWorkspaceFile(
  input: ProjectWriteFileInput,
): Promise<ProjectWriteFileResult> {
  const target = resolveWorkspaceFilePath({
    workspaceRoot: input.cwd,
    relativePath: input.relativePath,
  });

  if (input.expectedMtimeMs !== undefined && input.expectedMtimeMs !== null) {
    let currentStats;
    try {
      currentStats = await fs.stat(target.absolutePath);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          throw new WorkspaceFileConflictError(
            `Workspace file changed on disk since it was opened: ${target.relativePath}`,
          );
        }
      }
      throw new WorkspaceFileNotReadableError(
        `Failed to stat workspace file before save: ${String(error)}`,
      );
    }

    if (
      !currentStats.isFile() ||
      Math.abs(currentStats.mtimeMs - input.expectedMtimeMs) > WORKSPACE_MTIME_MATCH_TOLERANCE_MS
    ) {
      throw new WorkspaceFileConflictError(
        `Workspace file changed on disk since it was opened: ${target.relativePath}`,
      );
    }
  }

  await fs.mkdir(path.dirname(target.absolutePath), { recursive: true });
  await fs.writeFile(target.absolutePath, input.contents, "utf8");

  return { relativePath: target.relativePath };
}
