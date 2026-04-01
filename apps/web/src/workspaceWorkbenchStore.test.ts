import { ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import {
  clampWorkspacePaneWidth,
  partializeWorkspaceWorkbenchState,
  selectWorkspaceThreadState,
  useWorkspaceWorkbenchStore,
  workspaceFileStateKey,
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
      openFilePathsByThreadId: {},
      activeFilePathByThreadId: {},
      draftContentByThreadIdAndPath: {},
      baseMtimeMsByThreadIdAndPath: {},
      isDirtyByThreadIdAndPath: {},
      lastLoadErrorByThreadIdAndPath: {},
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
    store.openFile(THREAD_ID, "/repo-a/src/index.ts");
    store.setDirectoryExpanded(OTHER_THREAD_ID, "/repo-b/app", true);
    store.openFile(OTHER_THREAD_ID, "/repo-b/app/main.ts");

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
    expect(useWorkspaceWorkbenchStore.getState().activeFilePathByThreadId[THREAD_ID]).toBe(
      "/repo-a/src/index.ts",
    );
    expect(useWorkspaceWorkbenchStore.getState().openFilePathsByThreadId[THREAD_ID]).toEqual([
      "/repo-a/src/index.ts",
    ]);
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
    expect(useWorkspaceWorkbenchStore.getState().activeFilePathByThreadId[OTHER_THREAD_ID]).toBe(
      "/repo-b/app/main.ts",
    );
    expect(useWorkspaceWorkbenchStore.getState().openFilePathsByThreadId[OTHER_THREAD_ID]).toEqual([
      "/repo-b/app/main.ts",
    ]);
  });

  it("clears stale thread selection and expansion when the root changes", () => {
    const store = useWorkspaceWorkbenchStore.getState();
    store.syncThreadRoot(THREAD_ID, "/repo-a");
    store.setDirectoryExpanded(THREAD_ID, "/repo-a/src", true);
    store.openFile(THREAD_ID, "/repo-a/src/index.ts");
    store.hydrateFileDraft(THREAD_ID, "src/index.ts", {
      contents: "export const value = 1;\n",
      mtimeMs: 10,
    });
    store.setDraftContent(THREAD_ID, "src/index.ts", {
      contents: "export const value = 2;\n",
      baseContents: "export const value = 1;\n",
    });

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
    expect(
      useWorkspaceWorkbenchStore.getState().activeFilePathByThreadId[THREAD_ID],
    ).toBeUndefined();
    expect(
      useWorkspaceWorkbenchStore.getState().openFilePathsByThreadId[THREAD_ID],
    ).toBeUndefined();
    expect(
      useWorkspaceWorkbenchStore.getState().draftContentByThreadIdAndPath[
        workspaceFileStateKey(THREAD_ID, "src/index.ts")
      ],
    ).toBeUndefined();
  });

  it("keeps unique open tabs in order and reactivates existing tabs without duplication", () => {
    const store = useWorkspaceWorkbenchStore.getState();

    store.syncThreadRoot(THREAD_ID, "/repo");
    store.openFile(THREAD_ID, "src/index.ts");
    store.openFile(THREAD_ID, "README.md");
    store.openFile(THREAD_ID, "src/index.ts");

    expect(useWorkspaceWorkbenchStore.getState().openFilePathsByThreadId[THREAD_ID]).toEqual([
      "src/index.ts",
      "README.md",
    ]);
    expect(useWorkspaceWorkbenchStore.getState().activeFilePathByThreadId[THREAD_ID]).toBe(
      "src/index.ts",
    );
    expect(
      selectWorkspaceThreadState(
        useWorkspaceWorkbenchStore.getState().threadStateByThreadId,
        THREAD_ID,
      ).selectedPath,
    ).toBe("src/index.ts");
  });

  it("closes inactive tabs without changing the active file", () => {
    const store = useWorkspaceWorkbenchStore.getState();

    store.openFile(THREAD_ID, "src/index.ts");
    store.openFile(THREAD_ID, "README.md");
    store.closeFile(THREAD_ID, "src/index.ts");

    expect(useWorkspaceWorkbenchStore.getState().openFilePathsByThreadId[THREAD_ID]).toEqual([
      "README.md",
    ]);
    expect(useWorkspaceWorkbenchStore.getState().activeFilePathByThreadId[THREAD_ID]).toBe(
      "README.md",
    );
  });

  it("activates the next tab to the right, then the left, when closing the active tab", () => {
    const store = useWorkspaceWorkbenchStore.getState();

    store.openFile(THREAD_ID, "a.ts");
    store.openFile(THREAD_ID, "b.ts");
    store.openFile(THREAD_ID, "c.ts");
    store.openFile(THREAD_ID, "b.ts");

    store.closeFile(THREAD_ID, "b.ts");
    expect(useWorkspaceWorkbenchStore.getState().openFilePathsByThreadId[THREAD_ID]).toEqual([
      "a.ts",
      "c.ts",
    ]);
    expect(useWorkspaceWorkbenchStore.getState().activeFilePathByThreadId[THREAD_ID]).toBe("c.ts");

    store.closeFile(THREAD_ID, "c.ts");
    expect(useWorkspaceWorkbenchStore.getState().activeFilePathByThreadId[THREAD_ID]).toBe("a.ts");

    store.closeFile(THREAD_ID, "a.ts");
    expect(
      useWorkspaceWorkbenchStore.getState().activeFilePathByThreadId[THREAD_ID],
    ).toBeUndefined();
    expect(
      selectWorkspaceThreadState(
        useWorkspaceWorkbenchStore.getState().threadStateByThreadId,
        THREAD_ID,
      ).selectedPath,
    ).toBeNull();
  });

  it("tracks dirty draft lifecycle and resets it after save", () => {
    const store = useWorkspaceWorkbenchStore.getState();
    const key = workspaceFileStateKey(THREAD_ID, "src/index.ts");
    store.hydrateFileDraft(THREAD_ID, "src/index.ts", {
      contents: "export const value = 1;\n",
      mtimeMs: 10,
    });

    expect(useWorkspaceWorkbenchStore.getState().draftContentByThreadIdAndPath[key]).toBe(
      "export const value = 1;\n",
    );
    expect(useWorkspaceWorkbenchStore.getState().isDirtyByThreadIdAndPath[key]).toBeUndefined();
    expect(useWorkspaceWorkbenchStore.getState().baseMtimeMsByThreadIdAndPath[key]).toBe(10);

    store.setDraftContent(THREAD_ID, "src/index.ts", {
      contents: "export const value = 2;\n",
      baseContents: "export const value = 1;\n",
    });

    expect(useWorkspaceWorkbenchStore.getState().isDirtyByThreadIdAndPath[key]).toBe(true);

    store.markFileSaved(THREAD_ID, "src/index.ts", {
      contents: "export const value = 2;\n",
      mtimeMs: 22,
    });

    expect(useWorkspaceWorkbenchStore.getState().draftContentByThreadIdAndPath[key]).toBe(
      "export const value = 2;\n",
    );
    expect(useWorkspaceWorkbenchStore.getState().isDirtyByThreadIdAndPath[key]).toBeUndefined();
    expect(useWorkspaceWorkbenchStore.getState().baseMtimeMsByThreadIdAndPath[key]).toBe(22);
  });

  it("preserves draft state when a tab is closed", () => {
    const store = useWorkspaceWorkbenchStore.getState();
    const key = workspaceFileStateKey(THREAD_ID, "src/index.ts");

    store.openFile(THREAD_ID, "src/index.ts");
    store.hydrateFileDraft(THREAD_ID, "src/index.ts", {
      contents: "export const value = 1;\n",
      mtimeMs: 10,
    });
    store.setDraftContent(THREAD_ID, "src/index.ts", {
      contents: "export const value = 2;\n",
      baseContents: "export const value = 1;\n",
    });

    store.closeFile(THREAD_ID, "src/index.ts");

    expect(
      useWorkspaceWorkbenchStore.getState().openFilePathsByThreadId[THREAD_ID],
    ).toBeUndefined();
    expect(useWorkspaceWorkbenchStore.getState().draftContentByThreadIdAndPath[key]).toBe(
      "export const value = 2;\n",
    );
    expect(useWorkspaceWorkbenchStore.getState().isDirtyByThreadIdAndPath[key]).toBe(true);
  });
});
