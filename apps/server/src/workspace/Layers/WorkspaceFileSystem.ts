import fsPromises from "node:fs/promises";

import type { ProjectDirectoryEntry } from "@t3tools/contracts";
import { Effect, FileSystem, Layer, Option, Path } from "effect";

import { GitCore } from "../../git/Services/GitCore.ts";
import {
  WorkspaceFileSystem,
  WorkspaceFileSystemError,
  type WorkspaceFileSystemShape,
} from "../Services/WorkspaceFileSystem.ts";
import { WorkspaceEntries } from "../Services/WorkspaceEntries.ts";
import { WorkspacePaths } from "../Services/WorkspacePaths.ts";

export const WORKSPACE_EDITABLE_TEXT_SIZE_LIMIT_BYTES = 1024 * 1024;
const WORKSPACE_BINARY_SAMPLE_BYTES = 8192;
const WORKSPACE_MTIME_MATCH_TOLERANCE_MS = 0.5;
const WORKSPACE_DIRECTORY_LIST_MAX_ENTRIES = 1_000;
const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  ".convex",
  "node_modules",
  ".next",
  ".turbo",
  "dist",
  "build",
  "out",
  ".cache",
]);

function toPosixRelativePath(input: string): string {
  return input.replaceAll("\\", "/");
}

function isPathInIgnoredDirectory(relativePath: string): boolean {
  const firstSegment = relativePath.split("/")[0];
  if (!firstSegment) return false;
  return IGNORED_DIRECTORY_NAMES.has(firstSegment);
}

function compareWorkspaceDirectoryEntries(
  left: ProjectDirectoryEntry,
  right: ProjectDirectoryEntry,
): number {
  if (left.kind !== right.kind) {
    return left.kind === "directory" ? -1 : 1;
  }
  return left.name.localeCompare(right.name);
}

function bufferLooksBinary(buffer: Uint8Array): boolean {
  for (const byte of buffer) {
    if (byte === 0) {
      return true;
    }
  }
  return false;
}

function workspaceFileSystemError(input: {
  cwd: string;
  relativePath?: string | null;
  operation: string;
  detail: string;
  cause?: unknown;
}): WorkspaceFileSystemError {
  return new WorkspaceFileSystemError({
    cwd: input.cwd,
    operation: input.operation,
    detail: input.detail,
    ...(input.relativePath == null ? {} : { relativePath: input.relativePath }),
    ...(input.cause === undefined ? {} : { cause: input.cause }),
  });
}

function getInfoMtimeMs(info: FileSystem.File.Info): number {
  return Option.getOrElse(info.mtime, () => new Date(0)).getTime();
}

function getInfoSizeBytes(info: FileSystem.File.Info): number {
  return Number(info.size);
}

export const makeWorkspaceFileSystem = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const gitOption = yield* Effect.serviceOption(GitCore);
  const workspacePaths = yield* WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries;

  const normalizeWorkspaceRoot = Effect.fn("WorkspaceFileSystem.normalizeWorkspaceRoot")(function* (
    cwd: string,
  ) {
    return yield* workspacePaths.normalizeWorkspaceRoot(cwd).pipe(
      Effect.mapError((cause) =>
        workspaceFileSystemError({
          cwd,
          operation: "workspaceFileSystem.normalizeWorkspaceRoot",
          detail: cause.message,
          cause,
        }),
      ),
    );
  });

  const isInsideGitWorkTree = (cwd: string): Effect.Effect<boolean> =>
    Option.match(gitOption, {
      onSome: (git) => git.isInsideWorkTree(cwd).pipe(Effect.catch(() => Effect.succeed(false))),
      onNone: () => Effect.succeed(false),
    });

  const filterGitIgnoredPaths = (
    cwd: string,
    relativePaths: string[],
  ): Effect.Effect<string[], never> =>
    Option.match(gitOption, {
      onSome: (git) =>
        git.filterIgnoredPaths(cwd, relativePaths).pipe(
          Effect.map((paths) => [...paths]),
          Effect.catch(() => Effect.succeed(relativePaths)),
        ),
      onNone: () => Effect.succeed(relativePaths),
    });

  const listDirectory: WorkspaceFileSystemShape["listDirectory"] = Effect.fn(
    "WorkspaceFileSystem.listDirectory",
  )(function* (input) {
    const normalizedWorkspaceRoot = yield* normalizeWorkspaceRoot(input.cwd);

    let target: {
      absolutePath: string;
      normalizedRelativePath: string | null;
    };

    if (input.relativePath === null) {
      target = {
        absolutePath: normalizedWorkspaceRoot,
        normalizedRelativePath: null,
      };
    } else {
      const relativePath = input.relativePath;
      const trimmedPath = relativePath.trim();

      if (trimmedPath === "." || trimmedPath === "./") {
        return yield* workspaceFileSystemError({
          cwd: input.cwd,
          relativePath,
          operation: "workspaceFileSystem.listDirectory.resolvePath",
          detail: "Workspace directory path must be null for the root directory.",
        });
      }

      if (path.isAbsolute(trimmedPath)) {
        return yield* workspaceFileSystemError({
          cwd: input.cwd,
          relativePath,
          operation: "workspaceFileSystem.listDirectory.resolvePath",
          detail: "Workspace directory path must be relative to the project root.",
        });
      }

      const absolutePath = path.resolve(normalizedWorkspaceRoot, trimmedPath);
      const relativeToRoot = toPosixRelativePath(
        path.relative(normalizedWorkspaceRoot, absolutePath),
      );

      if (
        relativeToRoot.length === 0 ||
        relativeToRoot === "." ||
        relativeToRoot === ".." ||
        relativeToRoot.startsWith("../") ||
        path.isAbsolute(relativeToRoot)
      ) {
        return yield* workspaceFileSystemError({
          cwd: input.cwd,
          relativePath,
          operation: "workspaceFileSystem.listDirectory.resolvePath",
          detail: "Workspace directory path must stay within the project root.",
        });
      }

      if (isPathInIgnoredDirectory(relativeToRoot)) {
        return yield* workspaceFileSystemError({
          cwd: input.cwd,
          relativePath,
          operation: "workspaceFileSystem.listDirectory.resolvePath",
          detail: "Workspace directory path is unavailable.",
        });
      }

      target = {
        absolutePath,
        normalizedRelativePath: relativeToRoot,
      };
    }

    const targetStat = yield* fileSystem.stat(target.absolutePath).pipe(
      Effect.mapError((cause) =>
        workspaceFileSystemError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          operation: "workspaceFileSystem.listDirectory.stat",
          detail: `Workspace directory does not exist: ${cause.message}`,
          cause,
        }),
      ),
    );

    if (targetStat.type !== "Directory") {
      return yield* workspaceFileSystemError({
        cwd: input.cwd,
        relativePath: input.relativePath,
        operation: "workspaceFileSystem.listDirectory.stat",
        detail: "Workspace directory path must resolve to a directory.",
      });
    }

    const dirents = yield* Effect.tryPromise({
      try: () => fsPromises.readdir(target.absolutePath, { withFileTypes: true }),
      catch: (cause) =>
        workspaceFileSystemError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          operation: "workspaceFileSystem.listDirectory.readDirectory",
          detail: `Unable to read workspace directory: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
          cause,
        }),
    });

    const candidateEntries = dirents
      .filter((dirent) => dirent.name.length > 0 && dirent.name !== "." && dirent.name !== "..")
      .filter((dirent) => dirent.isDirectory() || dirent.isFile())
      .filter((dirent) => !(dirent.isDirectory() && IGNORED_DIRECTORY_NAMES.has(dirent.name)))
      .map((dirent) => {
        const relativePath = toPosixRelativePath(
          target.normalizedRelativePath
            ? path.join(target.normalizedRelativePath, dirent.name)
            : dirent.name,
        );
        return { dirent, relativePath };
      })
      .filter((entry) => !isPathInIgnoredDirectory(entry.relativePath));

    const allowedPathSet = (yield* isInsideGitWorkTree(normalizedWorkspaceRoot))
      ? new Set(
          yield* filterGitIgnoredPaths(
            normalizedWorkspaceRoot,
            candidateEntries.map((entry) => entry.relativePath),
          ),
        )
      : null;

    const entries: ProjectDirectoryEntry[] = candidateEntries
      .filter((entry) => (allowedPathSet ? allowedPathSet.has(entry.relativePath) : true))
      .map(
        (entry): ProjectDirectoryEntry => ({
          path: entry.relativePath,
          name: entry.dirent.name,
          kind: entry.dirent.isDirectory() ? "directory" : "file",
          parentPath: target.normalizedRelativePath,
        }),
      )
      .toSorted(compareWorkspaceDirectoryEntries);

    return {
      entries: entries.slice(0, WORKSPACE_DIRECTORY_LIST_MAX_ENTRIES),
      truncated: entries.length > WORKSPACE_DIRECTORY_LIST_MAX_ENTRIES,
    };
  });

  const readFile: WorkspaceFileSystemShape["readFile"] = Effect.fn("WorkspaceFileSystem.readFile")(
    function* (input) {
      const normalizedWorkspaceRoot = yield* normalizeWorkspaceRoot(input.cwd);
      const target = yield* workspacePaths.resolveRelativePathWithinRoot({
        workspaceRoot: normalizedWorkspaceRoot,
        relativePath: input.relativePath,
      });

      const stats = yield* fileSystem.stat(target.absolutePath).pipe(
        Effect.mapError((cause) => {
          const detail =
            cause.reason._tag === "NotFound"
              ? `Workspace file not found: ${target.absolutePath}`
              : `Failed to read workspace file: ${cause.message}`;

          return workspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.readFile.stat",
            detail,
            cause,
          });
        }),
      );

      if (stats.type !== "File") {
        return yield* workspaceFileSystemError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          operation: "workspaceFileSystem.readFile.stat",
          detail: `Workspace path is not a readable file: ${target.relativePath}`,
        });
      }

      const binarySample = yield* Effect.tryPromise({
        try: async () => {
          const handle = await fsPromises.open(target.absolutePath, "r");

          try {
            const sample = Buffer.allocUnsafe(WORKSPACE_BINARY_SAMPLE_BYTES);
            const { bytesRead } = await handle.read(sample, 0, WORKSPACE_BINARY_SAMPLE_BYTES, 0);
            return sample.subarray(0, bytesRead);
          } finally {
            await handle.close();
          }
        },
        catch: (cause) =>
          workspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.readFile.binarySample",
            detail: `Failed to read workspace file: ${
              cause instanceof Error ? cause.message : String(cause)
            }`,
            cause,
          }),
      });

      const sizeBytes = getInfoSizeBytes(stats);
      const isBinary = bufferLooksBinary(binarySample);
      const isTooLarge = sizeBytes > WORKSPACE_EDITABLE_TEXT_SIZE_LIMIT_BYTES;
      const contents =
        isBinary || isTooLarge
          ? ""
          : yield* fileSystem.readFileString(target.absolutePath).pipe(
              Effect.mapError((cause) =>
                workspaceFileSystemError({
                  cwd: input.cwd,
                  relativePath: input.relativePath,
                  operation: "workspaceFileSystem.readFile.readFileString",
                  detail: `Failed to read workspace file: ${cause.message}`,
                  cause,
                }),
              ),
            );

      return {
        relativePath: target.relativePath,
        contents,
        mtimeMs: getInfoMtimeMs(stats),
        sizeBytes,
        isBinary,
        isTooLarge,
      };
    },
  );

  const writeFile: WorkspaceFileSystemShape["writeFile"] = Effect.fn(
    "WorkspaceFileSystem.writeFile",
  )(function* (input) {
    const normalizedWorkspaceRoot = yield* normalizeWorkspaceRoot(input.cwd);
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: normalizedWorkspaceRoot,
      relativePath: input.relativePath,
    });

    if (input.expectedMtimeMs !== undefined && input.expectedMtimeMs !== null) {
      const currentStats = yield* fileSystem.stat(target.absolutePath).pipe(
        Effect.mapError((cause) =>
          workspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.writeFile.checkExpectedMtime",
            detail: `Workspace file changed on disk since it was opened: ${target.relativePath}`,
            cause,
          }),
        ),
      );

      if (
        currentStats.type !== "File" ||
        Math.abs(getInfoMtimeMs(currentStats) - input.expectedMtimeMs) >
          WORKSPACE_MTIME_MATCH_TOLERANCE_MS
      ) {
        return yield* workspaceFileSystemError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          operation: "workspaceFileSystem.writeFile.checkExpectedMtime",
          detail: `Workspace file changed on disk since it was opened: ${target.relativePath}`,
        });
      }
    }

    yield* fileSystem.makeDirectory(path.dirname(target.absolutePath), { recursive: true }).pipe(
      Effect.mapError((cause) =>
        workspaceFileSystemError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          operation: "workspaceFileSystem.makeDirectory",
          detail: cause.message,
          cause,
        }),
      ),
    );

    yield* fileSystem.writeFileString(target.absolutePath, input.contents).pipe(
      Effect.mapError((cause) =>
        workspaceFileSystemError({
          cwd: input.cwd,
          relativePath: input.relativePath,
          operation: "workspaceFileSystem.writeFile",
          detail: cause.message,
          cause,
        }),
      ),
    );

    yield* workspaceEntries.invalidate(normalizedWorkspaceRoot);
    return { relativePath: target.relativePath };
  });

  return { listDirectory, readFile, writeFile } satisfies WorkspaceFileSystemShape;
});

export const WorkspaceFileSystemLive = Layer.effect(WorkspaceFileSystem, makeWorkspaceFileSystem);
