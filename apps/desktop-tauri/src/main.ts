import { invoke } from "@tauri-apps/api/core";

import { installDesktopBridge } from "./desktopBridge";
import { attachDragRegionAdapter } from "./dragRegionAdapter";
import "./styles.css";

type DesktopStateResponse = {
  wsUrl: string;
};

async function bootstrap(): Promise<void> {
  const desktopState = await invoke<DesktopStateResponse>("desktop_state");
  await installDesktopBridge(desktopState.wsUrl);
  attachDragRegionAdapter();
  await import("../../web/src/main");
}

void bootstrap().catch((error) => {
  const root = document.getElementById("root");
  if (!root) {
    throw error;
  }

  root.innerHTML = `<div style="padding:16px;font-family:system-ui,sans-serif">
    <h1 style="font-size:16px;margin:0 0 8px">t4code failed to start</h1>
    <pre style="white-space:pre-wrap;margin:0">${String(error instanceof Error ? error.message : error)}</pre>
  </div>`;
});
