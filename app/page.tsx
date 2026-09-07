import { DashboardOverview } from "@/components/dashboard-overview";
import { requirePageUser } from "@/lib/app-auth";

export const dynamic = "force-dynamic";

export default async function Home() {
  await requirePageUser("/");
  return <DashboardOverview />;
}
