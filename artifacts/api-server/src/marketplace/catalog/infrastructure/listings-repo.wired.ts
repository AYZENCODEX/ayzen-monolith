/** MKT-05g composition root: the listings repository on the real pool. Only this file imports the pool. */
import { pool } from "../../kernel/infrastructure/pool";
import { createListingsRepo, type ListingsRepo, type Queryable } from "./listings-repo";

export const listingsRepo: ListingsRepo = createListingsRepo(pool as unknown as Queryable);
