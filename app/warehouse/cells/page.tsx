import { PageHeader } from "@/components/page-header";
import { WarehouseCellsWorkspace } from "@/components/warehouse-cells-workspace";
import { requirePagePermission } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export default async function CellsPage() {
  const { permissions } = await requirePagePermission("/warehouse/cells", ["warehouse.cells", "warehouse.tasks"]);
  return (
    <main className="min-h-svh bg-background">
      <PageHeader
        title="Ячейки и раскладка"
        description="Адресный склад: где лежит артикул и в каком порядке идёт сборщик"
      />
      <WarehouseCellsWorkspace canManage={permissions.includes("warehouse.cells")} />
    </main>
  );
}
