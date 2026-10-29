import crypto from "node:crypto";
import { createTraceContext } from "@ayzen/contracts";
import { assertEventEnvelope, createEventEnvelope } from "@ayzen/events";

export const CONNECTIVITY_TRANSPORTS = Object.freeze(["api", "eventbus"]);
export const CONNECTIVITY_CHANNELS = Object.freeze([
  "web",
  "mobile",
  "telegram",
  "email",
  "internal",
]);

const IDENTIFIER = /^[A-Za-z0-9._:@/-]{1,256}$/;

function assertIdentifier(value, label) {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function normalizeList(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${label} must be an array of strings`);
  }
  return [...new Set(value.map((item) => item.trim()))];
}

function requireContext(context) {
  if (!context?.requestId || !context.traceId || !context.correlationId) {
    throw new Error("Connectivity trace context is required");
  }
  if (!context.organizationId && !context.workspaceId) {
    throw new Error("Connectivity tenant scope is required");
  }
  return context;
}

export function createConnectionFabric({
  channels = CONNECTIVITY_CHANNELS,
  apps = [],
  bots = [],
  connections = [],
} = {}) {
  const registeredChannels = new Set(normalizeList(channels, "Channels"));
  const registeredApps = new Set(normalizeList(apps, "Apps"));
  const registeredBots = new Set(normalizeList(bots, "Bots"));
  const normalized = connections.map((connection) => {
    const transport = assertIdentifier(connection.transport, "Connection transport");
    if (!CONNECTIVITY_TRANSPORTS.includes(transport)) throw new Error(`Unsafe connectivity transport: ${transport}`);
    if (!registeredApps.has(connection.from) && !registeredBots.has(connection.from) && !registeredChannels.has(connection.from)) {
      throw new Error(`Connection source is not registered: ${connection.from}`);
    }
    if (!registeredApps.has(connection.to) && !registeredBots.has(connection.to) && !registeredChannels.has(connection.to)) {
      throw new Error(`Connection target is not registered: ${connection.to}`);
    }
    const scopes = normalizeList(connection.scopes ?? [], "Connection scopes");
    const events = normalizeList(connection.events ?? [], "Connection events");
    return Object.freeze({
      id: connection.id ?? `${connection.from}->${connection.to}`,
      from: connection.from,
      to: connection.to,
      transport,
      scopes: Object.freeze(scopes),
      events: Object.freeze(events),
      audience: assertIdentifier(connection.audience ?? connection.to, "Connection audience"),
      resources: Object.freeze(normalizeList(connection.resources ?? ["tenant"], "Connection resources")),
      enabled: connection.enabled !== false,
    });
  });
  const keys = new Set();
  for (const connection of normalized) {
    if (keys.has(connection.id)) throw new Error(`Duplicate connection: ${connection.id}`);
    keys.add(connection.id);
  }
  return Object.freeze({
    channels: Object.freeze([...registeredChannels]),
    apps: Object.freeze([...registeredApps]),
    bots: Object.freeze([...registeredBots]),
    list: () => [...normalized],
    resolve({ from, to, transport } = {}) {
      return normalized.find((connection) =>
        connection.enabled && (!from || connection.from === from) && (!to || connection.to === to)
          && (!transport || connection.transport === transport));
    },
    validate({ context, from, to, transport, scope, resource } = {}) {
      const connection = this.resolve({ from, to, transport });
      const errors = [];
      if (!connection) errors.push("connection_not_registered");
      if (!context?.traceId || !context?.correlationId) errors.push("trace_context_required");
      if (connection && scope && !connection.scopes.includes(scope)) errors.push("scope_not_granted");
      if (connection && resource && !connection.resources.includes(resource)) errors.push("resource_not_granted");
      return { valid: errors.length === 0, errors, connection };
    },
  });
}

export function createCrossAppBridge({ fabric, clock = () => new Date().toISOString() } = {}) {
  if (!fabric || typeof fabric.validate !== "function") throw new Error("Connection fabric is required");
  const receipts = new Map();
  return Object.freeze({
    publish({ from, to, eventType, payload, context, scope, resource = "tenant", idempotencyKey } = {}) {
      requireContext(context);
      const check = fabric.validate({ context, from, to, transport: "eventbus", scope, resource });
      if (!check.valid) return { delivered: false, code: "CROSS_APP_CONNECTION_DENIED", errors: check.errors };
      const key = idempotencyKey ?? crypto.randomUUID();
      if (receipts.has(key)) return { delivered: false, duplicate: true, receipt: receipts.get(key) };
      const envelope = createEventEnvelope({
        type: eventType,
        payload,
        traceId: context.traceId,
        correlationId: context.correlationId,
        causationId: context.causationId,
        organizationId: context.organizationId,
        workspaceId: context.workspaceId,
        metadata: { sourceApp: from, targetApp: to, scope, resource },
      });
      const receipt = Object.freeze({ id: crypto.randomUUID(), key, from, to, eventId: envelope.eventId, at: clock() });
      receipts.set(key, receipt);
      return { delivered: true, duplicate: false, envelope, receipt };
    },
    receipt(key) {
      return receipts.get(key);
    },
  });
}

export function createCrossChannelRouter({ fabric, adapters = {} } = {}) {
  if (!fabric || typeof fabric.validate !== "function") throw new Error("Connection fabric is required");
  return Object.freeze({
    async send({ from, channel, eventType, payload, context, scope, resource = "tenant" } = {}) {
      requireContext(context);
      if (!CONNECTIVITY_CHANNELS.includes(channel)) return { delivered: false, code: "CHANNEL_NOT_SUPPORTED" };
      const check = fabric.validate({ context, from, to: channel, transport: "api", scope, resource });
      if (!check.valid) return { delivered: false, code: "CROSS_CHANNEL_CONNECTION_DENIED", errors: check.errors };
      const envelope = createEventEnvelope({
        type: eventType,
        payload,
        traceId: context.traceId,
        correlationId: context.correlationId,
        organizationId: context.organizationId,
        workspaceId: context.workspaceId,
        metadata: { sourceApp: from, channel, scope, resource },
      });
      const adapter = adapters[channel];
      if (typeof adapter !== "function") return { delivered: false, code: "CHANNEL_ADAPTER_NOT_CONFIGURED", envelope };
      await adapter(envelope);
      return { delivered: true, channel, envelope };
    },
  });
}

export function createBotBridge({ fabric, bot, app, allowedCommands = [] } = {}) {
  if (!fabric || typeof fabric.validate !== "function") throw new Error("Connection fabric is required");
  assertIdentifier(bot, "Bot");
  assertIdentifier(app, "App");
  const commands = new Set(normalizeList(allowedCommands, "Bot commands"));
  return Object.freeze({
    async dispatch({ command, payload = {}, context, scope, resource = "tenant" } = {}) {
      requireContext(context);
      if (!commands.has(command)) return { accepted: false, code: "BOT_COMMAND_NOT_ALLOWED" };
      const check = fabric.validate({ context, from: bot, to: app, transport: "api", scope, resource });
      if (!check.valid) return { accepted: false, code: "BOT_APP_CONNECTION_DENIED", errors: check.errors };
      const envelope = createEventEnvelope({
        type: "telegram.update.received",
        payload: { command, ...payload },
        traceId: context.traceId,
        correlationId: context.correlationId,
        organizationId: context.organizationId,
        workspaceId: context.workspaceId,
        metadata: { bot, targetApp: app, scope, resource },
      });
      return { accepted: true, bot, app, command, envelope };
    },
  });
}

export function createConnectivityContext(input = {}) {
  return requireContext({
    ...createTraceContext(input),
    ...(input.organizationId ? { organizationId: input.organizationId } : {}),
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
  });
}

export function assertConnectivityEnvelope(envelope) {
  return assertEventEnvelope(envelope);
}