/** MKT-05g composition root: the favorites service on the real repository. */
import { favoritesRepo } from "../infrastructure/favorites-repo.wired";
import { createFavoritesService } from "./favorites";

export const favorites = createFavoritesService(favoritesRepo);
