/** MKT-05d composition root: the review resource builders on the real repository. */
import { reviewsRepo } from "../infrastructure/reviews-repo.wired";
import { createReviewResources } from "./review-resources";

export const { marketplaceReviewOrderResource, marketplaceReviewBuyerResource, marketplaceReviewSellerResource } = createReviewResources(reviewsRepo);
