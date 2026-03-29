import type { DesktopBridge, NativeApi } from "@t3tools/contracts";

declare global {
  interface Window {
    desktopBridge?: DesktopBridge;
    nativeApi?: NativeApi;
  }
}
