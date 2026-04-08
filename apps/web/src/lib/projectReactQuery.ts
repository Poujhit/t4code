import type { ProjectListDirectoryResult, ProjectSearchEntriesResult } from "@t3tools/contracts";
import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { ensureNativeApi } from "~/nativeApi";
import { invalidateGitQueries } from "./gitReactQuery";

export const projectQueryKeys = {
  all: ["projects"] as const,
  listDirectory: (cwd: string | null, relativePath: string | null) =>
    ["projects", "list-directory", cwd, relativePath] as const,
  readFile: (cwd: string | null, relativePath: string | null) =>
    ["projects", "read-file", cwd, relativePath] as const,
  searchFileContents: (
    cwd: string | null,
    query: string,
    flags: {
      caseSensitive: boolean;
      wholeWord: boolean;
      regexp: boolean;
      includeGlobs: readonly string[];
      excludeGlobs: readonly string[];
    },
    limit: number,
  ) =>
    [
      "projects",
      "search-file-contents",
      cwd,
      query,
      flags.caseSensitive,
      flags.wholeWord,
      flags.regexp,
      [...flags.includeGlobs],
      [...flags.excludeGlobs],
      limit,
    ] as const,
  searchEntries: (cwd: string | null, query: string, limit: number) =>
    ["projects", "search-entries", cwd, query, limit] as const,
};

export const projectMutationKeys = {
  writeFile: (cwd: string | null, relativePath: string | null) =>
    ["projects", "mutation", "write-file", cwd, relativePath] as const,
};

const DEFAULT_LIST_DIRECTORY_STALE_TIME = 15_000;
const DEFAULT_READ_FILE_STALE_TIME = 15_000;
const DEFAULT_SEARCH_FILE_CONTENTS_LIMIT = 200;
const DEFAULT_SEARCH_FILE_CONTENTS_STALE_TIME = 15_000;
const DEFAULT_SEARCH_ENTRIES_LIMIT = 80;
const DEFAULT_SEARCH_ENTRIES_STALE_TIME = 15_000;
const EMPTY_LIST_DIRECTORY_RESULT: ProjectListDirectoryResult = {
  entries: [],
  truncated: false,
};
const EMPTY_SEARCH_ENTRIES_RESULT: ProjectSearchEntriesResult = {
  entries: [],
  truncated: false,
};

function parentPathOf(relativePath: string): string | null {
  const separatorIndex = relativePath.lastIndexOf("/");
  return separatorIndex === -1 ? null : relativePath.slice(0, separatorIndex);
}

export function projectListDirectoryQueryOptions(input: {
  cwd: string | null;
  relativePath: string | null;
  enabled?: boolean;
  staleTime?: number;
}) {
  return queryOptions({
    queryKey: projectQueryKeys.listDirectory(input.cwd, input.relativePath),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) {
        throw new Error("Workspace directory listing is unavailable.");
      }
      return api.projects.listDirectory({
        cwd: input.cwd,
        relativePath: input.relativePath,
      });
    },
    enabled: (input.enabled ?? true) && input.cwd !== null,
    staleTime: input.staleTime ?? DEFAULT_LIST_DIRECTORY_STALE_TIME,
    placeholderData: (previous) => previous ?? EMPTY_LIST_DIRECTORY_RESULT,
  });
}

export function projectSearchEntriesQueryOptions(input: {
  cwd: string | null;
  query: string;
  enabled?: boolean;
  limit?: number;
  staleTime?: number;
}) {
  const limit = input.limit ?? DEFAULT_SEARCH_ENTRIES_LIMIT;
  return queryOptions({
    queryKey: projectQueryKeys.searchEntries(input.cwd, input.query, limit),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) {
        throw new Error("Workspace entry search is unavailable.");
      }
      return api.projects.searchEntries({
        cwd: input.cwd,
        query: input.query,
        limit,
      });
    },
    enabled: (input.enabled ?? true) && input.cwd !== null && input.query.length > 0,
    staleTime: input.staleTime ?? DEFAULT_SEARCH_ENTRIES_STALE_TIME,
    placeholderData: (previous) => previous ?? EMPTY_SEARCH_ENTRIES_RESULT,
  });
}

export function projectSearchFileContentsQueryOptions(input: {
  cwd: string | null;
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regexp: boolean;
  includeGlobs: readonly string[];
  excludeGlobs: readonly string[];
  enabled?: boolean;
  limit?: number;
  staleTime?: number;
}) {
  const limit = input.limit ?? DEFAULT_SEARCH_FILE_CONTENTS_LIMIT;
  const flags = {
    caseSensitive: input.caseSensitive,
    wholeWord: input.wholeWord,
    regexp: input.regexp,
    includeGlobs: [...input.includeGlobs],
    excludeGlobs: [...input.excludeGlobs],
  };
  return queryOptions({
    queryKey: projectQueryKeys.searchFileContents(input.cwd, input.query, flags, limit),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd) {
        throw new Error("Workspace content search is unavailable.");
      }
      return api.projects.searchFileContents({
        cwd: input.cwd,
        query: input.query,
        caseSensitive: input.caseSensitive,
        wholeWord: input.wholeWord,
        regexp: input.regexp,
        includeGlobs: [...input.includeGlobs],
        excludeGlobs: [...input.excludeGlobs],
        limit,
      });
    },
    enabled: (input.enabled ?? true) && input.cwd !== null && input.query.length > 0,
    staleTime: input.staleTime ?? DEFAULT_SEARCH_FILE_CONTENTS_STALE_TIME,
  });
}

export function projectReadFileQueryOptions(input: {
  cwd: string | null;
  relativePath: string | null;
  enabled?: boolean;
  staleTime?: number;
}) {
  return queryOptions({
    queryKey: projectQueryKeys.readFile(input.cwd, input.relativePath),
    queryFn: async () => {
      const api = ensureNativeApi();
      if (!input.cwd || !input.relativePath) {
        throw new Error("Workspace file contents are unavailable.");
      }
      return api.projects.readFile({
        cwd: input.cwd,
        relativePath: input.relativePath,
      });
    },
    enabled: (input.enabled ?? true) && input.cwd !== null && input.relativePath !== null,
    staleTime: input.staleTime ?? DEFAULT_READ_FILE_STALE_TIME,
  });
}

export function projectWriteFileMutationOptions(input: { queryClient: QueryClient }) {
  return mutationOptions({
    mutationKey: projectMutationKeys.writeFile(null, null),
    mutationFn: async (payload: {
      cwd: string;
      relativePath: string;
      contents: string;
      expectedMtimeMs?: number | null;
    }) => {
      const api = ensureNativeApi();
      return api.projects.writeFile(payload);
    },
    onSuccess: async (_result, variables) => {
      await Promise.all([
        input.queryClient.invalidateQueries({
          queryKey: projectQueryKeys.readFile(variables.cwd, variables.relativePath),
        }),
        input.queryClient.invalidateQueries({
          queryKey: projectQueryKeys.listDirectory(
            variables.cwd,
            parentPathOf(variables.relativePath),
          ),
        }),
        invalidateGitQueries(input.queryClient),
      ]);
    },
  });
}
