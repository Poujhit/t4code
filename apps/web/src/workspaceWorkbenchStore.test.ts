import { ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import {
  clampWorkspacePaneWidth,
  partializeWorkspaceWorkbenchState,
  selectWorkspaceThreadState,
  useWorkspaceWorkbenchStore,
  WORKSPACE_INLINE_DEFAULT_WIDTH,
  WORKSPACE_INLINE_MAX_WIDTH,
  WORKSPACE_INLINE_MIN_WIDTH,
} from "./workspaceWorkbenchStore";

const THREAD_ID = ThreadId.makeUnsafe("thread-1");
const OTHER_THREAD_ID = ThreadId.makeUnsafe("thread-2");

describe("workspaceWorkbenchStore", () => {
  beforeEach(() => {
    if (typeof localStorage !== "undefined") {
      localStorage.clear();
    }
    useWorkspaceWorkbenchStore.setState({
      isWorkspaceOpen: false,
      workspacePaneWidth: WORKSPACE_INLINE_DEFAULT_WIDTH,
      threadStateByThreadId: {},
    });
  });

  it("persists workspace open state and pane width", () => {
    useWorkspaceWorkbenchStore.getState().setWorkspaceOpen(true);
    useWorkspaceWorkbenchStore.getState().setWorkspacePaneWidth(WORKSPACE_INLINE_MAX_WIDTH + 500);
    const persistedState = partializeWorkspaceWorkbenchState(
      useWorkspaceWorkbenchStore.getState(),
    ) as {
      isWorkspaceOpen?: boolean;
      workspacePaneWidth?: number;
    };

    expect(useWorkspaceWorkbenchStore.getState().isWorkspaceOpen).toBe(true);
    expect(useWorkspaceWorkbenchStore.getState().workspacePaneWidth).toBe(
      clampWorkspacePaneWidth(WORKSPACE_INLINE_MAX_WIDTH + 500),
    );
    expect(persistedState.isWorkspaceOpen).toBe(true);
    expect(persistedState.workspacePaneWidth).toBe(
      clampWorkspacePaneWidth(WORKSPACE_INLINE_MAX_WIDTH + 500),
    );
  });

  it("clamps workspace pane width through the store action", () => {
    useWorkspaceWorkbenchStore.getState().setWorkspacePaneWidth(WORKSPACE_INLINE_MIN_WIDTH - 500);
    expect(useWorkspaceWorkbenchStore.getState().workspacePaneWidth).toBe(
      clampWorkspacePaneWidth(WORKSPACE_INLINE_MIN_WIDTH - 500),
    );
  });

  it("keeps selection and expansion scoped per thread", () => {
    const store = useWorkspaceWorkbenchStore.getState();
    store.syncThreadRoot(THREAD_ID, "/repo-a");
    store.syncThreadRoot(OTHER_THREAD_ID, "/repo-b");
    store.setDirectoryExpanded(THREAD_ID, "/repo-a/src", true);
    store.setSelectedPath(THREAD_ID, "/repo-a/src/index.ts");
    store.setDirectoryExpanded(OTHER_THREAD_ID, "/repo-b/app", true);
    store.setSelectedPath(OTHER_THREAD_ID, "/repo-b/app/main.ts");

    expect(
      selectWorkspaceThreadState(
        useWorkspaceWorkbenchStore.getState().threadStateByThreadId,
        THREAD_ID,
      ),
    ).toEqual({
      rootPath: "/repo-a",
      selectedPath: "/repo-a/src/index.ts",
      expandedDirectoryPaths: ["/repo-a/src"],
    });
    expect(
      selectWorkspaceThreadState(
        useWorkspaceWorkbenchStore.getState().threadStateByThreadId,
        OTHER_THREAD_ID,
      ),
    ).toEqual({
      rootPath: "/repo-b",
      selectedPath: "/repo-b/app/main.ts",
      expandedDirectoryPaths: ["/repo-b/app"],
    });
  });

  it("clears stale thread selection and expansion when the root changes", () => {
    const store = useWorkspaceWorkbenchStore.getState();
    store.syncThreadRoot(THREAD_ID, "/repo-a");
    store.setDirectoryExpanded(THREAD_ID, "/repo-a/src", true);
    store.setSelectedPath(THREAD_ID, "/repo-a/src/index.ts");

    store.syncThreadRoot(THREAD_ID, "/repo-b");

    expect(
      selectWorkspaceThreadState(
        useWorkspaceWorkbenchStore.getState().threadStateByThreadId,
        THREAD_ID,
      ),
    ).toEqual({
      rootPath: "/repo-b",
      selectedPath: null,
      expandedDirectoryPaths: [],
    });
  });
});
