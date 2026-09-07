import { OrdersAnalytics } from "@/components/orders-analytics";
import { PageHeader } from "@/components/page-header";
import { hasAdminAccess, requirePageUser } from "@/lib/app-auth";

export const dynamic = "force-dynamic";

export default async function OrdersPage() {
  const user = await requirePageUser("/orders");
  return (
    <main className="min-h-svh bg-background">
      <PageHeader title="Заказы и аналитика" description="Выкупы, отмены, география и сроки доставки" />
      <OrdersAnalytics canSync={hasAdminAccess(user)} />
    </main>
  );
}
