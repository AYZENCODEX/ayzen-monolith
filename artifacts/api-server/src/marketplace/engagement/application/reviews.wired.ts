/** MKT-05d composition root: the reviews service on the real repository. Routes import this file, tests import reviews.ts. */
import { reviewsRepo } from "../infrastructure/reviews-repo.wired";
import { createReviewsService } from "./reviews";

export const reviews = createReviewsService(reviewsRepo);
