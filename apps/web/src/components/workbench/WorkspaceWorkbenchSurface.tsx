import type { ThreadId } from "@t3tools/contracts";
import {
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Sheet, SheetPopup } from "../ui/sheet";
import { cn } from "~/lib/utils";
import { clampWorkspacePaneWidth, useWorkspaceWorkbenchStore } from "~/workspaceWorkbenchStore";
import { WorkspaceWorkbench } from "./WorkspaceWorkbench";

export function WorkspaceWorkbenchSurface(props: {
  mobile: boolean;
  open: boolean;
  threadId: ThreadId;
  workspaceRoot: string | null;
  onClose: () => void;
  renderContent: boolean;
}) {
  const desktopWidth = useWorkspaceWorkbenchStore((state) => state.workspacePaneWidth);
  const setWorkspacePaneWidth = useWorkspaceWorkbenchStore((state) => state.setWorkspacePaneWidth);
  const clampWorkspacePaneWidthToViewport = useWorkspaceWorkbenchStore(
    (state) => state.clampWorkspacePaneWidthToViewport,
  );
  const clampedDesktopWidth = clampWorkspacePaneWidth(desktopWidth);
  const [isResizing, setIsResizing] = useState(false);

  useEffect(() => {
    if (props.mobile) {
      return;
    }
    clampWorkspacePaneWidthToViewport();
    window.addEventListener("resize", clampWorkspacePaneWidthToViewport);
    return () => {
      window.removeEventListener("resize", clampWorkspacePaneWidthToViewport);
    };
  }, [clampWorkspacePaneWidthToViewport, props.mobile]);
  const startResize = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (props.mobile || event.button !== 0) {
        return;
      }

      event.preventDefault();
      const startX = event.clientX;
      const startWidth = clampedDesktopWidth;
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      setIsResizing(true);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const handlePointerMove = (moveEvent: PointerEvent) => {
        setWorkspacePaneWidth(startWidth + (startX - moveEvent.clientX));
      };

      const finishResize = () => {
        setIsResizing(false);
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", finishResize);
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", finishResize, { once: true });
    },
    [clampedDesktopWidth, props.mobile, setWorkspacePaneWidth],
  );

  if (props.mobile) {
    return (
      <Sheet
        open={props.open}
        onOpenChange={(open) => {
          if (!open) {
            props.onClose();
          }
        }}
      >
        <SheetPopup
          side="right"
          showCloseButton={false}
          keepMounted
          className="w-[min(92vw,960px)] max-w-[960px] p-0"
        >
          {props.renderContent ? (
            <WorkspaceWorkbench threadId={props.threadId} workspaceRoot={props.workspaceRoot} />
          ) : null}
        </SheetPopup>
      </Sheet>
    );
  }

  if (!props.renderContent) {
    return null;
  }

  return (
    <div
      className="group/workspace hidden min-h-0 flex-none text-foreground md:block"
      data-slot="workspace-workbench"
      data-resizing={isResizing ? "true" : "false"}
      data-state={props.open ? "expanded" : "collapsed"}
      data-testid="workspace-workbench-inline"
      style={{ "--workspace-pane-width": `${clampedDesktopWidth}px` } as CSSProperties}
    >
      <div
        className={cn(
          "relative w-[var(--workspace-pane-width)] bg-transparent transition-[width] duration-200 ease-linear group-data-[state=collapsed]/workspace:w-0",
          isResizing && "transition-none",
        )}
        data-slot="workspace-workbench-gap"
      >
        <div
          className={cn(
            "absolute inset-y-0 right-0 flex h-dvh w-[var(--workspace-pane-width)] min-h-0 min-w-0 flex-col overflow-hidden border-l border-border bg-card text-foreground transition-transform duration-200 ease-linear group-data-[state=collapsed]/workspace:translate-x-full",
            isResizing && "transition-none",
          )}
          data-slot="workspace-workbench-panel"
        >
          <button
            type="button"
            aria-label="Resize workspace pane"
            className="absolute inset-y-0 left-0 z-10 w-4 -translate-x-1/2 cursor-col-resize bg-transparent"
            onPointerDown={startResize}
            title="Drag to resize workspace pane"
          />
          <WorkspaceWorkbench threadId={props.threadId} workspaceRoot={props.workspaceRoot} />
        </div>
      </div>
    </div>
  );
}
