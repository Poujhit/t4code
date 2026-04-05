import { describe, expect, it } from "vitest";

import { parseAiReviewHunksFromUnifiedDiff, type AiReviewLine } from "./aiReviewDiff";

function lineTexts(lines: readonly AiReviewLine[]): string[] {
  return lines.map((line) => line.text);
}

function emphasizedText(line: AiReviewLine): string[] {
  return line.emphasizedRanges.map((range) => line.text.slice(range.start, range.end));
}

describe("parseAiReviewHunksFromUnifiedDiff", () => {
  it("returns exact changed ranges for replacement hunks", () => {
    const diff = [
      "diff --git a/src/example.ts b/src/example.ts",
      "index 1111111..2222222 100644",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -1,4 +1,5 @@",
      " export function example() {",
      "-  return 1;",
      "+  const value = 2;",
      "+  return value;",
      " }",
      "",
    ].join("\n");

    const hunks = parseAiReviewHunksFromUnifiedDiff(diff, "src/example.ts", "test");

    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({
      id: "src/example.ts:0:0:2",
      startLine: 2,
      endLine: 3,
    });
    expect(lineTexts(hunks[0]!.deletedLines)).toEqual(["  return 1;"]);
    expect(lineTexts(hunks[0]!.addedLines)).toEqual(["  const value = 2;", "  return value;"]);
  });

  it("anchors deletion-only hunks to the nearest current line", () => {
    const diff = [
      "diff --git a/src/example.ts b/src/example.ts",
      "index 1111111..2222222 100644",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -2,2 +2,1 @@",
      " keep",
      "-remove one",
      "-remove two",
      "",
    ].join("\n");

    const hunks = parseAiReviewHunksFromUnifiedDiff(diff, "src/example.ts", "test");

    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({
      id: "src/example.ts:0:0:3",
      startLine: 3,
      endLine: 3,
    });
    expect(lineTexts(hunks[0]!.deletedLines)).toEqual(["remove one", "remove two"]);
    expect(lineTexts(hunks[0]!.addedLines)).toEqual([]);
  });

  it("supports multiple hunks in one file and ignores other files", () => {
    const diff = [
      "diff --git a/src/ignore.ts b/src/ignore.ts",
      "index 1111111..2222222 100644",
      "--- a/src/ignore.ts",
      "+++ b/src/ignore.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "diff --git a/src/example.ts b/src/example.ts",
      "index 3333333..4444444 100644",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -1,2 +1,2 @@",
      "-first",
      "+first changed",
      " second",
      "@@ -6,2 +6,3 @@",
      " six",
      "-seven",
      "+seven changed",
      "+eight",
      "",
    ].join("\n");

    const hunks = parseAiReviewHunksFromUnifiedDiff(diff, "src/example.ts", "test");

    expect(hunks).toHaveLength(2);
    expect(hunks.map((hunk) => hunk.id)).toEqual(["src/example.ts:0:0:1", "src/example.ts:1:0:7"]);
    expect(hunks.map((hunk) => [hunk.startLine, hunk.endLine])).toEqual([
      [1, 1],
      [7, 8],
    ]);
    expect(lineTexts(hunks[0]!.deletedLines)).toEqual(["first"]);
    expect(lineTexts(hunks[0]!.addedLines)).toEqual(["first changed"]);
    expect(lineTexts(hunks[1]!.deletedLines)).toEqual(["seven"]);
    expect(lineTexts(hunks[1]!.addedLines)).toEqual(["seven changed", "eight"]);
  });

  it("splits separate change segments inside one hunk instead of spanning unchanged context", () => {
    const diff = [
      "diff --git a/src/example.ts b/src/example.ts",
      "index 1111111..2222222 100644",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -183,7 +183,8 @@",
      "   ) : (",
      '-    <div className="flex justify-between items-center">',
      '+    <div className="flex justify-between items-start">',
      '       <h3 className="text-xl font-bold text-slate-100">Your Cover Letter</h3>',
      '-      <div className="flex space-x-3">',
      '+      <div className="flex flex-col items-end gap-2">',
      '+        <div className="flex space-x-3">',
      "           <button>",
      "             Copy",
      "           </button>",
      "",
    ].join("\n");

    const hunks = parseAiReviewHunksFromUnifiedDiff(diff, "src/example.ts", "test");

    expect(hunks).toHaveLength(2);
    expect(hunks.map((hunk) => [hunk.startLine, hunk.endLine])).toEqual([
      [184, 184],
      [186, 187],
    ]);
    expect(lineTexts(hunks[0]!.deletedLines)).toEqual([
      '    <div className="flex justify-between items-center">',
    ]);
    expect(lineTexts(hunks[0]!.addedLines)).toEqual([
      '    <div className="flex justify-between items-start">',
    ]);
    expect(lineTexts(hunks[1]!.deletedLines)).toEqual(['      <div className="flex space-x-3">']);
    expect(lineTexts(hunks[1]!.addedLines)).toEqual([
      '      <div className="flex flex-col items-end gap-2">',
      '        <div className="flex space-x-3">',
    ]);
  });

  it("mirrors the diff view word-level emphasis for replacement lines", () => {
    const diff = [
      "diff --git a/src/example.ts b/src/example.ts",
      "index 1111111..2222222 100644",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -1,3 +1,3 @@",
      "-const handleCopy = () => {",
      "-  if (coverLetter?.coverLetter) {",
      "+const handleCopy = async () => {",
      "+  if (!coverLetter?.coverLetter) return;",
      " }",
      "",
    ].join("\n");

    const hunks = parseAiReviewHunksFromUnifiedDiff(diff, "src/example.ts", "test");

    expect(hunks).toHaveLength(1);
    expect(emphasizedText(hunks[0]!.addedLines[0]!)).toEqual(["async "]);
    expect(emphasizedText(hunks[0]!.addedLines[1]!)).toContain("return;");
    expect(emphasizedText(hunks[0]!.deletedLines[1]!)).not.toContain("coverLetter?.coverLetter");
  });
});
