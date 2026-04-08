import type { ThreadId } from "@t3tools/contracts";
import { BotIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { ChangedFilesTree } from "../chat/ChangedFilesTree";
import { Button } from "../ui/button";
import { WorkbenchEmptyState } from "./WorkbenchEmptyState";
import { deriveAiChangedFiles } from "~/lib/aiChangedFiles";
import type { Thread } from "~/types";

export function WorkspaceAiChangedFilesPane(props: {
  threadId: ThreadId;
  activeThread: Thread | null;
  selectedFilePath: string | null;
  theme: "light" | "dark";
  onOpenFile: (path: string) => void;
}) {
  const [allDirectoriesExpanded, setAllDirectoriesExpanded] = useState(false);
  const files = useMemo(
    () => deriveAiChangedFiles(props.activeThread?.turnDiffSummaries ?? []),
    [props.activeThread?.turnDiffSummaries],
  );

  if (files.length === 0) {
    return (
      <WorkbenchEmptyState
        icon={<BotIcon className="size-4" />}
        title="No AI changed files"
        description="Files changed by AI in this thread will appear here."
      />
    );
  }

  const treeTurnId = files[0]!.turnId;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            {files.length} {files.length === 1 ? "file" : "files"}
          </p>
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => setAllDirectoriesExpanded((expanded) => !expanded)}
          >
            {allDirectoriesExpanded ? "Collapse all" : "Expand all"}
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <ChangedFilesTree
          turnId={treeTurnId}
          files={files}
          allDirectoriesExpanded={allDirectoriesExpanded}
          resolvedTheme={props.theme}
          selectedFilePath={props.selectedFilePath}
          onSelectChangedFile={(_, filePath) => props.onOpenFile(filePath)}
        />
      </div>
    </div>
  );
}
