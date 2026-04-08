import type { NativeApi } from "@t3tools/contracts";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as nativeApi from "../nativeApi";
import {
  projectListDirectoryQueryOptions,
  projectMutationKeys,
  projectQueryKeys,
  projectReadFileQueryOptions,
  projectSearchFileContentsQueryOptions,
  projectSearchEntriesQueryOptions,
  projectWriteFileMutationOptions,
} from "./projectReactQuery";

function mockNativeApi(input: {
  listDirectory?: ReturnType<typeof vi.fn>;
  readFile?: ReturnType<typeof vi.fn>;
  searchFileContents?: ReturnType<typeof vi.fn>;
  searchEntries?: ReturnType<typeof vi.fn>;
  writeFile?: ReturnType<typeof vi.fn>;
}) {
  vi.spyOn(nativeApi, "ensureNativeApi").mockReturnValue({
    projects: {
      listDirectory: input.listDirectory ?? vi.fn(),
      readFile: input.readFile ?? vi.fn(),
      searchFileContents: input.searchFileContents ?? vi.fn(),
      searchEntries: input.searchEntries ?? vi.fn(),
      writeFile: input.writeFile ?? vi.fn(),
    },
    git: {
      status: vi.fn(),
      listBranches: vi.fn(),
    },
  } as unknown as NativeApi);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("projectQueryKeys.listDirectory", () => {
  it("keys root and nested listings separately", () => {
    expect(projectQueryKeys.listDirectory("/repo", null)).not.toEqual(
      projectQueryKeys.listDirectory("/repo", "src"),
    );
  });
});

describe("projectListDirectoryQueryOptions", () => {
  it("forwards directory listing input to the native API", async () => {
    const listDirectory = vi.fn().mockResolvedValue({ entries: [], truncated: false });
    mockNativeApi({ listDirectory });

    const queryClient = new QueryClient();
    await queryClient.fetchQuery(
      projectListDirectoryQueryOptions({
        cwd: "/repo",
        relativePath: "src",
      }),
    );

    expect(listDirectory).toHaveBeenCalledWith({
      cwd: "/repo",
      relativePath: "src",
    });
  });

  it("fails fast when the workspace root is unavailable", async () => {
    mockNativeApi({});
    const queryClient = new QueryClient();

    await expect(
      queryClient.fetchQuery(
        projectListDirectoryQueryOptions({
          cwd: null,
          relativePath: null,
        }),
      ),
    ).rejects.toThrow("Workspace directory listing is unavailable.");
  });
});

describe("projectSearchEntriesQueryOptions", () => {
  it("forwards search input to the native API", async () => {
    const searchEntries = vi.fn().mockResolvedValue({ entries: [], truncated: false });
    mockNativeApi({ searchEntries });

    const queryClient = new QueryClient();
    await queryClient.fetchQuery(
      projectSearchEntriesQueryOptions({
        cwd: "/repo",
        query: "comp",
      }),
    );

    expect(searchEntries).toHaveBeenCalledWith({
      cwd: "/repo",
      query: "comp",
      limit: 80,
    });
  });
});

describe("projectSearchFileContentsQueryOptions", () => {
  it("forwards content search input to the native API", async () => {
    const searchFileContents = vi.fn().mockResolvedValue({ files: [], truncated: false });
    mockNativeApi({ searchFileContents });

    const queryClient = new QueryClient();
    await queryClient.fetchQuery(
      projectSearchFileContentsQueryOptions({
        cwd: "/repo",
        query: "needle",
        caseSensitive: false,
        wholeWord: true,
        regexp: false,
        includeGlobs: ["src/**/*.ts"],
        excludeGlobs: ["dist/**"],
      }),
    );

    expect(searchFileContents).toHaveBeenCalledWith({
      cwd: "/repo",
      query: "needle",
      caseSensitive: false,
      wholeWord: true,
      regexp: false,
      includeGlobs: ["src/**/*.ts"],
      excludeGlobs: ["dist/**"],
      limit: 200,
    });
  });
});

describe("projectReadFileQueryOptions", () => {
  it("forwards file reads to the native API", async () => {
    const readFile = vi.fn().mockResolvedValue({
      relativePath: "src/index.ts",
      contents: "export {};",
      mtimeMs: 123,
      sizeBytes: 10,
      isBinary: false,
      isTooLarge: false,
    });
    mockNativeApi({ readFile });

    const queryClient = new QueryClient();
    await queryClient.fetchQuery(
      projectReadFileQueryOptions({
        cwd: "/repo",
        relativePath: "src/index.ts",
      }),
    );

    expect(readFile).toHaveBeenCalledWith({
      cwd: "/repo",
      relativePath: "src/index.ts",
    });
  });
});

describe("projectWriteFileMutationOptions", () => {
  it("invalidates the file query, parent directory tree query, and git queries after save", async () => {
    const writeFile = vi.fn().mockResolvedValue({ relativePath: "src/index.ts" });
    mockNativeApi({ writeFile });

    const queryClient = new QueryClient();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const options = projectWriteFileMutationOptions({ queryClient });
    const variables = {
      cwd: "/repo",
      relativePath: "src/index.ts",
      contents: "export const value = 1;\n",
      expectedMtimeMs: 10,
    };

    expect(options.mutationKey).toEqual(projectMutationKeys.writeFile(null, null));

    await options.mutationFn!(variables, {} as never);
    await options.onSuccess?.({ relativePath: "src/index.ts" }, variables, undefined, {} as never);

    expect(writeFile).toHaveBeenCalledWith(variables);
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: projectQueryKeys.readFile("/repo", "src/index.ts"),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: projectQueryKeys.listDirectory("/repo", "src"),
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["git"],
    });
  });
});
