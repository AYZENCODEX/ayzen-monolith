/** MKT-05g composition root: the listings service on the real repository. Routes import this file, tests import listings.ts. */
import { listingsRepo } from "../infrastructure/listings-repo.wired";
import { createListingsService } from "./listings";

export const listings = createListingsService(listingsRepo);
