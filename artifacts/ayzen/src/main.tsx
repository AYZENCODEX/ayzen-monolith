import "./lib/api-routing-boot";
import { createRoot } from "react-dom/client";
import { getCurrentSubdomainApp } from "./lib/subdomain-app";
import { hasStoredToken, shouldShowModuleLanding } from "./lib/module-landing-gate";

const root = createRoot(document.getElementById("root")!);
// A module build IS its module; the central build on a module host resolves it from the hostname.
const build = getCurrentSubdomainApp()?.id as import("@ayzen/module-registry").ModuleId | undefined ?? null;

// W2-P4: a signed-out visit to "/" on a module build shows the public landing only. App (providers, auth probe, analytics)
// is imported lazily so NOTHING that talks to the API runs before the person chooses to sign in.
if (shouldShowModuleLanding({ build, pathname: window.location.pathname, hasToken: hasStoredToken(), enabled: import.meta.env.VITE_MODULE_LANDING !== "0" })) {
  void import("./pages/modules/landing").then(({ default: ModuleLanding }) => {
    document.getElementById("module-landing-css")?.remove();
    root.render(<ModuleLanding moduleId={build!} />);
  });
} else {
  void Promise.all([import("./App"), import("./lib/posthog"), import("./index.css")]).then(([{ default: App }, { initPosthog }]) => {
    initPosthog();
    root.render(<App />);
  });
}
