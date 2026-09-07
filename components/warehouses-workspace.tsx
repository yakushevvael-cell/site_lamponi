"use client";

import { useCallback, useEffect, useState } from "react";
import { Building2, CheckCircle2, CircleDashed, Loader2, RefreshCw, Warehouse } from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";

type WarehouseItem = {
  id: string;
  name: string;
  remoteActive: boolean;
  remoteStatus: string | null;
  publishFullStock: boolean;
  syncStatus: "never" | "ok" | "error";
  syncError: string | null;
  publishEnabledBy: string | null;
  publishEnabledAt: string | null;
  lastCheckedAt: string | null;
  lastStockSyncAt: string | null;
};

type Integration = {
  id: string;
  name: string;
  shortName: string;
  configured: boolean;
  connected: boolean;
  credentialsMessage: string | null;
  lastCheckedAt: string | null;
  warehouseCount: number;
  activeWarehouseCount: number;
  publishingWarehouseCount: number;
  warehouses: WarehouseItem[];
};

type Totals = { physicalQuantity: number; reservedQuantity: number; availableQuantity: number; manualZeroCount: number };
type PendingDisable = { marketplaceId: string; marketplaceName: string; warehouse: WarehouseItem };
type PendingEnable = { marketplaceId: string; marketplaceName: string; warehouse: WarehouseItem; alreadyPublishing: number };

const colors: Record<string, string> = { wildberries: "bg-violet-600", ozon: "bg-blue-600", yandex: "bg-amber-500" };

export function WarehousesWorkspace({ canManage }: { canManage: boolean }) {
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [pendingDisable, setPendingDisable] = useState<PendingDisable | null>(null);
  const [pendingEnable, setPendingEnable] = useState<PendingEnable | null>(null);

  const load = useCallback(async () => {
    const [statusResponse, stockResponse] = await Promise.all([
      fetch("/api/integrations/status", { cache: "no-store" }),
      fetch("/api/stocks?limit=1", { cache: "no-store" }),
    ]);
    const status = await statusResponse.json() as { integrations?: Integration[]; error?: string };
    const stock = await stockResponse.json() as { totals?: Totals; error?: string };
    if (!statusResponse.ok) throw new Error(status.error ?? "Не удалось загрузить склады.");
    if (!stockResponse.ok) throw new Error(stock.error ?? "Не удалось загрузить остатки.");
    setIntegrations(status.integrations ?? []);
    setTotals(stock.totals ?? null);
  }, []);

  useEffect(() => {
    void Promise.resolve().then(() => load())
      .catch((error) => toast.error("Склады не загружены", { description: error instanceof Error ? error.message : "Повторите попытку." }))
      .finally(() => setLoading(false));
  }, [load]);

  async function refreshWarehouses(integration: Integration) {
    if (integration.id !== "wildberries" && integration.id !== "ozon") return;
    // ТЗ, п. 5: кнопка и список складов остаются видимыми и без ключа.
    if (!integration.configured) {
      toast.error("Добавьте API-ключ для обновления списка складов.");
      return;
    }
    setRefreshing(integration.id);
    try {
      const response = await fetch(`/api/integrations/${integration.id}/check`, { method: "POST" });
      const data = await response.json() as { error?: string; activeWarehouseCount?: number };
      if (!response.ok) throw new Error(data.error ?? "Не удалось обновить список складов.");
      await load();
      toast.success("Список складов обновлён", {
        description: integration.id === "ozon" && typeof data.activeWarehouseCount === "number"
          ? `Активных складов Ozon: ${data.activeWarehouseCount}.`
          : undefined,
      });
    } catch (error) {
      toast.error("Не удалось обновить склады", { description: error instanceof Error ? error.message : "Повторите попытку." });
    } finally {
      setRefreshing(null);
    }
  }

  async function changePublishing(marketplaceId: string, warehouse: WarehouseItem, publishFullStock: boolean) {
    const key = `${marketplaceId}:${warehouse.id}`;
    setSaving(key);
    try {
      const response = await fetch("/api/warehouses/publishing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ marketplaceId, warehouseId: warehouse.id, publishFullStock }),
      });
      const data = await response.json() as { error?: string; zeroed?: number; sent?: number; warning?: string | null };
      if (!response.ok) throw new Error(data.error ?? "Не удалось изменить настройку склада.");
      await load();
      toast.success(publishFullStock ? "Выгрузка включена" : "Выгрузка отключена", {
        description: publishFullStock
          ? `Текущий остаток отправлен${data.sent ? ` по ${data.sent.toLocaleString("ru-RU")} позициям` : ""}. Склад участвует в синхронизации.`
          : `Доступный остаток обнулён${data.zeroed ? ` для ${data.zeroed.toLocaleString("ru-RU")} позиций` : ""}.`,
      });
      if (data.warning) toast.warning("Несколько складов одного маркетплейса", { description: data.warning });
    } catch (error) {
      toast.error("Настройка не изменена", { description: error instanceof Error ? error.message : "Повторите попытку." });
    } finally {
      setSaving(null);
      setPendingDisable(null);
      setPendingEnable(null);
    }
  }

  if (loading) {
    return <div className="grid min-h-72 place-items-center text-sm text-muted-foreground"><Loader2 className="mr-2 inline size-4 animate-spin" />Загружаем реальные склады…</div>;
  }

  return <div className="mx-auto max-w-[1320px] space-y-6 p-4 md:p-7">
    <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{[
      ["Физически по ОСВ", totals?.physicalQuantity ?? 0],
      ["В резерве", totals?.reservedQuantity ?? 0],
      ["Доступно", totals?.availableQuantity ?? 0],
      ["Обнулено вручную", totals?.manualZeroCount ?? 0],
    ].map(([label, value]) => <Card key={String(label)} className="gap-0 py-5"><CardContent className="flex items-center justify-between px-5"><div><p className="text-sm text-muted-foreground">{label}</p><p className="mt-2 text-2xl font-semibold">{Number(value).toLocaleString("ru-RU")}</p></div><Warehouse className="size-5 text-muted-foreground" /></CardContent></Card>)}</section>

    <div className="rounded-2xl border border-blue-200 bg-blue-50 px-5 py-4">
      <p className="text-sm font-semibold text-blue-950">Остатки отправляются только на выбранные склады</p>
      <p className="mt-1 text-xs leading-5 text-blue-800">Формула доступного остатка для каждого SKU: ОСВ − активные резервы WB и Ozon − страховой запас. Архивные и отключённые склады в синхронизации не участвуют.</p>
    </div>

    <section className="grid gap-4 lg:grid-cols-3">{integrations.map((integration) => <Card key={integration.id}>
      <CardHeader className="px-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className={`grid size-10 place-items-center rounded-xl text-xs font-bold text-white ${colors[integration.id]}`}>{integration.shortName}</span>
            <div><CardTitle className="text-base">{integration.name}</CardTitle><p className="mt-1 text-xs text-muted-foreground">FBS</p></div>
          </div>
          <Badge className={integration.connected ? "bg-emerald-100 text-emerald-800 hover:bg-emerald-100" : "bg-muted text-muted-foreground hover:bg-muted"}>
            {integration.connected ? <CheckCircle2 /> : <CircleDashed />}{integration.connected ? "Подключено" : integration.configured ? "Ключ добавлен" : "API-ключ не добавлен"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 px-5">
        {!integration.configured && (integration.id === "wildberries" || integration.id === "ozon")
          ? <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900">
              API-ключ не добавлен. Список складов и настройки сохранены, новые остатки не отправляются.
            </p>
          : null}
        <div className="rounded-xl bg-muted px-4 py-3 text-sm">
          <div className="flex items-center justify-between"><span className="flex items-center gap-2"><Building2 className="size-4" />Складов в кабинете</span><span className="font-semibold">{integration.warehouseCount}</span></div>
          <div className="mt-2 flex items-center justify-between"><span>Активных</span><span className="font-semibold">{integration.activeWarehouseCount}</span></div>
          <div className="mt-2 flex items-center justify-between"><span>Выгрузка включена</span><span className="font-semibold text-emerald-700">{integration.publishingWarehouseCount}</span></div>
          <div className="mt-3 flex items-center justify-between"><span className="flex items-center gap-2"><RefreshCw className="size-4" />Проверено</span><span className="text-xs text-muted-foreground">{integration.lastCheckedAt ? new Date(integration.lastCheckedAt).toLocaleString("ru-RU") : "не было"}</span></div>
        </div>

        {integration.warehouses.length ? <div className="max-h-80 space-y-2 overflow-auto pr-1">{integration.warehouses.map((warehouse) => {
          const key = `${integration.id}:${warehouse.id}`;
          const isSaving = saving === key;
          return <div key={warehouse.id} className={`rounded-xl border px-3 py-3 ${warehouse.remoteActive ? "bg-background" : "bg-muted/50"}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{warehouse.name}</p>
                <code className="text-[10px] text-muted-foreground">{warehouse.id}</code>
              </div>
              <div className="flex flex-col items-end gap-1">
                <Badge variant="outline" className={warehouse.remoteActive ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-slate-100 text-slate-600"}>
                  {warehouse.remoteActive ? "Активен" : "Архив / отключён"}
                </Badge>
                {warehouse.syncStatus === "error" ? <Badge variant="outline" className="border-red-200 bg-red-50 text-red-700">Ошибка синхронизации</Badge> : null}
              </div>
            </div>
            <div className="mt-3 flex items-center justify-between gap-3 border-t pt-3">
              <div>
                <p className="text-xs font-medium">Выгружать остатки</p>
                <p className="mt-0.5 text-[10px] text-muted-foreground">{warehouse.publishFullStock ? "Выгрузка включена" : "Выгрузка выключена"}</p>
              </div>
              {canManage && (integration.id === "wildberries" || integration.id === "ozon") ? <div className="flex items-center gap-2">
                {isSaving ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
                <Switch
                  aria-label={`Выгружать остатки на склад ${warehouse.name}`}
                  checked={warehouse.publishFullStock}
                  disabled={!warehouse.remoteActive || isSaving || Boolean(saving)}
                  onCheckedChange={(checked) => {
                    if (!checked) {
                      setPendingDisable({ marketplaceId: integration.id, marketplaceName: integration.name, warehouse });
                      return;
                    }
                    // ТЗ, п. 10: перед включением второго склада показываем предупреждение.
                    if (integration.publishingWarehouseCount > 0) {
                      setPendingEnable({
                        marketplaceId: integration.id,
                        marketplaceName: integration.name,
                        warehouse,
                        alreadyPublishing: integration.publishingWarehouseCount,
                      });
                      return;
                    }
                    void changePublishing(integration.id, warehouse, true);
                  }}
                />
              </div> : <Badge variant="secondary">{warehouse.publishFullStock ? "Включено" : "Выключено"}</Badge>}
            </div>
            <div className="mt-2 space-y-0.5 text-[10px] text-muted-foreground">
              {warehouse.remoteStatus ? <p>Статус в кабинете: {warehouse.remoteStatus}</p> : null}
              {warehouse.lastCheckedAt ? <p>Проверен: {new Date(warehouse.lastCheckedAt).toLocaleString("ru-RU")}</p> : null}
              <p>Последняя успешная выгрузка: {warehouse.lastStockSyncAt ? new Date(warehouse.lastStockSyncAt).toLocaleString("ru-RU") : "не было"}</p>
              {warehouse.syncError ? <p className="text-red-600">{warehouse.syncError}</p> : null}
            </div>
          </div>;
        })}</div> : <p className="text-sm text-muted-foreground">Склады не загружены.</p>}

        {canManage && (integration.id === "wildberries" || integration.id === "ozon") ? <Button variant="outline" className="w-full" disabled={Boolean(refreshing) || Boolean(saving)} onClick={() => void refreshWarehouses(integration)}>
          {refreshing === integration.id ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          Обновить список складов
        </Button> : null}
        {canManage ? <Button variant="ghost" className="w-full" asChild><a href="/settings">Управлять подключением</a></Button> : null}
      </CardContent>
    </Card>)}</section>

    <AlertDialog open={Boolean(pendingEnable)} onOpenChange={(open) => { if (!open) setPendingEnable(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Включить выгрузку ещё на один склад?</AlertDialogTitle>
          <AlertDialogDescription>
            {pendingEnable
              ? `На каждый выбранный склад ${pendingEnable.marketplaceName} будет передан полный доступный остаток. Остаток между складами не распределяется. Сейчас выгрузка включена на ${pendingEnable.alreadyPublishing} складе(ах), станет ${pendingEnable.alreadyPublishing + 1}.`
              : ""}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Отмена</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              if (pendingEnable) void changePublishing(pendingEnable.marketplaceId, pendingEnable.warehouse, true);
            }}
          >Включить выгрузку</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <AlertDialog open={Boolean(pendingDisable)} onOpenChange={(open) => { if (!open) setPendingDisable(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Отключить выгрузку на этот склад?</AlertDialogTitle>
          <AlertDialogDescription>
            {pendingDisable ? `На складе «${pendingDisable.warehouse.name}» (${pendingDisable.marketplaceName}) сначала будет обнулён доступный остаток, затем склад перестанет участвовать в синхронизации. Текущие заказы и их резервы сохранятся.` : ""}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Отмена</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
              if (pendingDisable) void changePublishing(pendingDisable.marketplaceId, pendingDisable.warehouse, false);
            }}
          >Обнулить и отключить</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>;
}
