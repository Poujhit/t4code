import type { ThreadId, TurnId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { AiReviewHunk } from "~/lib/aiReviewDiff";

interface WorkspaceThreadState {
  rootPath: string | null;
  selectedPath: string | null;
  expandedDirectoryPaths: string[];
}

export type WorkspacePaneMode = "files" | "search" | "ai-changed-files";

export interface WorkspaceSearchState {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regexp: boolean;
  includeGlobInput: string;
  excludeGlobInput: string;
  collapsedFilePaths: string[];
  activeMatchKey: string | null;
  focusRequestKey: number;
}

export interface WorkspaceMatchRevealTarget {
  path: string;
  lineNumber: number;
  startColumn: number;
  endColumn: number;
  requestKey: number;
}

export interface WorkspaceFileErrorState {
  kind: "missing" | "unreadable" | "conflict";
  message: string;
}

export interface WorkspaceAiReviewState {
  turnId: TurnId;
  snapshotContents: string;
  hunks: AiReviewHunk[];
  acceptedHunkIds: string[];
  status: "active" | "completed" | "invalidated";
}

interface WorkspaceWorkbenchStoreState {
  hasHydrated: boolean;
  isWorkspaceOpen: boolean;
  workspacePaneWidth: number;
  threadStateByThreadId: Record<ThreadId, WorkspaceThreadState>;
  paneModeByThreadId: Record<ThreadId, WorkspacePaneMode>;
  searchStateByThreadId: Record<ThreadId, WorkspaceSearchState>;
  openFilePathsByThreadId: Record<ThreadId, string[]>;
  activeFilePathByThreadId: Record<ThreadId, string | null>;
  draftContentByThreadIdAndPath: Record<string, string>;
  baseMtimeMsByThreadIdAndPath: Record<string, number>;
  isDirtyByThreadIdAndPath: Record<string, boolean>;
  lastLoadErrorByThreadIdAndPath: Record<string, WorkspaceFileErrorState>;
  aiReviewStateByThreadIdAndPath: Record<string, WorkspaceAiReviewState>;
  acceptedAiReviewHunksByKey: Record<string, string[]>;
  editorFindRequestKeyByThreadId: Record<ThreadId, number>;
  pendingRevealTargetByThreadId: Record<ThreadId, WorkspaceMatchRevealTarget | null>;
  setHasHydrated: (hydrated: boolean) => void;
  setWorkspaceOpen: (open: boolean) => void;
  toggleWorkspaceOpen: () => void;
  setWorkspacePaneWidth: (width: number, reservedWidth?: number) => void;
  clampWorkspacePaneWidthToViewport: (reservedWidth?: number) => void;
  syncThreadRoot: (threadId: ThreadId, rootPath: string | null) => void;
  setPaneMode: (threadId: ThreadId, mode: WorkspacePaneMode) => void;
  focusSearchPane: (threadId: ThreadId) => void;
  updateSearchState: (threadId: ThreadId, patch: Partial<WorkspaceSearchState>) => void;
  toggleSearchResultCollapsed: (threadId: ThreadId, path: string) => void;
  requestEditorFind: (threadId: ThreadId) => void;
  setPendingRevealTarget: (
    threadId: ThreadId,
    target: Omit<WorkspaceMatchRevealTarget, "requestKey"> | null,
  ) => void;
  clearPendingRevealTarget: (threadId: ThreadId) => void;
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
  setAiReviewState: (threadId: ThreadId, path: string, input: WorkspaceAiReviewState) => void;
  acceptAiReviewHunk: (threadId: ThreadId, path: string, hunkId: string) => void;
  acceptAllAiReviewHunks: (threadId: ThreadId, path: string) => void;
  invalidateAiReviewState: (threadId: ThreadId, path: string) => void;
  clearAiReviewState: (threadId: ThreadId, path: string) => void;
  clearThreadState: (threadId: ThreadId) => void;
}

export const WORKSPACE_WORKBENCH_STORAGE_KEY = "t3code:workspace-workbench:v1";
export const WORKSPACE_INLINE_DEFAULT_WIDTH = 40 * 16;
export const WORKSPACE_INLINE_MAX_WIDTH = 100 * 16;
export const WORKSPACE_INLINE_MIN_WIDTH = 40 * 16;
export const WORKSPACE_INLINE_MIN_MAIN_CONTENT_WIDTH = 40 * 16;

const DEFAULT_THREAD_STATE: WorkspaceThreadState = Object.freeze({
  rootPath: null,
  selectedPath: null,
  expandedDirectoryPaths: [],
});

const DEFAULT_SEARCH_STATE: WorkspaceSearchState = Object.freeze({
  query: "",
  caseSensitive: false,
  wholeWord: false,
  regexp: false,
  includeGlobInput: "",
  excludeGlobInput: "",
  collapsedFilePaths: [],
  activeMatchKey: null,
  focusRequestKey: 0,
});

export function selectWorkspaceSearchState(
  searchStateByThreadId: Record<ThreadId, WorkspaceSearchState>,
  threadId: ThreadId,
): WorkspaceSearchState {
  return searchStateByThreadId[threadId] ?? DEFAULT_SEARCH_STATE;
}

export function selectWorkspacePaneMode(
  paneModeByThreadId: Record<ThreadId, WorkspacePaneMode>,
  threadId: ThreadId,
): WorkspacePaneMode {
  return paneModeByThreadId[threadId] ?? "files";
}

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

export function workspaceAiReviewKey(threadId: ThreadId, path: string, turnId: TurnId): string {
  return `${threadId}\u0000${path}\u0000${turnId}`;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function areStringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function areAiReviewStatesEqual(
  left: WorkspaceAiReviewState | undefined,
  right: WorkspaceAiReviewState,
): boolean {
  return (
    left !== undefined &&
    left.turnId === right.turnId &&
    left.snapshotContents === right.snapshotContents &&
    left.status === right.status &&
    areStringArraysEqual(left.acceptedHunkIds, right.acceptedHunkIds) &&
    left.hunks === right.hunks
  );
}

function applyAcceptedAiReviewHunkIds(
  current: WorkspaceAiReviewState,
  acceptedHunkIds: string[],
): WorkspaceAiReviewState {
  const allAccepted =
    current.hunks.length > 0 && current.hunks.every((hunk) => acceptedHunkIds.includes(hunk.id));
  return {
    ...current,
    acceptedHunkIds,
    status: allAccepted ? "completed" : "active",
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

export function clampWorkspacePaneWidth(width: number, reservedWidth = 0): number {
  if (typeof window === "undefined") {
    return Math.max(WORKSPACE_INLINE_MIN_WIDTH, Math.min(width, WORKSPACE_INLINE_MAX_WIDTH));
  }

  const viewportMaxWidth =
    window.innerWidth - reservedWidth - WORKSPACE_INLINE_MIN_MAIN_CONTENT_WIDTH;
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
    aiReviewStateByThreadIdAndPath: state.aiReviewStateByThreadIdAndPath,
    acceptedAiReviewHunksByKey: state.acceptedAiReviewHunksByKey,
  };
}

export function mergeWorkspaceWorkbenchPersistedState(
  persistedState: unknown,
  currentState: WorkspaceWorkbenchStoreState,
): WorkspaceWorkbenchStoreState {
  if (!isRecord(persistedState)) {
    return currentState;
  }

  return {
    ...currentState,
    isWorkspaceOpen:
      typeof persistedState.isWorkspaceOpen === "boolean"
        ? persistedState.isWorkspaceOpen
        : currentState.isWorkspaceOpen,
    workspacePaneWidth:
      typeof persistedState.workspacePaneWidth === "number"
        ? persistedState.workspacePaneWidth
        : currentState.workspacePaneWidth,
    threadStateByThreadId: isRecord(persistedState.threadStateByThreadId)
      ? (persistedState.threadStateByThreadId as Record<ThreadId, WorkspaceThreadState>)
      : currentState.threadStateByThreadId,
    openFilePathsByThreadId: isRecord(persistedState.openFilePathsByThreadId)
      ? (persistedState.openFilePathsByThreadId as Record<ThreadId, string[]>)
      : currentState.openFilePathsByThreadId,
    activeFilePathByThreadId: isRecord(persistedState.activeFilePathByThreadId)
      ? (persistedState.activeFilePathByThreadId as Record<ThreadId, string | null>)
      : currentState.activeFilePathByThreadId,
    draftContentByThreadIdAndPath: isRecord(persistedState.draftContentByThreadIdAndPath)
      ? (persistedState.draftContentByThreadIdAndPath as Record<string, string>)
      : currentState.draftContentByThreadIdAndPath,
    baseMtimeMsByThreadIdAndPath: isRecord(persistedState.baseMtimeMsByThreadIdAndPath)
      ? (persistedState.baseMtimeMsByThreadIdAndPath as Record<string, number>)
      : currentState.baseMtimeMsByThreadIdAndPath,
    isDirtyByThreadIdAndPath: isRecord(persistedState.isDirtyByThreadIdAndPath)
      ? (persistedState.isDirtyByThreadIdAndPath as Record<string, boolean>)
      : currentState.isDirtyByThreadIdAndPath,
    lastLoadErrorByThreadIdAndPath: isRecord(persistedState.lastLoadErrorByThreadIdAndPath)
      ? (persistedState.lastLoadErrorByThreadIdAndPath as Record<string, WorkspaceFileErrorState>)
      : currentState.lastLoadErrorByThreadIdAndPath,
    aiReviewStateByThreadIdAndPath: isRecord(persistedState.aiReviewStateByThreadIdAndPath)
      ? (persistedState.aiReviewStateByThreadIdAndPath as Record<string, WorkspaceAiReviewState>)
      : currentState.aiReviewStateByThreadIdAndPath,
    acceptedAiReviewHunksByKey: isRecord(persistedState.acceptedAiReviewHunksByKey)
      ? (persistedState.acceptedAiReviewHunksByKey as Record<string, string[]>)
      : currentState.acceptedAiReviewHunksByKey,
  };
}

export const useWorkspaceWorkbenchStore = create<WorkspaceWorkbenchStoreState>()(
  persist(
    (set) => ({
      hasHydrated: false,
      isWorkspaceOpen: false,
      workspacePaneWidth: WORKSPACE_INLINE_DEFAULT_WIDTH,
      threadStateByThreadId: {},
      paneModeByThreadId: {},
      searchStateByThreadId: {},
      openFilePathsByThreadId: {},
      activeFilePathByThreadId: {},
      draftContentByThreadIdAndPath: {},
      baseMtimeMsByThreadIdAndPath: {},
      isDirtyByThreadIdAndPath: {},
      lastLoadErrorByThreadIdAndPath: {},
      aiReviewStateByThreadIdAndPath: {},
      acceptedAiReviewHunksByKey: {},
      editorFindRequestKeyByThreadId: {},
      pendingRevealTargetByThreadId: {},
      setHasHydrated: (hydrated) =>
        set((state) => (state.hasHydrated === hydrated ? state : { hasHydrated: hydrated })),
      setWorkspaceOpen: (open) =>
        set((state) => (state.isWorkspaceOpen === open ? state : { isWorkspaceOpen: open })),
      toggleWorkspaceOpen: () => set((state) => ({ isWorkspaceOpen: !state.isWorkspaceOpen })),
      setWorkspacePaneWidth: (width, reservedWidth = 0) =>
        set((state) => {
          const nextWidth = clampWorkspacePaneWidth(width, reservedWidth);
          return state.workspacePaneWidth === nextWidth ? state : { workspacePaneWidth: nextWidth };
        }),
      clampWorkspacePaneWidthToViewport: (reservedWidth = 0) =>
        set((state) => {
          const nextWidth = clampWorkspacePaneWidth(state.workspacePaneWidth, reservedWidth);
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
            paneModeByThreadId: deleteThreadValue(state.paneModeByThreadId, threadId),
            searchStateByThreadId: deleteThreadValue(state.searchStateByThreadId, threadId),
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
            aiReviewStateByThreadIdAndPath: clearThreadScopedRecord(
              state.aiReviewStateByThreadIdAndPath,
              threadId,
            ),
            acceptedAiReviewHunksByKey: clearThreadScopedRecord(
              state.acceptedAiReviewHunksByKey,
              threadId,
            ),
            editorFindRequestKeyByThreadId: deleteThreadValue(
              state.editorFindRequestKeyByThreadId,
              threadId,
            ),
            pendingRevealTargetByThreadId: deleteThreadValue(
              state.pendingRevealTargetByThreadId,
              threadId,
            ),
          };
        }),
      setPaneMode: (threadId, mode) =>
        set((state) => ({
          paneModeByThreadId:
            state.paneModeByThreadId[threadId] === mode
              ? state.paneModeByThreadId
              : { ...state.paneModeByThreadId, [threadId]: mode },
        })),
      focusSearchPane: (threadId) =>
        set((state) => {
          const current = state.searchStateByThreadId[threadId] ?? DEFAULT_SEARCH_STATE;
          return {
            paneModeByThreadId:
              state.paneModeByThreadId[threadId] === "search"
                ? state.paneModeByThreadId
                : { ...state.paneModeByThreadId, [threadId]: "search" },
            searchStateByThreadId: {
              ...state.searchStateByThreadId,
              [threadId]: {
                ...current,
                focusRequestKey: current.focusRequestKey + 1,
              },
            },
          };
        }),
      updateSearchState: (threadId, patch) =>
        set((state) => {
          const current = state.searchStateByThreadId[threadId] ?? DEFAULT_SEARCH_STATE;
          const next = { ...current, ...patch };
          return {
            searchStateByThreadId: {
              ...state.searchStateByThreadId,
              [threadId]: next,
            },
          };
        }),
      toggleSearchResultCollapsed: (threadId, path) =>
        set((state) => {
          const current = state.searchStateByThreadId[threadId] ?? DEFAULT_SEARCH_STATE;
          const isCollapsed = current.collapsedFilePaths.includes(path);
          return {
            searchStateByThreadId: {
              ...state.searchStateByThreadId,
              [threadId]: {
                ...current,
                collapsedFilePaths: isCollapsed
                  ? current.collapsedFilePaths.filter((entry) => entry !== path)
                  : [...current.collapsedFilePaths, path],
              },
            },
          };
        }),
      requestEditorFind: (threadId) =>
        set((state) => ({
          editorFindRequestKeyByThreadId: {
            ...state.editorFindRequestKeyByThreadId,
            [threadId]: (state.editorFindRequestKeyByThreadId[threadId] ?? 0) + 1,
          },
        })),
      setPendingRevealTarget: (threadId, target) =>
        set((state) => ({
          pendingRevealTargetByThreadId:
            target === null
              ? deleteThreadValue(state.pendingRevealTargetByThreadId, threadId)
              : {
                  ...state.pendingRevealTargetByThreadId,
                  [threadId]: {
                    ...target,
                    requestKey:
                      (state.pendingRevealTargetByThreadId[threadId]?.requestKey ?? 0) + 1,
                  },
                },
        })),
      clearPendingRevealTarget: (threadId) =>
        set((state) => ({
          pendingRevealTargetByThreadId: deleteThreadValue(
            state.pendingRevealTargetByThreadId,
            threadId,
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
                : {
                    ...state.openFilePathsByThreadId,
                    [threadId]: nextOpenFilePaths,
                  },
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
                : {
                    ...state.openFilePathsByThreadId,
                    [threadId]: nextOpenPaths,
                  },
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
                : {
                    ...state.openFilePathsByThreadId,
                    [threadId]: nextOpenFilePaths,
                  },
            activeFilePathByThreadId:
              nextActiveFilePath === null
                ? deleteThreadValue(state.activeFilePathByThreadId, threadId)
                : {
                    ...state.activeFilePathByThreadId,
                    [threadId]: nextActiveFilePath,
                  },
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
      setAiReviewState: (threadId, path, input) =>
        set((state) => {
          const key = workspaceFileStateKey(threadId, path);
          const current = state.aiReviewStateByThreadIdAndPath[key];
          if (areAiReviewStatesEqual(current, input)) {
            return state;
          }
          return {
            aiReviewStateByThreadIdAndPath: setThreadScopedValue(
              state.aiReviewStateByThreadIdAndPath,
              threadId,
              path,
              input,
            ),
          };
        }),
      acceptAiReviewHunk: (threadId, path, hunkId) =>
        set((state) => {
          const key = workspaceFileStateKey(threadId, path);
          const current = state.aiReviewStateByThreadIdAndPath[key];
          if (!current || current.status !== "active" || current.acceptedHunkIds.includes(hunkId)) {
            return state;
          }
          const acceptedHunkIds = [...current.acceptedHunkIds, hunkId];
          const acceptanceKey = workspaceAiReviewKey(threadId, path, current.turnId);
          return {
            aiReviewStateByThreadIdAndPath: setThreadScopedValue(
              state.aiReviewStateByThreadIdAndPath,
              threadId,
              path,
              applyAcceptedAiReviewHunkIds(current, acceptedHunkIds),
            ),
            acceptedAiReviewHunksByKey: {
              ...state.acceptedAiReviewHunksByKey,
              [acceptanceKey]: acceptedHunkIds,
            },
          };
        }),
      acceptAllAiReviewHunks: (threadId, path) =>
        set((state) => {
          const key = workspaceFileStateKey(threadId, path);
          const current = state.aiReviewStateByThreadIdAndPath[key];
          if (!current || current.status !== "active" || current.hunks.length === 0) {
            return state;
          }
          const acceptedHunkIds = current.hunks.map((hunk) => hunk.id);
          const acceptanceKey = workspaceAiReviewKey(threadId, path, current.turnId);
          return {
            aiReviewStateByThreadIdAndPath: setThreadScopedValue(
              state.aiReviewStateByThreadIdAndPath,
              threadId,
              path,
              applyAcceptedAiReviewHunkIds(current, acceptedHunkIds),
            ),
            acceptedAiReviewHunksByKey: {
              ...state.acceptedAiReviewHunksByKey,
              [acceptanceKey]: acceptedHunkIds,
            },
          };
        }),
      invalidateAiReviewState: (threadId, path) =>
        set((state) => {
          const key = workspaceFileStateKey(threadId, path);
          const current = state.aiReviewStateByThreadIdAndPath[key];
          if (!current || current.status === "invalidated") {
            return state;
          }
          return {
            aiReviewStateByThreadIdAndPath: setThreadScopedValue(
              state.aiReviewStateByThreadIdAndPath,
              threadId,
              path,
              {
                ...current,
                status: "invalidated",
              },
            ),
          };
        }),
      clearAiReviewState: (threadId, path) =>
        set((state) => {
          const key = workspaceFileStateKey(threadId, path);
          if (!Object.hasOwn(state.aiReviewStateByThreadIdAndPath, key)) {
            return state;
          }
          return {
            aiReviewStateByThreadIdAndPath: deleteThreadScopedValue(
              state.aiReviewStateByThreadIdAndPath,
              threadId,
              path,
            ),
          };
        }),
      clearThreadState: (threadId) =>
        set((state) => ({
          threadStateByThreadId: updateThreadStateByThreadId(
            state.threadStateByThreadId,
            threadId,
            () => copyThreadState(DEFAULT_THREAD_STATE),
          ),
          paneModeByThreadId: deleteThreadValue(state.paneModeByThreadId, threadId),
          searchStateByThreadId: deleteThreadValue(state.searchStateByThreadId, threadId),
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
          aiReviewStateByThreadIdAndPath: clearThreadScopedRecord(
            state.aiReviewStateByThreadIdAndPath,
            threadId,
          ),
          acceptedAiReviewHunksByKey: clearThreadScopedRecord(
            state.acceptedAiReviewHunksByKey,
            threadId,
          ),
          editorFindRequestKeyByThreadId: deleteThreadValue(
            state.editorFindRequestKeyByThreadId,
            threadId,
          ),
          pendingRevealTargetByThreadId: deleteThreadValue(
            state.pendingRevealTargetByThreadId,
            threadId,
          ),
        })),
    }),
    {
      name: WORKSPACE_WORKBENCH_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: partializeWorkspaceWorkbenchState,
      merge: mergeWorkspaceWorkbenchPersistedState,
      onRehydrateStorage: () => {
        return (state) => {
          state?.setHasHydrated(true);
        };
      },
    },
  ),
);
