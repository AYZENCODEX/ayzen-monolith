// Hierarchical Telegram command parser and help renderer (Track E, Phase E2).
//
// Walks COMMAND_TREE_DEFINITIONS instead of doing a flat token lookup, so
// `/vault reveal my-secret` resolves vault -> reveal -> vault.read-secret with
// args ["my-secret"], and each bot's /help is generated from the tree.

import { COMMAND_TREE_DEFINITIONS } from "@ayzen/capabilities";

function findTopNode(botKey, command) {
  if (!botKey || !command) return null;
  return COMMAND_TREE_DEFINITIONS.find((node) => node.bot === botKey && node.command === command) ?? null;
}

/**
 * Resolves message text such as "/vault reveal my-secret" for one bot.
 * Returns null when the bot does not own the command (strictly bot-scoped, no
 * global fallback), otherwise:
 *   { bot, command, path, capability, args, hasSubcommands, deprecated, replacement? }
 *
 * - `path` is the matched subcommand tokens ([] for a bare parent command).
 * - `args` is everything after the matched tokens, with original casing kept
 *   (secret names and values are case-sensitive).
 * - An unrecognised token after a parent is NOT dropped: it falls back to the
 *   deepest matched node's own capability and stays in `args`.
 * - `hasSubcommands` says whether the top-level command is a parent, so callers
 *   can offer sub-feature help without string-matching help text.
 * - `capability` is undefined when the deepest matched node is a pure group
 *   with no capability of its own.
 */
export function resolveCommandTreePath(text, { botKey } = {}) {
  const tokens = String(text ?? "").trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;

  const command = tokens[0].toLowerCase();
  const top = findTopNode(botKey, command);
  if (!top) return null;

  let node = top;
  const path = [];
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index].toLowerCase();
    const child = node.subcommands?.find((candidate) => candidate.token === token);
    if (!child) break;
    node = child;
    path.push(child.token);
    index += 1;
  }

  return {
    bot: top.bot,
    command,
    path,
    capability: node.capability,
    args: tokens.slice(index),
    hasSubcommands: (top.subcommands?.length ?? 0) > 0,
    deprecated: top.deprecated === true,
    ...(top.deprecated ? { replacement: top.replacement } : {}),
  };
}

/**
 * Generates a bot's /help text from the tree. Deprecated aliases are omitted so
 * users are steered to the hierarchy, while the aliases keep resolving.
 * Returns null for a bot that owns no commands.
 */
export function renderCommandTreeHelp(botKey) {
  const nodes = COMMAND_TREE_DEFINITIONS.filter((node) => node.bot === botKey);
  if (!nodes.length) return null;
  const lines = nodes
    .filter((node) => !node.deprecated)
    .map((node) => {
      const children = node.subcommands?.map((child) => child.token) ?? [];
      return children.length ? `${node.command} — ${children.join(", ")}` : node.command;
    });
  return [`${botKey} commands:`, ...lines].join("\n");
}

/**
 * Help for one command's sub-features ("/vault help"). Returns null when the
 * bot does not own the command.
 */
export function renderSubcommandHelp(botKey, command) {
  const node = findTopNode(botKey, String(command ?? "").trim().toLowerCase());
  if (!node) return null;
  const children = node.subcommands ?? [];
  if (!children.length) return `${node.command} takes no sub-features.`;
  return [`${node.command} sub-features:`, ...children.map((child) => `${node.command} ${child.token}`)].join("\n");
}
