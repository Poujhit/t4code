import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, afterEach, vi } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import * as processRunner from "../../processRunner.ts";
import {
  WorkspaceContentSearch,
  WorkspaceContentSearchError,
} from "../Services/WorkspaceContentSearch.ts";
import { WorkspaceContentSearchLive } from "./WorkspaceContentSearch.ts";
import { WorkspacePathsLive } from "./WorkspacePaths.ts";

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(WorkspaceContentSearchLive.pipe(Layer.provide(WorkspacePathsLive))),
  Layer.provideMerge(WorkspacePathsLive),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-workspace-content-search-",
  });
});

const writeTextFile = Effect.fn("WorkspaceContentSearch.test.writeTextFile")(function* (
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

afterEach(() => {
  vi.restoreAllMocks();
});

it.layer(TestLayer)("WorkspaceContentSearchLive", (it) => {
  describe("search", () => {
    it.effect("returns grouped matches with line and column data", () =>
      Effect.gen(function* () {
        const workspaceContentSearch = yield* WorkspaceContentSearch;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(
          cwd,
          "src/index.ts",
          ["export const value = 1;", "export const needle = value + 1;", ""].join("\n"),
        );

        const result = yield* workspaceContentSearch.search({
          cwd,
          query: "needle",
          caseSensitive: false,
          wholeWord: false,
          regexp: false,
          includeGlobs: [],
          excludeGlobs: [],
          limit: 20,
        });

        expect(result.truncated).toBe(false);
        expect(result.files).toHaveLength(1);
        expect(result.files[0]?.relativePath).toBe("src/index.ts");
        expect(result.files[0]?.matchCount).toBe(1);
        expect(result.files[0]?.matches[0]).toMatchObject({
          relativePath: "src/index.ts",
          lineNumber: 2,
          startColumn: 14,
          endColumn: 20,
        });
      }),
    );

    it.effect("supports regex, whole-word, and include/exclude glob filters", () =>
      Effect.gen(function* () {
        const workspaceContentSearch = yield* WorkspaceContentSearch;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/one.ts", "const needle = 1;\nconst needleish = 2;\n");
        yield* writeTextFile(cwd, "tests/one.test.ts", "const needle = 3;\n");

        const result = yield* workspaceContentSearch.search({
          cwd,
          query: "needle|needleish",
          caseSensitive: true,
          wholeWord: true,
          regexp: true,
          includeGlobs: ["src/**/*.ts"],
          excludeGlobs: ["**/*.test.ts"],
          limit: 20,
        });

        expect(result.files).toHaveLength(1);
        expect(result.files[0]?.relativePath).toBe("src/one.ts");
        expect(result.files[0]?.matchCount).toBe(2);
        expect(result.files[0]?.matches.map((match) => match.lineNumber)).toEqual([1, 2]);
      }),
    );

    it.effect("respects ignore files and built-in ignored directories", () =>
      Effect.gen(function* () {
        const workspaceContentSearch = yield* WorkspaceContentSearch;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, ".gitignore", "ignored.txt\n");
        yield* writeTextFile(cwd, "src/keep.ts", "const needle = true;\n");
        yield* writeTextFile(cwd, "ignored.txt", "needle\n");
        yield* writeTextFile(cwd, "node_modules/pkg/index.js", "needle\n");

        const result = yield* workspaceContentSearch.search({
          cwd,
          query: "needle",
          caseSensitive: false,
          wholeWord: false,
          regexp: false,
          includeGlobs: [],
          excludeGlobs: [],
          limit: 20,
        });

        expect(result.files.map((file) => file.relativePath)).toEqual(["src/keep.ts"]);
      }),
    );

    it.effect("marks results truncated when the match limit is reached", () =>
      Effect.gen(function* () {
        const workspaceContentSearch = yield* WorkspaceContentSearch;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/one.ts", "needle\nneedle\nneedle\n");

        const result = yield* workspaceContentSearch.search({
          cwd,
          query: "needle",
          caseSensitive: false,
          wholeWord: false,
          regexp: false,
          includeGlobs: [],
          excludeGlobs: [],
          limit: 1,
        });

        expect(result.truncated).toBe(true);
        expect(result.files[0]?.matchCount).toBe(1);
      }),
    );

    it.effect("returns a typed error when ripgrep is unavailable", () =>
      Effect.gen(function* () {
        const workspaceContentSearch = yield* WorkspaceContentSearch;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "src/one.ts", "needle\n");
        vi.spyOn(processRunner, "runProcess").mockRejectedValue(new Error("Command not found: rg"));

        const error = yield* Effect.flip(
          workspaceContentSearch.search({
            cwd,
            query: "needle",
            caseSensitive: false,
            wholeWord: false,
            regexp: false,
            includeGlobs: [],
            excludeGlobs: [],
            limit: 20,
          }),
        );

        expect(error).toBeInstanceOf(WorkspaceContentSearchError);
        expect(error.detail).toContain("ripgrep (rg) is required");
      }),
    );
  });
});
