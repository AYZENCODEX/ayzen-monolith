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
  /** Big numeral, e.g. "404". Falls back to a glyph for non-HTTP states. */
  code?: string;
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

/** Sylo accent per failure so each screen reads differently at a glance. */
const KIND_THEME: Record<ErrorKind, string> = {
  unauthorized: "t-brass", forbidden: "t-copper", "not-found": "t-slate",
  "rate-limited": "t-moss", server: "t-rose", network: "t-patina", unknown: "t-rose",
};

export function ErrorScreen({
  kind = "unknown", code, eyebrow, title, description, actions, reference, embedded = false,
}: ErrorScreenProps) {
  const body = (
    <div role="alert" className={cn("err", !embedded && "full")}>
      <div className="box">
        <div className="code" aria-hidden="true">{code ?? "!"}</div>
        {eyebrow && <div className="eb">{eyebrow}</div>}
        <h1>{title}</h1>
        <p>{description}</p>
        {actions && <div className="acts">{actions}</div>}
        {reference && <div className="ref">Reference <code>{reference}</code></div>}
      </div>
    </div>
  );
  // Embedded inside the Sylo shell the .sx scope already exists; standalone it must bring its own.
  return embedded ? body : <div className={cn("sx sx-solo", KIND_THEME[kind])}>{body}</div>;
}

/** Where "Go home" should land: the module's own home inside a subdomain app, else the root. */
function homeHref(): string {
  return getCurrentSubdomainApp()?.homePath ?? "/";
}

function BackButton() {
  return (
    <button type="button" className="btn" onClick={() => window.history.back()}>
      <ArrowLeft size={14} aria-hidden="true" /> Go back
    </button>
  );
}

function HomeButton({ label = "Go home" }: { label?: string }) {
  return (
    <Link href={homeHref()} className="btn p">
      <Home size={14} aria-hidden="true" /> {label}
    </Link>
  );
}

export function NotFoundPage({ embedded = false }: { embedded?: boolean }) {
  return (
    <ErrorScreen
      kind="not-found" code="404" eyebrow="Error 404" title="Page not found"
      description="The page you’re looking for doesn’t exist or has moved. Check the address, or head back to where you were."
      embedded={embedded}
      actions={<><BackButton /><HomeButton /></>}
    />
  );
}

export function UnauthorizedPage({ embedded = false }: { embedded?: boolean }) {
  return (
    <ErrorScreen
      kind="unauthorized" code="401" eyebrow="Error 401" title="Sign in to continue"
      description="This area needs a signed-in account. Sign in and we’ll bring you straight back here."
      embedded={embedded}
      actions={<>
        <Link href="/login" className="btn p"><LockKeyhole size={14} aria-hidden="true" /> Sign in</Link>
        <HomeButton label="Go home" />
      </>}
    />
  );
}

export function SessionExpiredPage({ embedded = false }: { embedded?: boolean }) {
  const d = COPY.unauthorized;
  return (
    <ErrorScreen
      kind="unauthorized" code="401" eyebrow="Session expired" title={d.title} description={d.description}
      embedded={embedded}
      actions={<Link href="/login" className="btn p"><LockKeyhole size={14} aria-hidden="true" /> Sign in again</Link>}
    />
  );
}

export function ForbiddenPage({ embedded = false }: { embedded?: boolean }) {
  const d = COPY.forbidden;
  return (
    <ErrorScreen
      kind="forbidden" code="403" eyebrow="Error 403" title={d.title} description={d.description}
      embedded={embedded}
      actions={<><BackButton /><HomeButton /></>}
    />
  );
}

export function RateLimitedPage({ embedded = false, onRetry }: { embedded?: boolean; onRetry?: () => void }) {
  const d = COPY["rate-limited"];
  return (
    <ErrorScreen
      kind="rate-limited" code="429" eyebrow="Error 429" title={d.title} description={d.description}
      embedded={embedded}
      actions={<>
        {onRetry && <button type="button" className="btn p" onClick={onRetry}><RefreshCw size={14} aria-hidden="true" /> Try again</button>}
        <HomeButton />
      </>}
    />
  );
}

export function ServerErrorPage({ embedded = false, onRetry, reference }: { embedded?: boolean; onRetry?: () => void; reference?: string }) {
  const d = COPY.server;
  return (
    <ErrorScreen
      kind="server" code="500" eyebrow="Error 500" title={d.title} description={d.description}
      embedded={embedded} reference={reference}
      actions={<>
        {onRetry && <button type="button" className="btn p" onClick={onRetry}><RefreshCw size={14} aria-hidden="true" /> Try again</button>}
        <HomeButton />
      </>}
    />
  );
}

export function MaintenancePage({ embedded = false }: { embedded?: boolean }) {
  return (
    <ErrorScreen
      kind="server" code="503" eyebrow="Maintenance" title="Back in a few minutes"
      description="Sylo is being updated. Your data is safe and nothing is lost. Try again shortly."
      embedded={embedded}
      actions={<button type="button" className="btn p" onClick={() => window.location.reload()}><RefreshCw size={14} aria-hidden="true" /> Reload</button>}
    />
  );
}

export function OfflinePage({ embedded = false }: { embedded?: boolean }) {
  const d = COPY.network;
  return (
    <ErrorScreen
      kind="network" code="···" eyebrow="Offline" title={d.title} description={d.description}
      embedded={embedded}
      actions={<button type="button" className="btn p" onClick={() => window.location.reload()}><RefreshCw size={14} aria-hidden="true" /> Try again</button>}
    />
  );
}

/** /error/:code — direct, linkable preview of every error surface. */
export function ErrorByCode({ code }: { code?: string }) {
  switch (code) {
    case "401": return <UnauthorizedPage />;
    case "expired": return <SessionExpiredPage />;
    case "403": return <ForbiddenPage />;
    case "429": return <RateLimitedPage onRetry={() => window.history.back()} />;
    case "500": return <ServerErrorPage onRetry={() => window.location.reload()} reference="demo-0000" />;
    case "503": return <MaintenancePage />;
    case "offline": return <OfflinePage />;
    default: return <NotFoundPage />;
  }
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
