import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm as confirmDialog, open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { ContextMenuItem, DesktopBridge, DesktopTheme } from "@t3tools/contracts";

import { showContextMenuFallback } from "../../web/src/contextMenuFallback";

function normalizeTheme(theme: DesktopTheme): "light" | "dark" | null {
  if (theme === "system") {
    return null;
  }
  return theme;
}

export async function installDesktopBridge(wsUrl: string): Promise<void> {
  const appWindow = getCurrentWindow();

  const bridge: DesktopBridge = {
    getWsUrl: () => wsUrl,
    pickFolder: async () => {
      const selected = await openDialog({
        directory: true,
        multiple: false,
      });

      if (Array.isArray(selected)) {
        return typeof selected[0] === "string" ? selected[0] : null;
      }

      return typeof selected === "string" ? selected : null;
    },
    confirm: (message) =>
      confirmDialog(message, {
        title: "t4code",
      }),
    setTheme: async (theme) => {
      await appWindow.setTheme(normalizeTheme(theme));
    },
    showContextMenu: <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position?: { x: number; y: number },
    ) => showContextMenuFallback(items, position),
    openExternal: async (url: string) => {
      try {
        await openUrl(url);
        return true;
      } catch {
        return false;
      }
    },
    onMenuAction: () => () => undefined,
    getUpdateState: () => invoke("unsupported_bridge_method"),
    downloadUpdate: () => invoke("unsupported_bridge_method"),
    installUpdate: () => invoke("unsupported_bridge_method"),
    onUpdateState: () => () => undefined,
  };

  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    enumerable: false,
    writable: false,
    value: bridge,
  });
}
