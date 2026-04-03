import { ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("./WorkspaceWorkbench", () => ({
  WorkspaceWorkbench: ({ workspaceRoot }: { workspaceRoot: string | null }) => (
    <div data-testid="workspace-workbench">{workspaceRoot ?? "no-root"}</div>
  ),
}));
vi.mock("../ui/sheet", () => ({
  Sheet: ({ children }: { children: ReactNode }) => <div data-slot="sheet">{children}</div>,
  SheetPopup: ({ children }: { children: ReactNode }) => (
    <div data-slot="sheet-popup">{children}</div>
  ),
}));

import { WorkspaceWorkbenchSurface } from "./WorkspaceWorkbenchSurface";

describe("WorkspaceWorkbenchSurface", () => {
  it("renders the workspace pane inside a right drawer on mobile", () => {
    const html = renderToStaticMarkup(
      <WorkspaceWorkbenchSurface
        mobile
        open
        threadId={ThreadId.makeUnsafe("thread-1")}
        workspaceRoot="/repo"
        onClose={vi.fn()}
        renderContent
      />,
    );

    expect(html).toContain('data-slot="sheet-popup"');
    expect(html).toContain("/repo");
    expect(html).not.toContain('aria-label="Resize workspace pane"');
  });

  it("renders the workspace pane inline on desktop", () => {
    const html = renderToStaticMarkup(
      <WorkspaceWorkbenchSurface
        mobile={false}
        open
        threadId={ThreadId.makeUnsafe("thread-1")}
        workspaceRoot="/repo"
        onClose={vi.fn()}
        renderContent
      />,
    );

    expect(html).toContain('data-testid="workspace-workbench-inline"');
    expect(html).toContain('aria-label="Resize workspace pane"');
    expect(html).not.toContain('data-slot="sheet-popup"');
  });
});
