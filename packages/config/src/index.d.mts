export interface DatabaseUrlEnvironment {
  APP_DATABASE_URL?: string;
  DATABASE_URL?: string;
  DATABASE_URL_TARGET?: string;
}

export type DatabaseUrlTarget = "app" | "replit-test";

export function selectDatabaseUrl(options?: {
  env?: DatabaseUrlEnvironment;
  target?: DatabaseUrlTarget;
}): string | undefined;
