import { PageHeader } from "@/components/page-header";
import { WarehouseProblemsWorkspace } from "@/components/warehouse-problems-workspace";
import { requirePagePermission } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export default async function ProblemsPage() {
  await requirePagePermission("/warehouse/problems", ["warehouse.problems", "warehouse.problems.release", "warehouse.tasks"]);
  return (
    <main className="min-h-svh bg-background">
      <PageHeader
        title="Проблемные товары"
        description="Числится в учёте, нет в ячейке: остаток обнулён до разбора"
      />
      <WarehouseProblemsWorkspace />
    </main>
  );
}
