import type { Thread, TurnDiffFileChange } from "~/types";

export interface AiChangedFileEntry extends TurnDiffFileChange {
  turnId: Thread["turnDiffSummaries"][number]["turnId"];
  checkpointTurnCount?: number | undefined;
  completedAt: string;
}

function compareTurnRecency(left: AiChangedFileEntry, right: AiChangedFileEntry): number {
  const leftTurnCount = left.checkpointTurnCount ?? Number.MIN_SAFE_INTEGER;
  const rightTurnCount = right.checkpointTurnCount ?? Number.MIN_SAFE_INTEGER;
  if (leftTurnCount !== rightTurnCount) {
    return rightTurnCount - leftTurnCount;
  }
  return right.completedAt.localeCompare(left.completedAt);
}

export function deriveAiChangedFiles(
  turnDiffSummaries: readonly Thread["turnDiffSummaries"][number][],
): AiChangedFileEntry[] {
  const latestByPath = new Map<string, AiChangedFileEntry>();

  for (const summary of turnDiffSummaries) {
    for (const file of summary.files) {
      const nextEntry: AiChangedFileEntry = {
        ...file,
        turnId: summary.turnId,
        checkpointTurnCount: summary.checkpointTurnCount,
        completedAt: summary.completedAt,
      };
      const current = latestByPath.get(file.path);
      if (!current || compareTurnRecency(nextEntry, current) < 0) {
        latestByPath.set(file.path, nextEntry);
      }
    }
  }

  return [...latestByPath.values()].toSorted((left, right) => {
    const recencyOrder = compareTurnRecency(left, right);
    return recencyOrder !== 0 ? recencyOrder : left.path.localeCompare(right.path);
  });
}
