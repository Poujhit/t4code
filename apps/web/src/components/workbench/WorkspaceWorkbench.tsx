import type { ThreadId } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { FileCode2Icon, FolderTreeIcon, PanelRightOpenIcon } from "lucide-react";
import { basenameOfPath } from "~/vscode-icons";
import { useTheme } from "~/hooks/useTheme";
import { projectListDirectoryQueryOptions } from "~/lib/projectReactQuery";
import { selectWorkspaceThreadState, useWorkspaceWorkbenchStore } from "~/workspaceWorkbenchStore";
import { WorkbenchEmptyState } from "./WorkbenchEmptyState";
import { WorkspaceTree } from "./WorkspaceTree";

export function WorkspaceWorkbench(props: { threadId: ThreadId; workspaceRoot: string | null }) {
  const { resolvedTheme } = useTheme();
  const threadState = useWorkspaceWorkbenchStore((state) =>
    selectWorkspaceThreadState(state.threadStateByThreadId, props.threadId),
  );
  const rootQuery = useQuery(
    projectListDirectoryQueryOptions({
      cwd: props.workspaceRoot,
      relativePath: null,
      enabled: props.workspaceRoot !== null,
    }),
  );

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-card text-card-foreground">
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <PanelRightOpenIcon style={{ cursor: 'pointer' }} className="size-4" onClick={() => {
            useWorkspaceWorkbenchStore.getState().setWorkspaceOpen(false);
          }} />
          <span>Workspace</span>
        </div>
        <p
          className="mt-1 truncate text-xs text-muted-foreground"
          title={props.workspaceRoot ?? ""}
        >
          {props.workspaceRoot ?? "No workspace root"}
        </p>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(15rem,18rem)_1fr]">
        <div className="min-h-0 border-b border-border md:border-r md:border-b-0">
          <WorkspaceTree
            entries={rootQuery.data?.entries ?? []}
            truncated={rootQuery.data?.truncated ?? false}
            isLoading={rootQuery.isPending}
            isError={rootQuery.isError}
            threadId={props.threadId}
            workspaceRoot={props.workspaceRoot}
            theme={resolvedTheme}
          />
        </div>
        <div className="min-h-0">
          {threadState.selectedPath ? (
            <div className="flex h-full min-h-0 flex-col">
              <div className="border-b border-border px-4 py-3">
                <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <FileCode2Icon className="size-4" />
                  <span className="truncate">{basenameOfPath(threadState.selectedPath)}</span>
                </div>
                <p
                  className="mt-1 truncate text-xs text-muted-foreground"
                  title={threadState.selectedPath}
                >
                  {threadState.selectedPath}
                </p>
              </div>
              <WorkbenchEmptyState
                icon={<FileCode2Icon className="size-4" />}
                title="Editor coming next"
                description="File browsing is ready. Inline editing and diffs will build on top of this pane next."
              />
            </div>
          ) : (
            <WorkbenchEmptyState
              icon={<FolderTreeIcon className="size-4" />}
              title="Select a file"
              description="Choose a file from the tree to preview its path here."
            />
          )}
        </div>
      </div>
    </div>
  );
}
