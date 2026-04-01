import type { ProjectDirectoryEntry, ThreadId } from "@t3tools/contracts";
import { useQuery } from "@tanstack/react-query";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { projectListDirectoryQueryOptions } from "~/lib/projectReactQuery";
import { cn } from "~/lib/utils";
import { selectWorkspaceThreadState, useWorkspaceWorkbenchStore } from "~/workspaceWorkbenchStore";
import { VscodeEntryIcon } from "../chat/VscodeEntryIcon";

export function WorkspaceTreeNode(props: {
  entry: ProjectDirectoryEntry;
  threadId: ThreadId;
  workspaceRoot: string;
  depth: number;
  theme: "light" | "dark";
}) {
  const expanded = useWorkspaceWorkbenchStore((state) =>
    selectWorkspaceThreadState(
      state.threadStateByThreadId,
      props.threadId,
    ).expandedDirectoryPaths.includes(props.entry.path),
  );
  const selectedPath = useWorkspaceWorkbenchStore(
    (state) => selectWorkspaceThreadState(state.threadStateByThreadId, props.threadId).selectedPath,
  );
  const openFile = useWorkspaceWorkbenchStore((state) => state.openFile);
  const setDirectoryExpanded = useWorkspaceWorkbenchStore((state) => state.setDirectoryExpanded);
  const childrenQuery = useQuery(
    projectListDirectoryQueryOptions({
      cwd: props.workspaceRoot,
      relativePath: props.entry.kind === "directory" ? props.entry.path : null,
      enabled: props.entry.kind === "directory" && expanded,
    }),
  );
  const isSelected = selectedPath === props.entry.path;
  const isDirectory = props.entry.kind === "directory";

  return (
    <li className="min-w-0">
      <button
        type="button"
        className={cn(
          "flex w-full min-w-0 items-center gap-1 rounded-md px-2 py-1 text-left text-sm transition-colors hover:bg-accent/60",
          isSelected && "bg-accent text-accent-foreground",
        )}
        style={{ paddingLeft: `${props.depth * 0.75 + 0.5}rem` }}
        onClick={() => {
          if (isDirectory) {
            setDirectoryExpanded(props.threadId, props.entry.path, !expanded);
            return;
          }
          openFile(props.threadId, props.entry.path);
        }}
      >
        <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
          {isDirectory ? (
            expanded ? (
              <ChevronDownIcon className="size-3.5" />
            ) : (
              <ChevronRightIcon className="size-3.5" />
            )
          ) : null}
        </span>
        <VscodeEntryIcon
          pathValue={props.entry.path}
          kind={props.entry.kind}
          theme={props.theme}
          className="size-4"
        />
        <span className="truncate">{props.entry.name}</span>
      </button>
      {isDirectory && expanded ? (
        <div className="min-w-0">
          {childrenQuery.isPending ? (
            <div
              className="px-2 py-1 text-xs text-muted-foreground"
              style={{ paddingLeft: `${(props.depth + 1) * 0.75 + 1.5}rem` }}
            >
              Loading...
            </div>
          ) : childrenQuery.isError ? (
            <div
              className="px-2 py-1 text-xs text-destructive"
              style={{ paddingLeft: `${(props.depth + 1) * 0.75 + 1.5}rem` }}
            >
              Unable to load directory
            </div>
          ) : (
            <ul className="min-w-0">
              {childrenQuery.data.entries.map((child) => (
                <WorkspaceTreeNode
                  key={child.path}
                  entry={child}
                  threadId={props.threadId}
                  workspaceRoot={props.workspaceRoot}
                  depth={props.depth + 1}
                  theme={props.theme}
                />
              ))}
              {childrenQuery.data.entries.length === 0 ? (
                <li
                  className="px-2 py-1 text-xs text-muted-foreground"
                  style={{ paddingLeft: `${(props.depth + 1) * 0.75 + 1.5}rem` }}
                >
                  Empty directory
                </li>
              ) : null}
              {childrenQuery.data.truncated ? (
                <li
                  className="px-2 py-1 text-xs text-muted-foreground"
                  style={{ paddingLeft: `${(props.depth + 1) * 0.75 + 1.5}rem` }}
                >
                  Showing first 1000 entries
                </li>
              ) : null}
            </ul>
          )}
        </div>
      ) : null}
    </li>
  );
}
