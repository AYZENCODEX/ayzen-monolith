/**
 * marketplace/kernel/ports/notifier-port.ts
 * MKT-03: notifications leave Marketplace through this port (adapter wraps lib/notification-bus). Both calls are
 * fire-and-forget in the routes today (`.catch(() => {})`); adapters keep returning the promise so callers decide.
 */
export interface NotifierPort {
  orderResolved(buyerId: number, action: "approve" | "reject", message: string): Promise<void>;
  offerReceived(sellerId: number, listingTitle: string, priceAzn: number, buyerUsername: string): Promise<void>;
}
