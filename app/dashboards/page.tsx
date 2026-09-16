import { MarketplaceDashboard } from "@/components/marketplace-dashboard";
import { MetalPriceTiles } from "@/components/metal-price-tiles";
import { PageHeader } from "@/components/page-header";
import { hasAdminAccess } from "@/lib/app-auth";
import { readMetalPrices, type MetalPrices } from "@/lib/metal-prices";
import { requirePagePermission } from "@/lib/permissions";
import { getRuntimeEnv } from "@/lib/runtime-env";

export const dynamic = "force-dynamic";

export default async function DashboardsPage() {
  const { user } = await requirePagePermission("/dashboards", "money.view");
  const db = getRuntimeEnv().DB;
  const empty: MetalPrices = { gold: null, silver: null, source: null, fetchedAt: null, attemptedAt: null, error: null };
  const metals = db ? await readMetalPrices(db).catch(() => empty) : empty;
  return (
    <main className="min-h-svh bg-background">
      <PageHeader title="Дашборды" description="Заказы и выкупы по дням, по цене продавца" />
      <MetalPriceTiles initial={metals} />
      <MarketplaceDashboard canSync={hasAdminAccess(user)} />
    </main>
  );
}
