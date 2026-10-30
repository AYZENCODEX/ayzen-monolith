import { useCallback, useEffect, useState } from "react";

/**
 * useSidebarCollapsed - Module Shell Split, Season 4.
 *
 * Shared collapse state for both sidebars (central + module). State is
 * stored in localStorage keyed per scope (module id or "central"), so each
 * subdomain keeps its own collapsed/expanded memory. Default expanded.
 * try/catch everywhere: private mode etc. just loses the memory.
 * Toggle with the header button or the [ keyboard shortcut.
 */
export function useSidebarCollapsed(scopeKey: string) {
  const storageKey = "ayzen.sidebar.collapsed." + scopeKey;
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(storageKey) === "1";
    } catch {
      return false;
    }
  });

  const toggle = useCallback(() => {
    setCollapsed((c) => {
      const next = !c;
      try {
        window.localStorage.setItem(storageKey, next ? "1" : "0");
      } catch {
        // best-effort
      }
      return next;
    });
  }, [storageKey]);

  // keyboard shortcut: [ toggles collapse (ignored while typing in inputs)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (e.key === "[") {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  return { collapsed, toggle };
}