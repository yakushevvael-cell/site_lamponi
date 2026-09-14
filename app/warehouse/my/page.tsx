import { PageHeader } from "@/components/page-header";
import { WarehousePickerWorkspace } from "@/components/warehouse-picker-workspace";
import { requirePagePermission } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export default async function MyTasksPage() {
  await requirePagePermission("/warehouse/my", "warehouse.pick");
  return (
    <main className="min-h-svh bg-background">
      <PageHeader title="Моё задание" description="Собрать по ячейкам и закрыть задание" />
      <WarehousePickerWorkspace />
    </main>
  );
}
