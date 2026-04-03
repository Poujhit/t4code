import { AtomRegistry } from "effect/unstable/reactivity";
import { createContext, type ReactNode } from "react";

export let appAtomRegistry = AtomRegistry.make();
export const AppAtomRegistryContext = createContext(appAtomRegistry);

export function AppAtomRegistryProvider({ children }: { readonly children: ReactNode }) {
  return (
    <AppAtomRegistryContext.Provider value={appAtomRegistry}>
      {children}
    </AppAtomRegistryContext.Provider>
  );
}

export function resetAppAtomRegistryForTests() {
  appAtomRegistry.dispose();
  appAtomRegistry = AtomRegistry.make();
}
