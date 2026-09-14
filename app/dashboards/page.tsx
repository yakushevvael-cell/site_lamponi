import { MarketplaceDashboard } from "@/components/marketplace-dashboard";
import { PageHeader } from "@/components/page-header";
import { hasAdminAccess } from "@/lib/app-auth";
import { requirePagePermission } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export default async function DashboardsPage() {
  const { user } = await requirePagePermission("/dashboards", "money.view");
  return (
    <main className="min-h-svh bg-background">
      <PageHeader title="Дашборды" description="Заказы и выкупы по дням, по цене продавца" />
      <MarketplaceDashboard canSync={hasAdminAccess(user)} />
    </main>
  );
}
