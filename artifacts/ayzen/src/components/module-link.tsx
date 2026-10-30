import { useCallback } from "react";
import { Link, useLocation } from "wouter";
import { getCurrentSubdomainApp, getModuleForPath, moduleUrl, centralUrl } from "@/lib/subdomain-app";

/**
 * components/module-link.tsx
 * Module Shell Split - Season 5.
 *
 * A link to another module route must go to that module subdomain
 * instead of bouncing home (the central host would scope-block it on a
 * module host, and a module host would scope-block it on central).
 *
 * ModuleLink: wouter Link (client-side, no reload) when the target
 * belongs to the module we are already on - or when the path is
 * central-only and we are on the central domain. Otherwise a plain
 * anchor full navigation to moduleUrl(id, href) (centralUrl for
 * central-only). Query strings and hash are preserved verbatim.
 *
 * useModuleNavigate: imperative counterpart for navigate() calls.
 */

export function moduleLinkProps(href: string): { to: string; href: string; crossOrigin: boolean; targetId: string | null } {
  const current = getCurrentSubdomainApp();
  const targetId = getModuleForPath(href);
  const crossOrigin = targetId !== null && targetId !== (current ? current.id : null);
  return { to: href, href: crossOrigin && targetId ? moduleUrl(targetId, href) : (current ? href : centralUrl(href)), crossOrigin, targetId };
}

export function ModuleLink({ href, className, children, onNavigate }: {
  href: string;
  className?: string;
  children: React.ReactNode;
  onNavigate?: () => void;
}) {
  const { crossOrigin, href: resolved } = moduleLinkProps(href);
  if (crossOrigin) {
    return (
      <a href={resolved} className={className} onClick={onNavigate}>
        {children}
      </a>
    );
  }
  return (
    <Link href={resolved} className={className} onClick={onNavigate}>
      {children}
    </Link>
  );
}

/** Imperative navigation that crosses module origins when needed. */
export function useModuleNavigate() {
  const [, baseNavigate] = useLocation();
  const current = getCurrentSubdomainApp();
  return useCallback((href: string) => {
    const targetId = getModuleForPath(href);
    const crossOrigin = targetId !== null && targetId !== (current ? current.id : null);
    if (crossOrigin && targetId) {
      window.location.assign(moduleUrl(targetId, href));
      return;
    }
    baseNavigate(href);
  }, [baseNavigate, current ? current.id : null]);
}

/** True when href points at a different module than the one we are on. */
export function isCrossModule(href: string): boolean {
  const current = getCurrentSubdomainApp();
  const targetId = getModuleForPath(href);
  return targetId !== null && targetId !== (current ? current.id : null);
}