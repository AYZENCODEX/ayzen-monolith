/**
 * components/sylo/section-tabs.tsx
 * Route-driven tabs (real links, so each view is bookmarkable and back/forward
 * work). Not a state-driven <Tabs>: switching a view is a navigation.
 */
import { Link } from "wouter";
import { accountPath, type AccountSection, type AccountView } from "@/lib/sylo-routes";
import { SECTION_META, SECTION_VIEWS, VIEW_META } from "./sections";
import { cn } from "@/lib/utils";

export function SectionTabs({ section, active }: { section: AccountSection; active: AccountView }) {
  const views = SECTION_VIEWS[section];
  if (views.length < 2) return null;
  return (
    <nav aria-label={`${SECTION_META[section].label} sections`} className="border-b border-border font-ui">
      <ul className="-mb-px flex gap-1 overflow-x-auto">
        {views.map((view) => {
          const { label, icon: Icon } = VIEW_META[view];
          const isActive = view === active;
          return (
            <li key={view}>
              <Link
                href={accountPath(section, view)}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2 whitespace-nowrap border-b-2 px-3.5 py-2.5 text-sm font-medium transition-colors",
                  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
                  isActive
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
                )}
              >
                <Icon className="size-4" aria-hidden="true" />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
