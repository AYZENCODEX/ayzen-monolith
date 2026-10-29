/**
 * Provider / event ports (VLT-GAP-12): Vault application code reaches email, notifications, Telegram and the domain-event bus only
 * through these aliases, so the layer rule (application -> infrastructure) holds for providers as it does for persistence.
 */
export { publishAyzenDomainEvent as publishAyzenDomainEventPort } from "../../../lib/mega-engine/domain-events";
export { createNotification as createNotificationProvider } from "../../../lib/create-notification";
export { sendToUser as sendTelegramToUserProvider } from "../../../lib/telegram";
export { sendVaultHealthDigestEmail as sendVaultHealthDigestEmailProvider, sendEmail as sendEmailProvider } from "../../../lib/email";
export { broadcastEvent as broadcastEventPort } from "../../../lib/event-hub";
