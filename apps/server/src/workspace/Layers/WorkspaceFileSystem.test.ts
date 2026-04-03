import fsPromises from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Path, Schema } from "effect";

import { ServerConfig } from "../../config.ts";
import { GitCoreLive } from "../../git/Layers/GitCore.ts";
import { WorkspaceEntries } from "../Services/WorkspaceEntries.ts";
import { WorkspaceFileSystem, WorkspaceFileSystemError } from "../Services/WorkspaceFileSystem.ts";
import { WorkspaceEntriesLive } from "./WorkspaceEntries.ts";
import {
  WORKSPACE_EDITABLE_TEXT_SIZE_LIMIT_BYTES,
  WorkspaceFileSystemLive,
} from "./WorkspaceFileSystem.ts";
import { WorkspacePathsLive } from "./WorkspacePaths.ts";

const ProjectLayer = WorkspaceFileSystemLive.pipe(
  Layer.provide(WorkspacePathsLive),
  Layer.provide(WorkspaceEntriesLive.pipe(Layer.provide(WorkspacePathsLive))),
);

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(ProjectLayer),
  Layer.provideMerge(WorkspaceEntriesLive.pipe(Layer.provide(WorkspacePathsLive))),
  Layer.provideMerge(WorkspacePathsLive),
  Layer.provideMerge(GitCoreLive),
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-workspace-files-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-workspace-files-",
  });
});

const writeTextFile = Effect.fn("writeTextFile")(function* (
  cwd: string,
  relativePath: string,
  contents = "",
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* fileSystem.writeFileString(absolutePath, contents).pipe(Effect.orDie);
});

it.layer(TestLayer)("WorkspaceFileSystemLive", (it) => {
  describe("listDirectory", () => {
    it.effect("lists only direct children and filters ignored directories", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/components/Composer.tsx");
        yield* writeTextFile(cwd, "src/index.ts");
        yield* writeTextFile(cwd, "README.md");
        yield* writeTextFile(cwd, "node_modules/pkg/index.js");

        const root = yield* workspaceFileSystem.listDirectory({
          cwd,
          relativePath: null,
        });
        expect(root).toEqual({
          entries: [
            { path: "src", name: "src", kind: "directory", parentPath: null },
            { path: "README.md", name: "README.md", kind: "file", parentPath: null },
          ],
          truncated: false,
        });

        const nested = yield* workspaceFileSystem.listDirectory({
          cwd,
          relativePath: "src",
        });
        expect(nested).toEqual({
          entries: [
            {
              path: "src/components",
              name: "components",
              kind: "directory",
              parentPath: "src",
            },
            { path: "src/index.ts", name: "index.ts", kind: "file", parentPath: "src" },
          ],
          truncated: false,
        });
      }),
    );
  });

  describe("readFile", () => {
    it.effect("returns binary fallback metadata without file contents", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const path = yield* Path.Path;
        yield* Effect.promise(() =>
          fsPromises.writeFile(path.join(cwd, "image.bin"), Buffer.from([0x01, 0x00, 0x02])),
        );

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "image.bin",
        });

        expect(result).toEqual({
          relativePath: "image.bin",
          contents: "",
          mtimeMs: result.mtimeMs,
          sizeBytes: 3,
          isBinary: true,
          isTooLarge: false,
        });
        expect(typeof result.mtimeMs).toBe("number");
      }),
    );

    it.effect("returns too-large fallback metadata without loading full contents", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(
          cwd,
          "large.txt",
          "a".repeat(WORKSPACE_EDITABLE_TEXT_SIZE_LIMIT_BYTES + 1),
        );

        const result = yield* workspaceFileSystem.readFile({
          cwd,
          relativePath: "large.txt",
        });

        expect(result).toEqual({
          relativePath: "large.txt",
          contents: "",
          mtimeMs: result.mtimeMs,
          sizeBytes: WORKSPACE_EDITABLE_TEXT_SIZE_LIMIT_BYTES + 1,
          isBinary: false,
          isTooLarge: true,
        });
        expect(typeof result.mtimeMs).toBe("number");
      }),
    );
  });

  describe("writeFile", () => {
    it.effect("writes files relative to the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });
        const saved = yield* fileSystem
          .readFileString(path.join(cwd, "plans/effect-rpc.md"))
          .pipe(Effect.orDie);

        expect(result).toEqual({ relativePath: "plans/effect-rpc.md" });
        expect(saved).toBe("# Plan\n");
      }),
    );

    it.effect("invalidates workspace entry search cache after writes", () =>
      Effect.gen(function* () {
        const workspaceEntries = yield* WorkspaceEntries;
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/existing.ts", "export {};\n");

        const beforeWrite = yield* workspaceEntries.search({
          cwd,
          query: "rpc",
          limit: 10,
        });
        expect(beforeWrite).toEqual({
          entries: [],
          truncated: false,
        });

        yield* workspaceFileSystem.writeFile({
          cwd,
          relativePath: "plans/effect-rpc.md",
          contents: "# Plan\n",
        });

        const afterWrite = yield* workspaceEntries.search({
          cwd,
          query: "rpc",
          limit: 10,
        });
        expect(afterWrite.entries).toEqual(
          expect.arrayContaining([expect.objectContaining({ path: "plans/effect-rpc.md" })]),
        );
        expect(afterWrite.truncated).toBe(false);
      }),
    );

    it.effect("rejects writes outside the workspace root", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const cwd = yield* makeTempDir;
        const path = yield* Path.Path;
        const fileSystem = yield* FileSystem.FileSystem;

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "../escape.md",
            contents: "# nope\n",
          })
          .pipe(Effect.flip);

        expect(error.message).toContain(
          "Workspace file path must be relative to the project root: ../escape.md",
        );

        const escapedPath = path.resolve(cwd, "..", "escape.md");
        const escapedStat = yield* fileSystem
          .stat(escapedPath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        expect(escapedStat).toBeNull();
      }),
    );

    it.effect("rejects stale writes when the on-disk mtime changes", () =>
      Effect.gen(function* () {
        const workspaceFileSystem = yield* WorkspaceFileSystem;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        const absolutePath = path.join(cwd, "notes.md");
        yield* fileSystem.writeFileString(absolutePath, "first\n");
        const originalStats = yield* fileSystem.stat(absolutePath);
        const originalMtimeMs = Option.getOrElse(originalStats.mtime, () => new Date(0)).getTime();

        yield* fileSystem.writeFileString(absolutePath, "second\n");
        const updatedTime = new Date(originalMtimeMs + 5_000);
        yield* Effect.promise(() => fsPromises.utimes(absolutePath, updatedTime, updatedTime));

        const error = yield* workspaceFileSystem
          .writeFile({
            cwd,
            relativePath: "notes.md",
            contents: "third\n",
            expectedMtimeMs: originalMtimeMs,
          })
          .pipe(Effect.flip);

        expect(Schema.is(WorkspaceFileSystemError)(error)).toBe(true);
        if (Schema.is(WorkspaceFileSystemError)(error)) {
          expect(error.detail).toContain("Workspace file changed on disk since it was opened");
        }
        const saved = yield* fileSystem.readFileString(absolutePath).pipe(Effect.orDie);
        expect(saved).toBe("second\n");
      }),
    );
  });
});
