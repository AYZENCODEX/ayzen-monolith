/** MKT-05 composition root: the discovery service on the real repository. Routes import this file, tests import discovery.ts. */
import { discoveryRepo } from "../infrastructure/discovery-repo.wired";
import { createDiscoveryService } from "./discovery";

export const discovery = createDiscoveryService(discoveryRepo);
