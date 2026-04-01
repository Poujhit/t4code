import {
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  type TerminalContextDraft,
} from "./lib/terminalContext";
import { selectionMention } from "./lib/workspaceCodeSelection";

export type ComposerPromptSegment =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "mention";
      path: string;
      tokenText: string;
      lineStart?: number;
      lineEnd?: number;
    }
  | {
      type: "terminal-context";
      context: TerminalContextDraft | null;
    };

const MENTION_TOKEN_REGEX = /(^|\s)@([^\s@]+)(?=\s)/g;

function parseMentionToken(tokenText: string): {
  path: string;
  tokenText: string;
  lineStart?: number;
  lineEnd?: number;
} {
  const normalizedToken = tokenText.startsWith("@") ? tokenText.slice(1) : tokenText;
  const lineRefMatch = /^(.*)#L(\d+)(?:-(\d+))?$/.exec(normalizedToken);
  if (!lineRefMatch) {
    return {
      path: normalizedToken,
      tokenText: `@${normalizedToken}`,
    };
  }

  const path = lineRefMatch[1] ?? normalizedToken;
  const startLine = Number.parseInt(lineRefMatch[2] ?? "", 10);
  const endLine = Number.parseInt(lineRefMatch[3] ?? lineRefMatch[2] ?? "", 10);
  if (!path || !Number.isFinite(startLine) || !Number.isFinite(endLine)) {
    return {
      path: normalizedToken,
      tokenText: `@${normalizedToken}`,
    };
  }

  return {
    path,
    tokenText: selectionMention({ relativePath: path, startLine, endLine }),
    lineStart: startLine,
    lineEnd: endLine,
  };
}

function pushTextSegment(segments: ComposerPromptSegment[], text: string): void {
  if (!text) return;
  const last = segments[segments.length - 1];
  if (last && last.type === "text") {
    last.text += text;
    return;
  }
  segments.push({ type: "text", text });
}

function splitPromptTextIntoComposerSegments(text: string): ComposerPromptSegment[] {
  const segments: ComposerPromptSegment[] = [];
  if (!text) {
    return segments;
  }

  let cursor = 0;
  for (const match of text.matchAll(MENTION_TOKEN_REGEX)) {
    const fullMatch = match[0];
    const prefix = match[1] ?? "";
    const rawToken = match[2] ?? "";
    const matchIndex = match.index ?? 0;
    const mentionStart = matchIndex + prefix.length;
    const mentionEnd = mentionStart + fullMatch.length - prefix.length;

    if (mentionStart > cursor) {
      pushTextSegment(segments, text.slice(cursor, mentionStart));
    }

    if (rawToken.length > 0) {
      segments.push({ type: "mention", ...parseMentionToken(`@${rawToken}`) });
    } else {
      pushTextSegment(segments, text.slice(mentionStart, mentionEnd));
    }

    cursor = mentionEnd;
  }

  if (cursor < text.length) {
    pushTextSegment(segments, text.slice(cursor));
  }

  return segments;
}

export function splitPromptIntoComposerSegments(
  prompt: string,
  terminalContexts: ReadonlyArray<TerminalContextDraft> = [],
): ComposerPromptSegment[] {
  if (!prompt) {
    return [];
  }

  const segments: ComposerPromptSegment[] = [];
  let textCursor = 0;
  let terminalContextIndex = 0;

  for (let index = 0; index < prompt.length; index += 1) {
    if (prompt[index] !== INLINE_TERMINAL_CONTEXT_PLACEHOLDER) {
      continue;
    }

    if (index > textCursor) {
      segments.push(...splitPromptTextIntoComposerSegments(prompt.slice(textCursor, index)));
    }
    segments.push({
      type: "terminal-context",
      context: terminalContexts[terminalContextIndex] ?? null,
    });
    terminalContextIndex += 1;
    textCursor = index + 1;
  }

  if (textCursor < prompt.length) {
    segments.push(...splitPromptTextIntoComposerSegments(prompt.slice(textCursor)));
  }

  return segments;
}
