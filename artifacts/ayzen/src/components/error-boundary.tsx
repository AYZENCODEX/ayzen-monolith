/**
 * components/error-boundary.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Render-error boundary used at two levels:
 *
 *   - Root (App.tsx): last resort, full-screen. A crash here means the shell
 *     itself failed.
 *   - Route (ProtectedRoute): wraps only the page, `embedded`, so the sidebar
 *     and header survive a page crash. Pass `resetKey={location}` and the
 *     boundary clears itself when the user navigates away — a crash on one
 *     page never traps them on every other page.
 *
 * Each crash gets a short reference id that is logged with the stack, so a
 * user can quote it to support and engineers can find the matching log line.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Home, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorScreen } from "@/components/console/error-pages";

interface Props {
  children: ReactNode;
  /** When this value changes while in the error state, the boundary resets. */
  resetKey?: string;
  /** Render inside the app layout instead of taking the full viewport. */
  embedded?: boolean;
}

interface State {
  error: Error | null;
  reference: string | null;
}

function newReference(): string {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, reference: null };

  static getDerivedStateFromError(error: Error): State {
    return { error, reference: newReference() };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[AYZEN] render error ref=${this.state.reference}`, error, info.componentStack);
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null, reference: null });
    }
  }

  private retry = () => this.setState({ error: null, reference: null });
  private goHome = () => { window.location.assign("/"); };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <ErrorScreen
        kind="unknown"
        title="This page hit a problem"
        description="An unexpected error stopped this page from loading. Your data is safe — nothing was changed. Try again, or go back home."
        reference={this.state.reference ?? undefined}
        embedded={this.props.embedded}
        actions={
          <>
            <Button onClick={this.retry}><RefreshCw aria-hidden="true" /> Try again</Button>
            <Button variant="outline" onClick={this.goHome}><Home aria-hidden="true" /> Go home</Button>
          </>
        }
      />
    );
  }
}
