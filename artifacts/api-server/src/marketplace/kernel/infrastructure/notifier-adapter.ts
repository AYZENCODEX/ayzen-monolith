/** MKT-03: NotifierPort over lib/notification-bus (same functions the routes call today). */
import { notifyVerveOfferReceived, notifyVerveOrderResolved } from "../../../lib/notification-bus";
import type { NotifierPort } from "../ports/notifier-port";

export const notifierAdapter: NotifierPort = {
  orderResolved: (buyerId, action, message) => notifyVerveOrderResolved(buyerId, action, message),
  offerReceived: (sellerId, listingTitle, priceAzn, buyerUsername) => notifyVerveOfferReceived(sellerId, listingTitle, priceAzn, buyerUsername),
};
