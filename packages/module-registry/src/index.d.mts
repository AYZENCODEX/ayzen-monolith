export type ModuleId = "sylo" | "ryft" | "fyra" | "verve" | "skarn" | "warde" | "wisp" | "zynth";

export interface ModuleDefinition {
  readonly id: ModuleId;
  readonly label: string;
  /** Three-letter Universal ID prefix (ADR A1), e.g. SYL -> SYL-000001. */
  readonly uidPrefix: string;
  /** UI sort order across modules (lower first). */
  readonly order: number;
  readonly description: string;
  readonly homePath: string;
  readonly routePrefixes: readonly string[];
  readonly hostEnv: string;
  readonly defaultHost: string;
  readonly telegramBot: string;
  readonly oidcClientId: string;
  /** Reserved: W1-P5. */
  readonly clerkApp: string | null;
  /** Reserved: W3-P3. */
  readonly mcpEndpoint: string | null;
  readonly kind: "module";
}

export const MODULES: readonly ModuleDefinition[];
export const MODULE_IDS: readonly ModuleId[];
export function getModule(id: string): ModuleDefinition | null;
export function getModulesByOrder(): ModuleDefinition[];
export function hasPrefix(path: string, prefix: string): boolean;
export function getModuleIdForPath(path: string): ModuleId | null;

export const MODULE_HOST_ALLOWED_PREFIXES: readonly string[];
export function pathCandidates(rawPath: string): string[] | null;
export type ModuleHostDecision =
  | { action: "allow"; reason: "own_or_allowlisted" | "unowned"; owner: null }
  | { action: "deny"; reason: "other_module" | "unknown_module" | "malformed_path" | "not_in_module"; owner: ModuleId | null };
export function decideModuleHostAccess(input: { module: string; path: string; strict?: boolean; sharedPrefixes?: readonly string[] }): ModuleHostDecision;

export interface ModuleLandingContent {
  id: ModuleId; label: string; host: string; homePath: string; tagline: string;
  hero: { eyebrow: string; title: string; lead: string };
  features: { title: string; text: string }[];
  shards: string;
  faq: [string, string][];
  brand: { bg: string; surface: string; fg: string; muted: string; accent: string; ink: string };
}
