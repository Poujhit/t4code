import { type ThreadId } from "@t3tools/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { markdown } from "@codemirror/lang-markdown";
import { oneDark } from "@codemirror/theme-one-dark";
import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";

import { basenameOfPath } from "~/vscode-icons";
import {
  projectReadFileQueryOptions,
  projectWriteFileMutationOptions,
} from "~/lib/projectReactQuery";
import { useWorkspaceWorkbenchStore, workspaceFileStateKey } from "~/workspaceWorkbenchStore";
import { WorkspaceEditorHeader } from "./WorkspaceEditorHeader";
import { WorkspaceFileFallback } from "./WorkspaceFileFallback";
import { WorkspaceOpenFilesBar } from "./WorkspaceOpenFilesBar";

function classifyWorkspaceFileError(error: unknown): {
  kind: "missing" | "unreadable" | "conflict";
  message: string;
} {
  const message =
    error instanceof Error && error.message.trim().length > 0
      ? error.message
      : "An unexpected workspace file error occurred.";
  if (/changed on disk since it was opened/i.test(message)) {
    return { kind: "conflict", message };
  }
  if (/not found/i.test(message)) {
    return { kind: "missing", message };
  }
  return { kind: "unreadable", message };
}

function languageExtensionForPath(relativePath: string): Extension | null {
  const lower = relativePath.toLowerCase();
  if (lower.endsWith(".tsx")) return javascript({ jsx: true, typescript: true });
  if (lower.endsWith(".ts")) return javascript({ typescript: true });
  if (lower.endsWith(".jsx")) return javascript({ jsx: true });
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) {
    return javascript();
  }
  if (lower.endsWith(".json")) return javascript();
  if (lower.endsWith(".md") || lower.endsWith(".mdx")) return markdown();
  if (lower.endsWith(".css") || lower.endsWith(".scss") || lower.endsWith(".less")) {
    return css();
  }
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return html();
  return null;
}

function editorTheme(_resolvedTheme: "light" | "dark"): Extension {
  const gutterBackground = "var(--color-neutral-900)";

  return EditorView.theme(
    {
      "&": {
        height: "100%",
        width: "100%",
        maxWidth: "100%",
        minHeight: "0",
        minWidth: "0",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        backgroundColor: "var(--background)",
        color: "var(--foreground)",
      },
      "& .cm-scroller": {
        fontFamily: '"SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
        fontSize: "13px",
        lineHeight: "1.58",
        flex: "1 1 0%",
        height: "100%",
        width: "100%",
        minHeight: "0",
        minWidth: "0",
        overflowX: "auto",
        overflowY: "auto",
        overscrollBehavior: "contain",
        scrollbarWidth: "thin",
        scrollbarColor: "rgba(255, 255, 255, 0.1) transparent",
        backgroundColor: "var(--background)",
      },
      "& .cm-scroller::-webkit-scrollbar": {
        width: "6px",
        height: "6px",
      },
      "& .cm-scroller::-webkit-scrollbar-track": {
        background: "transparent",
      },
      "& .cm-scroller::-webkit-scrollbar-thumb": {
        background: "rgba(255, 255, 255, 0.1)",
        borderRadius: "3px",
      },
      "& .cm-scroller::-webkit-scrollbar-thumb:hover": {
        background: "rgba(255, 255, 255, 0.18)",
      },
      "& .cm-scroller::-webkit-scrollbar-corner": {
        background: "var(--background)",
      },
      "& .cm-sizer": {
        minHeight: "100%",
        minWidth: "100%",
      },
      "& .cm-gutter": {
        minHeight: "100%",
        backgroundColor: gutterBackground,
      },
      "& .cm-gutters": {
        minWidth: "3.5rem",
        flexShrink: "0",
        backgroundColor: gutterBackground,
        color: "var(--muted-foreground)",
        borderRight: "1px solid color-mix(in srgb, var(--border) 78%, transparent)",
      },
      "& .cm-lineNumbers": {
        backgroundColor: gutterBackground,
      },
      "& .cm-gutter-filler": {
        backgroundColor: gutterBackground,
      },
      "& .cm-gutterElement": {
        backgroundColor: gutterBackground,
      },
      "& .cm-scrollbar-filler": {
        backgroundColor: "var(--background)",
      },
      "& .cm-content": {
        minHeight: "100%",
        padding: "18px 20px 24px",
        minWidth: "fit-content",
        backgroundColor: "var(--background)",
      },
      "&.cm-focused": {
        outline: "none",
      },
      "& .cm-line": {
        paddingLeft: "2px",
      },
      "& .cm-activeLine": {
        backgroundColor: "color-mix(in srgb, var(--muted) 38%, var(--background))",
      },
      "& .cm-activeLineGutter": {
        backgroundColor: gutterBackground,
      },
      "& .cm-selectionLayer .cm-selectionBackground": {
        backgroundColor: "rgba(62, 116, 253, 0.34)",
        borderRadius: "2px",
      },
      "&.cm-focused .cm-selectionLayer .cm-selectionBackground": {
        backgroundColor: "rgba(62, 116, 253, 0.42)",
        borderRadius: "2px",
      },
      "& .cm-content ::selection": {
        backgroundColor: "rgba(62, 116, 253, 0.42)",
      },
    },
    { dark: true },
  );
}

function createEditorExtensions(params: {
  relativePath: string;
  resolvedTheme: "light" | "dark";
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  const languageExtension = languageExtensionForPath(params.relativePath);

  return [
    oneDark,
    lineNumbers(),
    highlightActiveLineGutter(),
    drawSelection(),
    dropCursor(),
    history(),
    indentOnInput(),
    bracketMatching(),
    highlightActiveLine(),
    keymap.of([
      {
        key: "Mod-s",
        preventDefault: true,
        run: () => {
          params.onSave();
          return true;
        },
      },
      indentWithTab,
      ...defaultKeymap,
      ...historyKeymap,
    ]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        params.onChange(update.state.doc.toString());
      }
    }),
    editorTheme(params.resolvedTheme),
    ...(languageExtension ? [languageExtension] : []),
  ];
}

function CodeMirrorEditor(props: {
  relativePath: string;
  value: string;
  resolvedTheme: "light" | "dark";
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const initialValueRef = useRef(props.value);
  const onChangeEvent = useEffectEvent(props.onChange);
  const onSaveEvent = useEffectEvent(props.onSave);

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    const state = EditorState.create({
      doc: initialValueRef.current,
      extensions: createEditorExtensions({
        relativePath: props.relativePath,
        resolvedTheme: props.resolvedTheme,
        onChange: (value) => onChangeEvent(value),
        onSave: () => onSaveEvent(),
      }),
    });
    const view = new EditorView({
      state,
      parent: containerRef.current,
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [props.relativePath, props.resolvedTheme]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) {
      return;
    }
    const currentValue = view.state.doc.toString();
    if (currentValue === props.value) {
      return;
    }
    const selection = view.state.selection.main;
    view.dispatch({
      changes: { from: 0, to: currentValue.length, insert: props.value },
      selection: EditorSelection.cursor(Math.min(selection.head, props.value.length)),
    });
  }, [props.value]);

  return (
    <div className="workspace-editor-codemirror flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <div
        ref={containerRef}
        className="h-full min-h-0 min-w-0 flex-1 overflow-hidden bg-background"
      />
    </div>
  );
}

export function WorkspaceEditor(props: {
  threadId: ThreadId;
  workspaceRoot: string;
  relativePath: string;
  resolvedTheme: "light" | "dark";
}) {
  const queryClient = useQueryClient();
  const draftKey = workspaceFileStateKey(props.threadId, props.relativePath);
  const openFilePaths = useWorkspaceWorkbenchStore(
    (state) => state.openFilePathsByThreadId[props.threadId] ?? [],
  );
  const openFile = useWorkspaceWorkbenchStore((state) => state.openFile);
  const activeFileError = useWorkspaceWorkbenchStore(
    (state) => state.lastLoadErrorByThreadIdAndPath[draftKey] ?? null,
  );
  const draftContent = useWorkspaceWorkbenchStore(
    (state) => state.draftContentByThreadIdAndPath[draftKey],
  );
  const baseMtimeMs = useWorkspaceWorkbenchStore(
    (state) => state.baseMtimeMsByThreadIdAndPath[draftKey] ?? null,
  );
  const isDirty = useWorkspaceWorkbenchStore(
    (state) => state.isDirtyByThreadIdAndPath[draftKey] ?? false,
  );
  const hydrateFileDraft = useWorkspaceWorkbenchStore((state) => state.hydrateFileDraft);
  const setDraftContent = useWorkspaceWorkbenchStore((state) => state.setDraftContent);
  const markFileSaved = useWorkspaceWorkbenchStore((state) => state.markFileSaved);
  const setFileError = useWorkspaceWorkbenchStore((state) => state.setFileError);
  const [isReloading, setIsReloading] = useState(false);

  const fileQuery = useQuery(
    projectReadFileQueryOptions({
      cwd: props.workspaceRoot,
      relativePath: props.relativePath,
    }),
  );
  const saveMutation = useMutation(projectWriteFileMutationOptions({ queryClient }));

  useEffect(() => {
    if (openFilePaths.includes(props.relativePath)) {
      return;
    }
    openFile(props.threadId, props.relativePath);
  }, [openFile, openFilePaths, props.relativePath, props.threadId]);

  useEffect(() => {
    if (!fileQuery.isSuccess) {
      return;
    }
    hydrateFileDraft(props.threadId, props.relativePath, {
      contents: fileQuery.data.contents,
      mtimeMs: fileQuery.data.mtimeMs,
    });
  }, [fileQuery.data, fileQuery.isSuccess, hydrateFileDraft, props.relativePath, props.threadId]);

  useEffect(() => {
    if (!fileQuery.isError) {
      return;
    }
    setFileError(props.threadId, props.relativePath, classifyWorkspaceFileError(fileQuery.error));
  }, [fileQuery.error, fileQuery.isError, props.relativePath, props.threadId, setFileError]);

  const handleSave = useCallback(async () => {
    const contents = draftContent ?? fileQuery.data?.contents ?? "";
    if (saveMutation.isPending || fileQuery.data?.isBinary || fileQuery.data?.isTooLarge) {
      return;
    }

    try {
      setFileError(props.threadId, props.relativePath, null);
      await saveMutation.mutateAsync({
        cwd: props.workspaceRoot,
        relativePath: props.relativePath,
        contents,
        expectedMtimeMs: baseMtimeMs,
      });
      const refreshed = await queryClient.fetchQuery(
        projectReadFileQueryOptions({
          cwd: props.workspaceRoot,
          relativePath: props.relativePath,
          staleTime: 0,
        }),
      );
      markFileSaved(props.threadId, props.relativePath, {
        contents: refreshed.contents,
        mtimeMs: refreshed.mtimeMs,
      });
    } catch (error) {
      setFileError(props.threadId, props.relativePath, classifyWorkspaceFileError(error));
    }
  }, [
    baseMtimeMs,
    draftContent,
    fileQuery.data,
    markFileSaved,
    props.relativePath,
    props.threadId,
    props.workspaceRoot,
    queryClient,
    saveMutation,
    setFileError,
  ]);

  const handleReloadFromDisk = useCallback(async () => {
    setIsReloading(true);
    try {
      const refreshed = await queryClient.fetchQuery(
        projectReadFileQueryOptions({
          cwd: props.workspaceRoot,
          relativePath: props.relativePath,
          staleTime: 0,
        }),
      );
      markFileSaved(props.threadId, props.relativePath, {
        contents: refreshed.contents,
        mtimeMs: refreshed.mtimeMs,
      });
      setFileError(props.threadId, props.relativePath, null);
    } catch (error) {
      setFileError(props.threadId, props.relativePath, classifyWorkspaceFileError(error));
    } finally {
      setIsReloading(false);
    }
  }, [
    markFileSaved,
    props.relativePath,
    props.threadId,
    props.workspaceRoot,
    queryClient,
    setFileError,
  ]);

  const handleRetry = useCallback(() => {
    setFileError(props.threadId, props.relativePath, null);
    void fileQuery.refetch();
  }, [fileQuery, props.relativePath, props.threadId, setFileError]);

  const currentContents = draftContent ?? fileQuery.data?.contents ?? "";
  const filename = basenameOfPath(props.relativePath);

  let readOnlyLabel: string | null = null;
  if (fileQuery.data?.isBinary) {
    readOnlyLabel = "Binary";
  } else if (fileQuery.data?.isTooLarge) {
    readOnlyLabel = "Read only";
  } else if (activeFileError && activeFileError.kind !== "conflict") {
    readOnlyLabel = "Unavailable";
  }

  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background"
      data-testid="workspace-editor"
    >
      <WorkspaceOpenFilesBar
        threadId={props.threadId}
        openFilePaths={openFilePaths}
        activeFilePath={props.relativePath}
        resolvedTheme={props.resolvedTheme}
      />
      <WorkspaceEditorHeader
        filename={filename}
        relativePath={props.relativePath}
        isDirty={isDirty}
        readOnlyLabel={readOnlyLabel}
      />
      {activeFileError?.kind === "conflict" ? (
        <WorkspaceFileFallback
          kind="conflict"
          variant="banner"
          title="File changed on disk"
          description="Reload the latest version from disk before saving again, or keep your local draft and resolve the conflict manually."
          details={activeFileError.message}
          primaryAction={{
            label: "Reload from disk",
            onClick: () => {
              void handleReloadFromDisk();
            },
            loading: isReloading,
          }}
          secondaryAction={{
            label: "Keep local draft",
            onClick: () => setFileError(props.threadId, props.relativePath, null),
          }}
        />
      ) : null}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
        {fileQuery.isPending && !fileQuery.data ? (
          <div className="p-4 text-sm text-muted-foreground">Loading file...</div>
        ) : fileQuery.isError ? (
          <WorkspaceFileFallback
            kind={activeFileError?.kind === "missing" ? "missing" : "unreadable"}
            title={activeFileError?.kind === "missing" ? "File not found" : "Unable to open file"}
            description={
              activeFileError?.kind === "missing"
                ? "This file no longer exists at the selected path."
                : "The workspace could not read this file."
            }
            details={activeFileError?.message}
            primaryAction={{ label: "Retry", onClick: handleRetry, loading: fileQuery.isFetching }}
          />
        ) : fileQuery.data?.isBinary ? (
          <WorkspaceFileFallback
            kind="binary"
            title="Binary files open read only"
            description="This file appears to contain binary data, so the workspace editor will not try to edit it as text."
            details={`${fileQuery.data.sizeBytes.toLocaleString()} bytes`}
          />
        ) : fileQuery.data?.isTooLarge ? (
          <WorkspaceFileFallback
            kind="tooLarge"
            title="File is too large to edit inline"
            description="The workspace editor caps editable text files at 1 MB to keep loading and typing predictable."
            details={`${fileQuery.data.sizeBytes.toLocaleString()} bytes on disk`}
          />
        ) : (
          <CodeMirrorEditor
            relativePath={props.relativePath}
            value={currentContents}
            resolvedTheme={props.resolvedTheme}
            onChange={(contents) =>
              setDraftContent(props.threadId, props.relativePath, {
                contents,
                baseContents: fileQuery.data?.contents ?? "",
              })
            }
            onSave={() => {
              void handleSave();
            }}
          />
        )}
      </div>
    </div>
  );
}
