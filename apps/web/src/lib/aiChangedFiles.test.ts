import { TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { deriveAiChangedFiles } from "./aiChangedFiles";

describe("deriveAiChangedFiles", () => {
  it("dedupes by path and keeps the most recent summary metadata", () => {
    const files = deriveAiChangedFiles([
      {
        turnId: TurnId.makeUnsafe("turn-1"),
        completedAt: "2026-04-05T10:01:00.000Z",
        checkpointTurnCount: 1,
        files: [
          { path: "README.md", additions: 1, deletions: 0 },
          { path: "src/index.ts", additions: 2, deletions: 1 },
        ],
      },
      {
        turnId: TurnId.makeUnsafe("turn-2"),
        completedAt: "2026-04-05T10:02:00.000Z",
        checkpointTurnCount: 2,
        files: [
          { path: "src/index.ts", additions: 5, deletions: 3 },
          { path: "src/feature.ts", additions: 4, deletions: 0 },
        ],
      },
    ]);

    expect(files).toEqual([
      {
        path: "src/feature.ts",
        additions: 4,
        deletions: 0,
        turnId: TurnId.makeUnsafe("turn-2"),
        checkpointTurnCount: 2,
        completedAt: "2026-04-05T10:02:00.000Z",
      },
      {
        path: "src/index.ts",
        additions: 5,
        deletions: 3,
        turnId: TurnId.makeUnsafe("turn-2"),
        checkpointTurnCount: 2,
        completedAt: "2026-04-05T10:02:00.000Z",
      },
      {
        path: "README.md",
        additions: 1,
        deletions: 0,
        turnId: TurnId.makeUnsafe("turn-1"),
        checkpointTurnCount: 1,
        completedAt: "2026-04-05T10:01:00.000Z",
      },
    ]);
  });
});
