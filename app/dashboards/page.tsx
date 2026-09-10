import { MarketplaceDashboard } from "@/components/marketplace-dashboard";
import { PageHeader } from "@/components/page-header";
import { hasAdminAccess, requirePageUser } from "@/lib/app-auth";

export const dynamic = "force-dynamic";

export default async function DashboardsPage() {
  const user = await requirePageUser("/dashboards");
  return (
    <main className="min-h-svh bg-background">
      <PageHeader title="Дашборды" description="Заказы и выкупы по дням, по цене продавца" />
      <MarketplaceDashboard canSync={hasAdminAccess(user)} />
    </main>
  );
}
