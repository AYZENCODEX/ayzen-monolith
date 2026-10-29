/** MKT-05g composition root: the favorites repository on the real pool. Only this file imports the pool. */
import { pool } from "../../kernel/infrastructure/pool";
import { createFavoritesRepo, type FavoritesRepo, type Queryable } from "./favorites-repo";

export const favoritesRepo: FavoritesRepo = createFavoritesRepo(pool as unknown as Queryable);
