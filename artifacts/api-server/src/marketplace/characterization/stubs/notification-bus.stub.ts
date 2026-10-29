// MKT-01b stub of lib/notification-bus.ts: every call is recorded in globalThis.__mktNotifications.
function record(kind: string, args: unknown[]): void {
  const g = globalThis as any;
  (g.__mktNotifications ??= []).push([kind, ...args]);
}
export async function notifyVerveOrderResolved(...args: unknown[]): Promise<void> { record("orderResolved", args); }
export async function notifyVerveOfferReceived(...args: unknown[]): Promise<void> { record("offerReceived", args); }
