export interface IdentityContext {
  readonly hopId: string;
  readonly traceId: string;
  readonly correlationId: string;
  readonly causationId?: string;
}
export const INSTANCE_ID: RegExp;
export const ID_TYPES: readonly string[];
export function isValidId(value: unknown): value is string;
export function assertId(value: unknown, label?: string): string;
export function generateId(): string;
export function normalizeId(value: unknown): string | undefined;
export function createIdentityContext(input?: { hopId?: string; traceId?: string; correlationId?: string; causationId?: string }): IdentityContext;
export function deriveChildContext(parent: IdentityContext, options?: { causationId?: string }): IdentityContext;

/** W1-P1: durable per-module account id, e.g. SYL-000001. */
export const MODULE_UID: RegExp;
export function formatModuleUid(prefix: string, seq: number): string;
export function parseModuleUid(value: unknown): { prefix: string; seq: number } | null;
export function isValidModuleUid(value: unknown, options?: { prefix?: string }): value is string;
