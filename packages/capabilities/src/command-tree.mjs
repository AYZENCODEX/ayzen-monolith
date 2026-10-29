// Command tree schema for Telegram bots (Track E, Phase E1).
//
// A bot's command surface is a tree instead of a flat [bot, command, capability]
// list:
//
//   top-level node : { bot, command, capability?, subcommands?, args?, deprecated?, replacement? }
//   sub-feature    : { token, capability?, subcommands?, args? }
//
// A node needs a capability, subcommands, or both. When both are present the
// node's own capability is what the bare command resolves to (so `/vault` keeps
// meaning "list secrets" while `/vault reveal <name>` walks into a child).
//
// This module deliberately does NOT import the capability registry: the
// registry lives in index.mjs, which builds and validates the tree. The
// validator takes `getCapability` as an argument to avoid an import cycle.

const COMMAND_PATTERN = /^\/[a-z][a-z0-9_]*$/;
const TOKEN_PATTERN = /^[a-z][a-z0-9-]*$/;

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Builds a sub-feature node: `/vault reveal` is subCommand("reveal", "vault.read-secret"). */
export function subCommand(token, capability, { subcommands, args } = {}) {
  return {
    token,
    ...(capability !== undefined ? { capability } : {}),
    ...(subcommands ? { subcommands } : {}),
    ...(args ? { args } : {}),
  };
}

/**
 * Builds a top-level command node. `deprecated` + `replacement` mark a legacy
 * flat command kept as an alias for one release cycle: it still resolves, but
 * is hidden from generated /help and points users at its replacement.
 */
export function topCommand(bot, command, capability, { subcommands, args, deprecated = false, replacement } = {}) {
  return {
    bot,
    command,
    ...(capability !== undefined ? { capability } : {}),
    ...(subcommands ? { subcommands } : {}),
    ...(args ? { args } : {}),
    ...(deprecated ? { deprecated: true, replacement } : {}),
  };
}

function validateArgs(args, where, errors) {
  if (args === undefined) return;
  if (!Array.isArray(args)) {
    errors.push(`${where}: args must be an array`);
    return;
  }
  const seen = new Set();
  for (const arg of args) {
    if (!arg || typeof arg.name !== "string" || !arg.name) {
      errors.push(`${where}: every arg needs a non-empty name`);
    } else if (seen.has(arg.name)) {
      errors.push(`${where}: duplicate arg name "${arg.name}"`);
    } else {
      seen.add(arg.name);
    }
  }
}

function validateNode(node, where, getCapability, errors) {
  const hasCapability = node.capability !== undefined;
  const hasChildren = Array.isArray(node.subcommands) && node.subcommands.length > 0;

  if (hasCapability && !getCapability(node.capability)) {
    errors.push(`${where}: capability "${node.capability}" is not registered in the capability registry`);
  }
  if (!hasCapability && !hasChildren) {
    errors.push(`${where}: node has no capability and no subcommands, so it can never resolve to anything`);
  }
  if (node.subcommands !== undefined && !Array.isArray(node.subcommands)) {
    errors.push(`${where}: subcommands must be an array`);
    return;
  }
  validateArgs(node.args, where, errors);

  const seenTokens = new Set();
  for (const child of node.subcommands ?? []) {
    const token = typeof child?.token === "string" ? child.token : "";
    const childWhere = `${where} ${token || "<missing token>"}`;
    if (!TOKEN_PATTERN.test(token)) {
      errors.push(`${childWhere}: subcommand token must be lowercase letters, digits or hyphens`);
    } else if (seenTokens.has(token)) {
      errors.push(`${childWhere}: duplicate subcommand token "${token}"`);
    }
    seenTokens.add(token);
    validateNode(child, childWhere, getCapability, errors);
  }
}

/** Walks `tokens` down a top-level node's children; returns the deepest matching node or null. */
function walk(node, tokens) {
  let current = node;
  for (const token of tokens) {
    current = current.subcommands?.find((child) => child.token === token);
    if (!current) return null;
  }
  return current;
}

/**
 * Returns an array of error strings (empty = valid). Rejects:
 *  - capabilities that are not in the capability registry (typo / drift)
 *  - nodes with neither a capability nor subcommands
 *  - duplicate commands per bot and duplicate sibling subcommand tokens
 *  - deprecated aliases without a replacement, or whose replacement resolves to
 *    a different capability than the alias itself (a silent behaviour change)
 */
export function validateCommandTree(tree, { getCapability } = {}) {
  const errors = [];
  if (typeof getCapability !== "function") return ["validateCommandTree requires a getCapability function"];
  if (!Array.isArray(tree)) return ["command tree must be an array"];

  const seenCommands = new Set();
  for (const node of tree) {
    const bot = typeof node?.bot === "string" ? node.bot : "";
    const command = typeof node?.command === "string" ? node.command : "";
    const where = `${bot || "<missing bot>"} ${command || "<missing command>"}`;
    if (!bot) errors.push(`${where}: bot is required`);
    if (!COMMAND_PATTERN.test(command)) errors.push(`${where}: command must look like /name (lowercase)`);
    const key = `${bot}:${command}`;
    if (seenCommands.has(key)) errors.push(`${where}: duplicate command for bot`);
    seenCommands.add(key);
    validateNode(node, where, getCapability, errors);
  }

  // Deprecated aliases: replacement must exist and must not change behaviour.
  for (const node of tree) {
    if (!node?.deprecated) continue;
    const where = `${node.bot} ${node.command}`;
    if (typeof node.replacement !== "string" || !node.replacement.startsWith("/")) {
      errors.push(`${where}: deprecated command needs a replacement like "/parent child"`);
      continue;
    }
    const [command, ...tokens] = node.replacement.trim().split(/\s+/);
    const parent = tree.find((candidate) => candidate.bot === node.bot && candidate.command === command);
    const target = parent && walk(parent, tokens);
    if (!target) {
      errors.push(`${where}: replacement "${node.replacement}" does not exist in the tree`);
    } else if (target.capability !== node.capability) {
      errors.push(`${where}: replacement "${node.replacement}" resolves to ${target.capability}, not ${node.capability}`);
    }
  }
  return errors;
}

export function assertCommandTreeValid(tree, { getCapability } = {}) {
  const errors = validateCommandTree(tree, { getCapability });
  if (errors.length) throw new Error(`Invalid Telegram command tree:\n- ${errors.join("\n- ")}`);
  return tree;
}

/**
 * The legacy flat view: one entry per top-level command that owns a capability.
 * TELEGRAM_COMMAND_DEFINITIONS is derived from the tree through this, so the
 * flat list can never drift from the hierarchy.
 */
export function flattenCommandTree(tree) {
  return tree
    .filter((node) => node.capability !== undefined)
    .map((node) => ({
      bot: node.bot,
      command: node.command,
      capability: node.capability,
      ...(node.deprecated ? { deprecated: true, replacement: node.replacement } : {}),
    }));
}

export { deepFreeze };
