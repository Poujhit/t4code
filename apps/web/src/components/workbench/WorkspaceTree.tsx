import type { ProjectDirectoryEntry, ThreadId } from "@t3tools/contracts";
import { FolderTreeIcon } from "lucide-react";
import { WorkbenchEmptyState } from "./WorkbenchEmptyState";
import { WorkspaceTreeNode } from "./WorkspaceTreeNode";

export function WorkspaceTree(props: {
  entries: readonly ProjectDirectoryEntry[];
  truncated: boolean;
  isLoading: boolean;
  isError: boolean;
  threadId: ThreadId;
  workspaceRoot: string | null;
  theme: "light" | "dark";
}) {
  if (!props.workspaceRoot) {
    return (
      <WorkbenchEmptyState
        icon={<FolderTreeIcon className="size-4" />}
        title="Workspace unavailable"
        description="Open a thread with an active project to browse files."
      />
    );
  }

  if (props.isLoading) {
    return <div className="p-3 text-sm text-muted-foreground">Loading workspace...</div>;
  }

  if (props.isError) {
    return <div className="p-3 text-sm text-destructive">Unable to load the workspace tree.</div>;
  }

  if (props.entries.length === 0) {
    return (
      <WorkbenchEmptyState
        icon={<FolderTreeIcon className="size-4" />}
        title="Workspace is empty"
        description="No files or folders are available in this directory yet."
      />
    );
  }

  const workspaceRoot = props.workspaceRoot;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <ul className="space-y-0.5">
          {props.entries.map((entry) => (
            <WorkspaceTreeNode
              key={entry.path}
              entry={entry}
              threadId={props.threadId}
              workspaceRoot={workspaceRoot}
              depth={0}
              theme={props.theme}
            />
          ))}
        </ul>
      </div>
      {props.truncated ? (
        <div className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
          Showing first 1000 entries
        </div>
      ) : null}
    </div>
  );
}
