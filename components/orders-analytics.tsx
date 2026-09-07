"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Ban, CheckCircle2, Loader2, RefreshCw, RotateCcw, ShoppingBag, XCircle } from "lucide-react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type Analytics = {
  days: number;
  summary: { orderCount: number; orderedUnits: number; orderAmount: number; buyoutOrders: number; buyoutUnits: number; buyoutAmount: number; canceledOrders: number; canceledUnits: number; sellerCanceledOrders: number; sellerCanceledUnits: number; completedOrders: number; buyoutRate: number; cancelRate: number; sellerCancelRate: number; averageDeliveryDays: number | null };
  marketplaces: Array<{ id: string; name: string; orders: number; amount: number; buyouts: number; cancellations: number; sellerCancellations: number; buyoutRate: number; cancelRate: number }>;
  trend: Array<{ date: string; orders: number; amount: number; buyouts: number; cancellations: number; sellerCancellations: number }>;
  productRatings: Array<{ article: string; orders: number; units: number; buyouts: number; buyoutUnits: number; cancellations: number; canceledUnits: number; sellerCancellations: number; sellerCanceledUnits: number; amount: number }>;
  geography: Array<{ location: string; orders: number; buyouts: number; cancellations: number; amount: number }>;
  recentOrders: Array<{ id: string; marketplace: string; city: string; amount: number; status: string; orderedAt: string; sellerCancelled: boolean }>;
  lastSync: Array<{ marketplaceId: string; lastSyncAt: string | null }>;
};

const emptySummary: Analytics["summary"] = { orderCount: 0, orderedUnits: 0, orderAmount: 0, buyoutOrders: 0, buyoutUnits: 0, buyoutAmount: 0, canceledOrders: 0, canceledUnits: 0, sellerCanceledOrders: 0, sellerCanceledUnits: 0, completedOrders: 0, buyoutRate: 0, cancelRate: 0, sellerCancelRate: 0, averageDeliveryDays: null };
function formatMoney(value: number) { return new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB", maximumFractionDigits: 0 }).format(value); }
function shortDate(value: string) { return new Date(value).toLocaleDateString("ru-RU", { day: "2-digit", month: "short" }); }

export function OrdersAnalytics({ canSync }: { canSync: boolean }) {
  const [period, setPeriod] = useState("30");
  const [data, setData] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const autoSyncStarted = useRef(false);

  const load = useCallback(async (days: string) => {
    setLoading(true);
    try {
      const response = await fetch(`/api/orders/analytics?days=${days}`, { cache: "no-store" });
      const payload = await response.json() as Analytics & { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Не удалось загрузить аналитику.");
      setData(payload);
    } catch (error) { toast.error("Аналитика не загружена", { description: error instanceof Error ? error.message : "Повторите попытку." }); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void Promise.resolve().then(() => load(period)); }, [load, period]);
  useEffect(() => {
    if (!canSync) return;
    if (autoSyncStarted.current) return;
    autoSyncStarted.current = true;
    void fetch("/api/orders/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ days: 30, force: false }),
    }).then(() => load(period)).catch(() => undefined);
  }, [canSync, load, period]);

  async function syncOrders() {
    setSyncing(true);
    try {
      const response = await fetch("/api/orders/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ days: Number(period), force: true }) });
      const payload = await response.json() as { results?: Array<{ marketplace?: string; orders?: number; skipped?: boolean }>; errors?: Array<{ marketplace: string; message: string }> };
      if (!response.ok && response.status !== 207) throw new Error(payload.errors?.map((item) => item.message).join(" ") || "Синхронизация не выполнена.");
      const count = payload.results?.reduce((sum, item) => sum + Number(item.orders ?? 0), 0) ?? 0;
      if (payload.errors?.length) toast.warning("Часть данных не загрузилась", { description: payload.errors.map((item) => `${item.marketplace}: ${item.message}`).join(" ") });
      else toast.success("Реальные заказы обновлены", { description: `Получено заказов за период: ${count}. Остатки не изменялись.` });
      await load(period);
    } catch (error) { toast.error("Заказы не обновлены", { description: error instanceof Error ? error.message : "Повторите попытку." }); }
    finally { setSyncing(false); }
  }

  const summary = data?.summary ?? emptySummary;
  const chartData = (data?.trend ?? []).map((row) => ({ ...row, label: shortDate(row.date) }));
  return <div className="mx-auto max-w-[1520px] space-y-5 p-4 md:p-7">
    <div className="flex flex-col gap-3 rounded-2xl border bg-card p-4 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-semibold">Реальные данные WB и Ozon</p><p className="mt-1 text-xs text-muted-foreground">Данные доступны для просмотра. Обновление заказов из API и полную синхронизацию остатков запускает администратор.</p></div><div className="flex gap-2"><Select value={period} onValueChange={setPeriod}><SelectTrigger className="w-32"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="7">7 дней</SelectItem><SelectItem value="30">30 дней</SelectItem><SelectItem value="90">90 дней</SelectItem></SelectContent></Select>{canSync ? <Button onClick={() => void syncOrders()} disabled={syncing}>{syncing ? <Loader2 className="animate-spin" /> : <RefreshCw />}{syncing ? "Получаем…" : "Обновить из API"}</Button> : null}</div></div>

    {loading ? <div className="grid min-h-72 place-items-center text-sm text-muted-foreground"><Loader2 className="mr-2 inline size-4 animate-spin" />Считаем реальные показатели…</div> : <>
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">{[
        { label: "Заказы", value: summary.orderCount.toLocaleString("ru-RU"), note: `${summary.orderedUnits.toLocaleString("ru-RU")} шт.`, icon: ShoppingBag },
        { label: "Выкупы", value: summary.buyoutOrders.toLocaleString("ru-RU"), note: `${summary.buyoutRate}% завершённых`, icon: CheckCircle2 },
        { label: "Все отмены", value: summary.canceledOrders.toLocaleString("ru-RU"), note: `${summary.cancelRate}% заказов`, icon: XCircle },
        { label: "Отмены продавцом", value: summary.sellerCanceledOrders.toLocaleString("ru-RU"), note: `${summary.sellerCancelRate}% заказов`, icon: Ban },
        { label: "Сумма заказов", value: formatMoney(summary.orderAmount), note: `выкуплено ${formatMoney(summary.buyoutAmount)}`, icon: RotateCcw },
      ].map((item) => <Card key={item.label} className="gap-0 py-5"><CardContent className="px-5"><div className="flex items-start justify-between"><div><p className="text-sm text-muted-foreground">{item.label}</p><p className="mt-2 text-2xl font-semibold">{item.value}</p><p className="mt-2 text-xs text-muted-foreground">{item.note}</p></div><span className="grid size-10 place-items-center rounded-xl bg-secondary"><item.icon className="size-4" /></span></div></CardContent></Card>)}</section>

      <Card><CardHeader><CardTitle className="text-base">Динамика заказов, выкупов и отмен</CardTitle></CardHeader><CardContent className="h-[290px] px-2 sm:px-5">{chartData.length ? <ResponsiveContainer width="100%" height="100%"><AreaChart data={chartData} margin={{ left: -18, right: 12 }}><CartesianGrid vertical={false} strokeDasharray="4 4" /><XAxis dataKey="label" tick={{ fontSize: 11 }} /><YAxis tick={{ fontSize: 11 }} /><Tooltip /><Area type="monotone" dataKey="orders" name="Заказы" stroke="#8056d9" fill="#8056d9" fillOpacity={0.15} /><Area type="monotone" dataKey="buyouts" name="Выкупы" stroke="#228b63" fillOpacity={0} /><Area type="monotone" dataKey="cancellations" name="Отмены" stroke="#d24f63" fillOpacity={0} /></AreaChart></ResponsiveContainer> : <div className="grid h-full place-items-center text-sm text-muted-foreground">После первой загрузки заказов здесь появится график.</div>}</CardContent></Card>

      <Tabs defaultValue="products"><TabsList className="flex h-auto flex-wrap"><TabsTrigger value="products">Рейтинг товаров</TabsTrigger><TabsTrigger value="marketplaces">Площадки</TabsTrigger><TabsTrigger value="geography">География</TabsTrigger><TabsTrigger value="orders">Последние заказы</TabsTrigger></TabsList>
        <TabsContent value="products"><Card className="gap-0 overflow-hidden py-0"><div className="border-b px-5 py-4"><p className="font-semibold">Сводный рейтинг товаров по WB и Ozon</p><p className="mt-1 text-xs text-muted-foreground">Размеры объединены на уровне артикула; сортировка по количеству заказанных единиц.</p></div><div className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead className="pl-5">#</TableHead><TableHead>Артикул</TableHead><TableHead className="text-right">Заказы</TableHead><TableHead className="text-right">Штук</TableHead><TableHead className="text-right">Выкупы</TableHead><TableHead className="text-right">Отмены</TableHead><TableHead className="pr-5 text-right">Отмены продавцом</TableHead></TableRow></TableHeader><TableBody>{data?.productRatings.length ? data.productRatings.map((row, index) => <TableRow key={row.article}><TableCell className="pl-5 text-muted-foreground">{index + 1}</TableCell><TableCell className="font-mono text-xs font-semibold">{row.article}</TableCell><TableCell className="text-right">{row.orders}</TableCell><TableCell className="text-right font-semibold">{row.units}</TableCell><TableCell className="text-right text-emerald-700">{row.buyouts}</TableCell><TableCell className="text-right text-rose-700">{row.cancellations}</TableCell><TableCell className="pr-5 text-right font-semibold text-rose-800">{row.sellerCancellations}</TableCell></TableRow>) : <TableRow><TableCell colSpan={7} className="h-28 text-center text-muted-foreground">Нет заказов за выбранный период.</TableCell></TableRow>}</TableBody></Table></div></Card></TabsContent>
        <TabsContent value="marketplaces"><Card className="gap-0 overflow-hidden py-0"><Table><TableHeader><TableRow><TableHead className="pl-5">Площадка</TableHead><TableHead className="text-right">Заказы</TableHead><TableHead className="text-right">Сумма</TableHead><TableHead className="text-right">Выкупы</TableHead><TableHead className="text-right">Отмены</TableHead><TableHead className="pr-5 text-right">Отмены продавцом</TableHead></TableRow></TableHeader><TableBody>{data?.marketplaces.length ? data.marketplaces.map((row) => <TableRow key={row.id}><TableCell className="pl-5 font-semibold">{row.name}</TableCell><TableCell className="text-right">{row.orders}</TableCell><TableCell className="text-right">{formatMoney(row.amount)}</TableCell><TableCell className="text-right">{row.buyouts} <span className="text-xs text-muted-foreground">({row.buyoutRate}%)</span></TableCell><TableCell className="text-right">{row.cancellations}</TableCell><TableCell className="pr-5 text-right font-semibold">{row.sellerCancellations}</TableCell></TableRow>) : <TableRow><TableCell colSpan={6} className="h-28 text-center text-muted-foreground">Нет данных.</TableCell></TableRow>}</TableBody></Table></Card></TabsContent>
        <TabsContent value="geography"><Card className="gap-0 overflow-hidden py-0"><Table><TableHeader><TableRow><TableHead className="pl-5">Регион / город</TableHead><TableHead className="text-right">Заказы</TableHead><TableHead className="text-right">Выкупы</TableHead><TableHead className="text-right">Отмены</TableHead><TableHead className="pr-5 text-right">Сумма</TableHead></TableRow></TableHeader><TableBody>{data?.geography.length ? data.geography.map((row) => <TableRow key={row.location}><TableCell className="pl-5 font-medium">{row.location}</TableCell><TableCell className="text-right">{row.orders}</TableCell><TableCell className="text-right">{row.buyouts}</TableCell><TableCell className="text-right">{row.cancellations}</TableCell><TableCell className="pr-5 text-right">{formatMoney(row.amount)}</TableCell></TableRow>) : <TableRow><TableCell colSpan={5} className="h-28 text-center text-muted-foreground">Площадки не передали географию за этот период.</TableCell></TableRow>}</TableBody></Table></Card></TabsContent>
        <TabsContent value="orders"><Card className="gap-0 overflow-hidden py-0"><div className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead className="pl-5">Заказ</TableHead><TableHead>Площадка</TableHead><TableHead>Город</TableHead><TableHead className="text-right">Сумма</TableHead><TableHead>Статус</TableHead><TableHead className="pr-5 text-right">Дата</TableHead></TableRow></TableHeader><TableBody>{data?.recentOrders.length ? data.recentOrders.map((order) => <TableRow key={`${order.marketplace}-${order.id}`}><TableCell className="pl-5 font-mono text-xs font-semibold">{order.id}</TableCell><TableCell>{order.marketplace}</TableCell><TableCell>{order.city}</TableCell><TableCell className="text-right">{formatMoney(order.amount)}</TableCell><TableCell><Badge variant={order.status.includes("Отмена") ? "destructive" : "secondary"}>{order.status}</Badge></TableCell><TableCell className="pr-5 text-right text-xs text-muted-foreground">{new Date(order.orderedAt).toLocaleString("ru-RU")}</TableCell></TableRow>) : <TableRow><TableCell colSpan={6} className="h-28 text-center text-muted-foreground">Нет заказов за выбранный период.</TableCell></TableRow>}</TableBody></Table></div></Card></TabsContent>
      </Tabs>
    </>}
  </div>;
}
