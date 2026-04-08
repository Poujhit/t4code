import type { ThreadId } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { BotIcon, FolderTreeIcon, PanelRightOpenIcon, SearchIcon } from "lucide-react";
import { useTheme } from "~/hooks/useTheme";
import { projectListDirectoryQueryOptions } from "~/lib/projectReactQuery";
import type { CodeSelection } from "~/lib/workspaceCodeSelection";
import { useStore } from "~/store";
import {
  selectWorkspacePaneMode,
  selectWorkspaceThreadState,
  useWorkspaceWorkbenchStore,
} from "~/workspaceWorkbenchStore";
import { Button } from "../ui/button";
import { WorkbenchEmptyState } from "./WorkbenchEmptyState";
import { WorkspaceAiChangedFilesPane } from "./WorkspaceAiChangedFilesPane";
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
  const openFile = useWorkspaceWorkbenchStore((state) => state.openFile);
  const activeThread = useStore(
    (state) => state.threads.find((thread) => thread.id === props.threadId) ?? null,
  );
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
      <div className="grid min-h-0 flex-1 overflow-hidden grid-cols-[minmax(15rem,18rem)_1fr]">
        <div className="min-h-0 overflow-hidden border-r border-border">
          <div className="flex h-full min-h-0 flex-col">
            <div className="border-b border-border px-2 py-2">
              <div className="grid grid-cols-3 gap-1">
                <Button
                  variant={paneMode === "files" ? "secondary" : "ghost"}
                  size="sm"
                  className="flex h-12 min-w-0 flex-col items-center justify-center gap-1 px-1 text-[9px] leading-none"
                  aria-label="Files"
                  onClick={() => setPaneMode(props.threadId, "files")}
                >
                  <FolderTreeIcon className="size-3.5 shrink-0" />
                  <span className="min-w-0 whitespace-nowrap text-center">Files</span>
                </Button>
                <Button
                  variant={paneMode === "search" ? "secondary" : "ghost"}
                  size="sm"
                  className="flex h-12 min-w-0 flex-col items-center justify-center gap-1 px-1 text-[9px] leading-none"
                  aria-label="Search"
                  onClick={() => focusSearchPane(props.threadId)}
                >
                  <SearchIcon className="size-3.5 shrink-0" />
                  <span className="min-w-0 whitespace-nowrap text-center">Search</span>
                </Button>
                <Button
                  variant={paneMode === "ai-changed-files" ? "secondary" : "ghost"}
                  size="sm"
                  className="flex h-12 min-w-0 flex-col items-center justify-center gap-1 px-1 text-[9px] leading-none"
                  aria-label="AI Changes"
                  onClick={() => setPaneMode(props.threadId, "ai-changed-files")}
                >
                  <BotIcon className="size-3.5 shrink-0" />
                  <span className="min-w-0 whitespace-nowrap text-center">Changes</span>
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
              ) : paneMode === "ai-changed-files" ? (
                <WorkspaceAiChangedFilesPane
                  threadId={props.threadId}
                  activeThread={activeThread}
                  selectedFilePath={activeFilePath}
                  theme={resolvedTheme}
                  onOpenFile={(path) => openFile(props.threadId, path)}
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
