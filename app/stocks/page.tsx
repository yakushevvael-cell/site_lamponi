import { PageHeader } from "@/components/page-header";
import { StocksWorkspace } from "@/components/stocks-workspace";
import { hasAdminAccess, requirePageUser } from "@/lib/app-auth";

export const dynamic = "force-dynamic";

export default async function StocksPage() {
  const user = await requirePageUser("/stocks");
  return (
    <main className="min-h-svh bg-background">
      <PageHeader title="Остатки" description="Физический сток, резервы и остаток для публикации" />
      <StocksWorkspace canSyncAll={hasAdminAccess(user)} />
    </main>
  );
}
