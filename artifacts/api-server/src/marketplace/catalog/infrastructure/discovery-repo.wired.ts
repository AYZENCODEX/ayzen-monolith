/** MKT-05 composition root: the discovery repository on the real pool. Only this file imports the pool (it needs DATABASE env at load). */
import { pool } from "../../kernel/infrastructure/pool";
import { createDiscoveryRepo, type DiscoveryRepo, type Queryable } from "./discovery-repo";

export const discoveryRepo: DiscoveryRepo = createDiscoveryRepo(pool as unknown as Queryable);
