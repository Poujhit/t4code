import type { ThreadId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

interface WorkspaceThreadState {
  rootPath: string | null;
  selectedPath: string | null;
  expandedDirectoryPaths: string[];
}

export interface WorkspaceFileErrorState {
  kind: "missing" | "unreadable" | "conflict";
  message: string;
}

interface WorkspaceWorkbenchStoreState {
  isWorkspaceOpen: boolean;
  workspacePaneWidth: number;
  threadStateByThreadId: Record<ThreadId, WorkspaceThreadState>;
  openFilePathsByThreadId: Record<ThreadId, string[]>;
  activeFilePathByThreadId: Record<ThreadId, string | null>;
  draftContentByThreadIdAndPath: Record<string, string>;
  baseMtimeMsByThreadIdAndPath: Record<string, number>;
  isDirtyByThreadIdAndPath: Record<string, boolean>;
  lastLoadErrorByThreadIdAndPath: Record<string, WorkspaceFileErrorState>;
  setWorkspaceOpen: (open: boolean) => void;
  toggleWorkspaceOpen: () => void;
  setWorkspacePaneWidth: (width: number) => void;
  clampWorkspacePaneWidthToViewport: () => void;
  syncThreadRoot: (threadId: ThreadId, rootPath: string | null) => void;
  setSelectedPath: (threadId: ThreadId, path: string | null) => void;
  setActiveFilePath: (threadId: ThreadId, path: string | null) => void;
  openFile: (threadId: ThreadId, path: string) => void;
  revealFile: (threadId: ThreadId, path: string) => void;
  closeFile: (threadId: ThreadId, path: string) => void;
  setDirectoryExpanded: (threadId: ThreadId, path: string, expanded: boolean) => void;
  hydrateFileDraft: (
    threadId: ThreadId,
    path: string,
    input: { contents: string; mtimeMs: number },
  ) => void;
  setDraftContent: (
    threadId: ThreadId,
    path: string,
    input: { contents: string; baseContents: string },
  ) => void;
  markFileSaved: (
    threadId: ThreadId,
    path: string,
    input: { contents: string; mtimeMs: number },
  ) => void;
  setFileError: (threadId: ThreadId, path: string, error: WorkspaceFileErrorState | null) => void;
  clearThreadState: (threadId: ThreadId) => void;
}

const WORKSPACE_WORKBENCH_STORAGE_KEY = "t3code:workspace-workbench:v1";
export const WORKSPACE_INLINE_DEFAULT_WIDTH = 30 * 16;
export const WORKSPACE_INLINE_MAX_WIDTH = 100 * 16;
export const WORKSPACE_INLINE_MIN_WIDTH = 30 * 16;
export const WORKSPACE_INLINE_MIN_MAIN_CONTENT_WIDTH = 40 * 16;

const DEFAULT_THREAD_STATE: WorkspaceThreadState = Object.freeze({
  rootPath: null,
  selectedPath: null,
  expandedDirectoryPaths: [],
});

function copyThreadState(state: WorkspaceThreadState): WorkspaceThreadState {
  return {
    rootPath: state.rootPath,
    selectedPath: state.selectedPath,
    expandedDirectoryPaths: [...state.expandedDirectoryPaths],
  };
}

export function workspaceFileStateKey(threadId: ThreadId, path: string): string {
  return `${threadId}\u0000${path}`;
}

function clearThreadScopedRecord<T>(
  record: Record<string, T>,
  threadId: ThreadId,
): Record<string, T> {
  const prefix = `${threadId}\u0000`;
  let changed = false;
  const nextEntries = Object.entries(record).filter(([key]) => {
    if (!key.startsWith(prefix)) {
      return true;
    }
    changed = true;
    return false;
  });
  return changed ? Object.fromEntries(nextEntries) : record;
}

function setThreadScopedValue<T>(
  record: Record<string, T>,
  threadId: ThreadId,
  path: string,
  value: T,
): Record<string, T> {
  const key = workspaceFileStateKey(threadId, path);
  return record[key] === value ? record : { ...record, [key]: value };
}

function deleteThreadScopedValue<T>(
  record: Record<string, T>,
  threadId: ThreadId,
  path: string,
): Record<string, T> {
  const key = workspaceFileStateKey(threadId, path);
  if (!Object.hasOwn(record, key)) {
    return record;
  }
  const { [key]: _removed, ...rest } = record;
  return rest;
}

function deleteThreadValue<T>(record: Record<string, T>, threadId: ThreadId): Record<string, T> {
  if (!Object.hasOwn(record, threadId)) {
    return record;
  }
  const { [threadId]: _removed, ...rest } = record;
  return rest as Record<string, T>;
}

export function selectWorkspaceThreadState(
  threadStateByThreadId: Record<ThreadId, WorkspaceThreadState>,
  threadId: ThreadId,
): WorkspaceThreadState {
  return threadStateByThreadId[threadId] ?? DEFAULT_THREAD_STATE;
}

function uniqueSortedPaths(paths: readonly string[]): string[] {
  return [...new Set(paths.filter((path) => path.trim().length > 0))].toSorted((a, b) =>
    a.localeCompare(b),
  );
}

function appendUniquePath(paths: string[], path: string): string[] {
  if (path.trim().length === 0 || paths.includes(path)) {
    return paths;
  }
  return [...paths, path];
}

function ancestorDirectoryPaths(path: string): string[] {
  const normalized = path.trim().replace(/^\/+|\/+$/g, "");
  if (normalized.length === 0) {
    return [];
  }

  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  if (segments.length <= 1) {
    return [];
  }

  const ancestors: string[] = [];
  for (let index = 0; index < segments.length - 1; index += 1) {
    ancestors.push(segments.slice(0, index + 1).join("/"));
  }
  return ancestors;
}

function normalizeThreadState(state: WorkspaceThreadState): WorkspaceThreadState {
  const normalizedExpanded = uniqueSortedPaths(state.expandedDirectoryPaths);
  const normalizedSelectedPath =
    typeof state.selectedPath === "string" && state.selectedPath.trim().length > 0
      ? state.selectedPath
      : null;
  const normalizedRootPath =
    typeof state.rootPath === "string" && state.rootPath.trim().length > 0 ? state.rootPath : null;

  const nextSelectedPath = normalizedRootPath === null ? null : normalizedSelectedPath;
  const nextExpandedPaths = normalizedRootPath === null ? [] : normalizedExpanded;

  if (
    normalizedRootPath === state.rootPath &&
    nextSelectedPath === state.selectedPath &&
    nextExpandedPaths.length === state.expandedDirectoryPaths.length &&
    nextExpandedPaths.every((path, index) => path === state.expandedDirectoryPaths[index])
  ) {
    return state;
  }

  return {
    rootPath: normalizedRootPath,
    selectedPath: nextSelectedPath,
    expandedDirectoryPaths: nextExpandedPaths,
  };
}

function updateThreadStateByThreadId(
  threadStateByThreadId: Record<ThreadId, WorkspaceThreadState>,
  threadId: ThreadId,
  updater: (state: WorkspaceThreadState) => WorkspaceThreadState,
): Record<ThreadId, WorkspaceThreadState> {
  const current = selectWorkspaceThreadState(threadStateByThreadId, threadId);
  const next = normalizeThreadState(updater(current));

  const isDefault =
    next.rootPath === DEFAULT_THREAD_STATE.rootPath &&
    next.selectedPath === DEFAULT_THREAD_STATE.selectedPath &&
    next.expandedDirectoryPaths.length === DEFAULT_THREAD_STATE.expandedDirectoryPaths.length;

  if (isDefault) {
    if (!Object.hasOwn(threadStateByThreadId, threadId)) {
      return threadStateByThreadId;
    }
    const { [threadId]: _removed, ...rest } = threadStateByThreadId;
    return rest as Record<ThreadId, WorkspaceThreadState>;
  }

  const existing = threadStateByThreadId[threadId];
  if (
    existing &&
    existing.rootPath === next.rootPath &&
    existing.selectedPath === next.selectedPath &&
    existing.expandedDirectoryPaths.length === next.expandedDirectoryPaths.length &&
    existing.expandedDirectoryPaths.every(
      (path, index) => path === next.expandedDirectoryPaths[index],
    )
  ) {
    return threadStateByThreadId;
  }

  return {
    ...threadStateByThreadId,
    [threadId]: next,
  };
}

export function clampWorkspacePaneWidth(width: number): number {
  if (typeof window === "undefined") {
    return Math.max(WORKSPACE_INLINE_MIN_WIDTH, Math.min(width, WORKSPACE_INLINE_MAX_WIDTH));
  }

  const viewportMaxWidth = window.innerWidth - WORKSPACE_INLINE_MIN_MAIN_CONTENT_WIDTH;
  return Math.max(
    WORKSPACE_INLINE_MIN_WIDTH,
    Math.min(width, WORKSPACE_INLINE_MAX_WIDTH, viewportMaxWidth),
  );
}

export function partializeWorkspaceWorkbenchState(state: WorkspaceWorkbenchStoreState) {
  return {
    isWorkspaceOpen: state.isWorkspaceOpen,
    workspacePaneWidth: state.workspacePaneWidth,
    threadStateByThreadId: state.threadStateByThreadId,
    openFilePathsByThreadId: state.openFilePathsByThreadId,
    activeFilePathByThreadId: state.activeFilePathByThreadId,
    draftContentByThreadIdAndPath: state.draftContentByThreadIdAndPath,
    baseMtimeMsByThreadIdAndPath: state.baseMtimeMsByThreadIdAndPath,
    isDirtyByThreadIdAndPath: state.isDirtyByThreadIdAndPath,
    lastLoadErrorByThreadIdAndPath: state.lastLoadErrorByThreadIdAndPath,
  };
}

export const useWorkspaceWorkbenchStore = create<WorkspaceWorkbenchStoreState>()(
  persist(
    (set) => ({
      isWorkspaceOpen: false,
      workspacePaneWidth: WORKSPACE_INLINE_DEFAULT_WIDTH,
      threadStateByThreadId: {},
      openFilePathsByThreadId: {},
      activeFilePathByThreadId: {},
      draftContentByThreadIdAndPath: {},
      baseMtimeMsByThreadIdAndPath: {},
      isDirtyByThreadIdAndPath: {},
      lastLoadErrorByThreadIdAndPath: {},
      setWorkspaceOpen: (open) =>
        set((state) => (state.isWorkspaceOpen === open ? state : { isWorkspaceOpen: open })),
      toggleWorkspaceOpen: () => set((state) => ({ isWorkspaceOpen: !state.isWorkspaceOpen })),
      setWorkspacePaneWidth: (width) =>
        set((state) => {
          const nextWidth = clampWorkspacePaneWidth(width);
          return state.workspacePaneWidth === nextWidth ? state : { workspacePaneWidth: nextWidth };
        }),
      clampWorkspacePaneWidthToViewport: () =>
        set((state) => {
          const nextWidth = clampWorkspacePaneWidth(state.workspacePaneWidth);
          return state.workspacePaneWidth === nextWidth ? state : { workspacePaneWidth: nextWidth };
        }),
      syncThreadRoot: (threadId, rootPath) =>
        set((state) => {
          const currentThreadState = selectWorkspaceThreadState(
            state.threadStateByThreadId,
            threadId,
          );
          if (currentThreadState.rootPath === rootPath) {
            return state;
          }
          return {
            threadStateByThreadId: updateThreadStateByThreadId(
              state.threadStateByThreadId,
              threadId,
              () => ({
                rootPath,
                selectedPath: null,
                expandedDirectoryPaths: [],
              }),
            ),
            openFilePathsByThreadId: deleteThreadValue(state.openFilePathsByThreadId, threadId),
            activeFilePathByThreadId: deleteThreadValue(state.activeFilePathByThreadId, threadId),
            draftContentByThreadIdAndPath: clearThreadScopedRecord(
              state.draftContentByThreadIdAndPath,
              threadId,
            ),
            baseMtimeMsByThreadIdAndPath: clearThreadScopedRecord(
              state.baseMtimeMsByThreadIdAndPath,
              threadId,
            ),
            isDirtyByThreadIdAndPath: clearThreadScopedRecord(
              state.isDirtyByThreadIdAndPath,
              threadId,
            ),
            lastLoadErrorByThreadIdAndPath: clearThreadScopedRecord(
              state.lastLoadErrorByThreadIdAndPath,
              threadId,
            ),
          };
        }),
      setSelectedPath: (threadId, path) =>
        set((state) => ({
          threadStateByThreadId: updateThreadStateByThreadId(
            state.threadStateByThreadId,
            threadId,
            (current) => ({
              ...copyThreadState(current),
              selectedPath: path,
            }),
          ),
        })),
      setActiveFilePath: (threadId, path) =>
        set((state) => ({
          activeFilePathByThreadId:
            state.activeFilePathByThreadId[threadId] === path
              ? state.activeFilePathByThreadId
              : { ...state.activeFilePathByThreadId, [threadId]: path },
        })),
      openFile: (threadId, path) =>
        set((state) => {
          const currentOpenFilePaths = state.openFilePathsByThreadId[threadId] ?? [];
          const nextOpenFilePaths = appendUniquePath(currentOpenFilePaths, path);
          return {
            threadStateByThreadId: updateThreadStateByThreadId(
              state.threadStateByThreadId,
              threadId,
              (current) => ({
                ...copyThreadState(current),
                selectedPath: path,
              }),
            ),
            openFilePathsByThreadId:
              nextOpenFilePaths === currentOpenFilePaths
                ? state.openFilePathsByThreadId
                : { ...state.openFilePathsByThreadId, [threadId]: nextOpenFilePaths },
            activeFilePathByThreadId:
              state.activeFilePathByThreadId[threadId] === path
                ? state.activeFilePathByThreadId
                : { ...state.activeFilePathByThreadId, [threadId]: path },
          };
        }),
      revealFile: (threadId, path) =>
        set((state) => {
          const openPaths = state.openFilePathsByThreadId[threadId] ?? [];
          const nextOpenPaths = appendUniquePath(openPaths, path);
          const expandedPaths = uniqueSortedPaths([
            ...selectWorkspaceThreadState(state.threadStateByThreadId, threadId)
              .expandedDirectoryPaths,
            ...ancestorDirectoryPaths(path),
          ]);

          return {
            threadStateByThreadId: updateThreadStateByThreadId(
              state.threadStateByThreadId,
              threadId,
              (current) => ({
                ...copyThreadState(current),
                selectedPath: path,
                expandedDirectoryPaths: expandedPaths,
              }),
            ),
            openFilePathsByThreadId:
              nextOpenPaths === openPaths
                ? state.openFilePathsByThreadId
                : { ...state.openFilePathsByThreadId, [threadId]: nextOpenPaths },
            activeFilePathByThreadId:
              state.activeFilePathByThreadId[threadId] === path
                ? state.activeFilePathByThreadId
                : { ...state.activeFilePathByThreadId, [threadId]: path },
          };
        }),
      closeFile: (threadId, path) =>
        set((state) => {
          const openFilePaths = state.openFilePathsByThreadId[threadId] ?? [];
          const closeIndex = openFilePaths.indexOf(path);
          if (closeIndex === -1) {
            return state;
          }

          const nextOpenFilePaths = openFilePaths.filter((entry) => entry !== path);
          const activeFilePath = state.activeFilePathByThreadId[threadId] ?? null;
          const nextActiveFilePath =
            activeFilePath !== path
              ? activeFilePath
              : (nextOpenFilePaths[closeIndex] ?? nextOpenFilePaths[closeIndex - 1] ?? null);

          return {
            threadStateByThreadId: updateThreadStateByThreadId(
              state.threadStateByThreadId,
              threadId,
              (current) => ({
                ...copyThreadState(current),
                selectedPath: activeFilePath === path ? nextActiveFilePath : current.selectedPath,
              }),
            ),
            openFilePathsByThreadId:
              nextOpenFilePaths.length === 0
                ? deleteThreadValue(state.openFilePathsByThreadId, threadId)
                : { ...state.openFilePathsByThreadId, [threadId]: nextOpenFilePaths },
            activeFilePathByThreadId:
              nextActiveFilePath === null
                ? deleteThreadValue(state.activeFilePathByThreadId, threadId)
                : { ...state.activeFilePathByThreadId, [threadId]: nextActiveFilePath },
          };
        }),
      setDirectoryExpanded: (threadId, path, expanded) =>
        set((state) => ({
          threadStateByThreadId: updateThreadStateByThreadId(
            state.threadStateByThreadId,
            threadId,
            (current) => ({
              ...copyThreadState(current),
              expandedDirectoryPaths: expanded
                ? uniqueSortedPaths([...current.expandedDirectoryPaths, path])
                : current.expandedDirectoryPaths.filter((entry) => entry !== path),
            }),
          ),
        })),
      hydrateFileDraft: (threadId, path, input) =>
        set((state) => {
          const key = workspaceFileStateKey(threadId, path);
          if (state.isDirtyByThreadIdAndPath[key]) {
            return state;
          }
          return {
            draftContentByThreadIdAndPath: setThreadScopedValue(
              state.draftContentByThreadIdAndPath,
              threadId,
              path,
              input.contents,
            ),
            baseMtimeMsByThreadIdAndPath: setThreadScopedValue(
              state.baseMtimeMsByThreadIdAndPath,
              threadId,
              path,
              input.mtimeMs,
            ),
            isDirtyByThreadIdAndPath: deleteThreadScopedValue(
              state.isDirtyByThreadIdAndPath,
              threadId,
              path,
            ),
            lastLoadErrorByThreadIdAndPath: deleteThreadScopedValue(
              state.lastLoadErrorByThreadIdAndPath,
              threadId,
              path,
            ),
          };
        }),
      setDraftContent: (threadId, path, input) =>
        set((state) => {
          const isDirty = input.contents !== input.baseContents;
          return {
            draftContentByThreadIdAndPath: setThreadScopedValue(
              state.draftContentByThreadIdAndPath,
              threadId,
              path,
              input.contents,
            ),
            isDirtyByThreadIdAndPath: isDirty
              ? setThreadScopedValue(state.isDirtyByThreadIdAndPath, threadId, path, true)
              : deleteThreadScopedValue(state.isDirtyByThreadIdAndPath, threadId, path),
          };
        }),
      markFileSaved: (threadId, path, input) =>
        set((state) => ({
          draftContentByThreadIdAndPath: setThreadScopedValue(
            state.draftContentByThreadIdAndPath,
            threadId,
            path,
            input.contents,
          ),
          baseMtimeMsByThreadIdAndPath: setThreadScopedValue(
            state.baseMtimeMsByThreadIdAndPath,
            threadId,
            path,
            input.mtimeMs,
          ),
          isDirtyByThreadIdAndPath: deleteThreadScopedValue(
            state.isDirtyByThreadIdAndPath,
            threadId,
            path,
          ),
          lastLoadErrorByThreadIdAndPath: deleteThreadScopedValue(
            state.lastLoadErrorByThreadIdAndPath,
            threadId,
            path,
          ),
        })),
      setFileError: (threadId, path, error) =>
        set((state) => ({
          lastLoadErrorByThreadIdAndPath:
            error === null
              ? deleteThreadScopedValue(state.lastLoadErrorByThreadIdAndPath, threadId, path)
              : setThreadScopedValue(state.lastLoadErrorByThreadIdAndPath, threadId, path, error),
        })),
      clearThreadState: (threadId) =>
        set((state) => ({
          threadStateByThreadId: updateThreadStateByThreadId(
            state.threadStateByThreadId,
            threadId,
            () => copyThreadState(DEFAULT_THREAD_STATE),
          ),
          openFilePathsByThreadId: deleteThreadValue(state.openFilePathsByThreadId, threadId),
          activeFilePathByThreadId: Object.fromEntries(
            Object.entries(state.activeFilePathByThreadId).filter(([key]) => key !== threadId),
          ) as Record<ThreadId, string | null>,
          draftContentByThreadIdAndPath: clearThreadScopedRecord(
            state.draftContentByThreadIdAndPath,
            threadId,
          ),
          baseMtimeMsByThreadIdAndPath: clearThreadScopedRecord(
            state.baseMtimeMsByThreadIdAndPath,
            threadId,
          ),
          isDirtyByThreadIdAndPath: clearThreadScopedRecord(
            state.isDirtyByThreadIdAndPath,
            threadId,
          ),
          lastLoadErrorByThreadIdAndPath: clearThreadScopedRecord(
            state.lastLoadErrorByThreadIdAndPath,
            threadId,
          ),
        })),
    }),
    {
      name: WORKSPACE_WORKBENCH_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: partializeWorkspaceWorkbenchState,
    },
  ),
);
