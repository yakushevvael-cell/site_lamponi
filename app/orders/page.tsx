import { OrdersAnalytics } from "@/components/orders-analytics";
import { PageHeader } from "@/components/page-header";
import { hasAdminAccess } from "@/lib/app-auth";
import { requirePagePermission } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export default async function OrdersPage() {
  const { user } = await requirePagePermission("/orders", "money.view");
  return (
    <main className="min-h-svh bg-background">
      <PageHeader title="Заказы и аналитика" description="Выкупы, отмены, география и сроки доставки" />
      <OrdersAnalytics canSync={hasAdminAccess(user)} />
    </main>
  );
}
