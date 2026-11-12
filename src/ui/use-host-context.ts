import { useEffect, useState } from "react";
import { useHostStyles, type App } from "@modelcontextprotocol/ext-apps/react";
import type { HostContext } from "./card-types.js";

/**
 * Tracks the host context and applies it to the document: theme, style variables and fonts through
 * the ext-apps hooks, and the safe-area insets as body padding.
 */
export function useHostContext(app: App | null): HostContext | undefined {
  const [hostContext, setHostContext] = useState<HostContext | undefined>(undefined);

  useHostStyles(app, app?.getHostContext());

  useEffect(() => {
    if (!app) return;
    setHostContext(app.getHostContext());
    const onChange = (changed: Partial<HostContext>) => {
      setHostContext((previous) => ({ ...previous, ...changed }) as HostContext);
    };
    app.addEventListener("hostcontextchanged", onChange);
    return () => app.removeEventListener("hostcontextchanged", onChange);
  }, [app]);

  const insets = hostContext?.safeAreaInsets;
  useEffect(() => {
    if (!insets) return;
    document.body.style.padding = `${insets.top}px ${insets.right}px ${insets.bottom}px ${insets.left}px`;
  }, [insets?.top, insets?.right, insets?.bottom, insets?.left]);

  return hostContext;
}
