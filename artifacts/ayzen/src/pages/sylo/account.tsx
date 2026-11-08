/**
 * pages/sylo/account.tsx — /vault/account/:section/:view
 *
 * One routed shell for every Account section/view pair. The shell owns the
 * header and tabs; the view body is lazy-loaded so opening Local never pays
 * for the 1,700-line Entity manager. Existing dashboards and managers are
 * reused as-is — this page only changes where they live and how you reach them.
 *
 * Access control: any path under /vault is wrapped in VaultUnlockGate by
 * App.tsx, so nothing here re-implements it.
 */
import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from "react";
import { Redirect, useParams } from "wouter";
import { NotFoundPage, PageHeader, StatGridSkeleton, WidgetSkeleton } from "@/components/console";
import { SECTION_META, SECTION_VIEWS, VIEW_META } from "@/components/sylo/sections";
import { SectionTabs } from "@/components/sylo/section-tabs";
import {
  SYLO_HOME, accountPath, isAccountSection, isAccountView,
  type AccountSection, type AccountView,
} from "@/lib/sylo-routes";

type Body = LazyExoticComponent<ComponentType>;
type PlainView = Extract<AccountView, "dashboard" | "management">;

const SectionHome = lazy(() => import("@/components/sylo/views/section-home"));
const SectionAnalysis = lazy(() => import("@/components/sylo/views/section-analysis"));

const PLAIN: Record<AccountSection, Partial<Record<PlainView, Body>>> = {
  entity: {
    dashboard: lazy(() => import("@/pages/user/vault-entity-dashboard")),
    management: lazy(() => import("@/components/sylo/entity-manager").then((m) => ({ default: m.EntityManager }))),
  },
  local: {
    dashboard: lazy(() => import("@/pages/user/vault-local-dashboard")),
    management: lazy(() => import("@/components/local-accounts")),
  },
  kyc: {
    dashboard: lazy(() => import("@/pages/user/vault-kyc-dashboard")),
    management: lazy(() => import("@/components/kyc-entries")),
  },
  game: {
    management: lazy(() => import("@/components/game-entries")),
  },
};

/** Content-only fallback: the header and tabs stay put while the body loads. */
function BodyFallback() {
  return (
    <div className="space-y-6">
      <StatGridSkeleton />
      <div className="grid gap-4 lg:grid-cols-2">
        <WidgetSkeleton announce={false} />
        <WidgetSkeleton announce={false} />
      </div>
    </div>
  );
}

function ViewBody({ section, view }: { section: AccountSection; view: AccountView }) {
  if (section !== "game" && view === "home") return <SectionHome section={section} />;
  if (section !== "game" && view === "analysis") return <SectionAnalysis section={section} />;
  const Body = view === "dashboard" || view === "management" ? PLAIN[section][view] : undefined;
  return Body ? <Body /> : <NotFoundPage embedded />;
}

export default function AccountSectionPage() {
  const { section, view } = useParams<{ section: string; view?: string }>();

  if (!isAccountSection(section)) return <NotFoundPage embedded />;
  const allowed = SECTION_VIEWS[section];

  // /vault/account/entity  →  its first view
  if (view === undefined) return <Redirect to={accountPath(section, allowed[0])} replace />;
  if (!isAccountView(view)) return <NotFoundPage embedded />;
  // e.g. /vault/account/game/dashboard — valid view name, but not offered for this section
  if (!allowed.includes(view)) return <Redirect to={accountPath(section, allowed[0])} replace />;

  const meta = SECTION_META[section];
  return (
    <div className="space-y-6 page-enter">
      <PageHeader
        eyebrow="Account"
        title={meta.label}
        description={meta.description}
        breadcrumbs={[
          { label: "Sylo", href: SYLO_HOME },
          { label: "Account" },
          { label: meta.label, href: view === "home" ? undefined : accountPath(section, "home") },
          ...(view === "home" ? [] : [{ label: VIEW_META[view].label }]),
        ]}
      />
      <SectionTabs section={section} active={view} />
      <Suspense fallback={<BodyFallback />}>
        <ViewBody section={section} view={view} />
      </Suspense>
    </div>
  );
}
