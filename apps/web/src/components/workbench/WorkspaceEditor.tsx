import { type ThreadId } from "@t3tools/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Compartment,
  EditorSelection,
  EditorState,
  RangeSetBuilder,
  Text,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  WidgetType,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  bracketMatching,
  codeFolding,
  foldGutter,
  foldKeymap,
  indentOnInput,
} from "@codemirror/language";
import { openSearchPanel, search } from "@codemirror/search";
import { css } from "@codemirror/lang-css";
import { go } from "@codemirror/lang-go";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { oneDark } from "@codemirror/theme-one-dark";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import { checkpointDiffQueryOptions } from "~/lib/providerReactQuery";
import {
  parseAiReviewHunksFromUnifiedDiff,
  type AiReviewHunk,
  type AiReviewLine,
} from "~/lib/aiReviewDiff";
import { readNativeApi } from "~/nativeApi";
import { basenameOfPath } from "~/vscode-icons";
import {
  projectReadFileQueryOptions,
  projectWriteFileMutationOptions,
} from "~/lib/projectReactQuery";
import {
  getSelectedLines,
  langForPath,
  lineLabel,
  type CodeSelection,
} from "~/lib/workspaceCodeSelection";
import { useTurnDiffSummaries } from "~/hooks/useTurnDiffSummaries";
import { useStore } from "~/store";
import {
  useWorkspaceWorkbenchStore,
  workspaceAiReviewKey,
  workspaceFileStateKey,
  type WorkspaceMatchRevealTarget,
} from "~/workspaceWorkbenchStore";
import { WorkspaceEditorHeader } from "./WorkspaceEditorHeader";
import { WorkspaceFileFallback } from "./WorkspaceFileFallback";
import { WorkspaceEditorMinimap } from "./WorkspaceEditorMinimap";
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
  const language = langForPath(relativePath);
  if (language === "tsx") return javascript({ jsx: true, typescript: true });
  if (language === "ts") return javascript({ typescript: true });
  if (language === "jsx") return javascript({ jsx: true });
  if (language === "js" || language === "json") return javascript();
  if (language === "md") return markdown();
  if (language === "css") return css();
  if (language === "html") return html();
  if (language === "py") return python();
  if (language === "go") return go();
  return null;
}

function foldExtensionsForPath(relativePath: string): Extension[] {
  if (!languageExtensionForPath(relativePath)) {
    return [];
  }

  return [
    codeFolding(),
    foldGutter({
      markerDOM(open) {
        const marker = document.createElement("span");
        marker.className = `cm-foldMarker ${open ? "cm-foldMarker-open" : "cm-foldMarker-closed"}`;
        marker.textContent = open ? "⌄" : "›";
        return marker;
      },
    }),
  ];
}

function readPrimarySelectionSnapshot(
  view: EditorView,
  relativePath: string,
): CodeSelection | null {
  const selected = getSelectedLines(view.state.doc, {
    from: view.state.selection.main.from,
    to: view.state.selection.main.to,
  });
  if (!selected) return null;
  return {
    ...selected,
    relativePath,
  } satisfies CodeSelection;
}

function clampLineNumber(doc: Text, lineNumber: number): number {
  return Math.max(1, Math.min(doc.lines, lineNumber));
}

function positionForLineAndColumn(doc: Text, lineNumber: number, column: number): number {
  const safeLine = clampLineNumber(doc, lineNumber);
  const line = doc.line(safeLine);
  const safeColumn = Math.max(1, Math.min(line.text.length + 1, column));
  return Math.min(line.to, line.from + safeColumn - 1);
}

function revealWorkspaceMatch(view: EditorView, target: WorkspaceMatchRevealTarget) {
  const from = positionForLineAndColumn(view.state.doc, target.lineNumber, target.startColumn);
  const to = positionForLineAndColumn(view.state.doc, target.lineNumber, target.endColumn);
  const rangeEnd = Math.max(from, to);
  const scroller = view.scrollDOM;
  view.dispatch({
    selection: EditorSelection.single(from, rangeEnd),
    effects: EditorView.scrollIntoView(from, { x: "center", y: "center" }),
  });

  const lineTop = view.lineBlockAt(from).top;
  const targetTop = Math.max(0, lineTop - scroller.clientHeight / 2);
  const startCoords = view.coordsAtPos(from);
  const endCoords = view.coordsAtPos(rangeEnd);
  if (!startCoords) {
    scroller.scrollTo({ top: targetTop });
    return;
  }

  const scrollerRect = scroller.getBoundingClientRect();
  const matchLeft = startCoords.left + scroller.scrollLeft - scrollerRect.left;
  const matchRight =
    (endCoords?.right ?? startCoords.right) + scroller.scrollLeft - scrollerRect.left;
  const targetLeft = Math.max(0, (matchLeft + matchRight) / 2 - scroller.clientWidth / 2);

  scroller.scrollTo({ top: targetTop, left: targetLeft });

  requestAnimationFrame(() => {
    const domNodeAtPos = view.domAtPos(from).node;
    const domElementAtPos =
      domNodeAtPos instanceof HTMLElement ? domNodeAtPos : domNodeAtPos.parentElement;

    domElementAtPos?.closest<HTMLElement>(".cm-line")?.scrollIntoView({ block: "center" });

    requestAnimationFrame(() => {
      const measuredStartCoords = view.coordsAtPos(from);
      const measuredEndCoords = view.coordsAtPos(rangeEnd);
      if (!measuredStartCoords) {
        return;
      }

      const scrollerRect = scroller.getBoundingClientRect();
      const centeredLeft =
        (measuredStartCoords.left + (measuredEndCoords?.right ?? measuredStartCoords.right)) / 2 +
        scroller.scrollLeft -
        scrollerRect.left -
        scroller.clientWidth / 2;

      scroller.scrollTo({
        top: scroller.scrollTop,
        left: Math.max(0, centeredLeft),
      });
    });
  });
}

const NOOP = () => {};
const EMPTY_HUNK_IDS: readonly string[] = Object.freeze([]);

function bindSearchPanelReplaceControls(root: HTMLElement): () => void {
  let currentCleanup = NOOP;

  const sync = () => {
    currentCleanup();

    const panel = root.querySelector<HTMLElement>(".cm-search");
    const replaceField = panel?.querySelector<HTMLInputElement>("input[name='replace']");
    const replaceButton = panel?.querySelector<HTMLButtonElement>("button[name='replace']");
    const replaceAllButton = panel?.querySelector<HTMLButtonElement>("button[name='replaceAll']");

    if (!panel || !replaceField || !replaceButton || !replaceAllButton) {
      currentCleanup = NOOP;
      return;
    }

    const update = () => {
      const disabled = replaceField.value.trim().length === 0;
      replaceButton.disabled = disabled;
      replaceAllButton.disabled = disabled;
    };

    update();
    replaceField.addEventListener("input", update);
    replaceField.addEventListener("change", update);
    currentCleanup = () => {
      replaceField.removeEventListener("input", update);
      replaceField.removeEventListener("change", update);
    };
  };

  sync();
  const observer = new MutationObserver(() => {
    sync();
  });
  observer.observe(root, {
    childList: true,
    subtree: true,
  });

  return () => {
    observer.disconnect();
    currentCleanup();
  };
}

function readLineRangeSelectionSnapshot(
  doc: Text,
  relativePath: string,
  startLine: number,
  endLine: number,
): CodeSelection {
  const safeStartLine = clampLineNumber(doc, startLine);
  const safeEndLine = clampLineNumber(doc, Math.max(startLine, endLine));
  const start = doc.line(safeStartLine);
  const end = doc.line(safeEndLine);
  return {
    relativePath,
    startLine: safeStartLine,
    endLine: safeEndLine,
    selectedText: doc.sliceString(start.from, end.to),
  } satisfies CodeSelection;
}

function areAiReviewHunksEqual(
  left: readonly AiReviewHunk[],
  right: readonly AiReviewHunk[],
): boolean {
  return (
    left.length === right.length &&
    left.every((hunk, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        hunk.id === other.id &&
        hunk.startLine === other.startLine &&
        hunk.endLine === other.endLine &&
        hunk.deletedLines.length === other.deletedLines.length &&
        hunk.deletedLines.every((line, lineIndex) => {
          const otherLine = other.deletedLines[lineIndex];
          return (
            otherLine !== undefined &&
            line.text === otherLine.text &&
            line.emphasizedRanges.length === otherLine.emphasizedRanges.length &&
            line.emphasizedRanges.every((range, rangeIndex) => {
              const otherRange = otherLine.emphasizedRanges[rangeIndex];
              return (
                otherRange !== undefined &&
                range.start === otherRange.start &&
                range.end === otherRange.end
              );
            })
          );
        }) &&
        hunk.addedLines.length === other.addedLines.length &&
        hunk.addedLines.every((line, lineIndex) => {
          const otherLine = other.addedLines[lineIndex];
          return (
            otherLine !== undefined &&
            line.text === otherLine.text &&
            line.emphasizedRanges.length === otherLine.emphasizedRanges.length &&
            line.emphasizedRanges.every((range, rangeIndex) => {
              const otherRange = otherLine.emphasizedRanges[rangeIndex];
              return (
                otherRange !== undefined &&
                range.start === otherRange.start &&
                range.end === otherRange.end
              );
            })
          );
        })
      );
    })
  );
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
        scrollbarWidth: "auto",
        scrollbarColor: "rgba(255, 255, 255, 0.1) transparent",
        backgroundColor: "var(--background)",
      },
      "& .cm-scroller::-webkit-scrollbar": {
        width: "10px",
        height: "10px",
      },
      "& .cm-scroller::-webkit-scrollbar-track": {
        background: "transparent",
      },
      "& .cm-scroller::-webkit-scrollbar-thumb": {
        background: "rgba(255, 255, 255, 0.1)",
        borderRadius: "999px",
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
      "& .cm-foldGutter": {
        width: "1.25rem",
      },
      "& .cm-foldGutter .cm-gutterElement": {
        padding: "0 2px 0 4px",
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
      "& .cm-foldMarker": {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: "14px",
        height: "14px",
        borderRadius: "3px",
        color: "var(--muted-foreground)",
        fontSize: "11px",
        lineHeight: "1",
      },
      "& .cm-gutterElement:hover .cm-foldMarker": {
        backgroundColor: "color-mix(in srgb, var(--accent) 80%, transparent)",
        color: "var(--foreground)",
      },
      "& .cm-foldPlaceholder": {
        border: "1px solid color-mix(in srgb, var(--border) 78%, transparent)",
        borderRadius: "4px",
        backgroundColor: "color-mix(in srgb, var(--card) 88%, var(--background))",
        color: "var(--muted-foreground)",
        padding: "0 6px",
      },
      "& .cm-ai-review-line": {
        backgroundColor: "color-mix(in srgb, var(--background) 80%, var(--primary) 20%)",
        boxShadow: "inset 3px 0 0 color-mix(in srgb, var(--primary) 72%, transparent)",
      },
      "& .cm-ai-review-inline-addition": {
        borderRadius: "3px",
        backgroundColor: "color-mix(in srgb, var(--background) 80%, var(--success) 20%)",
        boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--success) 30%, transparent)",
      },
      "& .cm-ai-review-deleted-block": {
        margin: "0",
        padding: "0 0 0 2px",
        backgroundColor: "color-mix(in srgb, var(--background) 84%, var(--destructive) 16%)",
        boxShadow: "inset 3px 0 0 color-mix(in srgb, var(--destructive) 70%, transparent)",
      },
      "& .cm-ai-review-deleted-line": {
        color: "color-mix(in srgb, var(--destructive) 84%, var(--foreground))",
        opacity: "0.95",
      },
      "& .cm-ai-review-inline-deletion": {
        borderRadius: "3px",
        backgroundColor: "color-mix(in srgb, var(--background) 82%, var(--destructive) 18%)",
        boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--destructive) 34%, transparent)",
      },
      "& .cm-ai-review-deleted-prefix": {
        display: "inline-block",
        width: "1ch",
        color: "color-mix(in srgb, var(--destructive) 92%, var(--foreground))",
      },
      "& .cm-ai-review-header": {
        margin: "0",
        padding: "0 0 6px 0",
      },
      "& .cm-ai-review-actions": {
        display: "flex",
        alignItems: "center",
        gap: "4px",
        padding: "0 0 6px 2px",
      },
      "& .cm-ai-review-range": {
        fontSize: "10px",
        lineHeight: "1",
        color: "var(--muted-foreground)",
        whiteSpace: "nowrap",
      },
      "& .cm-ai-review-button": {
        border: "1px solid color-mix(in srgb, var(--border) 80%, transparent)",
        borderRadius: "999px",
        backgroundColor: "color-mix(in srgb, var(--card) 90%, var(--background))",
        color: "var(--foreground)",
        fontSize: "10px",
        fontWeight: "600",
        lineHeight: "1",
        padding: "3px 7px",
        cursor: "pointer",
        whiteSpace: "nowrap",
      },
      "& .cm-ai-review-button:hover": {
        backgroundColor: "color-mix(in srgb, var(--card) 78%, var(--foreground))",
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
      "& .cm-panels": {
        backgroundColor: "color-mix(in srgb, var(--card) 98%, var(--background))",
        color: "var(--foreground)",
      },
      "& .cm-panels-top": {
        borderBottom: "1px solid color-mix(in srgb, var(--border) 78%, transparent)",
      },
      "& .cm-panels-bottom": {
        borderTop: "1px solid color-mix(in srgb, var(--border) 78%, transparent)",
      },
      "& .cm-panel": {
        backgroundColor: "color-mix(in srgb, var(--background) 94%, var(--card))",
        color: "var(--foreground)",
      },
      "& .cm-searchMatch": {
        borderRadius: "3px",
        backgroundColor: "color-mix(in srgb, #f59e0b 28%, transparent)",
        boxShadow: "inset 0 0 0 1px color-mix(in srgb, #f59e0b 46%, transparent)",
      },
      "& .cm-searchMatch.cm-searchMatch-selected": {
        backgroundColor: "color-mix(in srgb, var(--primary) 78%, var(--color-white) 8%)",
        color: "var(--primary-foreground)",
        boxShadow:
          "inset 0 0 0 1px color-mix(in srgb, var(--primary) 94%, var(--color-white) 12%), 0 0 0 1px color-mix(in srgb, var(--primary) 34%, transparent)",
      },
      "& .cm-search": {
        position: "relative",
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "6px",
        padding: "5px 8px 7px",
        paddingRight: "24px",
      },
      "& .cm-search > *": {
        margin: "0",
      },
      "& .cm-search input[name='search']": {
        order: 1,
        flex: "1 1 100%",
      },
      "& .cm-search button[name='next']": {
        order: 2,
      },
      "& .cm-search button[name='prev']": {
        order: 3,
      },
      "& .cm-search button[name='select']": {
        order: 4,
      },
      "& .cm-search label": {
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        fontSize: "12px",
        lineHeight: "1",
        color: "var(--muted-foreground)",
        whiteSpace: "nowrap",
      },
      "& .cm-search label:has(input[name='case'])": {
        order: 5,
      },
      "& .cm-search label:has(input[name='re'])": {
        order: 6,
      },
      "& .cm-search label:has(input[name='word'])": {
        order: 7,
      },
      "& .cm-search br": {
        order: 8,
        flexBasis: "100%",
        height: "0",
        content: '""',
      },
      "& .cm-search input[name='replace']": {
        order: 9,
        flex: "1 1 100%",
      },
      "& .cm-search button[name='replace']": {
        order: 10,
      },
      "& .cm-search button[name='replaceAll']": {
        order: 11,
      },
      "& .cm-search input[name='search'], & .cm-search input[name='replace']": {
        minWidth: "0",
        height: "24px",
        borderRadius: "0",
        border: "1px solid color-mix(in srgb, var(--primary) 22%, var(--border))",
        backgroundColor: "color-mix(in srgb, var(--background) 68%, var(--color-black))",
        color: "var(--foreground)",
        padding: "0 7px",
        boxSizing: "border-box",
        outline: "none",
        fontSize: "12px",
        lineHeight: "24px",
        boxShadow:
          "inset 0 1px 0 color-mix(in srgb, var(--color-white) 5%, transparent), 0 0 0 1px color-mix(in srgb, var(--primary) 8%, transparent)",
      },
      "& .cm-search input[name='search']:focus, & .cm-search input[name='replace']:focus": {
        borderColor: "color-mix(in srgb, var(--primary) 62%, var(--border))",
        boxShadow:
          "inset 0 1px 0 color-mix(in srgb, var(--color-white) 6%, transparent), 0 0 0 1px color-mix(in srgb, var(--primary) 32%, transparent)",
      },
      "& .cm-search input[name='search']::placeholder, & .cm-search input[name='replace']::placeholder":
        {
          color: "var(--muted-foreground)",
        },
      "& .cm-search input[type='checkbox']": {
        margin: "0",
        accentColor: "var(--primary)",
      },
      "& .cm-search button": {
        height: "24px",
        borderRadius: "0",
        border: "1px solid color-mix(in srgb, var(--border) 90%, transparent)",
        background:
          "linear-gradient(180deg, color-mix(in srgb, var(--card) 98%, var(--color-white)) 0%, color-mix(in srgb, var(--background) 88%, var(--color-black)) 100%)",
        color: "var(--foreground)",
        padding: "0 9px",
        fontSize: "11px",
        fontWeight: "600",
        lineHeight: "1",
        textTransform: "lowercase",
        cursor: "pointer",
        boxShadow: "inset 0 1px 0 color-mix(in srgb, var(--color-white) 6%, transparent)",
      },
      "& .cm-search button:hover": {
        background:
          "linear-gradient(180deg, color-mix(in srgb, var(--accent) 90%, var(--color-white)) 0%, color-mix(in srgb, var(--accent) 56%, var(--background)) 100%)",
      },
      "& .cm-search button:disabled": {
        opacity: "0.5",
        cursor: "default",
      },
      "& .cm-search button[name='close']": {
        position: "absolute",
        top: "5px",
        right: "6px",
        width: "16px",
        height: "16px",
        padding: "0",
        border: "none",
        backgroundColor: "transparent",
        color: "var(--muted-foreground)",
        textTransform: "none",
        fontSize: "13px",
        fontWeight: "500",
        boxShadow: "none",
      },
      "& .cm-search button[name='close']:hover": {
        backgroundColor: "color-mix(in srgb, var(--accent) 70%, transparent)",
        color: "var(--foreground)",
      },
    },
    { dark: true },
  );
}

function editorBehaviorExtensions(readOnly: boolean): Extension[] {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];
}

class ReviewHeaderWidget extends WidgetType {
  constructor(
    readonly hunkId: string,
    readonly selection: CodeSelection,
    readonly deletedLines: readonly AiReviewLine[],
    readonly onAccept: (hunkId: string) => void,
    readonly onAddToPrompt: (selection: CodeSelection) => void,
  ) {
    super();
  }

  override eq(other: ReviewHeaderWidget): boolean {
    return (
      this.hunkId === other.hunkId &&
      this.selection.startLine === other.selection.startLine &&
      this.selection.endLine === other.selection.endLine &&
      this.deletedLines.length === other.deletedLines.length &&
      this.deletedLines.every((line, index) => {
        const otherLine = other.deletedLines[index];
        return (
          otherLine !== undefined &&
          line.text === otherLine.text &&
          line.emphasizedRanges.length === otherLine.emphasizedRanges.length &&
          line.emphasizedRanges.every((range, rangeIndex) => {
            const otherRange = otherLine.emphasizedRanges[rangeIndex];
            return (
              otherRange !== undefined &&
              range.start === otherRange.start &&
              range.end === otherRange.end
            );
          })
        );
      })
    );
  }

  override toDOM() {
    const wrapper = document.createElement("div");
    wrapper.className = "cm-ai-review-header";

    const actions = document.createElement("div");
    actions.className = "cm-ai-review-actions";

    const range = document.createElement("span");
    range.className = "cm-ai-review-range";
    range.textContent = lineLabel(this.selection.startLine, this.selection.endLine);
    actions.append(range);

    const acceptButton = document.createElement("button");
    acceptButton.type = "button";
    acceptButton.className = "cm-ai-review-button";
    acceptButton.textContent = "Accept";
    acceptButton.setAttribute(
      "aria-label",
      `Accept AI hunk for ${lineLabel(this.selection.startLine, this.selection.endLine)}`,
    );
    acceptButton.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    acceptButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.onAccept(this.hunkId);
    });
    actions.append(acceptButton);

    const addToPromptButton = document.createElement("button");
    addToPromptButton.type = "button";
    addToPromptButton.className = "cm-ai-review-button";
    addToPromptButton.textContent = "Add to prompt";
    addToPromptButton.setAttribute(
      "aria-label",
      `Add AI hunk to prompt for ${lineLabel(this.selection.startLine, this.selection.endLine)}`,
    );
    addToPromptButton.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    addToPromptButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.onAddToPrompt(this.selection);
    });
    actions.append(addToPromptButton);
    wrapper.append(actions);

    if (this.deletedLines.length > 0) {
      wrapper.append(new DeletedLinesWidget(this.deletedLines).toDOM());
    }

    return wrapper;
  }
}

class DeletedLinesWidget extends WidgetType {
  constructor(readonly deletedLines: readonly AiReviewLine[]) {
    super();
  }

  override eq(other: DeletedLinesWidget): boolean {
    return (
      this.deletedLines.length === other.deletedLines.length &&
      this.deletedLines.every((line, index) => {
        const otherLine = other.deletedLines[index];
        return (
          otherLine !== undefined &&
          line.text === otherLine.text &&
          line.emphasizedRanges.length === otherLine.emphasizedRanges.length &&
          line.emphasizedRanges.every((range, rangeIndex) => {
            const otherRange = otherLine.emphasizedRanges[rangeIndex];
            return (
              otherRange !== undefined &&
              range.start === otherRange.start &&
              range.end === otherRange.end
            );
          })
        );
      })
    );
  }

  override toDOM() {
    const wrapper = document.createElement("div");
    wrapper.className = "cm-ai-review-deleted-block";
    for (const line of this.deletedLines) {
      const row = document.createElement("div");
      row.className = "cm-ai-review-deleted-line";
      const prefix = document.createElement("span");
      prefix.className = "cm-ai-review-deleted-prefix";
      prefix.textContent = "-";
      row.append(prefix);
      appendAiReviewLineContent(row, line, "cm-ai-review-inline-deletion");
      wrapper.append(row);
    }
    return wrapper;
  }
}

function appendAiReviewLineContent(
  parent: HTMLElement,
  line: AiReviewLine,
  emphasizedClassName: string,
) {
  let offset = 0;
  for (const range of line.emphasizedRanges) {
    const start = Math.max(offset, Math.min(line.text.length, range.start));
    const end = Math.max(start, Math.min(line.text.length, range.end));
    if (start > offset) {
      parent.append(document.createTextNode(line.text.slice(offset, start)));
    }
    if (end > start) {
      const span = document.createElement("span");
      span.className = emphasizedClassName;
      span.textContent = line.text.slice(start, end);
      parent.append(span);
    }
    offset = end;
  }
  if (offset < line.text.length) {
    parent.append(document.createTextNode(line.text.slice(offset)));
  }
}

function createAiReviewExtensions(params: {
  doc: Text;
  relativePath: string;
  reviewHunks: readonly AiReviewHunk[];
  onAcceptHunk: (hunkId: string) => void;
  onAddReviewHunkToPrompt: (selection: CodeSelection) => void;
}): Extension[] {
  if (params.reviewHunks.length === 0) {
    return [];
  }

  const decorations = new RangeSetBuilder<Decoration>();

  for (const hunk of params.reviewHunks) {
    const selection = readLineRangeSelectionSnapshot(
      params.doc,
      params.relativePath,
      hunk.startLine,
      hunk.endLine,
    );
    decorations.add(
      params.doc.line(selection.startLine).from,
      params.doc.line(selection.startLine).from,
      Decoration.widget({
        widget: new ReviewHeaderWidget(
          hunk.id,
          selection,
          hunk.deletedLines,
          params.onAcceptHunk,
          params.onAddReviewHunkToPrompt,
        ),
        block: true,
        side: -1,
      }),
    );
    for (let lineNumber = selection.startLine; lineNumber <= selection.endLine; lineNumber += 1) {
      decorations.add(
        params.doc.line(lineNumber).from,
        params.doc.line(lineNumber).from,
        Decoration.line({
          attributes: {
            class: "cm-ai-review-line",
          },
        }),
      );
      const addedLine = hunk.addedLines[lineNumber - selection.startLine];
      if (!addedLine) {
        continue;
      }
      const docLine = params.doc.line(lineNumber);
      for (const range of addedLine.emphasizedRanges) {
        const from = Math.min(docLine.to, docLine.from + range.start);
        const to = Math.min(docLine.to, docLine.from + range.end);
        if (to <= from) {
          continue;
        }
        decorations.add(from, to, Decoration.mark({ class: "cm-ai-review-inline-addition" }));
      }
    }
  }

  return [EditorView.decorations.of(decorations.finish())];
}

function createBaseEditorExtensions(params: {
  relativePath: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onAddSelectionToPrompt: (selection: CodeSelection) => void;
}) {
  return [
    oneDark,
    search({ top: true }),
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
      {
        key: "Mod-Shift-Enter",
        preventDefault: true,
        run: (view) => {
          const selection = readPrimarySelectionSnapshot(view, params.relativePath);
          if (!selection) {
            return false;
          }
          params.onAddSelectionToPrompt(selection);
          return true;
        },
      },
      indentWithTab,
      ...foldKeymap,
      ...defaultKeymap,
      ...historyKeymap,
    ]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        params.onChange(update.state.doc.toString());
      }
    }),
    EditorView.domEventHandlers({
      contextmenu: (event, view) => {
        const selection = readPrimarySelectionSnapshot(view, params.relativePath);
        if (!selection) {
          return false;
        }

        const api = readNativeApi();
        if (!api) {
          return false;
        }

        event.preventDefault();
        void api.contextMenu
          .show([{ id: "add-to-prompt", label: "Add to prompt" }], {
            x: event.clientX,
            y: event.clientY,
          })
          .then((clicked) => {
            if (clicked === "add-to-prompt") {
              params.onAddSelectionToPrompt(selection);
            }
          });
        return true;
      },
    }),
  ];
}

function CodeMirrorEditor(props: {
  relativePath: string;
  value: string;
  resolvedTheme: "light" | "dark";
  onChange: (value: string) => void;
  onSave: () => void;
  onAddSelectionToPrompt: (selection: CodeSelection) => void;
  readOnly?: boolean;
  reviewHunks?: readonly AiReviewHunk[];
  onAcceptReviewHunk?: ((hunkId: string) => void) | null;
  onAddReviewHunkToPrompt?: ((selection: CodeSelection) => void) | null;
  searchRequestKey?: number;
  onViewReady?: ((view: EditorView | null) => void) | null;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const initialRelativePathRef = useRef(props.relativePath);
  const initialValueRef = useRef(props.value);
  const [minimapView, setMinimapView] = useState<EditorView | null>(null);
  const foldCompartmentRef = useRef(new Compartment());
  const languageCompartmentRef = useRef(new Compartment());
  const themeCompartmentRef = useRef(new Compartment());
  const behaviorCompartmentRef = useRef(new Compartment());
  const reviewCompartmentRef = useRef(new Compartment());
  const onChangeEvent = useEffectEvent(props.onChange);
  const onSaveEvent = useEffectEvent(props.onSave);
  const onAddSelectionToPromptEvent = useEffectEvent(props.onAddSelectionToPrompt);
  const onAcceptReviewHunkEvent = useEffectEvent(props.onAcceptReviewHunk ?? (() => {}));
  const onAddReviewHunkToPromptEvent = useEffectEvent(props.onAddReviewHunkToPrompt ?? (() => {}));
  const onViewReadyEvent = useEffectEvent((view: EditorView | null) => {
    props.onViewReady?.(view);
  });

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    const state = EditorState.create({
      doc: initialValueRef.current,
      extensions: [
        foldCompartmentRef.current.of(foldExtensionsForPath(initialRelativePathRef.current)),
        lineNumbers(),
        highlightActiveLineGutter(),
        languageCompartmentRef.current.of(
          languageExtensionForPath(initialRelativePathRef.current)
            ? [languageExtensionForPath(initialRelativePathRef.current)!]
            : [],
        ),
        themeCompartmentRef.current.of(editorTheme("dark")),
        behaviorCompartmentRef.current.of(editorBehaviorExtensions(false)),
        reviewCompartmentRef.current.of([]),
        ...createBaseEditorExtensions({
          relativePath: initialRelativePathRef.current,
          onChange: (value) => onChangeEvent(value),
          onSave: () => onSaveEvent(),
          onAddSelectionToPrompt: (selection) => onAddSelectionToPromptEvent(selection),
        }),
      ],
    });
    const view = new EditorView({
      state,
      parent: containerRef.current,
    });
    viewRef.current = view;
    setMinimapView(view);
    onViewReadyEvent(view);
    return () => {
      view.destroy();
      viewRef.current = null;
      setMinimapView(null);
      onViewReadyEvent(null);
    };
  }, []);

  useEffect(() => {
    if (!containerRef.current || typeof MutationObserver === "undefined") {
      return;
    }

    return bindSearchPanelReplaceControls(containerRef.current);
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) {
      return;
    }
    const currentValue = view.state.doc.toString();
    const documentChanged = currentValue !== props.value;
    const nextDoc = documentChanged ? Text.of(props.value.split("\n")) : view.state.doc;
    const selection = view.state.selection.main;
    view.dispatch({
      ...(documentChanged
        ? {
            changes: { from: 0, to: currentValue.length, insert: props.value },
            selection: EditorSelection.cursor(Math.min(selection.head, props.value.length)),
          }
        : null),
      effects: [
        foldCompartmentRef.current.reconfigure(foldExtensionsForPath(props.relativePath)),
        languageCompartmentRef.current.reconfigure(
          languageExtensionForPath(props.relativePath)
            ? [languageExtensionForPath(props.relativePath)!]
            : [],
        ),
        themeCompartmentRef.current.reconfigure(editorTheme(props.resolvedTheme)),
        behaviorCompartmentRef.current.reconfigure(
          editorBehaviorExtensions(props.readOnly ?? false),
        ),
        reviewCompartmentRef.current.reconfigure(
          createAiReviewExtensions({
            doc: nextDoc,
            relativePath: props.relativePath,
            reviewHunks: props.reviewHunks ?? [],
            onAcceptHunk: (hunkId) => onAcceptReviewHunkEvent(hunkId),
            onAddReviewHunkToPrompt: (selection) => onAddReviewHunkToPromptEvent(selection),
          }),
        ),
      ],
    });
  }, [props.readOnly, props.relativePath, props.resolvedTheme, props.reviewHunks, props.value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !props.searchRequestKey) {
      return;
    }
    view.focus();
    openSearchPanel(view);
  }, [props.searchRequestKey]);

  return (
    <div className="workspace-editor-codemirror flex h-full min-h-0 min-w-0 flex-1 overflow-hidden bg-background">
      <div
        ref={containerRef}
        className="h-full min-h-0 min-w-0 flex-1 overflow-hidden bg-background"
      />
      <WorkspaceEditorMinimap
        value={props.value}
        resolvedTheme={props.resolvedTheme}
        view={minimapView}
        reviewHunks={props.reviewHunks ?? []}
      />
    </div>
  );
}

export function WorkspaceEditor(props: {
  threadId: ThreadId;
  workspaceRoot: string;
  relativePath: string;
  resolvedTheme: "light" | "dark";
  onAddCodeSelectionToPrompt?: ((selection: CodeSelection) => void) | null;
}) {
  const queryClient = useQueryClient();
  const draftKey = workspaceFileStateKey(props.threadId, props.relativePath);
  const bootstrapComplete = useStore((state) => state.bootstrapComplete);
  const activeThread = useStore(
    (state) => state.threads.find((thread) => thread.id === props.threadId) ?? null,
  );
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
  const aiReviewState = useWorkspaceWorkbenchStore(
    (state) => state.aiReviewStateByThreadIdAndPath[draftKey] ?? null,
  );
  const editorFindRequestKey = useWorkspaceWorkbenchStore(
    (state) => state.editorFindRequestKeyByThreadId[props.threadId] ?? 0,
  );
  const pendingRevealTarget = useWorkspaceWorkbenchStore(
    (state) => state.pendingRevealTargetByThreadId[props.threadId] ?? null,
  );
  const acceptedAiReviewHunksByKey = useWorkspaceWorkbenchStore(
    (state) => state.acceptedAiReviewHunksByKey,
  );
  const setAiReviewState = useWorkspaceWorkbenchStore((state) => state.setAiReviewState);
  const acceptAiReviewHunk = useWorkspaceWorkbenchStore((state) => state.acceptAiReviewHunk);
  const acceptAllAiReviewHunks = useWorkspaceWorkbenchStore(
    (state) => state.acceptAllAiReviewHunks,
  );
  const invalidateAiReviewState = useWorkspaceWorkbenchStore(
    (state) => state.invalidateAiReviewState,
  );
  const clearAiReviewState = useWorkspaceWorkbenchStore((state) => state.clearAiReviewState);
  const requestEditorFind = useWorkspaceWorkbenchStore((state) => state.requestEditorFind);
  const clearPendingRevealTarget = useWorkspaceWorkbenchStore(
    (state) => state.clearPendingRevealTarget,
  );
  const [isReloading, setIsReloading] = useState(false);
  const [editorView, setEditorView] = useState<EditorView | null>(null);
  const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } = useTurnDiffSummaries(
    activeThread ?? undefined,
  );

  const fileQuery = useQuery(
    projectReadFileQueryOptions({
      cwd: props.workspaceRoot,
      relativePath: props.relativePath,
    }),
  );
  const saveMutation = useMutation(projectWriteFileMutationOptions({ queryClient }));
  const latestAiReviewTurn = useMemo(() => {
    return (
      [...turnDiffSummaries]
        .filter(
          (summary) =>
            (summary.status === undefined || summary.status === "ready") &&
            summary.files.some((file) => file.path === props.relativePath),
        )
        .map((summary) => ({
          summary,
          turnCount:
            summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId],
        }))
        .filter(
          (
            entry,
          ): entry is {
            summary: (typeof turnDiffSummaries)[number];
            turnCount: number;
          } => typeof entry.turnCount === "number",
        )
        .toSorted((left, right) => {
          if (left.turnCount !== right.turnCount) {
            return right.turnCount - left.turnCount;
          }
          return right.summary.completedAt.localeCompare(left.summary.completedAt);
        })[0] ?? null
    );
  }, [inferredCheckpointTurnCountByTurnId, props.relativePath, turnDiffSummaries]);
  const persistedAcceptedAiReviewHunkIds = useMemo(() => {
    if (!latestAiReviewTurn) {
      return EMPTY_HUNK_IDS;
    }
    return (
      acceptedAiReviewHunksByKey[
        workspaceAiReviewKey(props.threadId, props.relativePath, latestAiReviewTurn.summary.turnId)
      ] ?? EMPTY_HUNK_IDS
    );
  }, [acceptedAiReviewHunksByKey, latestAiReviewTurn, props.relativePath, props.threadId]);
  const aiReviewDiffQuery = useQuery(
    checkpointDiffQueryOptions({
      threadId: props.threadId,
      fromTurnCount: latestAiReviewTurn ? Math.max(0, latestAiReviewTurn.turnCount - 1) : null,
      toTurnCount: latestAiReviewTurn?.turnCount ?? null,
      cacheScope: latestAiReviewTurn
        ? `workspace-ai-review:${props.threadId}:${props.relativePath}:${latestAiReviewTurn.summary.turnId}`
        : null,
      enabled: latestAiReviewTurn !== null,
    }),
  );
  const parsedAiReviewHunks = useMemo(() => {
    if (!aiReviewDiffQuery.data?.diff || !latestAiReviewTurn) {
      return [];
    }
    try {
      return parseAiReviewHunksFromUnifiedDiff(
        aiReviewDiffQuery.data.diff,
        props.relativePath,
        `workspace-ai-review:${props.threadId}:${props.relativePath}:${latestAiReviewTurn.summary.turnId}`,
      );
    } catch {
      return [];
    }
  }, [aiReviewDiffQuery.data?.diff, latestAiReviewTurn, props.relativePath, props.threadId]);

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

  const currentContents = draftContent ?? fileQuery.data?.contents ?? "";
  const latestDiskContents = fileQuery.data?.contents ?? "";
  const currentDraftMatchesDisk = currentContents === latestDiskContents;
  const isAwaitingAiReviewMetadata =
    aiReviewState !== null &&
    (!bootstrapComplete || activeThread === null) &&
    latestAiReviewTurn === null;

  useEffect(() => {
    if (!fileQuery.isSuccess || fileQuery.data.isBinary || fileQuery.data.isTooLarge) {
      if (aiReviewState !== null) {
        clearAiReviewState(props.threadId, props.relativePath);
      }
      return;
    }
    if (!latestAiReviewTurn) {
      if (isAwaitingAiReviewMetadata) {
        return;
      }
      if (aiReviewState !== null) {
        clearAiReviewState(props.threadId, props.relativePath);
      }
      return;
    }
    if (aiReviewDiffQuery.isPending) {
      return;
    }
    if (aiReviewDiffQuery.isError || parsedAiReviewHunks.length === 0) {
      if (aiReviewState !== null) {
        clearAiReviewState(props.threadId, props.relativePath);
      }
      return;
    }
    if (!currentDraftMatchesDisk) {
      if (
        aiReviewState?.turnId === latestAiReviewTurn.summary.turnId &&
        aiReviewState.status === "active"
      ) {
        invalidateAiReviewState(props.threadId, props.relativePath);
      }
      return;
    }

    if (aiReviewState?.turnId === latestAiReviewTurn.summary.turnId) {
      if (aiReviewState.status === "invalidated" || aiReviewState.status === "completed") {
        return;
      }
      if (
        aiReviewState.snapshotContents === fileQuery.data.contents &&
        areAiReviewHunksEqual(aiReviewState.hunks, parsedAiReviewHunks)
      ) {
        return;
      }
    }

    const acceptedHunkIdsSource =
      aiReviewState?.turnId === latestAiReviewTurn.summary.turnId
        ? aiReviewState.acceptedHunkIds
        : persistedAcceptedAiReviewHunkIds;
    const acceptedHunkIds = acceptedHunkIdsSource.filter((hunkId) =>
      parsedAiReviewHunks.some((hunk) => hunk.id === hunkId),
    );
    const allAccepted =
      parsedAiReviewHunks.length > 0 &&
      parsedAiReviewHunks.every((hunk) => acceptedHunkIds.includes(hunk.id));

    setAiReviewState(props.threadId, props.relativePath, {
      turnId: latestAiReviewTurn.summary.turnId,
      snapshotContents: fileQuery.data.contents,
      hunks: parsedAiReviewHunks,
      acceptedHunkIds,
      status: allAccepted ? "completed" : "active",
    });
  }, [
    aiReviewDiffQuery.isError,
    aiReviewDiffQuery.isPending,
    aiReviewState,
    activeThread,
    bootstrapComplete,
    clearAiReviewState,
    currentDraftMatchesDisk,
    fileQuery.data,
    fileQuery.isSuccess,
    invalidateAiReviewState,
    isAwaitingAiReviewMetadata,
    latestAiReviewTurn,
    parsedAiReviewHunks,
    persistedAcceptedAiReviewHunkIds,
    props.relativePath,
    props.threadId,
    setAiReviewState,
  ]);

  useEffect(() => {
    if (!fileQuery.isSuccess || !aiReviewState || aiReviewState.status !== "active") {
      return;
    }
    if (isAwaitingAiReviewMetadata) {
      return;
    }
    if (
      aiReviewState.turnId !== latestAiReviewTurn?.summary.turnId ||
      aiReviewState.snapshotContents !== fileQuery.data.contents
    ) {
      invalidateAiReviewState(props.threadId, props.relativePath);
    }
  }, [
    aiReviewState,
    isAwaitingAiReviewMetadata,
    fileQuery.data,
    fileQuery.isSuccess,
    invalidateAiReviewState,
    latestAiReviewTurn,
    props.relativePath,
    props.threadId,
  ]);

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

  const filename = basenameOfPath(props.relativePath);
  const pendingAiReviewHunks =
    aiReviewState?.status === "active"
      ? aiReviewState.hunks.filter((hunk) => !aiReviewState.acceptedHunkIds.includes(hunk.id))
      : [];
  const isAiReviewActive = pendingAiReviewHunks.length > 0;

  let readOnlyLabel: string | null = null;
  if (fileQuery.data?.isBinary) {
    readOnlyLabel = "Binary";
  } else if (fileQuery.data?.isTooLarge) {
    readOnlyLabel = "Read only";
  } else if (isAiReviewActive) {
    readOnlyLabel = "AI review";
  } else if (activeFileError && activeFileError.kind !== "conflict") {
    readOnlyLabel = "Unavailable";
  }
  const canOpenFind =
    !fileQuery.isPending &&
    !fileQuery.isError &&
    !fileQuery.data?.isBinary &&
    !fileQuery.data?.isTooLarge;
  const revealTargetForCurrentFile =
    pendingRevealTarget?.path === props.relativePath ? pendingRevealTarget : null;

  useEffect(() => {
    if (
      !editorView ||
      !revealTargetForCurrentFile ||
      !fileQuery.isSuccess ||
      fileQuery.data.isBinary ||
      fileQuery.data.isTooLarge
    ) {
      return;
    }

    let cancelled = false;
    let frameId = 0;
    let attempts = 0;

    const revealWhenReady = () => {
      if (cancelled) {
        return;
      }

      const scroller = editorView.scrollDOM;
      const hasLayout = scroller.clientHeight > 0 && scroller.clientWidth > 0;
      if (!hasLayout && attempts < 10) {
        attempts += 1;
        frameId = requestAnimationFrame(revealWhenReady);
        return;
      }

      editorView.focus();
      revealWorkspaceMatch(editorView, revealTargetForCurrentFile);
      clearPendingRevealTarget(props.threadId);
    };

    frameId = requestAnimationFrame(revealWhenReady);

    return () => {
      cancelled = true;
      cancelAnimationFrame(frameId);
    };
  }, [
    clearPendingRevealTarget,
    editorView,
    fileQuery.data,
    fileQuery.isSuccess,
    props.threadId,
    revealTargetForCurrentFile,
  ]);

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
        canAcceptAllAiChanges={isAiReviewActive}
        onAcceptAllAiChanges={() => acceptAllAiReviewHunks(props.threadId, props.relativePath)}
        canOpenFind={canOpenFind}
        onOpenFind={() => requestEditorFind(props.threadId)}
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
            key={props.relativePath}
            relativePath={props.relativePath}
            value={currentContents}
            resolvedTheme={props.resolvedTheme}
            readOnly={isAiReviewActive}
            reviewHunks={pendingAiReviewHunks}
            onAcceptReviewHunk={(hunkId) => {
              acceptAiReviewHunk(props.threadId, props.relativePath, hunkId);
            }}
            searchRequestKey={editorFindRequestKey}
            onViewReady={setEditorView}
            onAddReviewHunkToPrompt={(selection) => {
              props.onAddCodeSelectionToPrompt?.(selection);
            }}
            onAddSelectionToPrompt={(selection) => {
              props.onAddCodeSelectionToPrompt?.(selection);
            }}
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
