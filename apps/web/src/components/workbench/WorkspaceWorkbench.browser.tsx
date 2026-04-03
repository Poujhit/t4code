import "../../index.css";

import { EditorView } from "@codemirror/view";
import type { NativeApi, ThreadId } from "@t3tools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { isMacPlatform } from "~/lib/utils";
import {
  useWorkspaceWorkbenchStore,
  WORKSPACE_INLINE_DEFAULT_WIDTH,
} from "~/workspaceWorkbenchStore";
import { WorkspaceWorkbench } from "./WorkspaceWorkbench";

const THREAD_ID = "thread-workspace-editor" as ThreadId;

afterEach(() => {
  localStorage.clear();
  delete (window as typeof window & { nativeApi?: NativeApi }).nativeApi;
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
  });
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
    await expect.element(screen.getByRole("button", { name: "index.ts" })).toBeInTheDocument();

    await screen.getByRole("button", { name: "README.md" }).click();
    await expect.element(screen.getByTestId("workspace-editor")).toBeInTheDocument();
    await expect.element(screen.getByRole("tab", { name: /README\.md/i })).toBeInTheDocument();
    expect(
      Array.from(document.querySelectorAll("button")).find(
        (element) => element.textContent?.trim() === "Save",
      ),
    ).toBeUndefined();

    await screen.getByRole("button", { name: "src" }).click();
    await screen.getByRole("button", { name: "index.ts" }).click();
    await expect.element(screen.getByRole("tab", { name: /index\.ts/i })).toBeInTheDocument();

    await screen.getByRole("tab", { name: /README\.md/i }).click();
    await vi.waitFor(() => {
      expect(useWorkspaceWorkbenchStore.getState().activeFilePathByThreadId[THREAD_ID]).toBe(
        "README.md",
      );
    });

    useWorkspaceWorkbenchStore.getState().setDraftContent(THREAD_ID, "README.md", {
      contents: "# Notes\nUpdated",
      baseContents: "# Notes\n",
    });
    await expect.element(screen.getByText("Unsaved")).toBeInTheDocument();
    await expect
      .element(screen.getByLabelText("README.md has unsaved changes"))
      .toBeInTheDocument();

    await screen.getByRole("button", { name: "Close index.ts tab" }).click();
    await vi.waitFor(() => {
      expect(
        Array.from(document.querySelectorAll('[role="tab"]')).find((element) =>
          element.textContent?.includes("index.ts"),
        ),
      ).toBeUndefined();
    });

    let editorContent: HTMLElement | null = null;
    await vi.waitFor(() => {
      editorContent = document.querySelector<HTMLElement>(".cm-content");
      expect(editorContent).toBeTruthy();
    });
    editorContent!.focus();
    editorContent!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "s",
        ctrlKey: true,
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
});
