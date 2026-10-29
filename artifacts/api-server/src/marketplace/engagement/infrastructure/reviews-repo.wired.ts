/** MKT-05d composition root: the reviews repository on the real pool. Only this file imports the pool. */
import { pool } from "../../kernel/infrastructure/pool";
import { createReviewsRepo, type Queryable, type ReviewsRepo } from "./reviews-repo";

export const reviewsRepo: ReviewsRepo = createReviewsRepo(pool as unknown as Queryable);
