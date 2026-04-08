import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { ProjectTextSearchInput, ProjectTextSearchResult } from "./project";

const decodeTextSearchInput = Schema.decodeUnknownSync(ProjectTextSearchInput);
const decodeTextSearchResult = Schema.decodeUnknownSync(ProjectTextSearchResult);

describe("ProjectTextSearchInput", () => {
  it("decodes structured content-search requests", () => {
    const parsed = decodeTextSearchInput({
      cwd: "/repo",
      query: "needle",
      caseSensitive: false,
      wholeWord: true,
      regexp: false,
      includeGlobs: ["src/**/*.ts", "docs/**"],
      excludeGlobs: ["dist/**"],
      limit: 50,
    });

    expect(parsed.includeGlobs).toEqual(["src/**/*.ts", "docs/**"]);
    expect(parsed.excludeGlobs).toEqual(["dist/**"]);
    expect(parsed.wholeWord).toBe(true);
  });
});

describe("ProjectTextSearchResult", () => {
  it("decodes grouped per-file matches", () => {
    const parsed = decodeTextSearchResult({
      files: [
        {
          relativePath: "src/index.ts",
          matchCount: 2,
          matches: [
            {
              relativePath: "src/index.ts",
              lineNumber: 3,
              startColumn: 14,
              endColumn: 20,
              lineText: "export const needle = 1;",
              snippet: "export const needle = 1;",
            },
          ],
        },
      ],
      truncated: false,
    });

    expect(parsed.files[0]?.relativePath).toBe("src/index.ts");
    expect(parsed.files[0]?.matches[0]?.startColumn).toBe(14);
  });
});
