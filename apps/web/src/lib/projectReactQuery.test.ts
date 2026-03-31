import type { NativeApi } from "@t3tools/contracts";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as nativeApi from "../nativeApi";
import {
  projectListDirectoryQueryOptions,
  projectQueryKeys,
  projectSearchEntriesQueryOptions,
} from "./projectReactQuery";

function mockNativeApi(input: {
  listDirectory?: ReturnType<typeof vi.fn>;
  searchEntries?: ReturnType<typeof vi.fn>;
}) {
  vi.spyOn(nativeApi, "ensureNativeApi").mockReturnValue({
    projects: {
      listDirectory: input.listDirectory ?? vi.fn(),
      searchEntries: input.searchEntries ?? vi.fn(),
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
