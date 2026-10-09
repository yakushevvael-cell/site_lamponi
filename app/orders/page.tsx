import Link from "next/link";

import { OrdersAnalytics } from "@/components/orders-analytics";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { hasAdminAccess } from "@/lib/app-auth";
import { requirePagePermission } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export default async function OrdersPage() {
  const { user } = await requirePagePermission("/orders", "money.view");
  return (
    <main className="min-h-svh bg-background">
      <PageHeader
        title="Заказы и аналитика"
        description="Выкупы, отмены, география и сроки доставки"
        actions={(
          <Button asChild variant="outline" size="sm">
            <Link href="/orders/unshipped">Не отгружено на момент</Link>
          </Button>
        )}
      />
      <OrdersAnalytics canSync={hasAdminAccess(user)} />
    </main>
  );
}
