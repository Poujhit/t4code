import type { ThreadId } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { FolderTreeIcon, PanelRightOpenIcon, SearchIcon } from "lucide-react";
import { useTheme } from "~/hooks/useTheme";
import { projectListDirectoryQueryOptions } from "~/lib/projectReactQuery";
import type { CodeSelection } from "~/lib/workspaceCodeSelection";
import {
  selectWorkspacePaneMode,
  selectWorkspaceThreadState,
  useWorkspaceWorkbenchStore,
} from "~/workspaceWorkbenchStore";
import { Button } from "../ui/button";
import { WorkbenchEmptyState } from "./WorkbenchEmptyState";
import { WorkspaceEditor } from "./WorkspaceEditor";
import { WorkspaceSearchPane } from "./WorkspaceSearchPane";
import { WorkspaceTree } from "./WorkspaceTree";

export function WorkspaceWorkbench(props: {
  threadId: ThreadId;
  workspaceRoot: string | null;
  onAddCodeSelectionToPrompt?: ((selection: CodeSelection) => void) | null;
}) {
  const { resolvedTheme } = useTheme();
  const threadState = useWorkspaceWorkbenchStore((state) =>
    selectWorkspaceThreadState(state.threadStateByThreadId, props.threadId),
  );
  const paneMode = useWorkspaceWorkbenchStore((state) =>
    selectWorkspacePaneMode(state.paneModeByThreadId, props.threadId),
  );
  const activeFilePath = useWorkspaceWorkbenchStore(
    (state) => state.activeFilePathByThreadId[props.threadId] ?? null,
  );
  const setPaneMode = useWorkspaceWorkbenchStore((state) => state.setPaneMode);
  const focusSearchPane = useWorkspaceWorkbenchStore((state) => state.focusSearchPane);
  const rootQuery = useQuery(
    projectListDirectoryQueryOptions({
      cwd: props.workspaceRoot,
      relativePath: null,
      enabled: props.workspaceRoot !== null && paneMode === "files",
    }),
  );

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <PanelRightOpenIcon
            style={{ cursor: "pointer" }}
            className="size-4"
            onClick={() => {
              useWorkspaceWorkbenchStore.getState().setWorkspaceOpen(false);
            }}
          />
          <span>Workspace</span>
        </div>
        <p
          className="mt-1 truncate text-xs text-muted-foreground"
          title={props.workspaceRoot ?? ""}
        >
          {props.workspaceRoot ?? "No workspace root"}
        </p>
      </div>
      <div className="grid min-h-0 flex-1 overflow-hidden grid-cols-1 md:grid-cols-[minmax(15rem,18rem)_1fr]">
        <div className="min-h-0 overflow-hidden border-b border-border md:border-r md:border-b-0">
          <div className="flex h-full min-h-0 flex-col">
            <div className="border-b border-border px-2 py-2">
              <div className="flex gap-1">
                <Button
                  variant={paneMode === "files" ? "secondary" : "ghost"}
                  size="sm"
                  className="flex-1"
                  onClick={() => setPaneMode(props.threadId, "files")}
                >
                  <FolderTreeIcon className="size-4" />
                  Files
                </Button>
                <Button
                  variant={paneMode === "search" ? "secondary" : "ghost"}
                  size="sm"
                  className="flex-1"
                  onClick={() => focusSearchPane(props.threadId)}
                >
                  <SearchIcon className="size-4" />
                  Search
                </Button>
              </div>
            </div>
            <div className="min-h-0 flex-1">
              {paneMode === "search" ? (
                <WorkspaceSearchPane
                  threadId={props.threadId}
                  workspaceRoot={props.workspaceRoot}
                  theme={resolvedTheme}
                />
              ) : (
                <WorkspaceTree
                  entries={rootQuery.data?.entries ?? []}
                  truncated={rootQuery.data?.truncated ?? false}
                  isLoading={rootQuery.isPending}
                  isError={rootQuery.isError}
                  threadId={props.threadId}
                  workspaceRoot={props.workspaceRoot}
                  theme={resolvedTheme}
                />
              )}
            </div>
          </div>
        </div>
        <div className="flex min-h-0 min-w-0 flex-col overflow-hidden bg-background">
          {props.workspaceRoot && activeFilePath ? (
            <WorkspaceEditor
              threadId={props.threadId}
              workspaceRoot={props.workspaceRoot}
              relativePath={activeFilePath}
              resolvedTheme={resolvedTheme}
              {...(props.onAddCodeSelectionToPrompt !== undefined
                ? { onAddCodeSelectionToPrompt: props.onAddCodeSelectionToPrompt }
                : {})}
            />
          ) : (
            <WorkbenchEmptyState
              icon={<FolderTreeIcon className="size-4" />}
              title={threadState.selectedPath ? "Open a file" : "Select a file"}
              description="Choose a file from the tree to edit it here."
            />
          )}
        </div>
      </div>
    </div>
  );
}
