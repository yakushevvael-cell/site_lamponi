import { PageHeader } from "@/components/page-header";
import { WarehousesWorkspace } from "@/components/warehouses-workspace";
import { hasAdminAccess, requirePageUser } from "@/lib/app-auth";

export const dynamic = "force-dynamic";

export default async function WarehousesPage() {
  const user = await requirePageUser("/warehouses");
  return (
    <main className="min-h-svh bg-background">
      <PageHeader title="Склады" description="Один физический сток и все FBS-склады площадок" />
      <WarehousesWorkspace canManage={hasAdminAccess(user)} />
    </main>
  );
}
