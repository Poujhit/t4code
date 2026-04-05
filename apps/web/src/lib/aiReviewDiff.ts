import { parsePatchFiles, pushOrJoinSpan, type FileDiffMetadata } from "@pierre/diffs";
import { diffWordsWithSpace } from "diff";

export interface AiReviewInlineRange {
  start: number;
  end: number;
}

export interface AiReviewLine {
  text: string;
  emphasizedRanges: AiReviewInlineRange[];
}

export interface AiReviewHunk {
  id: string;
  startLine: number;
  endLine: number;
  deletedLines: AiReviewLine[];
  addedLines: AiReviewLine[];
}

function normalizeDiffPath(pathValue: string | undefined): string {
  if (!pathValue) {
    return "";
  }
  if (pathValue.startsWith("a/") || pathValue.startsWith("b/")) {
    return pathValue.slice(2);
  }
  return pathValue;
}

function resolveFilePath(file: FileDiffMetadata): string {
  return normalizeDiffPath(file.name || file.prevName);
}

function normalizePatchLine(line: string): string {
  return line.replace(/\n$/, "");
}

type InlineDiffSpan = [0 | 1, string];

function toInlineRanges(spans: readonly InlineDiffSpan[]): AiReviewInlineRange[] {
  const ranges: AiReviewInlineRange[] = [];
  let offset = 0;
  for (const [kind, value] of spans) {
    const start = offset;
    const end = offset + value.length;
    if (kind === 1 && end > start) {
      ranges.push({ start, end });
    }
    offset = end;
  }
  return ranges;
}

function buildInlineDiffRanges(
  deletionText: string,
  additionText: string,
): {
  deletionRanges: AiReviewInlineRange[];
  additionRanges: AiReviewInlineRange[];
} {
  const diffItems = diffWordsWithSpace(deletionText, additionText);
  const deletionSpans: InlineDiffSpan[] = [];
  const additionSpans: InlineDiffSpan[] = [];
  const lastItem = diffItems.at(-1);

  for (const item of diffItems) {
    const isLastItem = item === lastItem;
    if (!item.added && !item.removed) {
      pushOrJoinSpan({
        item,
        arr: deletionSpans,
        enableJoin: true,
        isNeutral: true,
        isLastItem,
      });
      pushOrJoinSpan({
        item,
        arr: additionSpans,
        enableJoin: true,
        isNeutral: true,
        isLastItem,
      });
      continue;
    }

    if (item.removed) {
      pushOrJoinSpan({
        item,
        arr: deletionSpans,
        enableJoin: true,
        isLastItem,
      });
      continue;
    }

    pushOrJoinSpan({
      item,
      arr: additionSpans,
      enableJoin: true,
      isLastItem,
    });
  }

  return {
    deletionRanges: toInlineRanges(deletionSpans),
    additionRanges: toInlineRanges(additionSpans),
  };
}

function measureLineSimilarity(left: string, right: string): number {
  const longest = Math.max(left.length, right.length, 1);
  const diffItems = diffWordsWithSpace(left, right);
  const unchangedLength = diffItems.reduce((total, item) => {
    if (item.added || item.removed) {
      return total;
    }
    return total + item.value.replace(/\s+/g, "").length;
  }, 0);
  return unchangedLength / longest;
}

function alignChangedLines(
  deletedLines: readonly string[],
  addedLines: readonly string[],
): Array<{ deletedIndex: number; addedIndex: number }> {
  if (deletedLines.length === 0 || addedLines.length === 0) {
    return [];
  }

  const pairScores = deletedLines.map((deletedLine) =>
    addedLines.map((addedLine) => measureLineSimilarity(deletedLine, addedLine)),
  );
  const scoreMatrix = Array.from({ length: deletedLines.length + 1 }, () =>
    Array<number>(addedLines.length + 1).fill(0),
  );
  const choiceMatrix = Array.from({ length: deletedLines.length + 1 }, () =>
    Array<"up" | "left" | "pair" | null>(addedLines.length + 1).fill(null),
  );

  for (let deletedIndex = 1; deletedIndex <= deletedLines.length; deletedIndex += 1) {
    for (let addedIndex = 1; addedIndex <= addedLines.length; addedIndex += 1) {
      let bestScore = scoreMatrix[deletedIndex - 1]![addedIndex]!;
      let bestChoice: "up" | "left" | "pair" = "up";

      const leftScore = scoreMatrix[deletedIndex]![addedIndex - 1]!;
      if (leftScore > bestScore) {
        bestScore = leftScore;
        bestChoice = "left";
      }

      const pairScore = pairScores[deletedIndex - 1]![addedIndex - 1]!;
      if (pairScore >= 0.2) {
        const diagonalScore = scoreMatrix[deletedIndex - 1]![addedIndex - 1]! + pairScore;
        if (diagonalScore > bestScore) {
          bestScore = diagonalScore;
          bestChoice = "pair";
        }
      }

      scoreMatrix[deletedIndex]![addedIndex] = bestScore;
      choiceMatrix[deletedIndex]![addedIndex] = bestChoice;
    }
  }

  const alignedPairs: Array<{ deletedIndex: number; addedIndex: number }> = [];
  let deletedIndex = deletedLines.length;
  let addedIndex = addedLines.length;

  while (deletedIndex > 0 && addedIndex > 0) {
    const choice = choiceMatrix[deletedIndex]![addedIndex];
    if (choice === "pair") {
      alignedPairs.push({
        deletedIndex: deletedIndex - 1,
        addedIndex: addedIndex - 1,
      });
      deletedIndex -= 1;
      addedIndex -= 1;
      continue;
    }
    if (choice === "left") {
      addedIndex -= 1;
      continue;
    }
    deletedIndex -= 1;
  }

  return alignedPairs.toReversed();
}

export function parseAiReviewHunksFromUnifiedDiff(
  diff: string,
  relativePath: string,
  cacheScope = "workspace-ai-review",
): AiReviewHunk[] {
  const normalizedDiff = diff.trim();
  if (normalizedDiff.length === 0) {
    return [];
  }

  const parsedPatches = parsePatchFiles(normalizedDiff, cacheScope);
  const file = parsedPatches
    .flatMap((parsedPatch) => parsedPatch.files)
    .find((entry) => resolveFilePath(entry) === relativePath);

  if (!file || file.hunks.length === 0) {
    return [];
  }

  const reviewHunks: AiReviewHunk[] = [];

  for (const [hunkIndex, hunk] of file.hunks.entries()) {
    let currentLine = Math.max(1, hunk.additionStart || 1);
    let deletionOffset = hunk.deletionLineIndex;
    let additionOffset = hunk.additionLineIndex;
    let changeIndex = 0;

    for (const segment of hunk.hunkContent) {
      if (segment.type === "context") {
        currentLine += segment.lines;
        deletionOffset += segment.lines;
        additionOffset += segment.lines;
        continue;
      }

      const deletedTexts =
        segment.deletions > 0
          ? file.deletionLines
              .slice(deletionOffset, deletionOffset + segment.deletions)
              .map(normalizePatchLine)
          : [];
      const addedTexts =
        segment.additions > 0
          ? file.additionLines
              .slice(additionOffset, additionOffset + segment.additions)
              .map(normalizePatchLine)
          : [];

      const deletedLines = deletedTexts.map<AiReviewLine>((text) => ({
        text,
        emphasizedRanges: [],
      }));
      const addedLines = addedTexts.map<AiReviewLine>((text) => ({
        text,
        emphasizedRanges: [],
      }));
      for (const { deletedIndex, addedIndex } of alignChangedLines(deletedTexts, addedTexts)) {
        const { deletionRanges, additionRanges } = buildInlineDiffRanges(
          deletedTexts[deletedIndex]!,
          addedTexts[addedIndex]!,
        );
        deletedLines[deletedIndex] = {
          text: deletedTexts[deletedIndex]!,
          emphasizedRanges: deletionRanges,
        };
        addedLines[addedIndex] = {
          text: addedTexts[addedIndex]!,
          emphasizedRanges: additionRanges,
        };
      }

      reviewHunks.push({
        id: `${relativePath}:${hunkIndex}:${changeIndex}:${currentLine}`,
        startLine: currentLine,
        endLine: segment.additions > 0 ? currentLine + segment.additions - 1 : currentLine,
        deletedLines,
        addedLines,
      });

      deletionOffset += segment.deletions;
      additionOffset += segment.additions;
      currentLine += segment.additions;
      changeIndex += 1;
    }
  }

  return reviewHunks;
}
