/**
 * components/console/error-pages.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * One place that decides how a failure is presented.
 *
 *   describeError(err)   classifies an unknown thrown value (ApiError status,
 *                        fetch network failure, anything else) into a kind +
 *                        user-safe copy + whether retrying can help.
 *   ErrorScreen          full-page / in-layout surface (404, 403, 5xx, crash)
 *   InlineError          compact surface for a single widget or table
 *
 * Security note: the API's 5xx bodies carry a `detail` field with the raw
 * exception message. It is deliberately never rendered here — only the
 * top-level `error` string is, and only for 4xx responses.
 */
import type { ReactNode } from "react";
import { Link } from "wouter";
import {
  AlertTriangle, ArrowLeft, Compass, Home, LockKeyhole, RefreshCw, ServerCrash, WifiOff,
  type LucideIcon,
} from "lucide-react";
import { ApiError } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { getCurrentSubdomainApp } from "@/lib/subdomain-app";
import { cn } from "@/lib/utils";

/* ─── Classification ─────────────────────────────────────────────────────── */

export type ErrorKind =
  | "unauthorized" | "forbidden" | "not-found" | "rate-limited" | "server" | "network" | "unknown";

export interface ErrorDescriptor {
  kind: ErrorKind;
  status?: number;
  title: string;
  description: string;
  /** Whether a plain retry has a realistic chance of succeeding. */
  retryable: boolean;
}

const COPY: Record<ErrorKind, Omit<ErrorDescriptor, "kind" | "status">> = {
  unauthorized: {
    title: "Your session has expired",
    description: "Sign in again to continue. Nothing you had open has been lost.",
    retryable: false,
  },
  forbidden: {
    title: "You don’t have access to this",
    description: "Your account doesn’t have permission to view this. If you think that’s a mistake, ask the owner to share it with you.",
    retryable: false,
  },
  "not-found": {
    title: "We couldn’t find that",
    description: "It may have been moved, deleted, or the link may be incorrect.",
    retryable: false,
  },
  "rate-limited": {
    title: "Too many requests",
    description: "You’re going a little fast. Wait a moment and try again.",
    retryable: true,
  },
  server: {
    title: "Something went wrong on our side",
    description: "The request failed and we’ve not changed anything. Try again in a moment.",
    retryable: true,
  },
  network: {
    title: "Can’t reach the server",
    description: "Check your connection and try again.",
    retryable: true,
  },
  unknown: {
    title: "Something went wrong",
    description: "An unexpected error occurred. Try again, and contact support if it keeps happening.",
    retryable: true,
  },
};

function kindFromStatus(status: number): ErrorKind {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not-found";
  if (status === 429) return "rate-limited";
  if (status >= 500) return "server";
  return "unknown";
}

/** Top-level `error` string from a 4xx body, if present. Never reads `detail`. */
function safeClientMessage(error: ApiError): string | null {
  if (error.status < 400 || error.status >= 500) return null;
  const data = error.data;
  if (data && typeof data === "object" && "error" in data) {
    const msg = (data as { error?: unknown }).error;
    if (typeof msg === "string" && msg.length > 0 && msg.length <= 200) return msg;
  }
  return null;
}

export function describeError(error: unknown): ErrorDescriptor {
  if (error instanceof ApiError) {
    const kind = kindFromStatus(error.status);
    const base = COPY[kind];
    // A specific 4xx message from the API (e.g. "Entity limit reached") beats generic copy.
    const message = kind === "unknown" || kind === "rate-limited" ? safeClientMessage(error) : null;
    return { kind, status: error.status, ...base, description: message ?? base.description };
  }
  // fetch() rejects with a TypeError when the network is down or the request is blocked.
  if (error instanceof TypeError) return { kind: "network", ...COPY.network };
  return { kind: "unknown", ...COPY.unknown };
}

/* ─── Full-page surface ──────────────────────────────────────────────────── */

const KIND_ICON: Record<ErrorKind, LucideIcon> = {
  unauthorized: LockKeyhole,
  forbidden: LockKeyhole,
  "not-found": Compass,
  "rate-limited": AlertTriangle,
  server: ServerCrash,
  network: WifiOff,
  unknown: AlertTriangle,
};

const KIND_TONE: Record<ErrorKind, string> = {
  unauthorized: "bg-warning-muted text-warning ring-warning/25",
  forbidden: "bg-warning-muted text-warning ring-warning/25",
  "not-found": "bg-info-muted text-info ring-info/25",
  "rate-limited": "bg-warning-muted text-warning ring-warning/25",
  server: "bg-danger-muted text-danger ring-danger/25",
  network: "bg-pending-muted text-pending ring-pending/25",
  unknown: "bg-danger-muted text-danger ring-danger/25",
};

export interface ErrorScreenProps {
  kind?: ErrorKind;
  /** Small label above the title, e.g. "Error 404". */
  eyebrow?: string;
  title: string;
  description: string;
  actions?: ReactNode;
  /** Support reference the user can quote. */
  reference?: string;
  /** Render inside the app layout (no full-viewport height). */
  embedded?: boolean;
}

export function ErrorScreen({
  kind = "unknown", eyebrow, title, description, actions, reference, embedded = false,
}: ErrorScreenProps) {
  const Icon = KIND_ICON[kind];
  return (
    <div
      role="alert"
      className={cn(
        "flex w-full items-center justify-center bg-background px-6 font-ui text-foreground",
        embedded ? "min-h-[60vh] py-12" : "min-h-screen",
      )}
    >
      <div className="w-full max-w-md text-center">
        <div className={cn("mx-auto flex size-12 items-center justify-center rounded-xl ring-1", KIND_TONE[kind])}>
          <Icon className="size-6" aria-hidden="true" />
        </div>
        {eyebrow && (
          <p className="mt-5 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{eyebrow}</p>
        )}
        <h1 className={cn("text-xl font-semibold tracking-tight", eyebrow ? "mt-1.5" : "mt-5")}>{title}</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{description}</p>
        {actions && <div className="mt-6 flex flex-wrap items-center justify-center gap-2">{actions}</div>}
        {reference && (
          <p className="mt-6 text-xs text-muted-foreground/70">
            Reference <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground/80">{reference}</code>
          </p>
        )}
      </div>
    </div>
  );
}

/** Where "Go home" should land: the module's own home inside a subdomain app, else the root. */
function homeHref(): string {
  return getCurrentSubdomainApp()?.homePath ?? "/";
}

function BackButton() {
  return (
    <Button variant="outline" onClick={() => window.history.back()}>
      <ArrowLeft aria-hidden="true" /> Go back
    </Button>
  );
}

function HomeButton({ label = "Go home" }: { label?: string }) {
  return (
    <Button asChild>
      <Link href={homeHref()}><Home aria-hidden="true" /> {label}</Link>
    </Button>
  );
}

export function NotFoundPage({ embedded = false }: { embedded?: boolean }) {
  return (
    <ErrorScreen
      kind="not-found"
      eyebrow="Error 404"
      title="Page not found"
      description="The page you’re looking for doesn’t exist or has moved. Check the address, or head back to where you were."
      embedded={embedded}
      actions={<><BackButton /><HomeButton /></>}
    />
  );
}

export function ForbiddenPage({ embedded = false }: { embedded?: boolean }) {
  const d = COPY.forbidden;
  return (
    <ErrorScreen
      kind="forbidden"
      eyebrow="Error 403"
      title={d.title}
      description={d.description}
      embedded={embedded}
      actions={<><BackButton /><HomeButton /></>}
    />
  );
}

export function ServerErrorPage({ embedded = false, onRetry, reference }: { embedded?: boolean; onRetry?: () => void; reference?: string }) {
  const d = COPY.server;
  return (
    <ErrorScreen
      kind="server"
      eyebrow="Error 500"
      title={d.title}
      description={d.description}
      embedded={embedded}
      reference={reference}
      actions={
        <>
          {onRetry && <Button onClick={onRetry}><RefreshCw aria-hidden="true" /> Try again</Button>}
          <Button variant="outline" asChild><Link href={homeHref()}><Home aria-hidden="true" /> Go home</Link></Button>
        </>
      }
    />
  );
}

/* ─── Inline surface (widgets, tables, panels) ───────────────────────────── */

export function InlineError({
  error, onRetry, retrying = false, className,
}: { error: unknown; onRetry?: () => void; retrying?: boolean; className?: string }) {
  const d = describeError(error);
  const Icon = KIND_ICON[d.kind];
  return (
    <div role="alert" className={cn("flex flex-col items-center justify-center gap-3 px-6 py-8 text-center font-ui", className)}>
      <div className={cn("flex size-9 items-center justify-center rounded-lg ring-1", KIND_TONE[d.kind])}>
        <Icon className="size-4" aria-hidden="true" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{d.title}</p>
        <p className="mx-auto max-w-xs text-xs leading-relaxed text-muted-foreground">{d.description}</p>
      </div>
      {onRetry && d.retryable && (
        <Button size="sm" variant="outline" onClick={onRetry} disabled={retrying}>
          <RefreshCw className={cn(retrying && "animate-spin motion-reduce:animate-none")} aria-hidden="true" />
          {retrying ? "Retrying" : "Try again"}
        </Button>
      )}
    </div>
  );
}
