/**
 * pages/sylo/console.tsx — /vault (Sylo home)
 *
 * The Console replaces the old Vault Hub card grid and the tabbed /vault page.
 * It is a read-only overview: every widget links into the Account section that
 * owns the data. Legacy `/vault?tab=…` links (46 call sites, plus any saved
 * sidebar entries in the DB) are forwarded to their new location before the
 * Console renders.
 */
import { Link, Redirect, useSearch } from "wouter";
import {
  Coins, Gamepad2, KeyRound, LockKeyhole, Mail, Plus, ShieldCheck, Smartphone, Wallet, type LucideIcon,
} from "lucide-react";
import { PageHeader, StatTile, Widget } from "@/components/console";
import { Button } from "@/components/ui/button";
import { ActivityWidget, AttentionWidget } from "@/components/sylo/widgets";
import { useKycSummary, useLocalSummary, useVaultAnalytics } from "@/hooks/use-sylo-data";
import { formatUsd } from "@/lib/format-money";
import { accountPath, resolveLegacyTab } from "@/lib/sylo-routes";

const UNAVAILABLE = { value: "—", hint: "Couldn’t load" } as const;

function PortfolioTiles() {
  const entity = useVaultAnalytics();
  const local = useLocalSummary();
  const kyc = useKycSummary();

  const eWorth = entity.data?.overview.totalVaultWorth;
  const allLoaded = eWorth !== undefined && local.data !== undefined && kyc.data !== undefined;
  const combined = allLoaded ? eWorth + local.data!.totalWorth + kyc.data!.totalWorth : null;

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <StatTile
        label="Combined worth" icon={Coins} tone="primary"
        loading={entity.isPending || local.isPending || kyc.isPending}
        value={combined !== null ? formatUsd(combined) : UNAVAILABLE.value}
        hint={combined !== null ? "Entity + local + KYC" : UNAVAILABLE.hint}
      />
      <StatTile
        label="Entities" icon={KeyRound} href={accountPath("entity", "home")} loading={entity.isPending}
        value={entity.data ? entity.data.overview.totalEntries : UNAVAILABLE.value}
        hint={entity.data ? formatUsd(entity.data.overview.totalVaultWorth) : UNAVAILABLE.hint}
      />
      <StatTile
        label="Local accounts" icon={Smartphone} href={accountPath("local", "home")} loading={local.isPending}
        value={local.data ? local.data.total : UNAVAILABLE.value}
        hint={local.data ? formatUsd(local.data.totalWorth) : UNAVAILABLE.hint}
      />
      <StatTile
        label="KYC entries" icon={ShieldCheck} href={accountPath("kyc", "home")} loading={kyc.isPending}
        value={kyc.data ? kyc.data.total : UNAVAILABLE.value}
        hint={kyc.data ? `${kyc.data.paid} paid · ${formatUsd(kyc.data.totalWorth)}` : UNAVAILABLE.hint}
      />
    </div>
  );
}

interface Shortcut { label: string; hint: string; href: string; icon: LucideIcon }

const SHORTCUTS: readonly Shortcut[] = [
  { label: "Vault security", hint: "PIN, 2FA and passkeys", href: "/vault/security", icon: LockKeyhole },
  { label: "Wallet hub", hint: "Addresses and seed phrases", href: "/vault/wallet-hub/wallet", icon: Wallet },
  { label: "Mail hub", hint: "Entity mailboxes", href: "/vault/mail-hub/entity", icon: Mail },
  { label: "Game accounts", hint: "Tracked game and platform accounts", href: accountPath("game", "management"), icon: Gamepad2 },
];

function ShortcutsWidget() {
  return (
    <Widget title="Shortcuts" padded={false}>
      <ul className="divide-y divide-border/60">
        {SHORTCUTS.map(({ label, hint, href, icon: Icon }) => (
          <li key={href}>
            <Link
              href={href}
              className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground ring-1 ring-border">
                <Icon className="size-4" aria-hidden="true" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium text-foreground">{label}</span>
                <span className="block truncate text-xs text-muted-foreground">{hint}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Widget>
  );
}

function Console() {
  return (
    <div className="space-y-6 page-enter">
      <PageHeader
        eyebrow="Sylo"
        title="Console"
        description="Everything you hold in Sylo, and what needs your attention."
        actions={
          <Button asChild>
            <Link href={`${accountPath("entity", "management")}?new=1`}><Plus aria-hidden="true" /> New entity</Link>
          </Button>
        }
      />
      <PortfolioTiles />
      <div className="grid gap-4 lg:grid-cols-3">
        <AttentionWidget className="lg:col-span-2" />
        <ShortcutsWidget />
      </div>
      <ActivityWidget limit={6} />
    </div>
  );
}

export default function SyloConsoleRoute() {
  const search = useSearch();
  const legacy = resolveLegacyTab(search);
  if (legacy) return <Redirect to={legacy} replace />;
  return <Console />;
}
