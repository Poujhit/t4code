import { replaceTextRange } from "~/composer-logic";

export interface DocLine {
  number: number;
  from: number;
  to: number;
}

export interface DocLike {
  length: number;
  lineAt: (position: number) => DocLine;
  sliceString: (from: number, to: number) => string;
}

export interface CodeSelection {
  relativePath: string;
  startLine: number;
  endLine: number;
  selectedText: string;
}

const LANG_SUFFIXES = [
  [".tsx", "tsx"],
  [".ts", "ts"],
  [".jsx", "jsx"],
  [".json", "json"],
  [".js", "js"],
  [".mjs", "js"],
  [".cjs", "js"],
  [".md", "md"],
  [".mdx", "md"],
  [".css", "css"],
  [".scss", "css"],
  [".less", "css"],
  [".html", "html"],
  [".htm", "html"],
  [".py", "py"],
  [".go", "go"],
  [".rs", "rs"],
  [".java", "java"],
  [".rb", "rb"],
  [".php", "php"],
  [".sh", "sh"],
  [".bash", "sh"],
  [".zsh", "sh"],
  [".yml", "yaml"],
  [".yaml", "yaml"],
  [".sql", "sql"],
] as const;

function clamp(length: number, position: number): number {
  if (!Number.isFinite(position)) return length;
  return Math.max(0, Math.min(length, Math.floor(position)));
}

export function getSelectedLines(
  doc: DocLike,
  selection: { from: number; to: number },
): Omit<CodeSelection, "relativePath"> | null {
  const from = clamp(doc.length, Math.min(selection.from, selection.to));
  const to = clamp(doc.length, Math.max(selection.from, selection.to));
  if (from === to) return null;

  const start = doc.lineAt(from);
  const end = doc.lineAt(Math.max(from, to - 1));
  return {
    startLine: start.number,
    endLine: end.number,
    selectedText: doc.sliceString(start.from, end.to),
  };
}

export function lineLabel(startLine: number, endLine: number): string {
  return startLine === endLine ? `Line ${startLine}` : `Lines ${startLine}-${endLine}`;
}

export function selectionMention(
  selection: Pick<CodeSelection, "relativePath" | "startLine" | "endLine">,
): string {
  return `@${selection.relativePath}#L${selection.startLine}${
    selection.endLine === selection.startLine ? "" : `-${selection.endLine}`
  }`;
}

export function langForPath(relativePath: string): string {
  const lower = relativePath.toLowerCase();
  for (const [suffix, language] of LANG_SUFFIXES) {
    if (lower.endsWith(suffix)) return language;
  }
  return "";
}

export function buildInsert(
  prompt: string,
  text: string,
  expandedCursor: number | null | undefined,
): {
  rangeStart: number;
  rangeEnd: number;
  replacement: string;
} {
  const rangeStart =
    expandedCursor === null || expandedCursor === undefined
      ? prompt.length
      : clamp(prompt.length, expandedCursor);
  const before = prompt.slice(0, rangeStart);
  const after = prompt.slice(rangeStart);

  return {
    rangeStart,
    rangeEnd: rangeStart,
    replacement: `${before.length === 0 || /\s$/.test(before) ? "" : " "}${text}${
      after.length === 0 ? " " : /^\s/.test(after) ? "" : " "
    }`,
  };
}

export function insertSelection(
  prompt: string,
  text: string,
  expandedCursor: number | null | undefined,
): { text: string; cursor: number } & ReturnType<typeof buildInsert> {
  const insert = buildInsert(prompt, text, expandedCursor);
  const next = replaceTextRange(prompt, insert.rangeStart, insert.rangeEnd, insert.replacement);
  return {
    ...insert,
    text: next.text,
    cursor: next.cursor,
  };
}
