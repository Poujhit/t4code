import type { ThreadId } from "@t3tools/contracts";
import { XIcon } from "lucide-react";

import { ScrollArea } from "~/components/ui/scroll-area";
import { cn } from "~/lib/utils";
import { useWorkspaceWorkbenchStore, workspaceFileStateKey } from "~/workspaceWorkbenchStore";
import { basenameOfPath } from "~/vscode-icons";
import { VscodeEntryIcon } from "../chat/VscodeEntryIcon";

export function WorkspaceOpenFilesBar(props: {
  threadId: ThreadId;
  openFilePaths: readonly string[];
  activeFilePath: string | null;
  resolvedTheme: "light" | "dark";
}) {
  const openFile = useWorkspaceWorkbenchStore((state) => state.openFile);
  const closeFile = useWorkspaceWorkbenchStore((state) => state.closeFile);

  return (
    <div className="border-b border-border">
      <ScrollArea className="w-full" hideScrollbars>
        <div aria-label="Open files" className="flex min-w-max items-stretch" role="tablist">
          {props.openFilePaths.map((path) => (
            <WorkspaceOpenFileTab
              key={path}
              threadId={props.threadId}
              path={path}
              active={props.activeFilePath === path}
              resolvedTheme={props.resolvedTheme}
              onSelect={() => openFile(props.threadId, path)}
              onClose={() => closeFile(props.threadId, path)}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

function WorkspaceOpenFileTab(props: {
  threadId: ThreadId;
  path: string;
  active: boolean;
  resolvedTheme: "light" | "dark";
  onSelect: () => void;
  onClose: () => void;
}) {
  const isDirty = useWorkspaceWorkbenchStore(
    (state) =>
      state.isDirtyByThreadIdAndPath[workspaceFileStateKey(props.threadId, props.path)] ?? false,
  );
  const filename = basenameOfPath(props.path);

  return (
    <div
      className={cn(
        "group/tab flex h-11 items-stretch border-r border-border/80 first:border-l",
        props.active && "bg-accent/50 text-accent-foreground",
      )}
    >
      <button
        aria-selected={props.active}
        role="tab"
        type="button"
        className={cn(
          "flex min-w-0 items-center gap-2 px-3 text-sm transition-colors hover:bg-accent/50",
          props.active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
        )}
        onClick={props.onSelect}
        title={props.path}
      >
        <VscodeEntryIcon
          pathValue={props.path}
          kind="file"
          theme={props.resolvedTheme}
          className="size-4 shrink-0"
        />
        <span className="truncate">{filename}</span>
        {isDirty ? (
          <span
            aria-label={`${filename} has unsaved changes`}
            className="size-2 shrink-0 rounded-full bg-amber-500"
          />
        ) : null}
      </button>
      <button
        type="button"
        aria-label={`Close ${filename} tab`}
        className={cn(
          "flex shrink-0 items-center justify-center px-2 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground",
          props.active && "text-foreground/70",
        )}
        onClick={props.onClose}
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}
