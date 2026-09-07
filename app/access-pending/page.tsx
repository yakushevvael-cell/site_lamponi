import { redirect } from "next/navigation";
import { Clock, ShieldCheck } from "lucide-react";

import { LogoutButton } from "@/components/logout-button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getAppUser, loginPath } from "@/lib/app-auth";

export const dynamic = "force-dynamic";

export default async function AccessPendingPage() {
  const user = await getAppUser();
  if (!user) redirect(loginPath("/"));
  if (user.status === "active") redirect("/");

  const blocked = user.status === "blocked";
  return (
    <main className="grid min-h-svh place-items-center bg-muted/35 p-6">
      <Card className="w-full max-w-md border-border/70 shadow-xl shadow-black/5">
        <CardHeader className="space-y-5 text-center">
          <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-muted text-muted-foreground">
            {blocked ? <ShieldCheck className="size-7" /> : <Clock className="size-7" />}
          </span>
          <div className="space-y-2">
            <CardTitle className="text-2xl">{blocked ? "Доступ закрыт" : "Доступ ещё не подтверждён"}</CardTitle>
            <CardDescription className="text-sm leading-6">
              {blocked
                ? "Администратор закрыл доступ к этому аккаунту. Если это ошибка, обратитесь к нему."
                : "Аккаунт создан. Администратор подтвердит доступ на вкладке «Пользователи» — после этого страница откроется."}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 text-center">
          <p className="text-sm text-muted-foreground">{user.fullName ?? user.email}</p>
          <LogoutButton className="w-full" />
        </CardContent>
      </Card>
    </main>
  );
}
