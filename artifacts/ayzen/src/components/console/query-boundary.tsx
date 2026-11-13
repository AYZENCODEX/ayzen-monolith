/**
 * components/console/query-boundary.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Renders the four states of an async read — loading, error, empty, data — so
 * a screen can't forget one of them. The previous vault code swallowed errors
 * (`.catch(() => {})`), which made a failed load look identical to "you have
 * no data". Here a failure is always an error surface with a retry.
 *
 *   <QueryBoundary query={q} skeleton={<WidgetSkeleton />} isEmpty={(d) => !d.length} empty={…}>
 *     {(data) => <Table rows={data} />}
 *   </QueryBoundary>
 *
 * Works with any TanStack Query result (structural type, no coupling).
 */
import type { ReactNode } from "react";
import { InlineError } from "./error-pages";

export interface QueryLike<T> {
  data: T | undefined;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  isFetching: boolean;
  refetch: () => unknown;
}

export interface QueryBoundaryProps<T> {
  query: QueryLike<T>;
  skeleton: ReactNode;
  children: (data: T) => ReactNode;
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  errorClassName?: string;
}

export function QueryBoundary<T>({
  query, skeleton, children, isEmpty, empty, errorClassName,
}: QueryBoundaryProps<T>) {
  // First load only: background refetches keep showing the last good data.
  if (query.isPending) return <>{skeleton}</>;

  if (query.isError && query.data === undefined) {
    return (
      <InlineError
        error={query.error}
        retrying={query.isFetching}
        onRetry={() => void query.refetch()}
        className={errorClassName}
      />
    );
  }

  const data = query.data as T;
  if (isEmpty?.(data)) return <>{empty ?? null}</>;
  return <>{children(data)}</>;
}
