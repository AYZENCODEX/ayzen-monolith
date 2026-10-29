import { TELEGRAM_COMMAND_POLICIES_BY_BOT, TELEGRAM_COMMAND_POLICIES } from "@ayzen/authorization";
import { createConsumerClient } from "@ayzen/policy-contract";

/**
 * Phase 07 -- "Unified Policy Decision Contract", Telegram consumer.
 *
 * Telegram command authorization already goes through
 * @ayzen/authorization's TELEGRAM_COMMAND_POLICIES_BY_BOT /
 * assertTelegramCommandAuthorized -- this does not replace that (Roadmap
 * section 3, non-duplication rule; @ayzen/authorization is still the only
 * place the command -> capability tables are defined). What was missing
 * was the Telegram layer's own client onto the *contract*: the same
 * `{ decide, explain }` shape every other consumer
 * (api/service/event/workflow/scheduler/admin) gets from
 * `createConsumerClient`, so a bot handler can ask "is this allowed" and
 * get back one of the roadmap's three decisions (with a `conditions`
 * array) instead of only a thrown-or-not boolean.
 *
 * `formatTelegramError` in packages/telegram/src/index.mjs already
 * special-cases the `STEP_UP_REQUIRED` error code with a user-facing
 * "please complete the security confirmation" message. This adapter's
 * `conditions[0].code` on a "conditional" decision is that same code, so
 * a bot handler that switches on it to render a confirmation prompt gets
 * identical behavior whether it came from a thrown
 * assertTelegramCommandAuthorized error or from this non-throwing client.
 */
export function createTelegramPolicyClient({ app, audit } = {}) {
  return createConsumerClient("telegram", { app, audit });
}

function resolveCommand(botKey, command) {
  const token = String(command ?? "").trim().split(/\s+/)[0];
  return TELEGRAM_COMMAND_POLICIES_BY_BOT[botKey]?.[token] ?? TELEGRAM_COMMAND_POLICIES[token];
}

/**
 * Decides a Telegram command through the unified contract instead of
 * throwing. `auth` carries the caller's identity/scopes/roles/stepUpAt --
 * the same fields `decide()` already accepts for any capability request.
 */
export function decideTelegramCommand({ command, botKey, app, auth = {} } = {}) {
  const mapping = resolveCommand(botKey, command);
  if (!mapping) {
    const error = new Error(`Telegram command is not registered: ${command}`);
    error.code = "TELEGRAM_COMMAND_NOT_REGISTERED";
    throw error;
  }
  if (botKey && mapping.bot && mapping.bot !== botKey) {
    const error = new Error("Telegram command is not registered for this bot");
    error.code = "TELEGRAM_COMMAND_BOT_MISMATCH";
    throw error;
  }
  const client = createTelegramPolicyClient({ app: app ?? botKey });
  return client.decide({
    capability: mapping.capability,
    subject: auth.subject,
    actorType: auth.actorType,
    organizationId: auth.organizationId,
    workspaceId: auth.workspaceId,
    scopes: auth.scopes ?? [],
    roles: auth.roles ?? [],
    stepUpAt: auth.stepUpAt,
  });
}
