import { redirect } from "next/navigation";

import { DashboardOverview } from "@/components/dashboard-overview";
import { requirePageUser } from "@/lib/app-auth";
import { readEffectivePermissions } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await requirePageUser("/");
  // Сборщику обзор бизнеса не нужен: его рабочий экран — своё задание.
  const permissions = await readEffectivePermissions(user);
  if (permissions.includes("warehouse.pick") && !permissions.includes("money.view") && !permissions.includes("warehouse.tasks")) {
    redirect("/warehouse/my");
  }
  return <DashboardOverview />;
}
