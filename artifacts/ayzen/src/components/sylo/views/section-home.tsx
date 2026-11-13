/**
 * Home view: headline figures for the section, a way into each of its views,
 * and (entity only) anything that needs attention.
 */
import { Link } from "wouter";
import { ArrowRight } from "lucide-react";
import { accountPath, type AccountSection, type AccountView } from "@/lib/sylo-routes";
import { SECTION_VIEWS, VIEW_BLURB, VIEW_META } from "../sections";
import { AttentionWidget, EntityStatGrid, KycStatGrid, LocalStatGrid } from "../widgets";

type ExploreView = Exclude<AccountView, "home">;

export default function SectionHome({ section }: { section: Exclude<AccountSection, "game"> }) {
  const explore = SECTION_VIEWS[section].filter((v): v is ExploreView => v !== "home");
  return (
    <div className="space-y-6">
      {section === "entity" && <EntityStatGrid />}
      {section === "local" && <LocalStatGrid />}
      {section === "kyc" && <KycStatGrid />}

      <div className="grid gap-3 md:grid-cols-3">
        {explore.map((view) => {
          const { label, icon: Icon } = VIEW_META[view];
          return (
            <Link
              key={view}
              href={accountPath(section, view)}
              className="group flex flex-col rounded-xl border border-border bg-card p-4 font-ui shadow-elevation-1 transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <span className="flex size-8 items-center justify-center rounded-md bg-primary/10 text-primary ring-1 ring-primary/20">
                <Icon className="size-4" aria-hidden="true" />
              </span>
              <span className="mt-3 text-sm font-semibold text-foreground">{label}</span>
              <span className="mt-1 flex-1 text-xs leading-relaxed text-muted-foreground">{VIEW_BLURB[view]}</span>
              <span className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary">
                Open <ArrowRight className="size-3 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
              </span>
            </Link>
          );
        })}
      </div>

      {section === "entity" && <AttentionWidget />}
    </div>
  );
}
