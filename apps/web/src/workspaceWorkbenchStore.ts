import type { ThreadId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

interface WorkspaceThreadState {
  rootPath: string | null;
  selectedPath: string | null;
  expandedDirectoryPaths: string[];
}

interface WorkspaceWorkbenchStoreState {
  isWorkspaceOpen: boolean;
  workspacePaneWidth: number;
  threadStateByThreadId: Record<ThreadId, WorkspaceThreadState>;
  setWorkspaceOpen: (open: boolean) => void;
  toggleWorkspaceOpen: () => void;
  setWorkspacePaneWidth: (width: number) => void;
  clampWorkspacePaneWidthToViewport: () => void;
  syncThreadRoot: (threadId: ThreadId, rootPath: string | null) => void;
  setSelectedPath: (threadId: ThreadId, path: string | null) => void;
  setDirectoryExpanded: (threadId: ThreadId, path: string, expanded: boolean) => void;
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
  };
}

export const useWorkspaceWorkbenchStore = create<WorkspaceWorkbenchStoreState>()(
  persist(
    (set) => ({
      isWorkspaceOpen: false,
      workspacePaneWidth: WORKSPACE_INLINE_DEFAULT_WIDTH,
      threadStateByThreadId: {},
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
        set((state) => ({
          threadStateByThreadId: updateThreadStateByThreadId(
            state.threadStateByThreadId,
            threadId,
            (current) => {
              if (current.rootPath === rootPath) {
                return current;
              }
              return {
                rootPath,
                selectedPath: null,
                expandedDirectoryPaths: [],
              };
            },
          ),
        })),
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
      clearThreadState: (threadId) =>
        set((state) => ({
          threadStateByThreadId: updateThreadStateByThreadId(
            state.threadStateByThreadId,
            threadId,
            () => copyThreadState(DEFAULT_THREAD_STATE),
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
