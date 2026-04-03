export interface TimelineDurationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  createdAt: string;
  completedAt?: string | undefined;
}

export function computeMessageDurationStart(
  messages: ReadonlyArray<TimelineDurationMessage>,
): Map<string, string> {
  const result = new Map<string, string>();
  let lastBoundary: string | null = null;

  for (const message of messages) {
    if (message.role === "user") {
      lastBoundary = message.createdAt;
    }
    result.set(message.id, lastBoundary ?? message.createdAt);
    if (message.role === "assistant" && message.completedAt) {
      lastBoundary = message.completedAt;
    }
  }

  return result;
}

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

interface ChangedFileLike {
  path: string;
}

export function defaultChangedFilePath(files: ReadonlyArray<ChangedFileLike>): string | null {
  return files[0]?.path ?? null;
}

export function resolveSelectedChangedFilePath(input: {
  turnId: string;
  files: ReadonlyArray<ChangedFileLike>;
  selectedFileByTurnId: Record<string, string>;
  activeDiffTurnId?: string | null;
  activeDiffFilePath?: string | null;
}): string | null {
  const paths = new Set(input.files.map((file) => file.path));
  const selectedFile = input.selectedFileByTurnId[input.turnId];
  if (selectedFile && paths.has(selectedFile)) {
    return selectedFile;
  }

  if (
    input.activeDiffTurnId === input.turnId &&
    input.activeDiffFilePath &&
    paths.has(input.activeDiffFilePath)
  ) {
    return input.activeDiffFilePath;
  }

  return defaultChangedFilePath(input.files);
}
