import posthog from "posthog-js";

export function initPosthog() {
  const key = import.meta.env.VITE_POSTHOG_KEY || "phc_qj9drtYoGoukv5hqiHsnFShrFboR3pCCrpmSijaMwZKx";
  const host = import.meta.env.VITE_POSTHOG_HOST || "https://us.i.posthog.com";
  posthog.init(key, {
    api_host: host,
    capture_pageview: true,
    capture_pageleave: true,
    persistence: "localStorage+cookie",
    autocapture: true,
  });
}

export default posthog;
