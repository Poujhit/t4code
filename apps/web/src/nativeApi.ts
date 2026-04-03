import type { NativeApi } from "@t3tools/contracts";

import { __resetWsNativeApiForTests, createWsNativeApi } from "./wsNativeApi";

let cachedApi: NativeApi | undefined;

export function readNativeApi(): NativeApi | undefined {
  if (typeof window === "undefined") return undefined;
  if (window.nativeApi) {
    if (cachedApi === window.nativeApi) {
      return cachedApi;
    }
    cachedApi = window.nativeApi;
    return cachedApi;
  }

  if (cachedApi) return cachedApi;

  cachedApi = createWsNativeApi();
  return cachedApi;
}

export function ensureNativeApi(): NativeApi {
  const api = readNativeApi();
  if (!api) {
    throw new Error("Native API not found");
  }
  return api;
}

export function __resetNativeApiForTests() {
  cachedApi = undefined;
  __resetWsNativeApiForTests();
}
