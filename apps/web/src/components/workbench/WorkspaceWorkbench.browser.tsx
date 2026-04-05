import "../../index.css";

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { TurnId, type NativeApi, type ThreadId } from "@t3tools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { isMacPlatform } from "~/lib/utils";
import { useStore } from "~/store";
import type { Thread } from "~/types";
import {
  useWorkspaceWorkbenchStore,
  WORKSPACE_INLINE_DEFAULT_WIDTH,
} from "~/workspaceWorkbenchStore";
import { WorkspaceWorkbench } from "./WorkspaceWorkbench";

const THREAD_ID = "thread-workspace-editor" as ThreadId;

afterEach(() => {
  localStorage.clear();
  delete (window as typeof window & { nativeApi?: NativeApi }).nativeApi;
  useStore.setState((state) => ({
    ...state,
    projects: [],
    threads: [],
    sidebarThreadsById: {},
    threadIdsByProjectId: {},
    bootstrapComplete: false,
  }));
});

function resetWorkbenchState() {
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
    aiReviewStateByThreadIdAndPath: {},
  });
}

function makeThread(
  input: {
    turnDiffSummaries?: Thread["turnDiffSummaries"];
    worktreePath?: string | null;
  } = {},
): Thread {
  return {
    id: THREAD_ID,
    codexThreadId: null,
    projectId: "project-1" as never,
    title: "Thread",
    modelSelection: {
      provider: "codex",
      model: "gpt-5-codex",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-04-05T10:00:00.000Z",
    archivedAt: null,
    updatedAt: "2026-04-05T10:00:00.000Z",
    latestTurn: null,
    pendingSourceProposedPlan: undefined,
    branch: null,
    worktreePath: input.worktreePath ?? "/repo",
    turnDiffSummaries: input.turnDiffSummaries ?? [],
    activities: [],
  };
}

async function waitForCodeMirrorView(): Promise<EditorView> {
  let view: EditorView | null = null;
  await vi.waitFor(() => {
    const editorDom = document.querySelector<HTMLElement>(".cm-editor");
    expect(editorDom).toBeTruthy();
    view = editorDom ? EditorView.findFromDOM(editorDom) : null;
    expect(view).toBeTruthy();
  });
  if (!view) {
    throw new Error("Unable to find CodeMirror view.");
  }
  return view;
}

describe("WorkspaceWorkbench", () => {
  it("keeps tree expansion working and saves editor changes with the keyboard shortcut", async () => {
    let readmeContents = "# Notes\n";
    let readmeMtimeMs = 100;
    const listDirectory = vi.fn(async ({ relativePath }: { relativePath: string | null }) => {
      if (relativePath === null) {
        return {
          entries: [
            { path: "src", name: "src", kind: "directory", parentPath: null },
            { path: "README.md", name: "README.md", kind: "file", parentPath: null },
          ],
          truncated: false,
        };
      }
      if (relativePath === "src") {
        return {
          entries: [{ path: "src/index.ts", name: "index.ts", kind: "file", parentPath: "src" }],
          truncated: false,
        };
      }
      return { entries: [], truncated: false };
    });
    const readFile = vi.fn(async ({ relativePath }: { relativePath: string }) => {
      if (relativePath === "README.md") {
        return {
          relativePath,
          contents: readmeContents,
          mtimeMs: readmeMtimeMs,
          sizeBytes: readmeContents.length,
          isBinary: false,
          isTooLarge: false,
        };
      }
      return {
        relativePath,
        contents: "export {};\n",
        mtimeMs: 50,
        sizeBytes: "export {};\n".length,
        isBinary: false,
        isTooLarge: false,
      };
    });
    const writeFile = vi.fn(
      async ({
        relativePath,
        contents,
        expectedMtimeMs,
      }: {
        relativePath: string;
        contents: string;
        expectedMtimeMs?: number | null;
      }) => {
        expect(relativePath).toBe("README.md");
        expect(expectedMtimeMs).toBe(readmeMtimeMs);
        readmeContents = contents;
        readmeMtimeMs += 1;
        return { relativePath };
      },
    );

    window.nativeApi = {
      projects: {
        listDirectory,
        readFile,
        searchEntries: vi.fn(),
        writeFile,
      },
    } as unknown as NativeApi;

    resetWorkbenchState();
    useWorkspaceWorkbenchStore.getState().syncThreadRoot(THREAD_ID, "/repo");

    const queryClient = new QueryClient();
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceWorkbench threadId={THREAD_ID} workspaceRoot="/repo" />
      </QueryClientProvider>,
      { container: host },
    );

    await expect.element(screen.getByRole("button", { name: "src" })).toBeInTheDocument();
    await screen.getByRole("button", { name: "src" }).click();
    await vi.waitFor(() => {
      expect(document.body.textContent ?? "").toContain("index.ts");
    });
    await expect.element(screen.getByRole("button", { name: "index.ts" })).toBeInTheDocument();

    await screen.getByRole("button", { name: "README.md" }).click();
    await expect.element(screen.getByTestId("workspace-editor")).toBeInTheDocument();
    await expect.element(screen.getByRole("tab", { name: /README\.md/i })).toBeInTheDocument();
    expect(
      Array.from(document.querySelectorAll("button")).find(
        (element) => element.textContent?.trim() === "Save",
      ),
    ).toBeUndefined();

    useWorkspaceWorkbenchStore.getState().setDraftContent(THREAD_ID, "README.md", {
      contents: "# Notes\nUpdated",
      baseContents: "# Notes\n",
    });
    await expect.element(screen.getByText("Unsaved")).toBeInTheDocument();
    await expect
      .element(screen.getByLabelText("README.md has unsaved changes"))
      .toBeInTheDocument();

    let editorContent: HTMLElement | null = null;
    await vi.waitFor(() => {
      editorContent = document.querySelector<HTMLElement>(".cm-content");
      expect(editorContent).toBeTruthy();
    });
    editorContent!.focus();
    editorContent!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "s",
        metaKey: isMacPlatform(navigator.platform),
        ctrlKey: !isMacPlatform(navigator.platform),
        bubbles: true,
        cancelable: true,
      }),
    );

    await vi.waitFor(() => {
      expect(writeFile).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(readFile).toHaveBeenCalledWith({
        cwd: "/repo",
        relativePath: "README.md",
      });
      expect(document.body.textContent ?? "").not.toContain("Unsaved");
    });

    await screen.unmount();
    host.remove();
  });

  it("supports add-to-prompt from the editor shortcut and context menu for a non-empty primary selection", async () => {
    const addCodeSelectionToPrompt = vi.fn();
    const showContextMenu = vi.fn(async () => "add-to-prompt" as const);
    window.nativeApi = {
      projects: {
        listDirectory: vi.fn(async ({ relativePath }: { relativePath: string | null }) => ({
          entries:
            relativePath === null
              ? [{ path: "src/example.ts", name: "example.ts", kind: "file", parentPath: null }]
              : [],
          truncated: false,
        })),
        readFile: vi.fn(async ({ relativePath }: { relativePath: string }) => ({
          relativePath,
          contents: [
            "export function example() {",
            "  const value = 1;",
            "  return value;",
            "}",
          ].join("\n"),
          mtimeMs: 100,
          sizeBytes: 64,
          isBinary: false,
          isTooLarge: false,
        })),
        searchEntries: vi.fn(),
        writeFile: vi.fn(),
      },
      contextMenu: {
        show: showContextMenu,
      },
    } as unknown as NativeApi;

    resetWorkbenchState();
    useWorkspaceWorkbenchStore.getState().syncThreadRoot(THREAD_ID, "/repo");

    const queryClient = new QueryClient();
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceWorkbench
          threadId={THREAD_ID}
          workspaceRoot="/repo"
          onAddCodeSelectionToPrompt={addCodeSelectionToPrompt}
        />
      </QueryClientProvider>,
      { container: host },
    );

    await screen.getByRole("button", { name: "example.ts" }).click();
    await expect.element(screen.getByTestId("workspace-editor")).toBeInTheDocument();

    const view = await waitForCodeMirrorView();
    const firstLine = view.state.doc.line(1);
    const thirdLine = view.state.doc.line(3);

    view.dispatch({
      selection: {
        anchor: firstLine.from + "export ".length,
        head: thirdLine.from + "  return".length,
      },
    });
    const editorContent = document.querySelector<HTMLElement>(".cm-content");
    expect(editorContent).toBeTruthy();
    editorContent!.focus();
    editorContent!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        shiftKey: true,
        metaKey: isMacPlatform(navigator.platform),
        ctrlKey: !isMacPlatform(navigator.platform),
        bubbles: true,
        cancelable: true,
      }),
    );
    await vi.waitFor(() => {
      expect(addCodeSelectionToPrompt).toHaveBeenCalledWith({
        relativePath: "src/example.ts",
        startLine: 1,
        endLine: 3,
        selectedText: ["export function example() {", "  const value = 1;", "  return value;"].join(
          "\n",
        ),
      });
    });

    addCodeSelectionToPrompt.mockClear();
    editorContent!.dispatchEvent(
      new MouseEvent("contextmenu", {
        clientX: 20,
        clientY: 24,
        bubbles: true,
        cancelable: true,
      }),
    );
    await vi.waitFor(() => {
      expect(showContextMenu).toHaveBeenCalledWith(
        [{ id: "add-to-prompt", label: "Add to prompt" }],
        { x: 20, y: 24 },
      );
      expect(addCodeSelectionToPrompt).toHaveBeenCalledTimes(1);
    });

    await screen.unmount();
    host.remove();
  });

  it("locks the editor for active AI review hunks, supports add-to-prompt, and unlocks after the final accept", async () => {
    const addCodeSelectionToPrompt = vi.fn();
    let fileContents = [
      "export function example() {",
      "  const value = 2;",
      "  return value;",
      "}",
      "",
      "export function another() {",
      "  return 2;",
      "}",
    ].join("\n");
    const diff = [
      "diff --git a/src/example.ts b/src/example.ts",
      "index 1111111..2222222 100644",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -1,4 +1,4 @@",
      " export function example() {",
      "-  return 1;",
      "+  const value = 2;",
      "+  return value;",
      " }",
      "@@ -5,4 +6,3 @@",
      " export function another() {",
      "-  return 1;",
      "+  return 2;",
      " }",
      "",
    ].join("\n");
    window.nativeApi = {
      projects: {
        listDirectory: vi.fn(async ({ relativePath }: { relativePath: string | null }) => ({
          entries:
            relativePath === null
              ? [{ path: "src/example.ts", name: "example.ts", kind: "file", parentPath: null }]
              : [],
          truncated: false,
        })),
        readFile: vi.fn(async ({ relativePath }: { relativePath: string }) => ({
          relativePath,
          contents: fileContents,
          mtimeMs: 100,
          sizeBytes: fileContents.length,
          isBinary: false,
          isTooLarge: false,
        })),
        searchEntries: vi.fn(),
        writeFile: vi.fn(),
      },
      orchestration: {
        getFullThreadDiff: vi.fn(async () => ({
          threadId: THREAD_ID,
          fromTurnCount: 0,
          toTurnCount: 1,
          diff,
        })),
        getTurnDiff: vi.fn(),
      },
    } as unknown as NativeApi;

    resetWorkbenchState();
    useWorkspaceWorkbenchStore.getState().syncThreadRoot(THREAD_ID, "/repo");
    useStore.setState((state) => ({
      ...state,
      threads: [
        makeThread({
          turnDiffSummaries: [
            {
              turnId: TurnId.makeUnsafe("turn-1"),
              completedAt: "2026-04-05T10:01:00.000Z",
              checkpointTurnCount: 1,
              status: "ready",
              files: [{ path: "src/example.ts", additions: 3, deletions: 2 }],
            },
          ],
        }),
      ],
      bootstrapComplete: true,
    }));

    const queryClient = new QueryClient();
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceWorkbench
          threadId={THREAD_ID}
          workspaceRoot="/repo"
          onAddCodeSelectionToPrompt={addCodeSelectionToPrompt}
        />
      </QueryClientProvider>,
      { container: host },
    );

    await screen.getByRole("button", { name: "example.ts" }).click();
    await expect.element(screen.getByText("AI review")).toBeInTheDocument();

    const view = await waitForCodeMirrorView();
    await vi.waitFor(() => {
      expect(view.state.facet(EditorState.readOnly)).toBe(true);
      expect(document.querySelectorAll('[aria-label^="Accept AI hunk"]').length).toBe(2);
      expect(document.body.textContent ?? "").toContain("return 1;");
      const inlineAdditions = Array.from(
        document.querySelectorAll(".cm-ai-review-inline-addition"),
      ).map((element) => element.textContent);
      expect(inlineAdditions.length).toBeGreaterThan(0);
    });

    const addButtons = document.querySelectorAll('[aria-label^="Add AI hunk to prompt"]');
    expect(addButtons[0]).toBeTruthy();
    (addButtons[0] as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(addCodeSelectionToPrompt).toHaveBeenCalledWith({
        relativePath: "src/example.ts",
        startLine: 2,
        endLine: 3,
        selectedText: ["  const value = 2;", "  return value;"].join("\n"),
      });
    });

    const acceptButtonsBefore = document.querySelectorAll('[aria-label^="Accept AI hunk"]');
    (acceptButtonsBefore[0] as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(document.querySelectorAll('[aria-label^="Accept AI hunk"]').length).toBe(1);
      expect(view.state.facet(EditorState.readOnly)).toBe(true);
    });

    const finalAcceptButton = document.querySelector('[aria-label^="Accept AI hunk"]');
    expect(finalAcceptButton).toBeTruthy();
    (finalAcceptButton as HTMLButtonElement).click();
    await vi.waitFor(() => {
      expect(document.querySelectorAll('[aria-label^="Accept AI hunk"]').length).toBe(0);
      expect(view.state.facet(EditorState.readOnly)).toBe(false);
      expect(document.body.textContent ?? "").not.toContain("AI review");
    });

    await screen.unmount();
    host.remove();
  });

  it("uses diff-style inline emphasis for matched replacement lines in the editor overlay", async () => {
    const fileContents = [
      "const handleRegenerate = () => {",
      "  setCoverLetter(null);",
      "  setShowOptions(false);",
      "  clearCopyStatus();",
      "};",
      "",
      "const handleCopy = async () => {",
      "  if (!coverLetter?.coverLetter) return;",
      "",
      "  try {",
      "    await copyTextToClipboard(coverLetter.coverLetter);",
      "  } catch (error) {",
      "    showCopyStatus({ type: 'error', message: getClipboardErrorMessage(error) });",
      "  }",
      "};",
    ].join("\n");
    const diff = [
      "diff --git a/src/example.ts b/src/example.ts",
      "index 1111111..2222222 100644",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -1,5 +1,15 @@",
      "-const handleCopy = () => {",
      "-  if (coverLetter?.coverLetter) {",
      "-    navigator.clipboard.writeText(coverLetter.coverLetter);",
      "+const handleRegenerate = () => {",
      "+  setCoverLetter(null);",
      "+  setShowOptions(false);",
      "+  clearCopyStatus();",
      "+};",
      "+",
      "+const handleCopy = async () => {",
      "+  if (!coverLetter?.coverLetter) return;",
      "+",
      "+  try {",
      "+    await copyTextToClipboard(coverLetter.coverLetter);",
      " }",
      "",
    ].join("\n");
    window.nativeApi = {
      projects: {
        listDirectory: vi.fn(async ({ relativePath }: { relativePath: string | null }) => ({
          entries:
            relativePath === null
              ? [{ path: "src/example.ts", name: "example.ts", kind: "file", parentPath: null }]
              : [],
          truncated: false,
        })),
        readFile: vi.fn(async ({ relativePath }: { relativePath: string }) => ({
          relativePath,
          contents: fileContents,
          mtimeMs: 100,
          sizeBytes: fileContents.length,
          isBinary: false,
          isTooLarge: false,
        })),
        searchEntries: vi.fn(),
        writeFile: vi.fn(),
      },
      orchestration: {
        getFullThreadDiff: vi.fn(async () => ({
          threadId: THREAD_ID,
          fromTurnCount: 0,
          toTurnCount: 1,
          diff,
        })),
        getTurnDiff: vi.fn(),
      },
    } as unknown as NativeApi;

    resetWorkbenchState();
    useWorkspaceWorkbenchStore.getState().syncThreadRoot(THREAD_ID, "/repo");
    useStore.setState((state) => ({
      ...state,
      threads: [
        makeThread({
          turnDiffSummaries: [
            {
              turnId: TurnId.makeUnsafe("turn-1"),
              completedAt: "2026-04-05T10:01:00.000Z",
              checkpointTurnCount: 1,
              status: "ready",
              files: [{ path: "src/example.ts", additions: 10, deletions: 3 }],
            },
          ],
        }),
      ],
      bootstrapComplete: true,
    }));

    const queryClient = new QueryClient();
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceWorkbench threadId={THREAD_ID} workspaceRoot="/repo" />
      </QueryClientProvider>,
      { container: host },
    );

    await screen.getByRole("button", { name: "example.ts" }).click();
    await expect.element(screen.getByText("AI review")).toBeInTheDocument();

    await vi.waitFor(() => {
      const inlineAdditions = Array.from(
        document.querySelectorAll(".cm-ai-review-inline-addition"),
      ).map((element) => element.textContent);
      expect(inlineAdditions).toContain("async ");
      expect(inlineAdditions).toContain("return;");
    });

    await screen.unmount();
    host.remove();
  });

  it("places mixed delete-and-add review highlights on the exact added lines", async () => {
    const fileContents = [
      "function example() {",
      "  const first = 'new first';",
      "  const context = true;",
      "  const second = 'new second';",
      "  const third = 'new third';",
      "  return context;",
      "}",
    ].join("\n");
    const diff = [
      "diff --git a/src/example.ts b/src/example.ts",
      "index 1111111..2222222 100644",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -1,6 +1,7 @@",
      " function example() {",
      "-  const first = 'old first';",
      "+  const first = 'new first';",
      "   const context = true;",
      "-  const second = 'old second';",
      "+  const second = 'new second';",
      "+  const third = 'new third';",
      "   return context;",
      " }",
      "",
    ].join("\n");
    window.nativeApi = {
      projects: {
        listDirectory: vi.fn(async ({ relativePath }: { relativePath: string | null }) => ({
          entries:
            relativePath === null
              ? [{ path: "src/example.ts", name: "example.ts", kind: "file", parentPath: null }]
              : [],
          truncated: false,
        })),
        readFile: vi.fn(async ({ relativePath }: { relativePath: string }) => ({
          relativePath,
          contents: fileContents,
          mtimeMs: 100,
          sizeBytes: fileContents.length,
          isBinary: false,
          isTooLarge: false,
        })),
        searchEntries: vi.fn(),
        writeFile: vi.fn(),
      },
      orchestration: {
        getFullThreadDiff: vi.fn(async () => ({
          threadId: THREAD_ID,
          fromTurnCount: 0,
          toTurnCount: 1,
          diff,
        })),
        getTurnDiff: vi.fn(),
      },
    } as unknown as NativeApi;

    resetWorkbenchState();
    useWorkspaceWorkbenchStore.getState().syncThreadRoot(THREAD_ID, "/repo");
    useStore.setState((state) => ({
      ...state,
      threads: [
        makeThread({
          turnDiffSummaries: [
            {
              turnId: TurnId.makeUnsafe("turn-1"),
              completedAt: "2026-04-05T10:01:00.000Z",
              checkpointTurnCount: 1,
              status: "ready",
              files: [{ path: "src/example.ts", additions: 3, deletions: 2 }],
            },
          ],
        }),
      ],
      bootstrapComplete: true,
    }));

    const queryClient = new QueryClient();
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceWorkbench threadId={THREAD_ID} workspaceRoot="/repo" />
      </QueryClientProvider>,
      { container: host },
    );

    await screen.getByRole("button", { name: "example.ts" }).click();
    await expect.element(screen.getByText("AI review")).toBeInTheDocument();

    await vi.waitFor(() => {
      const highlightedLines = Array.from(document.querySelectorAll(".cm-ai-review-line")).map(
        (line) => line.textContent?.trim(),
      );
      expect(highlightedLines).toEqual([
        "const first = 'new first';",
        "const second = 'new second';",
        "const third = 'new third';",
      ]);
      expect(document.body.textContent ?? "").toContain("const first = 'old first';");
      expect(document.body.textContent ?? "").toContain("const second = 'old second';");
      expect(document.body.textContent ?? "").not.toContain("const context = true;Accept");
    });

    await screen.unmount();
    host.remove();
  });

  it("replaces the review overlay when a newer AI turn changes the same file", async () => {
    let fileContents = ["export const value = 2;", "console.log(value);"].join("\n");
    const firstDiff = [
      "diff --git a/src/example.ts b/src/example.ts",
      "index 1111111..2222222 100644",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -1 +1 @@",
      "-export const value = 1;",
      "+export const value = 2;",
      "",
    ].join("\n");
    const secondDiff = [
      "diff --git a/src/example.ts b/src/example.ts",
      "index 2222222..3333333 100644",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -2 +2 @@",
      "-console.log(value);",
      "+console.info(value);",
      "",
    ].join("\n");
    window.nativeApi = {
      projects: {
        listDirectory: vi.fn(async ({ relativePath }: { relativePath: string | null }) => ({
          entries:
            relativePath === null
              ? [{ path: "src/example.ts", name: "example.ts", kind: "file", parentPath: null }]
              : [],
          truncated: false,
        })),
        readFile: vi.fn(async ({ relativePath }: { relativePath: string }) => ({
          relativePath,
          contents: fileContents,
          mtimeMs: 100,
          sizeBytes: fileContents.length,
          isBinary: false,
          isTooLarge: false,
        })),
        searchEntries: vi.fn(),
        writeFile: vi.fn(),
      },
      orchestration: {
        getFullThreadDiff: vi.fn(async () => ({
          threadId: THREAD_ID,
          fromTurnCount: 0,
          toTurnCount: 1,
          diff: firstDiff,
        })),
        getTurnDiff: vi.fn(async () => ({
          threadId: THREAD_ID,
          fromTurnCount: 1,
          toTurnCount: 2,
          diff: secondDiff,
        })),
      },
    } as unknown as NativeApi;

    resetWorkbenchState();
    useWorkspaceWorkbenchStore.getState().syncThreadRoot(THREAD_ID, "/repo");
    useStore.setState((state) => ({
      ...state,
      threads: [
        makeThread({
          turnDiffSummaries: [
            {
              turnId: TurnId.makeUnsafe("turn-1"),
              completedAt: "2026-04-05T10:01:00.000Z",
              checkpointTurnCount: 1,
              status: "ready",
              files: [{ path: "src/example.ts", additions: 1, deletions: 1 }],
            },
          ],
        }),
      ],
      bootstrapComplete: true,
    }));

    const queryClient = new QueryClient();
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceWorkbench threadId={THREAD_ID} workspaceRoot="/repo" />
      </QueryClientProvider>,
      { container: host },
    );

    await screen.getByRole("button", { name: "example.ts" }).click();
    await vi.waitFor(() => {
      expect(document.querySelector('[aria-label="Accept AI hunk for Line 1"]')).toBeTruthy();
    });

    fileContents = ["export const value = 2;", "console.info(value);"].join("\n");
    useStore.setState((state) => ({
      ...state,
      threads: [
        makeThread({
          turnDiffSummaries: [
            {
              turnId: TurnId.makeUnsafe("turn-1"),
              completedAt: "2026-04-05T10:01:00.000Z",
              checkpointTurnCount: 1,
              status: "ready",
              files: [{ path: "src/example.ts", additions: 1, deletions: 1 }],
            },
            {
              turnId: TurnId.makeUnsafe("turn-2"),
              completedAt: "2026-04-05T10:02:00.000Z",
              checkpointTurnCount: 2,
              status: "ready",
              files: [{ path: "src/example.ts", additions: 1, deletions: 1 }],
            },
          ],
        }),
      ],
    }));
    await queryClient.invalidateQueries();

    await vi.waitFor(() => {
      expect(document.querySelector('[aria-label="Accept AI hunk for Line 1"]')).toBeNull();
      expect(document.querySelector('[aria-label="Accept AI hunk for Line 2"]')).toBeTruthy();
    });

    await screen.unmount();
    host.remove();
  });

  it("clears active review mode when the file changes externally on disk", async () => {
    let fileContents = ["export const value = 2;", "console.log(value);"].join("\n");
    const diff = [
      "diff --git a/src/example.ts b/src/example.ts",
      "index 1111111..2222222 100644",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -1 +1 @@",
      "-export const value = 1;",
      "+export const value = 2;",
      "",
    ].join("\n");
    window.nativeApi = {
      projects: {
        listDirectory: vi.fn(async ({ relativePath }: { relativePath: string | null }) => ({
          entries:
            relativePath === null
              ? [{ path: "src/example.ts", name: "example.ts", kind: "file", parentPath: null }]
              : [],
          truncated: false,
        })),
        readFile: vi.fn(async ({ relativePath }: { relativePath: string }) => ({
          relativePath,
          contents: fileContents,
          mtimeMs: 100,
          sizeBytes: fileContents.length,
          isBinary: false,
          isTooLarge: false,
        })),
        searchEntries: vi.fn(),
        writeFile: vi.fn(),
      },
      orchestration: {
        getFullThreadDiff: vi.fn(async () => ({
          threadId: THREAD_ID,
          fromTurnCount: 0,
          toTurnCount: 1,
          diff,
        })),
        getTurnDiff: vi.fn(),
      },
    } as unknown as NativeApi;

    resetWorkbenchState();
    useWorkspaceWorkbenchStore.getState().syncThreadRoot(THREAD_ID, "/repo");
    useStore.setState((state) => ({
      ...state,
      threads: [
        makeThread({
          turnDiffSummaries: [
            {
              turnId: TurnId.makeUnsafe("turn-1"),
              completedAt: "2026-04-05T10:01:00.000Z",
              checkpointTurnCount: 1,
              status: "ready",
              files: [{ path: "src/example.ts", additions: 1, deletions: 1 }],
            },
          ],
        }),
      ],
      bootstrapComplete: true,
    }));

    const queryClient = new QueryClient();
    const host = document.createElement("div");
    document.body.append(host);
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceWorkbench threadId={THREAD_ID} workspaceRoot="/repo" />
      </QueryClientProvider>,
      { container: host },
    );

    await screen.getByRole("button", { name: "example.ts" }).click();
    const view = await waitForCodeMirrorView();
    await vi.waitFor(() => {
      expect(view.state.facet(EditorState.readOnly)).toBe(true);
      expect(document.body.textContent ?? "").toContain("AI review");
    });

    fileContents = ["export const value = 99;", "console.log(value);"].join("\n");
    await queryClient.invalidateQueries();

    await vi.waitFor(() => {
      expect(view.state.facet(EditorState.readOnly)).toBe(false);
      expect(document.querySelector('[aria-label^="Accept AI hunk"]')).toBeNull();
      expect(document.body.textContent ?? "").not.toContain("AI review");
    });

    await screen.unmount();
    host.remove();
  });
});
