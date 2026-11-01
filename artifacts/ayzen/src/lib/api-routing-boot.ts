// Side-effect module: imported FIRST in main.tsx so the fetch/EventSource shim
// is in place before any other module runs. See lib/api-routing.ts.
import { installApiRouting } from "./api-routing";

installApiRouting();
