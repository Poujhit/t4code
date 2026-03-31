import { ThreadId, type ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ChatHeader } from "./ChatHeader";
import { SidebarProvider } from "../ui/sidebar";

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];

describe("ChatHeader", () => {
  it("keeps the diff toggle and adds an independent workspace toggle", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider>
        <ChatHeader
          activeThreadId={ThreadId.makeUnsafe("thread-1")}
          activeThreadTitle="Thread"
          activeProjectName={undefined}
          isGitRepo
          openInCwd={null}
          activeProjectScripts={undefined}
          preferredScriptId={null}
          keybindings={EMPTY_KEYBINDINGS}
          availableEditors={[]}
          terminalAvailable
          terminalOpen={false}
          terminalToggleShortcutLabel={null}
          diffToggleShortcutLabel={null}
          workspaceAvailable
          workspaceOpen={false}
          gitCwd={null}
          diffOpen={false}
          onRunProjectScript={vi.fn()}
          onAddProjectScript={vi.fn(async () => {})}
          onUpdateProjectScript={vi.fn(async () => {})}
          onDeleteProjectScript={vi.fn(async () => {})}
          onToggleTerminal={vi.fn()}
          onToggleWorkspace={vi.fn()}
          onToggleDiff={vi.fn()}
        />
      </SidebarProvider>,
    );

    expect(html).toContain('aria-label="Toggle workspace pane"');
    expect(html).toContain('aria-label="Toggle diff panel"');
  });
});
