import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { splitPromptIntoComposerSegments } from "../composer-editor-mentions";
import {
  buildInsert,
  getSelectedLines,
  langForPath,
  lineLabel,
  insertSelection,
  selectionMention,
} from "./workspaceCodeSelection";

describe("getSelectedLines", () => {
  it("expands a partial multi-line selection to full lines", () => {
    const doc = Text.of(["alpha", "beta", "gamma"]);

    expect(
      getSelectedLines(doc, {
        from: doc.line(1).from + 2,
        to: doc.line(2).from + 2,
      }),
    ).toEqual({
      startLine: 1,
      endLine: 2,
      selectedText: "alpha\nbeta",
    });
  });

  it("does not include the next line when the selection ends at its start", () => {
    const doc = Text.of(["alpha", "beta", "gamma"]);

    expect(
      getSelectedLines(doc, {
        from: doc.line(1).from,
        to: doc.line(2).from,
      }),
    ).toEqual({
      startLine: 1,
      endLine: 1,
      selectedText: "alpha",
    });
  });

  it("returns null for an empty selection", () => {
    const doc = Text.of(["alpha"]);

    expect(
      getSelectedLines(doc, {
        from: 0,
        to: 0,
      }),
    ).toBeNull();
  });
});

describe("lineLabel", () => {
  it("formats a single line label", () => {
    expect(lineLabel(12, 12)).toBe("Line 12");
  });

  it("formats a multi-line label", () => {
    expect(lineLabel(12, 28)).toBe("Lines 12-28");
  });
});

describe("langForPath", () => {
  it("infers known file extensions", () => {
    expect(langForPath("src/example.tsx")).toBe("tsx");
    expect(langForPath("README.md")).toBe("md");
    expect(langForPath("scripts/setup.sh")).toBe("sh");
    expect(langForPath("scripts/tool.py")).toBe("py");
    expect(langForPath("cmd/server/main.go")).toBe("go");
  });

  it("returns an empty language tag when no mapping is known", () => {
    expect(langForPath("notes.unknownext")).toBe("");
  });
});

describe("formatSelection", () => {
  it("formats the selected code snippet as one combined mention token", () => {
    expect(
      selectionMention({
        relativePath: "src/example.ts",
        startLine: 2,
        endLine: 4,
      }),
    ).toBe("@src/example.ts#L2-4");
  });
});

describe("insertSelection", () => {
  const snippet = selectionMention({
    relativePath: "src/example.ts",
    startLine: 1,
    endLine: 2,
  });

  it("inserts at the current cursor by default", () => {
    expect(insertSelection("Before after", snippet, "Before".length)).toMatchObject({
      text: `Before ${snippet} after`,
      cursor: `Before ${snippet}`.length,
    });
  });

  it("appends at the end when the cursor is unavailable", () => {
    expect(insertSelection("Before", snippet, null)).toMatchObject({
      text: `Before ${snippet} `,
      cursor: `Before ${snippet} `.length,
    });
  });

  it("keeps inserted mentions valid for existing composer mention rendering", () => {
    const inserted = insertSelection("Review this", snippet, null);

    expect(splitPromptIntoComposerSegments(inserted.text)).toContainEqual(
      expect.objectContaining({
        type: "mention",
        path: "src/example.ts",
        lineStart: 1,
        lineEnd: 2,
      }),
    );
  });
});

describe("selectionMention", () => {
  it("encodes single-line and multi-line selections into one mention token", () => {
    expect(
      selectionMention({
        relativePath: "src/example.ts",
        startLine: 12,
        endLine: 12,
      }),
    ).toBe("@src/example.ts#L12");
    expect(
      selectionMention({
        relativePath: "src/example.ts",
        startLine: 12,
        endLine: 28,
      }),
    ).toBe("@src/example.ts#L12-28");
  });
});

describe("buildInsert", () => {
  it("adds minimal spacing around inserted selection mentions", () => {
    expect(buildInsert("Before after", "@src/example.ts#L1", "Before".length)).toEqual({
      rangeStart: "Before".length,
      rangeEnd: "Before".length,
      replacement: " @src/example.ts#L1",
    });
  });
});
