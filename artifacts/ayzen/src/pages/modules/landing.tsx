/**
 * pages/modules/landing.tsx — W2-P4 (req 11): the public landing for one module. Data-driven: all copy and brand tokens come
 * from @ayzen/module-registry/landing; the markup is the same pure template the build prerenders, so the SPA and the static
 * HTML cannot drift. No hooks, no fetch, no providers.
 */
import { getLandingContent, landingBody, landingStyles } from "@ayzen/module-registry/landing";

export default function ModuleLanding({ moduleId }: { moduleId: string }) {
  const c = getLandingContent(moduleId);
  if (!c) return null;
  // Safe: every interpolated value is HTML-escaped inside landingBody and comes from our own registry, never from the user.
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: landingStyles(c) }} />
      <div dangerouslySetInnerHTML={{ __html: landingBody(c) }} />
    </>
  );
}
